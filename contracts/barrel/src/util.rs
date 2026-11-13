//! Chain-dependent helpers. The pure rules live in the `barrel-core` crate.

pub use barrel_core::*;
use near_sdk::env;

pub fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// Ed25519 verification through the NEAR host function.
pub fn verify_ed25519(sig_hex: &str, message: &[u8], key_hex: &str) -> bool {
    let (Some(sig), Some(key)) = (decode_fixed::<64>(sig_hex), decode_fixed::<32>(key_hex)) else {
        return false;
    };
    env::ed25519_verify(&sig, message, &key)
}
