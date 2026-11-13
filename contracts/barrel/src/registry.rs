//! Grades (which model, how units are counted) and the model TEE keys that
//! are allowed to produce receipts for each grade.
//!
//! v1 trust root: keys are added by the owner after off-chain attestation
//! checks, with the hash of the published evidence bundle stored beside each
//! key so anyone can repeat the checks.

use crate::util::{is_hash_hex, normalize_key, now_sec, receipt_text, verify_ed25519};
use crate::{events, near, require, Contract, ContractExt};
use near_sdk::serde_json::json;

const MAX_KEYS_PER_GRADE: usize = 64;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Grade {
    /// For example `qwen3.8-27b/tdx+nvcc/v1`.
    pub id: String,
    /// Canonical model ID exactly as it appears in the signed text.
    pub model_id: String,
    /// Units charged per prompt token, in basis points of one output token.
    pub input_weight_bps: u32,
    /// How long a key registration lasts.
    pub key_ttl_sec: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct KeyInfo {
    /// Ed25519 public key, lowercase hex.
    pub key: String,
    pub registered_at: u64,
    pub expires_at: u64,
    /// SHA-256 of the published attestation evidence bundle.
    pub evidence_hash: String,
}

#[near(serializers = [json])]
pub struct ReceiptCheck {
    /// The signature verifies and the key is registered for the grade.
    pub valid: bool,
    pub signature_ok: bool,
    pub key_registered: bool,
    /// False once the registration has expired. An expired key still proves
    /// an old receipt, but it can no longer settle.
    pub key_live: bool,
    pub key_expires_at: Option<u64>,
    pub model_id: Option<String>,
    /// The exact text the model TEE must have signed.
    pub text: Option<String>,
    pub reason: Option<String>,
}

#[near]
impl Contract {
    /// Grades are immutable once added.
    pub fn add_grade(&mut self, grade: Grade) {
        self.assert_owner();
        require!(!grade.id.is_empty() && grade.id.len() <= 64, "bad grade id");
        require!(
            !grade.model_id.is_empty() && grade.model_id.len() <= 128 && !grade.model_id.contains(':'),
            "bad model id"
        );
        require!(grade.input_weight_bps <= 10_000, "input weight above 100%");
        require!(grade.key_ttl_sec > 0, "key ttl must be positive");
        require!(self.grades.get(&grade.id).is_none(), "grade exists");
        events::barrel("add_grade", json!({ "grade": &grade }));
        self.grades.insert(grade.id.clone(), grade);
    }

    /// Registers a model TEE signing key for a grade, or renews it.
    /// The expiry is set by the contract from the grade's TTL.
    pub fn add_key(&mut self, grade_id: String, key: String, evidence_hash: String) -> KeyInfo {
        self.assert_owner();
        let grade = self
            .grades
            .get(&grade_id)
            .unwrap_or_else(|| near_sdk::env::panic_str("unknown grade"));
        let key = normalize_key(&key).unwrap_or_else(|| near_sdk::env::panic_str("bad key"));
        require!(is_hash_hex(&evidence_hash), "bad evidence hash");
        let now = now_sec();
        let expires_at = now + grade.key_ttl_sec;
        let mut list = self.keys.get(&grade_id).cloned().unwrap_or_default();
        let info = match list.iter_mut().find(|k| k.key == key) {
            Some(existing) => {
                existing.expires_at = expires_at;
                existing.evidence_hash = evidence_hash;
                existing.clone()
            }
            None => {
                require!(list.len() < MAX_KEYS_PER_GRADE, "too many keys");
                let info = KeyInfo {
                    key,
                    registered_at: now,
                    expires_at,
                    evidence_hash,
                };
                list.push(info.clone());
                info
            }
        };
        self.keys.insert(grade_id.clone(), list);
        events::barrel("add_key", json!({ "grade_id": grade_id, "key": &info }));
        info
    }

    /// Ends a key's registration now. The record stays so old receipts can
    /// still be checked.
    pub fn revoke_key(&mut self, grade_id: String, key: String) {
        self.assert_owner();
        let key = normalize_key(&key).unwrap_or_else(|| near_sdk::env::panic_str("bad key"));
        let mut list = self.keys.get(&grade_id).cloned().unwrap_or_default();
        let entry = list
            .iter_mut()
            .find(|k| k.key == key)
            .unwrap_or_else(|| near_sdk::env::panic_str("unknown key"));
        entry.expires_at = now_sec();
        self.keys.insert(grade_id.clone(), list);
        events::barrel("revoke_key", json!({ "grade_id": grade_id, "key": key }));
    }

    pub fn get_grade(&self, grade_id: String) -> Option<Grade> {
        self.grades.get(&grade_id).cloned()
    }

    pub fn get_grades(&self) -> Vec<Grade> {
        self.grades.values().cloned().collect()
    }

    pub fn get_keys(&self, grade_id: String) -> Vec<KeyInfo> {
        self.keys.get(&grade_id).cloned().unwrap_or_default()
    }

    /// Free view call: checks any receipt against chain state.
    pub fn verify_receipt(
        &self,
        grade_id: String,
        request_hash: String,
        response_hash: String,
        tee_key: String,
        tee_sig: String,
    ) -> ReceiptCheck {
        let fail = |reason: &str| ReceiptCheck {
            valid: false,
            signature_ok: false,
            key_registered: false,
            key_live: false,
            key_expires_at: None,
            model_id: None,
            text: None,
            reason: Some(reason.to_string()),
        };
        let Some(grade) = self.grades.get(&grade_id) else {
            return fail("unknown grade");
        };
        if !is_hash_hex(&request_hash) || !is_hash_hex(&response_hash) {
            return fail("hashes must be 64 lowercase hex characters");
        }
        let Some(key) = normalize_key(&tee_key) else {
            return fail("signing key is not a 32-byte Ed25519 key");
        };
        let text = receipt_text(&grade.model_id, &request_hash, &response_hash);
        let signature_ok = verify_ed25519(&tee_sig, text.as_bytes(), &key);
        let registered = self.find_key(&grade_id, &key);
        let key_registered = registered.is_some();
        let key_live = registered
            .as_ref()
            .map(|k| now_sec() < k.expires_at)
            .unwrap_or(false);
        let reason = if !signature_ok {
            Some("signature does not verify over <model_id>:<request_hash>:<response_hash>".to_string())
        } else if !key_registered {
            Some("signing key is not registered for this grade (a gateway key is never registered)".to_string())
        } else {
            None
        };
        ReceiptCheck {
            valid: signature_ok && key_registered,
            signature_ok,
            key_registered,
            key_live,
            key_expires_at: registered.map(|k| k.expires_at),
            model_id: Some(grade.model_id.clone()),
            text: Some(text),
            reason,
        }
    }
}

impl Contract {
    pub(crate) fn find_key(&self, grade_id: &str, key: &str) -> Option<KeyInfo> {
        self.keys
            .get(grade_id)
            .and_then(|list| list.iter().find(|k| k.key == key).cloned())
    }

    pub(crate) fn key_is_live(&self, grade_id: &str, key: &str, now: u64) -> bool {
        self.find_key(grade_id, key)
            .map(|k| now < k.expires_at)
            .unwrap_or(false)
    }
}
