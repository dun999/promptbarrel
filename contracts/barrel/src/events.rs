//! NEP-297 events. Token movements use the NEP-245 event names; everything
//! specific to Barrel uses the `barrel` standard.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};

fn emit(standard: &str, event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": standard, "version": "1.0.0", "event": event, "data": data })
    ));
}

pub fn barrel(event: &str, data: Value) {
    emit("barrel", event, data);
}

pub fn mt_mint(owner: &AccountId, series_id: u64, amount: u128) {
    emit(
        "nep245",
        "mt_mint",
        json!([{ "owner_id": owner, "token_ids": [series_id.to_string()], "amounts": [amount.to_string()] }]),
    );
}

pub fn mt_burn(owner: &AccountId, series_id: u64, amount: u128, memo: &str) {
    emit(
        "nep245",
        "mt_burn",
        json!([{ "owner_id": owner, "token_ids": [series_id.to_string()], "amounts": [amount.to_string()], "memo": memo }]),
    );
}

pub fn mt_transfer(from: &AccountId, to: &AccountId, series_id: u64, amount: u128, memo: Option<&str>) {
    emit(
        "nep245",
        "mt_transfer",
        json!([{
            "old_owner_id": from,
            "new_owner_id": to,
            "token_ids": [series_id.to_string()],
            "amounts": [amount.to_string()],
            "memo": memo,
        }]),
    );
}
