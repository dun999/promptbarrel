//! Barrel's attestor: registers a model TEE's signing key after verifying
//! its attestation on-chain. Anyone can call it. Nobody's permission is
//! needed, and nobody, the owner included, can register a key without a
//! passing attestation.
//!
//!   1. `request_nonce()`  The contract issues a nonce from the block's
//!      random seed. A quote that carries it was made after this block.
//!   2. Off-chain, anyone asks the TEE cloud for an attestation report with
//!      that nonce. No API key is needed for that.
//!   3. `register(...)`    The contract verifies Intel's signature chain over
//!      the quote, the TCB level, that the quote names the signing key and
//!      the nonce, that the measured software is a compose file on the
//!      grade's reviewed list, and that the event log is the one the
//!      hardware measured. Then it calls `barrel.add_key`.
//!
//! What stays on trust is the reviewed list: which compose files count as
//! "serves this model as named". Adding to it waits out a public timelock;
//! removing from it is immediate.

use attest_core::{verify_evidence, Event, QuoteCollateralV3};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

const GAS_ADD_KEY: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Compose,
    Pending,
    Nonces,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Config {
    pub owner: AccountId,
    /// The Barrel contract keys are registered with.
    pub barrel: AccountId,
    /// Seconds an addition to a reviewed list, or an owner change, waits.
    pub timelock_sec: u64,
    /// Seconds a nonce stays usable.
    pub nonce_ttl_sec: u64,
    /// Intel TCB statuses a machine may have.
    pub accepted_tcb: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Pending {
    pub kind: String,
    pub value: String,
    pub ready_at: u64,
}

#[near(serializers = [json])]
pub struct CheckResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub compose_hash: Option<String>,
    pub tcb_status: Option<String>,
    pub advisory_ids: Vec<String>,
    pub on_reviewed_list: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Attestor {
    config: Config,
    /// Reviewed compose hashes per grade.
    compose: LookupMap<String, Vec<String>>,
    pending: LookupMap<String, Pending>,
    /// Nonce (hex) to the time it was issued.
    nonces: LookupMap<String, u64>,
    issued: u64,
}

fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "barrel-attestor", "version": "1.0.0", "event": event, "data": data })
    ));
}

fn fixed32(hex_text: &str, what: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_text, &mut out)
        .unwrap_or_else(|_| env::panic_str(&format!("{what} must be 64 hex characters")));
    out
}

