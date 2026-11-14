//! Firm series: the operator posts a USDC bond and takes on a duty to answer.
//!
//! An ordinary series protects the buyer's money: nothing is paid without
//! proof, and unused Barrels refund at expiry. It does not protect the
//! buyer's time: an operator that goes quiet keeps the money locked until
//! the series ends. A firm series closes that gap.
//!
//!   force_request  A tank owner sends a request through the chain. The
//!                  contract hashes the body itself, so neither side can
//!                  later dispute what was asked or when.
//!   answer_forced  The operator posts the model's answer and signature. The
//!                  contract hashes the answer, checks the signature, reads
//!                  the token counts out of the signed bytes and charges the
//!                  exact units.
//!   slash_forced   No answer by the deadline: the request's worst-case cost
//!                  is paid to the tank owner out of the bond, and it counts
//!                  as a miss.
//!   canary         Anyone asks the operator to prove it is alive. The
//!                  contract writes the request itself with a fresh nonce.
//!   default        After `max_misses` misses the series defaults: refunds
//!                  open at once and every remaining Barrel also takes its
//!                  share of what is left of the bond.
//!
//! A forced request and its answer are public. It is the escape hatch, not
//! the normal path.

use crate::series::Series;
use crate::tank::SettleRecord;
use crate::util::{
    normalize_key, now_sec, receipt_text, units_charged, usdc_ceil, verify_ed25519,
    worst_case_units, UNITS_PER_BARREL,
};
use crate::{events, near, require, AccountId, Contract, ContractExt, GAS_CALLBACK, U128};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, is_promise_success, NearToken, Promise, PromiseOrValue};

const MAX_BODY_BYTES: usize = 4_096;
const MAX_RESPONSE_BYTES: usize = 16_384;
const MAX_MESSAGES: usize = 32;
/// Kept well under what `MAX_RESPONSE_BYTES` holds, so an honest operator
/// is never left with an answer too large to post.
const MAX_TOKENS: u64 = 2_048;
/// Held while a forced request or canary is stored, returned by `clear_forced`.
/// It covers the bytes of the request and of the answer.
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(250);
const MAX_CANARY_FEE: NearToken = NearToken::from_millinear(100);
const CANARY_MAX_TOKENS: u64 = 16;

/// What an operator commits to when it opens a firm series.
#[near(serializers = [json])]
pub struct FirmTerms {
    /// Seconds the operator has to answer a forced request or a canary.
    pub respond_sec: u64,
    /// Misses after which the series defaults.
    pub max_misses: u32,
    /// Least seconds between two canaries.
    pub canary_interval_sec: u64,
    /// yoctoNEAR a canary pays the operator when it is answered.
    pub canary_fee: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Firm {
    /// USDC the operator has at stake right now.
    pub bond: U128,
    pub respond_sec: u64,
    pub max_misses: u32,
    pub canary_interval_sec: u64,
    pub canary_fee: U128,
    pub misses: u32,
    pub answered: u32,
    pub canary_sent: u32,
    pub canary_passed: u32,
    pub last_canary_at: u64,
    /// Forced requests and canaries waiting for an answer.
    pub open: Vec<u64>,
    /// USDC paid to holders for unanswered forced requests.
    pub slashed: U128,
    pub defaulted_at: Option<u64>,
    /// Set at default: USDC of bond each remaining Barrel takes on refund.
    pub comp_per_barrel: U128,
    pub comp_units: U128,
    pub comp_paid: U128,
}

impl Firm {
    pub(crate) fn open(terms: FirmTerms) -> Self {
        require!(
            (60..=86_400).contains(&terms.respond_sec),
            "respond_sec must be between 60 and 86400"
        );
        require!(
            (1..=100).contains(&terms.max_misses),
            "max_misses must be between 1 and 100"
        );
        require!(
            terms.canary_fee.0 <= MAX_CANARY_FEE.as_yoctonear(),
            "canary fee above 0.1 NEAR"
        );
        Firm {
            bond: U128(0),
            respond_sec: terms.respond_sec,
            max_misses: terms.max_misses,
            canary_interval_sec: terms.canary_interval_sec,
            canary_fee: terms.canary_fee,
            misses: 0,
            answered: 0,
            canary_sent: 0,
            canary_passed: 0,
            last_canary_at: 0,
            open: Vec::new(),
            slashed: U128(0),
            defaulted_at: None,
            comp_per_barrel: U128(0),
            comp_units: U128(0),
            comp_paid: U128(0),
        }
    }

