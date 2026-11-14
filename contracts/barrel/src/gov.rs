//! Governance. The owner can be a multisig or a DAO account. Everything that
//! could redirect money or replace the code waits out `timelock_sec` first,
//! in public, so holders can leave before a change they do not accept.
//!
//!   propose("owner", <account>)      then apply("owner")
//!   propose("attestor", <account>)   then apply("attestor"); "" clears it
//!   propose("upgrade", <sha256>)     then call `upgrade` with the code as input
//!
//! The guardian can pause and can cancel a pending change. It cannot move
//! money, register keys or unpause.

use crate::util::{is_hash_hex, now_sec};
use crate::{events, near, require, AccountId, Contract, ContractExt};
use near_sdk::env;
use near_sdk::serde_json::json;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Pending {
    pub kind: String,
    pub value: String,
    /// Unix seconds. The change can be applied from this time on.
    pub ready_at: u64,
}

fn parse_account(value: &str) -> AccountId {
    value
        .parse()
        .unwrap_or_else(|_| env::panic_str("value is not an account id"))
}

#[near]
impl Contract {
    /// Announces a change. It replaces an earlier proposal of the same kind
    /// and restarts its clock.
    pub fn propose(&mut self, kind: String, value: String) -> Pending {
        self.assert_owner();
        match kind.as_str() {
            "owner" => {
                parse_account(&value);
            }
            "attestor" => {
                if !value.is_empty() {
                    parse_account(&value);
                }
            }
            "upgrade" => require!(is_hash_hex(&value), "value must be the sha256 of the new code"),
            _ => env::panic_str("kind must be owner, attestor or upgrade"),
        }
        let pending = Pending {
            kind: kind.clone(),
            value,
            ready_at: now_sec() + self.config.timelock_sec,
        };
        events::barrel("propose", json!({ "pending": &pending }));
        self.pending.insert(kind, pending.clone());
        pending
    }

    pub fn cancel(&mut self, kind: String) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.config.owner || Some(&caller) == self.config.guardian.as_ref(),
            "owner or guardian only"
        );
        require!(self.pending.remove(&kind).is_some(), "nothing pending");
        events::barrel("cancel", json!({ "kind": kind, "by": caller }));
    }

    /// Applies an owner or attestor change whose timelock has passed.
    /// Anyone can call it: the change was approved when it was proposed.
    pub fn apply(&mut self, kind: String) {
        let pending = self
            .pending
            .get(&kind)
            .cloned()
            .unwrap_or_else(|| env::panic_str("nothing pending"));
        require!(now_sec() >= pending.ready_at, "the timelock has not passed");
        match kind.as_str() {
            "owner" => self.config.owner = parse_account(&pending.value),
            "attestor" => {
                self.config.attestor = if pending.value.is_empty() {
                    None
                } else {
                    Some(parse_account(&pending.value))
                }
            }
            _ => env::panic_str("an upgrade is applied by calling `upgrade` with the code"),
        }
        self.pending.remove(&kind);
        events::barrel("apply", json!({ "kind": kind, "value": pending.value }));
    }

    pub fn get_pending(&self, kind: String) -> Option<Pending> {
        self.pending.get(&kind).cloned()
    }

    /// The guardian holds a pause switch and nothing else, so naming one
    /// needs no timelock.
    pub fn set_guardian(&mut self, guardian: Option<AccountId>) {
        self.assert_owner();
        events::barrel("set_guardian", json!({ "guardian": &guardian }));
        self.config.guardian = guardian;
    }

    /// The owner gives up registering keys. From then on a key can only come
    /// from the attestor contract's on-chain check. Cannot be undone.
    pub fn renounce_key_registration(&mut self) {
        self.assert_owner();
        require!(
            self.config.attestor.is_some(),
            "set an attestor first, or no key could ever be registered"
        );
        self.config.owner_registers_keys = false;
        events::barrel("renounce_key_registration", json!({}));
    }

    /// Runs once after an upgrade. This version keeps the stored layout.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"))
    }
}

/// Replaces this contract's code. The call's input is the new code, raw.
/// It runs only if `propose("upgrade", sha256(code))` passed its timelock,
/// so anyone may send the transaction: the code was fixed when it was proposed.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn upgrade() {
    use near_sdk::{Gas, NearToken, Promise};
    env::setup_panic_hook();
    let mut contract: Contract =
        env::state_read().unwrap_or_else(|| env::panic_str("no state"));
    let code = env::input().unwrap_or_else(|| env::panic_str("send the new code as the input"));
    let hash = hex::encode(env::sha256(&code));
    let pending = contract
        .pending
        .get("upgrade")
        .cloned()
        .unwrap_or_else(|| env::panic_str("no upgrade is pending"));
    require!(pending.value == hash, "this is not the code that was proposed");
    require!(now_sec() >= pending.ready_at, "the timelock has not passed");
    contract.pending.remove("upgrade");
    contract.pending.flush();
    env::state_write(&contract);
    events::barrel("upgrade", json!({ "code_sha256": hash }));
    Promise::new(env::current_account_id())
        .deploy_contract(code)
        .function_call(
            "migrate".to_string(),
            Vec::new(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(50),
        )
        .as_return()
        .detach();
}