#[near]
impl Attestor {
    /// `compose` is the reviewed list each grade starts with: pairs of a
    /// grade id and its compose hashes, public in this transaction. Every
    /// later addition waits out the timelock.
    #[init]
    pub fn new(config: Config, compose: Option<Vec<(String, Vec<String>)>>) -> Self {
        let mut lists = LookupMap::new(StorageKey::Compose);
        for (grade_id, hashes) in compose.unwrap_or_default() {
            for h in &hashes {
                require!(
                    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                    "a compose hash is 64 lowercase hex characters"
                );
            }
            lists.insert(grade_id, hashes);
        }
        Self {
            config,
            compose: lists,
            pending: LookupMap::new(StorageKey::Pending),
            nonces: LookupMap::new(StorageKey::Nonces),
            issued: 0,
        }
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    /// Issues a nonce. The caller reads it from the transaction result.
    pub fn request_nonce(&mut self) -> String {
        self.issued += 1;
        let mut seed = env::random_seed();
        seed.extend_from_slice(&self.issued.to_le_bytes());
        seed.extend_from_slice(env::predecessor_account_id().as_bytes());
        let nonce = hex::encode(env::sha256(&seed));
        self.nonces.insert(nonce.clone(), now_sec());
        emit("nonce", json!({ "nonce": &nonce }));
        nonce
    }

    /// Verifies one attestation and registers its signing key for the grade.
    /// `quote` is the Intel quote in hex. `collateral` is Intel's public
    /// verification data for it (certificates, revocation lists, TCB levels),
    /// each part signed by Intel and checked here. `app_compose` and
    /// `event_log` come from the same report.
    #[allow(clippy::too_many_arguments)]
    pub fn register(
        &mut self,
        grade_id: String,
        signing_key: String,
        nonce: String,
        quote: String,
        collateral: QuoteCollateralV3,
        app_compose: String,
        event_log: Vec<Event>,
    ) -> Promise {
        let now = now_sec();
        // A report can carry several TEE instances under one nonce, so the
        // nonce stays usable until it expires. Replaying a registration
        // inside that time only renews the same key.
        let issued_at = self
            .nonces
            .get(&nonce)
            .copied()
            .unwrap_or_else(|| env::panic_str("unknown nonce: call request_nonce first"));
        require!(
            now <= issued_at + self.config.nonce_ttl_sec,
            "the nonce has expired; request a new one"
        );
        let key = fixed32(&signing_key, "signing_key");
        let nonce_bytes = fixed32(&nonce, "nonce");
        let quote_bytes = hex::decode(&quote).unwrap_or_else(|_| env::panic_str("quote must be hex"));

        let verified = verify_evidence(
            &quote_bytes,
            &collateral,
            &key,
            &nonce_bytes,
            &app_compose,
            &event_log,
            &self.config.accepted_tcb,
            now,
        )
        .unwrap_or_else(|e| env::panic_str(&e));

        let reviewed = self.compose.get(&grade_id).cloned().unwrap_or_default();
        require!(
            reviewed.contains(&verified.compose_hash),
            format!(
                "compose hash {} is not on the reviewed list of grade {}",
                verified.compose_hash, grade_id
            )
        );

        emit(
            "register",
            json!({ "grade_id": &grade_id, "key": hex::encode(key), "compose_hash": &verified.compose_hash,
                    "tcb_status": &verified.tcb_status, "advisory_ids": &verified.advisory_ids,
                    "quote_sha256": &verified.quote_hash, "by": env::predecessor_account_id() }),
        );
        Promise::new(self.config.barrel.clone()).function_call(
            "add_key".to_string(),
            json!({ "grade_id": grade_id, "key": hex::encode(key), "evidence_hash": verified.quote_hash })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_ADD_KEY,
        )
    }

    /// Runs the same checks without registering anything and without a
    /// nonce from this contract: a free view call for auditing any report
    /// against the chain's clock and this contract's policy.
    #[allow(clippy::too_many_arguments)]
    pub fn check(
        &self,
        grade_id: String,
        signing_key: String,
        nonce: String,
        quote: String,
        collateral: QuoteCollateralV3,
        app_compose: String,
        event_log: Vec<Event>,
    ) -> CheckResult {
        let key = fixed32(&signing_key, "signing_key");
        let nonce_bytes = fixed32(&nonce, "nonce");
        let quote_bytes = hex::decode(&quote).unwrap_or_else(|_| env::panic_str("quote must be hex"));
        match verify_evidence(
            &quote_bytes,
            &collateral,
            &key,
            &nonce_bytes,
            &app_compose,
            &event_log,
            &self.config.accepted_tcb,
            now_sec(),
        ) {
            Ok(v) => {
                let reviewed = self
                    .compose
                    .get(&grade_id)
                    .map(|l| l.contains(&v.compose_hash))
                    .unwrap_or(false);
                CheckResult {
                    ok: reviewed,
                    reason: (!reviewed).then(|| "compose hash is not on the grade's reviewed list".to_string()),
                    compose_hash: Some(v.compose_hash),
                    tcb_status: Some(v.tcb_status),
                    advisory_ids: v.advisory_ids,
                    on_reviewed_list: reviewed,
                }
            }
            Err(reason) => CheckResult {
                ok: false,
                reason: Some(reason),
                compose_hash: None,
                tcb_status: None,
                advisory_ids: Vec::new(),
                on_reviewed_list: false,
            },
        }
    }

    /// Reviewed compose hashes of a grade.
    pub fn get_compose(&self, grade_id: String) -> Vec<String> {
        self.compose.get(&grade_id).cloned().unwrap_or_default()
    }

    pub fn get_pending(&self, kind: String) -> Option<Pending> {
        self.pending.get(&kind).cloned()
    }

    /// Announces a change: kind "compose:<grade_id>" with a compose hash, or
    /// kind "owner" with an account. It can be applied after the timelock.
    pub fn propose(&mut self, kind: String, value: String) -> Pending {
        self.assert_owner();
        if kind == "owner" {
            let _: AccountId = value
                .parse()
                .unwrap_or_else(|_| env::panic_str("value is not an account id"));
        } else if kind.starts_with("compose:") {
            require!(
                value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                "value must be a compose hash: 64 lowercase hex characters"
            );
        } else {
            env::panic_str("kind must be owner or compose:<grade_id>");
        }
        let pending = Pending {
            kind: kind.clone(),
            value,
            ready_at: now_sec() + self.config.timelock_sec,
        };
        emit("propose", json!({ "pending": &pending }));
        self.pending.insert(kind, pending.clone());
        pending
    }

    pub fn cancel(&mut self, kind: String) {
        self.assert_owner();
        require!(self.pending.remove(&kind).is_some(), "nothing pending");
    }

    /// Applies a change whose timelock has passed. Anyone can call it.
    pub fn apply(&mut self, kind: String) {
        let pending = self
            .pending
            .remove(&kind)
            .unwrap_or_else(|| env::panic_str("nothing pending"));
        require!(now_sec() >= pending.ready_at, "the timelock has not passed");
        if kind == "owner" {
            self.config.owner = pending.value.parse().unwrap();
        } else {
            let grade_id = kind.trim_start_matches("compose:").to_string();
            let mut list = self.compose.get(&grade_id).cloned().unwrap_or_default();
            if !list.contains(&pending.value) {
                list.push(pending.value.clone());
            }
            self.compose.insert(grade_id, list);
        }
        emit("apply", json!({ "kind": kind, "value": pending.value }));
    }

    /// Takes a compose hash off a grade's list at once. Keys already
    /// registered run out with their lifetime, or the Barrel owner revokes them.
    pub fn remove_compose(&mut self, grade_id: String, compose_hash: String) {
        self.assert_owner();
        let mut list = self.compose.get(&grade_id).cloned().unwrap_or_default();
        list.retain(|h| *h != compose_hash);
        self.compose.insert(grade_id.clone(), list);
        emit("remove_compose", json!({ "grade_id": grade_id, "compose_hash": compose_hash }));
    }
}

impl Attestor {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.config.owner,
            "owner only"
        );
    }
}

#[cfg(target_arch = "wasm32")]
fn no_randomness(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(no_randomness);
