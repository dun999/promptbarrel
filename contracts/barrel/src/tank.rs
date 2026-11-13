//! Tanks and settlement.
//!
//! A tank is a balance of one series that a session key can spend on
//! inference and nothing else: the key cannot transfer or withdraw.
//!
//! `settle` is the rule the whole product rests on. For every request it
//! verifies two Ed25519 signatures on-chain:
//!   1. the tank key's ack, signed by the payer's SDK only after it checked
//!      the receipt and read the unit count from the signed response, and
//!   2. the model TEE's signature over `<model_id>:<request_hash>:<response_hash>`
//!      under a key registered for the series' grade.
//! Only then do units burn and USDC leave escrow.
//!
//! A job tank names an agent: someone else's agent does the work and spends
//! the tank on its own thinking. The owner (the client) either accepts the
//! job, and the leftover is paid to the agent in USDC, or unlocks the tank and
//! takes the leftover back. Either way the operator keeps what it delivered,
//! because both paths wait for the same unlock delay before money moves.

use crate::util::{ack_text, is_hash_hex, normalize_key, now_sec, receipt_text, usdc_floor, verify_ed25519};
use crate::{
    events, near, require, AccountId, Contract, ContractExt, GAS_CALLBACK, RECENT_CAP,
    RECORD_DEPOSIT, U128,
};
use near_sdk::serde_json::json;
use near_sdk::{env, is_promise_success, PromiseOrValue};

const MAX_ITEMS_PER_SETTLE: usize = 40;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Tank {
    pub id: u64,
    pub series_id: u64,
    pub owner: AccountId,
    /// Ed25519 session key, lowercase hex. It can only sign acks.
    pub key: String,
    pub balance: U128,
    pub spent: U128,
    /// Sequence number the next settled request must carry.
    pub next_seq: u64,
    /// Set when the owner asks for the balance back, or accepts the job. Unix seconds.
    pub unlock_at: Option<u64>,
    pub closed: bool,
    /// Job tanks only: the account paid the leftover when the owner accepts.
    pub agent: Option<AccountId>,
    /// The owner accepted the job. The leftover goes to the agent, never back.
    pub accepted: bool,
}

#[near(serializers = [json])]
pub struct SettleItem {
    pub seq: u64,
    pub request_hash: String,
    pub response_hash: String,
    pub units: U128,
    /// Tank key's signature over the ack text.
    pub ack_sig: String,
    /// Model TEE signing key and its signature over the receipt text.
    pub tee_key: String,
    pub tee_sig: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct SettleRecord {
    pub tank_id: u64,
    pub series_id: u64,
    pub seq: u64,
    pub units: U128,
    pub request_hash: String,
    pub response_hash: String,
    pub tee_key: String,
    pub tee_sig: String,
    pub at: u64,
}

#[near]
impl Contract {
    /// Moves Barrels from the caller's balance into a new tank. With `agent`,
    /// it is a job tank: the key belongs to that agent, and `accept` pays it
    /// whatever the work did not use.
    #[payable]
    pub fn fill(&mut self, series_id: u64, units: U128, key: String, agent: Option<AccountId>) -> u64 {
        self.assert_live();
        require!(
            env::attached_deposit() >= RECORD_DEPOSIT,
            "attach 0.01 NEAR for storage"
        );
        let key = normalize_key(&key).unwrap_or_else(|| env::panic_str("bad tank key"));
        let owner = env::predecessor_account_id();
        if let Some(agent) = &agent {
            require!(*agent != owner, "the agent must be another account");
            require!(*agent != env::current_account_id(), "the agent cannot be this contract");
        }
        self.move_into_tank(&owner, series_id, units.0);

        let id = self.next_tank_id;
        self.next_tank_id += 1;
        let tank = Tank {
            id,
            series_id,
            owner: owner.clone(),
            key,
            balance: units,
            spent: U128(0),
            next_seq: 0,
            unlock_at: None,
            closed: false,
            agent,
            accepted: false,
        };
        let mut mine = self.tanks_by_owner.get(&owner).cloned().unwrap_or_default();
        mine.push(id);
        self.tanks_by_owner.insert(owner, mine);
        events::barrel("fill", json!({ "tank": &tank }));
        self.tanks.insert(id, tank);
        id
    }