    fn comp_at(&self, units: u128) -> u128 {
        units * self.comp_per_barrel.0 / UNITS_PER_BARREL
    }

    /// The bond share of `units` being refunded after a default. Computed as
    /// the difference of two cumulative values so rounding never adds up.
    pub(crate) fn take_comp(&mut self, units: u128) -> u128 {
        let before = self.comp_at(self.comp_units.0);
        self.comp_units.0 += units;
        let comp = (self.comp_at(self.comp_units.0) - before).min(self.bond.0);
        self.bond.0 -= comp;
        self.comp_paid.0 += comp;
        comp
    }

    pub(crate) fn return_comp(&mut self, units: u128, comp: u128) {
        self.comp_units.0 -= units;
        self.bond.0 += comp;
        self.comp_paid.0 -= comp;
    }
}

/// A request sent through the chain: by a tank owner, or by the contract
/// itself as a canary.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Forced {
    pub id: u64,
    pub series_id: u64,
    /// None for a canary.
    pub tank_id: Option<u64>,
    pub by: AccountId,
    /// The exact request bytes the operator must send to the model.
    pub body: String,
    pub request_hash: String,
    /// Units set aside in the tank: the most this request can cost.
    pub reserved: U128,
    /// Canary only: yoctoNEAR paid to the operator on an answer.
    pub fee: U128,
    /// yoctoNEAR held for storage, returned by `clear_forced`.
    pub deposit: U128,
    pub created_at: u64,
    pub deadline: u64,
    /// "open", "answered" or "missed".
    pub status: String,
    pub response: Option<String>,
    pub response_hash: Option<String>,
    pub tee_key: Option<String>,
    pub tee_sig: Option<String>,
    pub units: U128,
}

/// A canary is a `Forced` with no tank. The alias names it in the API.
pub type Canary = Forced;

/// Checks that a forced request is one the operator can always answer, and
/// returns its `max_tokens`. The rules are strict on purpose: a request the
/// model would reject would let a holder slash an honest operator.
fn check_body(body: &str, model_id: &str) -> u64 {
    require!(body.len() <= MAX_BODY_BYTES, "request body above 4096 bytes");
    let v: Value =
        serde_json::from_str(body).unwrap_or_else(|_| env::panic_str("body is not JSON"));
    let o = v
        .as_object()
        .unwrap_or_else(|| env::panic_str("body must be a JSON object"));
    require!(
        o.len() == 3 && o.contains_key("model") && o.contains_key("messages") && o.contains_key("max_tokens"),
        "body must have exactly model, messages and max_tokens"
    );
    require!(
        o["model"].as_str() == Some(model_id),
        "model must be the grade's model id"
    );
    let max_tokens = o["max_tokens"]
        .as_u64()
        .unwrap_or_else(|| env::panic_str("max_tokens must be a whole number"));
    require!(
        (1..=MAX_TOKENS).contains(&max_tokens),
        "max_tokens must be between 1 and 2048"
    );
    let messages = o["messages"]
        .as_array()
        .unwrap_or_else(|| env::panic_str("messages must be a list"));
    require!(
        !messages.is_empty() && messages.len() <= MAX_MESSAGES,
        "between 1 and 32 messages"
    );
    for (i, m) in messages.iter().enumerate() {
        let m = m
            .as_object()
            .unwrap_or_else(|| env::panic_str("each message must be an object"));
        require!(
            m.len() == 2 && m.contains_key("role") && m.contains_key("content"),
            "each message must have exactly role and content"
        );
        let role = m["role"].as_str().unwrap_or("");
        let last = i + 1 == messages.len();
        require!(
            if last { role == "user" } else { matches!(role, "system" | "user" | "assistant") },
            "roles are system, user or assistant, and the last message is from the user"
        );
        require!(
            m["content"].as_str().map(|c| !c.is_empty()).unwrap_or(false),
            "message content must be non-empty text"
        );
    }
    max_tokens
}

