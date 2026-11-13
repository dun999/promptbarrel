//! Barrel: prepaid AI inference that pays the provider only when the
//! contract sees the model's own TEE signature.
//!
//! The loop:
//!   buy     USDC in, Barrels out. USDC is held in escrow per series.
//!   fill    Barrels move into a tank controlled by a session key.
//!   settle  For each request: the tank key's ack and the model TEE's
//!           signature are both verified here. Units burn, USDC is released.
//!   refund  After the series expires, unused Barrels burn for their USDC.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

mod events;
mod registry;
mod series;
mod tank;
mod token;
pub mod util;

pub use registry::{Grade, KeyInfo, ReceiptCheck};
pub use series::Series;
pub use tank::{SettleItem, SettleRecord, Tank};

pub(crate) const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub(crate) const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// Flat deposit charged for calls that create a long-lived record.
pub(crate) const RECORD_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// How many recent settlements are kept on-chain for explorers.
pub(crate) const RECENT_CAP: u32 = 100;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub(crate) enum StorageKey {
    Grades,
    Keys,
    Series,
    Balances,
    Tanks,
    TanksByOwner,
    Recent,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Config {
    /// Registers grades and keys, sets caps, unpauses.
    pub owner: AccountId,
    /// The one stablecoin this deployment accepts.
    pub usdc: AccountId,
    /// How long a tank owner waits between asking for their Barrels back and
    /// getting them. Must exceed the operator's settle interval.
    pub unlock_delay_sec: u64,
    /// After a series ends, operators have this long to settle what they
    /// already served. Refunds open when it has passed.
    pub settle_grace_sec: u64,
    pub max_series_units: U128,
    pub max_total_escrow: U128,
    pub paused: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) config: Config,
    pub(crate) grades: IterableMap<String, Grade>,
    pub(crate) keys: LookupMap<String, Vec<KeyInfo>>,
    pub(crate) series: IterableMap<u64, Series>,
    pub(crate) balances: LookupMap<(AccountId, u64), u128>,
    pub(crate) tanks: IterableMap<u64, Tank>,
    pub(crate) tanks_by_owner: LookupMap<AccountId, Vec<u64>>,
    pub(crate) recent: Vector<SettleRecord>,
    pub(crate) recent_count: u64,
    pub(crate) next_series_id: u64,
    pub(crate) next_tank_id: u64,
    /// USDC currently held for all series.
    pub(crate) total_escrow: u128,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        usdc: AccountId,
        unlock_delay_sec: u64,
        settle_grace_sec: u64,
        max_series_units: U128,
        max_total_escrow: U128,
    ) -> Self {
        Self {
            config: Config {
                owner,
                usdc,
                unlock_delay_sec,
                settle_grace_sec,
                max_series_units,
                max_total_escrow,
                paused: false,
            },
            grades: IterableMap::new(StorageKey::Grades),
            keys: LookupMap::new(StorageKey::Keys),
            series: IterableMap::new(StorageKey::Series),
            balances: LookupMap::new(StorageKey::Balances),
            tanks: IterableMap::new(StorageKey::Tanks),
            tanks_by_owner: LookupMap::new(StorageKey::TanksByOwner),
            recent: Vector::new(StorageKey::Recent),
            recent_count: 0,
            next_series_id: 1,
            next_tank_id: 1,
            total_escrow: 0,
        }
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_total_escrow(&self) -> U128 {
        U128(self.total_escrow)
    }

    /// Stops new money and new settlements. Transfers, tank withdrawals and
    /// refunds stay open so nobody is locked in.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.config.paused = true;
        events::barrel("pause", near_sdk::serde_json::json!({}));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.config.paused = false;
        events::barrel("unpause", near_sdk::serde_json::json!({}));
    }

    pub fn set_caps(&mut self, max_series_units: U128, max_total_escrow: U128) {
        self.assert_owner();
        self.config.max_series_units = max_series_units;
        self.config.max_total_escrow = max_total_escrow;
    }
}

impl Contract {
    pub(crate) fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.config.owner,
            "owner only"
        );
    }

    pub(crate) fn assert_live(&self) {
        require!(!self.config.paused, "paused");
    }

    pub(crate) fn balance_of(&self, account: &AccountId, series_id: u64) -> u128 {
        self.balances
            .get(&(account.clone(), series_id))
            .copied()
            .unwrap_or(0)
    }

    pub(crate) fn credit(&mut self, account: &AccountId, series_id: u64, units: u128) {
        let b = self.balance_of(account, series_id);
        self.balances.insert(
            (account.clone(), series_id),
            b.checked_add(units)
                .unwrap_or_else(|| env::panic_str("overflow")),
        );
    }

    pub(crate) fn debit(&mut self, account: &AccountId, series_id: u64, units: u128) {
        let b = self.balance_of(account, series_id);
        require!(b >= units, "not enough Barrels");
        if b == units {
            self.balances.remove(&(account.clone(), series_id));
        } else {
            self.balances.insert((account.clone(), series_id), b - units);
        }
    }

    /// Sends USDC out of escrow. `total_escrow` is reduced up front and
    /// restored by the caller's callback if the transfer fails.
    pub(crate) fn send_usdc(&mut self, to: &AccountId, amount: u128) -> Promise {
        self.total_escrow = self
            .total_escrow
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("escrow underflow"));
        Promise::new(self.config.usdc.clone()).function_call(
            "ft_transfer".to_string(),
            near_sdk::serde_json::json!({ "receiver_id": to, "amount": U128(amount) })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(1),
            GAS_FT_TRANSFER,
        )
    }
}