    /// Adds more Barrels to an existing tank. Cancels a pending unlock.
    pub fn top_up(&mut self, tank_id: u64, units: U128) {
        self.assert_live();
        let mut tank = self.tank(tank_id);
        require!(env::predecessor_account_id() == tank.owner, "tank owner only");
        require!(!tank.closed, "tank closed");
        require!(!tank.accepted, "job accepted; the tank is paying out");
        self.move_into_tank(&tank.owner, tank.series_id, units.0);
        tank.balance.0 += units.0;
        tank.unlock_at = None;
        events::barrel("top_up", json!({ "tank_id": tank_id, "units": units }));
        self.tanks.insert(tank_id, tank);
    }

    /// Settles served requests. Anyone can call it; the USDC always goes to
    /// the series operator.
    pub fn settle(&mut self, tank_id: u64, items: Vec<SettleItem>) -> U128 {
        self.assert_live();
        require!(
            !items.is_empty() && items.len() <= MAX_ITEMS_PER_SETTLE,
            "between 1 and 40 items"
        );
        let mut tank = self.tank(tank_id);
        require!(!tank.closed, "tank closed");
        let mut series = self.series.get(&tank.series_id).cloned().unwrap();
        let now = now_sec();
        require!(
            now < series.window_end + self.config.settle_grace_sec,
            "settlement closed for this series"
        );
        let model_id = self.grades.get(&series.grade_id).unwrap().model_id.clone();
        let contract = env::current_account_id();
        let mut total: u128 = 0;

        for item in items.iter() {
            require!(item.seq == tank.next_seq, "wrong sequence number");
            require!(
                is_hash_hex(&item.request_hash) && is_hash_hex(&item.response_hash),
                "hashes must be 64 lowercase hex characters"
            );
            let units = item.units.0;
            require!(units > 0, "zero units");
            require!(units <= tank.balance.0, "more units than the tank holds");

            // 1. The payer agreed to this request, this answer and this unit count.
            let ack = ack_text(
                contract.as_str(),
                tank_id,
                item.seq,
                &item.request_hash,
                &item.response_hash,
                units,
            );
            require!(
                verify_ed25519(&item.ack_sig, ack.as_bytes(), &tank.key),
                "ack is not signed by the tank key"
            );

            // 2. The named model's TEE signed exactly this request and answer.
            let tee_key =
                normalize_key(&item.tee_key).unwrap_or_else(|| env::panic_str("bad model key"));
            require!(
                self.key_is_live(&series.grade_id, &tee_key, now),
                "signing key is not a live registered model key for this grade"
            );
            let text = receipt_text(&model_id, &item.request_hash, &item.response_hash);
            require!(
                verify_ed25519(&item.tee_sig, text.as_bytes(), &tee_key),
                "model signature does not verify"
            );

            tank.balance.0 -= units;
            tank.spent.0 += units;
            tank.next_seq += 1;
            total += units;

            let record = SettleRecord {
                tank_id,
                series_id: series.id,
                seq: item.seq,
                units: item.units,
                request_hash: item.request_hash.clone(),
                response_hash: item.response_hash.clone(),
                tee_key,
                tee_sig: item.tee_sig.clone(),
                at: now,
            };
            events::barrel("settle", json!({ "record": &record }));
            self.remember(record);
        }

        // Burn the delivered units and release exactly the USDC they earned.
        let price = series.price_per_barrel.0;
        let before = usdc_floor(series.burned.0, price);
        series.burned.0 += total;
        series.in_tanks.0 -= total;
        let earned = usdc_floor(series.burned.0, price) - before;
        series.released.0 += earned;
        series.payable.0 += earned;
        let series_id = series.id;
        self.series.insert(series_id, series);
        self.tanks.insert(tank_id, tank);
        events::mt_burn(&contract, series_id, total, "delivered");

        // Detached on purpose: a failed transfer is re-credited by `on_payout`
        // and can be retried with `claim`.
        if let Some(payout) = self.pay_operator(series_id) {
            payout.detach();
        }
        U128(total)
    }