/// Token counts from the `usage` field of a signed response body.
fn usage_of(response: &str) -> (u64, u64) {
    let v: Value = serde_json::from_str(response)
        .unwrap_or_else(|_| env::panic_str("response is not JSON"));
    let usage = &v["usage"];
    match (usage["prompt_tokens"].as_u64(), usage["completion_tokens"].as_u64()) {
        (Some(p), Some(c)) => (p, c),
        _ => env::panic_str("response has no usage"),
    }
}

#[near]
impl Contract {
    /// Sends a request through the chain. The caller owns the tank; the
    /// request's worst-case cost is set aside from it until the operator
    /// answers or misses the deadline. Attach 0.25 NEAR, returned by
    /// `clear_forced`.
    #[payable]
    pub fn force_request(&mut self, tank_id: u64, body: String) -> u64 {
        self.assert_live();
        let deposit = env::attached_deposit();
        require!(deposit >= STORAGE_DEPOSIT, "attach 0.25 NEAR; it is returned by clear_forced");
        let mut tank = self.tank(tank_id);
        let caller = env::predecessor_account_id();
        require!(caller == tank.owner, "tank owner only");
        require!(!tank.closed, "tank closed");
        require!(!tank.accepted, "job accepted; the tank is paying out");
        let mut series = self.series.get(&tank.series_id).cloned().unwrap();
        let now = now_sec();
        require!(now < series.window_end, "series expired");
        let grade = self.grades.get(&series.grade_id).unwrap().clone();
        let firm = series
            .firm
            .as_mut()
            .unwrap_or_else(|| env::panic_str("not a firm series"));
        require!(firm.defaulted_at.is_none(), "series defaulted");

        let max_tokens = check_body(&body, &grade.model_id);
        let reserved = worst_case_units(body.len() as u64, max_tokens, grade.input_weight_bps);
        require!(reserved <= tank.balance.0, "the tank cannot cover this request's worst case");
        tank.balance.0 -= reserved;
        tank.reserved.0 += reserved;

        let id = self.next_forced_id;
        self.next_forced_id += 1;
        firm.open.push(id);
        let forced = Forced {
            id,
            series_id: series.id,
            tank_id: Some(tank_id),
            by: caller,
            request_hash: hex::encode(env::sha256(body.as_bytes())),
            body,
            reserved: U128(reserved),
            fee: U128(0),
            deposit: U128(deposit.as_yoctonear()),
            created_at: now,
            deadline: now + firm.respond_sec,
            status: "open".to_string(),
            response: None,
            response_hash: None,
            tee_key: None,
            tee_sig: None,
            units: U128(0),
        };
        events::barrel(
            "force_request",
            json!({ "id": id, "series_id": series.id, "tank_id": tank_id,
                    "request_hash": &forced.request_hash, "reserved": forced.reserved,
                    "deadline": forced.deadline }),
        );
        self.series.insert(series.id, series);
        self.tanks.insert(tank_id, tank);
        self.forced.insert(id, forced);
        id
    }

