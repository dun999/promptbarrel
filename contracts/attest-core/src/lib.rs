//! The attestation checks, free of chain state so they run in a native test
//! against a real report exactly as they run on-chain.
//!
//! What a passing check proves: an Intel TDX machine at an acceptable patch
//! level booted the measured software described by `app_compose`, and that
//! software holds the private half of `signing_key`. The quote was made after
//! `nonce` existed, so the key is live now, not replayed from an old report.

pub use dcap_qvl::QuoteCollateralV3;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha384};

/// One entry of the TEE's runtime event log.
#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    pub imr: u32,
    pub event_type: u32,
    /// Hex. Boot events carry their digest; runtime events leave it empty.
    pub digest: String,
    pub event: String,
    /// Hex.
    pub event_payload: String,
}

pub struct Verified {
    /// Hex of sha256(app_compose): the identity of the software that booted.
    pub compose_hash: String,
    pub tcb_status: String,
    pub advisory_ids: Vec<String>,
    /// Hex of sha256(quote).
    pub quote_hash: String,
}

/// Replays the runtime event log into RTMR3. A runtime event's digest is
/// sha384(event_type_le || ":" || name || ":" || payload), which is what
/// makes the payloads (the compose hash among them) trustworthy.
pub fn replay_rtmr3(events: &[Event]) -> Result<[u8; 48], String> {
    let mut mr = [0u8; 48];
    for e in events.iter().filter(|e| e.imr == 3) {
        let mut digest = [0u8; 48];
        if e.digest.is_empty() {
            let payload = hex::decode(&e.event_payload).map_err(|_| "event payload is not hex")?;
            let mut h = Sha384::new();
            h.update(e.event_type.to_le_bytes());
            h.update(b":");
            h.update(e.event.as_bytes());
            h.update(b":");
            h.update(&payload);
            digest.copy_from_slice(&h.finalize());
        } else {
            let d = hex::decode(&e.digest).map_err(|_| "event digest is not hex")?;
            let n = d.len().min(48);
            digest[..n].copy_from_slice(&d[..n]);
        }
        let mut h = Sha384::new();
        h.update(mr);
        h.update(digest);
        mr.copy_from_slice(&h.finalize());
    }
    Ok(mr)
}

#[allow(clippy::too_many_arguments)]
pub fn verify_evidence(
    quote: &[u8],
    collateral: &QuoteCollateralV3,
    signing_key: &[u8; 32],
    nonce: &[u8; 32],
    app_compose: &str,
    events: &[Event],
    accepted_tcb: &[String],
    now_sec: u64,
) -> Result<Verified, String> {
    // 1. Intel's signature chain over the quote, checked against Intel's
    //    root certificate, revocation lists and current TCB levels.
    let report = dcap_qvl::verify::rustcrypto::verify(quote, collateral, now_sec)
        .map_err(|e| format!("Intel quote verification failed: {e:#}"))?;
    if !accepted_tcb.iter().any(|s| *s == report.status) {
        return Err(format!("TCB status {} is not accepted", report.status));
    }
    let td = report.report.as_td10().ok_or("not a TDX quote")?;
    if td.td_attributes[0] & 1 != 0 {
        return Err("the TD runs in debug mode".into());
    }

    // 2. The quote names this key and this nonce.
    if td.report_data[..32] != signing_key[..] || td.report_data[32..] != nonce[..] {
        return Err("report data does not bind this signing key and nonce".into());
    }

    // 3. The measured configuration is this compose file.
    let compose_hash: [u8; 32] = Sha256::digest(app_compose.as_bytes()).into();
    let mut expected = [0u8; 48];
    expected[0] = 1;
    expected[1..33].copy_from_slice(&compose_hash);
    if td.mr_config_id != expected {
        return Err("MRCONFIGID does not commit to this compose file".into());
    }

    // 4. The event log is the one the hardware measured, and it loaded the
    //    same compose file.
    if replay_rtmr3(events)? != td.rt_mr3 {
        return Err("event log does not replay to RTMR3".into());
    }
    let compose_hex = hex::encode(compose_hash);
    let measured = events
        .iter()
        .filter(|e| e.imr == 3 && e.event == "compose-hash")
        .map(|e| e.event_payload.as_str())
        .collect::<Vec<_>>();
    if measured != [compose_hex.as_str()] {
        return Err("the measured compose-hash event does not match the compose file".into());
    }

    let quote_hash: [u8; 32] = Sha256::digest(quote).into();
    Ok(Verified {
        compose_hash: compose_hex,
        tcb_status: report.status,
        advisory_ids: report.advisory_ids,
        quote_hash: hex::encode(quote_hash),
    })
}