    /// Starts the clock for getting a tank's balance back. On a job tank this
    /// is the client rejecting the job: the leftover returns to the client.
    pub fn request_unlock(&mut self, tank_id: u64) -> u64 {
        let mut tank = self.tank(tank_id);
        require!(env::predecessor_account_id() == tank.owner, "tank owner only");
        require!(!tank.closed, "tank closed");
        require!(!tank.accepted, "job accepted; the leftover goes to the agent");
        let at = now_sec() + self.config.unlock_delay_sec;
        tank.unlock_at = Some(at);
        events::barrel("request_unlock", json!({ "tank_id": tank_id, "unlock_at": at }));
        self.tanks.insert(tank_id, tank);
        at
    }

    /// The client accepts the agent's work. The tank stops being served, and
    /// after the unlock delay its leftover is paid to the agent in USDC.
    /// Cannot be undone. Returns when the payout opens, in Unix seconds.
    pub fn accept(&mut self, tank_id: u64) -> u64 {
        let mut tank = self.tank(tank_id);
        require!(env::predecessor_account_id() == tank.owner, "tank owner only");
        require!(!tank.closed, "tank closed");
        require!(tank.agent.is_some(), "this tank has no agent");
        require!(!tank.accepted, "already accepted");
        // An unlock already under way keeps its time: the operator was given
        // that long to settle, and the agent need not wait longer.
        let at = tank
            .unlock_at
            .unwrap_or(now_sec() + self.config.unlock_delay_sec);
        tank.accepted = true;
        tank.unlock_at = Some(at);
        events::barrel(
            "accept",
            json!({ "tank_id": tank_id, "agent": &tank.agent, "pays_out_at": at }),
        );
        self.tanks.insert(tank_id, tank);
        at
    }

    /// Empties a tank once the unlock delay has passed, or at any time after
    /// settlement has closed. An accepted job pays its leftover to the agent
    /// in USDC (the owner or the agent can trigger it). Otherwise the
    /// remaining Barrels return to the owner.
    pub fn withdraw(&mut self, tank_id: u64) -> PromiseOrValue<U128> {
        let mut tank = self.tank(tank_id);
        let caller = env::predecessor_account_id();
        if tank.accepted {
            let agent = tank.agent.clone().unwrap();
            require!(caller == tank.owner || caller == agent, "tank owner or agent only");
        } else {
            require!(caller == tank.owner, "tank owner only");
        }
        require!(!tank.closed, "tank closed");
        let mut series = self.series.get(&tank.series_id).cloned().unwrap();
        let now = now_sec();
        let settlement_closed = now >= series.window_end + self.config.settle_grace_sec;
        let unlocked = tank.unlock_at.map(|at| now >= at).unwrap_or(false);
        if tank.accepted {
            require!(
                settlement_closed || unlocked,
                "the agent is paid after the unlock delay"
            );
            return self.pay_agent(tank, series);
        }
        require!(
            settlement_closed || unlocked,
            "call request_unlock and wait for the unlock delay"
        );
        let units = tank.balance.0;
        tank.balance.0 = 0;
        tank.closed = true;
        series.in_tanks.0 -= units;
        self.series.insert(series.id, series.clone());
        self.credit(&tank.owner, series.id, units);
        events::mt_transfer(
            &env::current_account_id(),
            &tank.owner,
            series.id,
            units,
            Some("tank withdraw"),
        );
        events::barrel("withdraw", json!({ "tank_id": tank_id, "units": U128(units) }));
        self.tanks.insert(tank_id, tank);
        PromiseOrValue::Value(U128(units))
    }

