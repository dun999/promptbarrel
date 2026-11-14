//! The rules of Barrel that do not need a blockchain: hex handling, the two
//! signed texts, and the escrow arithmetic. Kept free of chain dependencies
//! so it can be tested natively and reused off-chain.

/// One Barrel is this many units of inference.
pub const UNITS_PER_BARREL: u128 = 1_000_000;

/// A SHA-256 digest exactly as NEAR AI Cloud writes it in signed text: 64 lowercase hex chars.
pub fn is_hash_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn decode_fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    hex::decode_to_slice(s, &mut out).ok()?;
    Some(out)
}

/// Lowercase hex of a 32-byte Ed25519 public key, or None if it is not one.
pub fn normalize_key(s: &str) -> Option<String> {
    decode_fixed::<32>(s).map(hex::encode)
}

/// The text a NEAR AI Cloud model TEE signs for a non-streamed completion:
/// `<MODEL_ID>:<request_hash>:<response_hash>`.
/// A gateway signature covers only `<request_hash>:<response_hash>` under a
/// different key, so it can never verify against this text.
pub fn receipt_text(model_id: &str, request_hash: &str, response_hash: &str) -> String {
    format!("{model_id}:{request_hash}:{response_hash}")
}

/// The text a tank key signs after the payer's SDK has verified the receipt.
/// The contract account is included so an ack cannot be replayed on another
/// deployment or network.
pub fn ack_text(
    contract: &str,
    tank_id: u64,
    seq: u64,
    request_hash: &str,
    response_hash: &str,
    units: u128,
) -> String {
    format!("barrel:v1:ack:{contract}:{tank_id}:{seq}:{request_hash}:{response_hash}:{units}")
}

/// The text a tank key signs to ask the Pump for one answer. It caps what the
/// request may cost before any tokens are generated. It reaches the chain
/// only when the operator claims an answer the payer did not acknowledge.
pub fn request_auth_text(
    contract: &str,
    tank_id: u64,
    seq: u64,
    request_hash: &str,
    max_units: u128,
) -> String {
    format!("barrel:v1:req:{contract}:{tank_id}:{seq}:{request_hash}:{max_units}")
}

/// The text a tank key signs to hand a tank it owns to a NEAR account.
/// Only tanks opened by a purchase for the key itself can be assigned.
pub fn assign_text(contract: &str, tank_id: u64, new_owner: &str) -> String {
    format!("barrel:v1:assign:{contract}:{tank_id}:{new_owner}")
}

/// Units charged for one answer:
/// completion_tokens + ceil(prompt_tokens x input_weight_bps / 10,000).
pub fn units_charged(prompt_tokens: u64, completion_tokens: u64, input_weight_bps: u32) -> u128 {
    let weighted = (prompt_tokens as u128 * input_weight_bps as u128).div_ceil(10_000);
    completion_tokens as u128 + weighted
}

/// The most units a request can cost, known before it is sent: every request
/// byte is at most one prompt token, and the answer is capped by `max_tokens`.
pub fn worst_case_units(request_bytes: u64, max_tokens: u64, input_weight_bps: u32) -> u128 {
    units_charged(request_bytes, max_tokens, input_weight_bps)
}

/// USDC owed for `units` at `price` per Barrel, rounded down.
/// Payouts and refunds are always computed as the difference of two of these
/// cumulative values, so rounding never accumulates.
pub fn usdc_floor(units: u128, price: u128) -> u128 {
    units
        .checked_mul(price)
        .expect("overflow")
        / UNITS_PER_BARREL
}

/// USDC a buyer must pay for `units`, rounded up, so escrow always covers
/// every unit that was minted.
pub fn usdc_ceil(units: u128, price: u128) -> u128 {
    let n = units.checked_mul(price).expect("overflow");
    n.div_ceil(UNITS_PER_BARREL)
}

/// Units that `amount` USDC buys at `price` per Barrel, rounded down.
pub fn units_for(amount: u128, price: u128) -> u128 {
    amount
        .checked_mul(UNITS_PER_BARREL)
        .expect("overflow")
        / price
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_hex_is_strict() {
        let h = "a".repeat(64);
        assert!(is_hash_hex(&h));
        assert!(!is_hash_hex(&"A".repeat(64)));
        assert!(!is_hash_hex(&"a".repeat(63)));
        assert!(!is_hash_hex(&format!("{}:", "a".repeat(63))));
    }

    #[test]
    fn texts_have_the_expected_shape() {
        let (rq, rs) = ("1".repeat(64), "2".repeat(64));
        assert_eq!(
            receipt_text("Qwen/Qwen3.8-27B", &rq, &rs),
            format!("Qwen/Qwen3.8-27B:{rq}:{rs}")
        );
        assert_eq!(
            ack_text("barrel.testnet", 7, 3, &rq, &rs, 1200),
            format!("barrel:v1:ack:barrel.testnet:7:3:{rq}:{rs}:1200")
        );
    }

    #[test]
    fn units_follow_the_published_formula() {
        // 1,000 prompt tokens at 16% weight = 160 units, plus 50 completion.
        assert_eq!(units_charged(1_000, 50, 1_600), 210);
        // The prompt share rounds up.
        assert_eq!(units_charged(1, 0, 1_600), 1);
        assert_eq!(units_charged(0, 7, 1_600), 7);
        assert_eq!(worst_case_units(300, 512, 10_000), 812);
        let rq = "1".repeat(64);
        assert_eq!(
            request_auth_text("barrel.testnet", 7, 3, &rq, 900),
            format!("barrel:v1:req:barrel.testnet:7:3:{rq}:900")
        );
        assert_eq!(
            assign_text("barrel.testnet", 7, "alice.testnet"),
            "barrel:v1:assign:barrel.testnet:7:alice.testnet"
        );
    }

    #[test]
    fn escrow_always_covers_minted_units() {
        // Odd prices and tiny purchases: what buyers paid in must cover what
        // can ever be paid out to the operator plus refunds.
        for price in [1u128, 3, 299_999, 1_000_000, 1_350_001] {
            let mut escrow = 0u128;
            let mut minted = 0u128;
            for amount in [1u128, 2, 7, 999, 1_000_000, 123_456_789] {
                let units = units_for(amount, price);
                let cost = usdc_ceil(units, price);
                assert!(cost <= amount, "buyer never pays more than sent");
                escrow += cost;
                minted += units;
            }
            for burned in [0, minted / 3, minted] {
                let refunded = minted - burned;
                let out = usdc_floor(burned, price) + usdc_floor(refunded, price);
                assert!(out <= escrow, "price {price}: paid out {out} > escrow {escrow}");
            }
        }
    }

    #[test]
    fn cumulative_payouts_do_not_lose_dust() {
        // 1,000 settlements of 1 unit at a price below 1 base unit per unit.
        let price = 300_000u128; // 0.30 USDC per Barrel = 0.3 base units per unit
        let mut burned = 0u128;
        let mut paid = 0u128;
        for _ in 0..1000 {
            let before = usdc_floor(burned, price);
            burned += 1;
            paid += usdc_floor(burned, price) - before;
        }
        assert_eq!(paid, usdc_floor(1000, price));
        assert_eq!(paid, 300);
    }

    #[test]
    fn key_normalization() {
        let k = "89154A43A47684742C3D1753252BB6F49F61DA9D8C84FC9B1DEF2DF130CB2D93";
        assert_eq!(normalize_key(k).unwrap(), k.to_lowercase());
        assert_eq!(normalize_key(&format!("0x{k}")).unwrap(), k.to_lowercase());
        assert!(normalize_key("abcd").is_none());
    }
}
