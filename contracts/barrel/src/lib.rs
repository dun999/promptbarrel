//! Barrel: prepaid AI inference that pays the provider only when the
//! contract sees the model's own TEE signature.
//!
//! The loop:
//!   buy     USDC in, Barrels out. USDC is held in escrow per series.
//!   fill    Barrels move into a tank controlled by a session key.
//!   settle  For each request: the tank key's ack and the model TEE's
//!           signature are both verified here. Units burn, USDC is released.
//!   refund  After the series expires, unused Barrels burn for their USDC.
//!
//! Around the loop:
//!   claim   An operator who served an answer the payer never acknowledged
//!           claims it with the payer's request authorization and the model's
//!           signature. The payer's own ack supersedes it inside a window.
//!   firm    A series with an operator bond: a holder can force a request
//!           through the chain, anyone can send a canary, and an operator
//!           that stops answering is slashed and defaulted.
//!   index   Every payout feeds a 24-hour price per grade built only from
//!           proven deliveries.
//!   gov     Owner changes and code upgrades wait out a timelock.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

mod events;
mod firm;
mod gov;
mod index;
mod registry;
mod series;
mod tank;
mod token;
pub mod util;

pub use firm::{Canary, Firm, Forced};
pub use gov::Pending;
pub use index::{Bucket, IndexView};
pub use registry::{Grade, KeyInfo, ReceiptCheck};
pub use series::Series;
pub use tank::{Claim, SettleItem, SettleRecord, Tank};

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
    TankByKey,
    Index,
    Forced,
    Pending,
    Owed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Config {
    /// Adds grades, sets caps, unpauses. Changes to it wait out the timelock.
    pub owner: AccountId,
    /// The one stablecoin this deployment accepts.
    pub usdc: AccountId,
    /// How long a tank owner waits between asking for their Barrels back and
    /// getting them. Must exceed the operator's settle interval and the
    /// claim window.
    pub unlock_delay_sec: u64,
    /// After a series ends, operators have this long to settle what they
    /// already served. Refunds open when it has passed.
    pub settle_grace_sec: u64,
    /// How long a payer has to answer an operator's claim with their own ack.
    pub claim_window_sec: u64,
    /// How long an owner change, an attestor change or an upgrade waits.
    pub timelock_sec: u64,
    pub max_series_units: U128,
    pub max_total_escrow: U128,
    /// Smallest purchase that may open a tank directly (keeps dust tanks out).
    pub min_tank_buy_units: U128,
    pub paused: bool,
    /// The contract that verifies TEE attestations on-chain and registers
    /// model keys. Anyone can call it; it needs no permission from the owner.
    pub attestor: Option<AccountId>,
    /// May pause, and nothing else.
    pub guardian: Option<AccountId>,
    /// While true the owner can also register keys after off-chain checks.
    /// Once turned off it cannot be turned on again.
    pub owner_registers_keys: bool,
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
    /// Latest tank opened for a spend key, so a repeat purchase tops it up.
    pub(crate) tank_by_key: LookupMap<String, u64>,
    /// Rolling 24-hour delivery price per grade.
    pub(crate) index: LookupMap<String, Vec<Bucket>>,
    pub(crate) forced: LookupMap<u64, Forced>,
    pub(crate) next_forced_id: u64,
    /// USDC currently held as operator bonds.
    pub(crate) total_bond: u128,
    /// Changes waiting out the timelock, by kind.
    pub(crate) pending: LookupMap<String, Pending>,
    /// USDC a holder is owed after a transfer to them failed.
    pub(crate) owed: LookupMap<AccountId, u128>,
}

#[near(serializers = [json])]
pub struct InitArgs {
    pub owner: AccountId,
    pub usdc: AccountId,
    pub unlock_delay_sec: u64,
    pub settle_grace_sec: u64,
    pub claim_window_sec: u64,
    pub timelock_sec: u64,
    pub max_series_units: U128,
    pub max_total_escrow: U128,
    pub min_tank_buy_units: U128,
    pub attestor: Option<AccountId>,
    pub guardian: Option<AccountId>,
    pub owner_registers_keys: bool,
}

#[near]
impl Contract {
    #[init]
    pub fn new(args: InitArgs) -> Self {
        require!(
            args.unlock_delay_sec > args.claim_window_sec,
            "the unlock delay must exceed the claim window"
        );
        Self {
            config: Config {
                owner: args.owner,
                usdc: args.usdc,
                unlock_delay_sec: args.unlock_delay_sec,
                settle_grace_sec: args.settle_grace_sec,
                claim_window_sec: args.claim_window_sec,
                timelock_sec: args.timelock_sec,
                max_series_units: args.max_series_units,
                max_total_escrow: args.max_total_escrow,
                min_tank_buy_units: args.min_tank_buy_units,
                paused: false,
                attestor: args.attestor,
                guardian: args.guardian,
                owner_registers_keys: args.owner_registers_keys,
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
            tank_by_key: LookupMap::new(StorageKey::TankByKey),
            index: LookupMap::new(StorageKey::Index),
            forced: LookupMap::new(StorageKey::Forced),
            next_forced_id: 1,
            total_bond: 0,
            pending: LookupMap::new(StorageKey::Pending),
            owed: LookupMap::new(StorageKey::Owed),
        }
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_total_escrow(&self) -> U128 {
        U128(self.total_escrow)
    }

    pub fn get_total_bond(&self) -> U128 {
        U128(self.total_bond)
    }

    /// Stops new money and new settlements. Transfers, tank withdrawals and
    /// refunds stay open so nobody is locked in.
    pub fn pause(&mut self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.config.owner || Some(&caller) == self.config.guardian.as_ref(),
            "owner or guardian only"
        );
        self.config.paused = true;
        events::barrel("pause", near_sdk::serde_json::json!({ "by": caller }));
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

    /// USDC owed to an account after a transfer to it failed (for example it
    /// was not registered with the token).
    pub fn get_owed(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }

    /// Retries a payout that failed earlier.
    pub fn claim_owed(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.owed.remove(&account).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.transfer_usdc(&account, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_owed_paid(account, U128(amount)),
        )
    }

    #[private]
    pub fn on_owed_paid(&mut self, account: AccountId, amount: U128) -> U128 {
        if near_sdk::is_promise_success() {
            return amount;
        }
        self.owe(&account, amount.0);
        U128(0)
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

    /// A plain USDC transfer. The caller keeps the books.
    pub(crate) fn transfer_usdc(&self, to: &AccountId, amount: u128) -> Promise {
        Promise::new(self.config.usdc.clone()).function_call(
            "ft_transfer".to_string(),
            near_sdk::serde_json::json!({ "receiver_id": to, "amount": U128(amount) })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(1),
            GAS_FT_TRANSFER,
        )
    }

    /// Sends USDC out of escrow. `total_escrow` is reduced up front and
    /// restored by the caller's callback if the transfer fails.
    pub(crate) fn send_usdc(&mut self, to: &AccountId, amount: u128) -> Promise {
        self.total_escrow = self
            .total_escrow
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("escrow underflow"));
        self.transfer_usdc(to, amount)
    }

    pub(crate) fn owe(&mut self, account: &AccountId, amount: u128) {
        let now = self.owed.get(account).copied().unwrap_or(0);
        self.owed.insert(account.clone(), now + amount);
    }
}