    /// If the agent's USDC transfer failed (for example the agent is not
    /// registered with the token), the tank is put back as it was so the
    /// payout can be retried with `withdraw`.
    #[private]
    pub fn on_agent_paid(&mut self, tank_id: u64, units: U128, amount: U128) -> U128 {
        if is_promise_success() {
            return amount;
        }
        let mut tank = self.tank(tank_id);
        let mut series = self.series.get(&tank.series_id).cloned().unwrap();
        series.refunded.0 -= units.0;
        series.refund_paid.0 -= amount.0;
        series.in_tanks.0 += units.0;
        self.total_escrow += amount.0;
        tank.balance.0 = units.0;
        tank.closed = false;
        let series_id = series.id;
        self.series.insert(series_id, series);
        events::mt_mint(&env::current_account_id(), series_id, units.0);
        events::barrel(
            "agent_payout_failed",
            json!({ "tank_id": tank_id, "agent": &tank.agent, "units": units }),
        );
        self.tanks.insert(tank_id, tank);
        U128(0)
    }

    pub fn get_tank(&self, tank_id: u64) -> Option<Tank> {
        self.tanks.get(&tank_id).cloned()
    }

    pub fn get_tanks_for(&self, owner: AccountId) -> Vec<Tank> {
        self.tanks_by_owner
            .get(&owner)
            .map(|ids| ids.iter().filter_map(|id| self.tanks.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    /// The text a tank key must sign for a given request. Lets a client
    /// confirm it is building acks the way this contract expects.
    pub fn ack_text_for(
        &self,
        tank_id: u64,
        seq: u64,
        request_hash: String,
        response_hash: String,
        units: U128,
    ) -> String {
        ack_text(
            env::current_account_id().as_str(),
            tank_id,
            seq,
            &request_hash,
            &response_hash,
            units.0,
        )
    }

    /// Most recent settlements first.
    pub fn get_recent_settlements(&self, limit: Option<u32>) -> Vec<SettleRecord> {
        let stored = self.recent.len() as u64;
        let take = (limit.unwrap_or(20) as u64).min(stored);
        (0..take)
            .filter_map(|i| {
                let n = self.recent_count - 1 - i;
                self.recent.get((n % RECENT_CAP as u64) as u32).cloned()
            })
            .collect()
    }

    pub fn get_settlement_count(&self) -> u64 {
        self.recent_count
    }
}

impl Contract {
    /// Burns an accepted tank's leftover and sends the USDC that backed it to
    /// the agent. Counted with refunds: units burned for their USDC outside
    /// settlement, with the same cumulative rounding so the books still close.
    fn pay_agent(&mut self, mut tank: Tank, mut series: crate::Series) -> PromiseOrValue<U128> {
        let agent = tank.agent.clone().unwrap();
        let tank_id = tank.id;
        let series_id = series.id;
        let units = tank.balance.0;
        let price = series.price_per_barrel.0;
        let before = usdc_floor(series.refunded.0, price);
        series.refunded.0 += units;
        series.in_tanks.0 -= units;
        let amount = usdc_floor(series.refunded.0, price) - before;
        series.refund_paid.0 += amount;
        tank.balance.0 = 0;
        tank.closed = true;
        self.series.insert(series_id, series);
        self.tanks.insert(tank_id, tank);
        if units > 0 {
            events::mt_burn(&env::current_account_id(), series_id, units, "job leftover paid to the agent");
        }
        events::barrel(
            "agent_paid",
            json!({ "tank_id": tank_id, "agent": &agent, "units": U128(units), "usdc": U128(amount) }),
        );
        if amount == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        PromiseOrValue::Promise(
            self.send_usdc(&agent, amount).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_agent_paid(tank_id, U128(units), U128(amount)),
            ),
        )
    }

    fn tank(&self, tank_id: u64) -> Tank {
        self.tanks
            .get(&tank_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown tank"))
    }

    fn move_into_tank(&mut self, owner: &AccountId, series_id: u64, units: u128) {
        require!(units > 0, "zero units");
        let mut series = self
            .series
            .get(&series_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown series"));
        require!(now_sec() < series.window_end, "series expired");
        self.debit(owner, series_id, units);
        series.in_tanks.0 += units;
        self.series.insert(series_id, series);
        events::mt_transfer(owner, &env::current_account_id(), series_id, units, Some("tank fill"));
    }

    fn remember(&mut self, record: SettleRecord) {
        let slot = (self.recent_count % RECENT_CAP as u64) as u32;
        if slot < self.recent.len() {
            self.recent.set(slot, record);
        } else {
            self.recent.push(record);
        }
        self.recent_count += 1;
    }
}