    /// Asks the operator of a firm series to prove it is serving. The
    /// contract writes the request itself, with a nonce from the block's
    /// random seed, so the operator cannot have the answer ready. Attach
    /// 0.25 NEAR (returned by `clear_forced`) plus the series' canary fee.
    #[payable]
    pub fn canary(&mut self, series_id: u64) -> u64 {
        self.assert_live();
        let mut series = self
            .series
            .get(&series_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown series"));
        let now = now_sec();
        require!(now < series.window_end, "series expired");
        let model_id = self.grades.get(&series.grade_id).unwrap().model_id.clone();
        let firm = series
            .firm
            .as_mut()
            .unwrap_or_else(|| env::panic_str("not a firm series"));
        require!(firm.defaulted_at.is_none(), "series defaulted");
        require!(
            now >= firm.last_canary_at + firm.canary_interval_sec,
            "a canary was sent too recently"
        );
        let attached = env::attached_deposit().as_yoctonear();
        let fee = firm.canary_fee.0;
        require!(
            attached >= STORAGE_DEPOSIT.as_yoctonear() + fee,
            "attach 0.25 NEAR plus the canary fee"
        );

        let id = self.next_forced_id;
        self.next_forced_id += 1;
        let nonce = hex::encode(&env::random_seed()[..8]);
        let body = json!({
            "model": model_id,
            "messages": [{ "role": "user", "content": format!("Barrel canary {id}-{nonce}. Reply with the word ok.") }],
            "max_tokens": CANARY_MAX_TOKENS,
        })
        .to_string();
        firm.open.push(id);
        firm.canary_sent += 1;
        firm.last_canary_at = now;
        let forced = Forced {
            id,
            series_id,
            tank_id: None,
            by: env::predecessor_account_id(),
            request_hash: hex::encode(env::sha256(body.as_bytes())),
            body,
            reserved: U128(0),
            fee: U128(fee),
            deposit: U128(attached - fee),
            created_at: now,
            deadline: now + firm.respond_sec,
            status: "open".to_string(),
            response: None,
            response_hash: None,
            tee_key: None,
            tee_sig: None,
            units: U128(0),
        };
        events::barrel(
            "canary",
            json!({ "id": id, "series_id": series_id, "request_hash": &forced.request_hash,
                    "deadline": forced.deadline }),
        );
        self.series.insert(series_id, series);
        self.forced.insert(id, forced);
        id
    }

    /// The operator answers a forced request or a canary with the model's
    /// exact response bytes and its signature. Anyone holding them may post
    /// them; the money goes to the operator either way.
    pub fn answer_forced(&mut self, id: u64, response: String, tee_key: String, tee_sig: String) -> U128 {
        let mut forced = self.forced_open(id);
        require!(response.len() <= MAX_RESPONSE_BYTES, "response above 16384 bytes");
        let mut series = self.series.get(&forced.series_id).cloned().unwrap();
        let grade = self.grades.get(&series.grade_id).unwrap().clone();
        let now = now_sec();

        let response_hash = hex::encode(env::sha256(response.as_bytes()));
        let tee_key = normalize_key(&tee_key).unwrap_or_else(|| env::panic_str("bad model key"));
        require!(
            self.key_is_live(&series.grade_id, &tee_key, now),
            "signing key is not a live registered model key for this grade"
        );
        let text = receipt_text(&grade.model_id, &forced.request_hash, &response_hash);
        require!(
            verify_ed25519(&tee_sig, text.as_bytes(), &tee_key),
            "model signature does not verify"
        );
        let (prompt_tokens, completion_tokens) = usage_of(&response);

        let firm = series.firm.as_mut().unwrap();
        firm.open.retain(|x| *x != id);
        firm.answered += 1;
        let mut units = 0;
        match forced.tank_id {
            Some(tank_id) => {
                let mut tank = self.tank(tank_id);
                units = units_charged(prompt_tokens, completion_tokens, grade.input_weight_bps)
                    .min(forced.reserved.0);
                tank.reserved.0 -= forced.reserved.0;
                tank.balance.0 += forced.reserved.0 - units;
                tank.spent.0 += units;
                self.tanks.insert(tank_id, tank);
                let record = SettleRecord {
                    tank_id,
                    series_id: series.id,
                    seq: id,
                    units: U128(units),
                    request_hash: forced.request_hash.clone(),
                    response_hash: response_hash.clone(),
                    tee_key: tee_key.clone(),
                    tee_sig: tee_sig.clone(),
                    at: now,
                    kind: "forced".to_string(),
                };
                events::barrel("settle", json!({ "record": &record }));
                self.remember(record);
                self.burn_delivered(series, units, 1);
            }
            None => {
                firm.canary_passed += 1;
                let operator = series.operator.clone();
                self.series.insert(series.id, series);
                if forced.fee.0 > 0 {
                    Promise::new(operator)
                        .transfer(NearToken::from_yoctonear(forced.fee.0))
                        .detach();
                }
            }
        }
        forced.status = "answered".to_string();
        forced.response = Some(response);
        forced.response_hash = Some(response_hash);
        forced.tee_key = Some(tee_key);
        forced.tee_sig = Some(tee_sig);
        forced.units = U128(units);
        events::barrel(
            "answer_forced",
            json!({ "id": id, "series_id": forced.series_id, "units": forced.units,
                    "response_hash": &forced.response_hash }),
        );
        self.forced.insert(id, forced);
        U128(units)
    }

    /// Records a miss once the deadline has passed with no answer. On a
    /// forced request the units go back to the tank and its worst-case cost
    /// is paid to the tank owner from the bond. A canary returns its fee.
    /// Anyone can call it. Returns the USDC slashed.
    pub fn slash_forced(&mut self, id: u64) -> PromiseOrValue<U128> {
        let mut forced = self.forced_open(id);
        let now = now_sec();
        require!(now > forced.deadline, "the operator still has time to answer");
        let mut series = self.series.get(&forced.series_id).cloned().unwrap();
        let price = series.price_per_barrel.0;
        let outstanding = series.outstanding();
        let firm = series.firm.as_mut().unwrap();
        firm.open.retain(|x| *x != id);
        firm.misses += 1;

        let mut payout: Option<(AccountId, u128)> = None;
        match forced.tank_id {
            Some(tank_id) => {
                let mut tank = self.tank(tank_id);
                tank.reserved.0 -= forced.reserved.0;
                tank.balance.0 += forced.reserved.0;
                // After a default the bond belongs to every holder alike.
                if firm.defaulted_at.is_none() {
                    let amount = usdc_ceil(forced.reserved.0, price).min(firm.bond.0);
                    if amount > 0 {
                        firm.bond.0 -= amount;
                        firm.slashed.0 += amount;
                        payout = Some((tank.owner.clone(), amount));
                    }
                }
                self.tanks.insert(tank_id, tank);
            }
            None => {
                if forced.fee.0 > 0 {
                    Promise::new(forced.by.clone())
                        .transfer(NearToken::from_yoctonear(forced.fee.0))
                        .detach();
                }
            }
        }

        if firm.defaulted_at.is_none() && firm.misses >= firm.max_misses {
            firm.defaulted_at = Some(now);
            if outstanding > 0 {
                firm.comp_per_barrel = U128(firm.bond.0 * UNITS_PER_BARREL / outstanding);
            }
            events::barrel(
                "default",
                json!({ "series_id": forced.series_id, "misses": firm.misses,
                        "bond": firm.bond, "bond_per_barrel": firm.comp_per_barrel }),
            );
        }
        forced.status = "missed".to_string();
        let slashed = payout.as_ref().map(|p| p.1).unwrap_or(0);
        events::barrel(
            "slash_forced",
            json!({ "id": id, "series_id": forced.series_id, "usdc": U128(slashed),
                    "misses": firm.misses }),
        );
        self.series.insert(forced.series_id, series);
        self.forced.insert(id, forced);

        match payout {
            Some((to, amount)) => {
                self.total_bond -= amount;
                PromiseOrValue::Promise(
                    self.transfer_usdc(&to, amount).then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_CALLBACK)
                            .on_owed_paid(to, U128(amount)),
                    ),
                )
            }
            None => PromiseOrValue::Value(U128(0)),
        }
    }

    /// Deletes a resolved forced request or canary and returns its storage
    /// deposit to whoever sent it.
    pub fn clear_forced(&mut self, id: u64) -> Promise {
        let forced = self
            .forced
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown forced request"));
        require!(env::predecessor_account_id() == forced.by, "only its sender can clear it");
        require!(forced.status != "open", "still open");
        self.forced.remove(&id);
        Promise::new(forced.by).transfer(NearToken::from_yoctonear(forced.deposit.0))
    }

    /// Returns the bond to the operator: after settlement closes on a series
    /// that kept its word, or on a defaulted series once no Barrel is left.
    pub fn withdraw_bond(&mut self, series_id: u64) -> Promise {
        let mut series = self
            .series
            .get(&series_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown series"));
        require!(
            env::predecessor_account_id() == series.operator,
            "series operator only"
        );
        let closed = now_sec() >= series.window_end + self.config.settle_grace_sec;
        let outstanding = series.outstanding();
        let firm = series
            .firm
            .as_mut()
            .unwrap_or_else(|| env::panic_str("not a firm series"));
        require!(firm.open.is_empty(), "forced requests are still open");
        if firm.defaulted_at.is_some() {
            require!(outstanding == 0, "the bond of a defaulted series belongs to its holders");
        } else {
            require!(closed, "the bond is held until settlement closes");
        }
        let amount = firm.bond.0;
        require!(amount > 0, "no bond");
        firm.bond.0 = 0;
        let operator = series.operator.clone();
        self.series.insert(series_id, series);
        self.total_bond -= amount;
        events::barrel("withdraw_bond", json!({ "series_id": series_id, "usdc": U128(amount) }));
        self.transfer_usdc(&operator, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_bond_returned(series_id, U128(amount)),
        )
    }

    #[private]
    pub fn on_bond_returned(&mut self, series_id: u64, amount: U128) -> U128 {
        if is_promise_success() {
            return amount;
        }
        let mut series = self.series.get(&series_id).cloned().unwrap();
        if let Some(firm) = series.firm.as_mut() {
            firm.bond.0 += amount.0;
        }
        self.series.insert(series_id, series);
        self.total_bond += amount.0;
        U128(0)
    }

    pub fn get_forced(&self, id: u64) -> Option<Forced> {
        self.forced.get(&id).cloned()
    }

    /// Forced requests and canaries a series' operator still has to answer.
    pub fn get_open_forced(&self, series_id: u64) -> Vec<Forced> {
        self.series
            .get(&series_id)
            .and_then(|s| s.firm.as_ref())
            .map(|f| f.open.iter().filter_map(|id| self.forced.get(id).cloned()).collect())
            .unwrap_or_default()
    }
}

impl Contract {
    fn forced_open(&self, id: u64) -> Forced {
        let forced = self
            .forced
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown forced request"));
        require!(forced.status == "open", "already resolved");
        forced
    }

    /// An operator adds to the bond of its firm series:
    /// `usdc.ft_transfer_call(barrel, amount, msg = {"bond_series": N})`.
    pub(crate) fn add_bond(&mut self, series_id: u64, sender: &AccountId, amount: u128) {
        let mut series: Series = self
            .series
            .get(&series_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown series"));
        require!(*sender == series.operator, "only the operator posts a bond");
        require!(now_sec() < series.window_end, "series expired");
        let firm = series
            .firm
            .as_mut()
            .unwrap_or_else(|| env::panic_str("not a firm series"));
        require!(firm.defaulted_at.is_none(), "series defaulted");
        firm.bond.0 += amount;
        self.total_bond += amount;
        events::barrel(
            "bond",
            json!({ "series_id": series_id, "usdc": U128(amount), "bond": firm.bond }),
        );
        self.series.insert(series_id, series);
    }
}
