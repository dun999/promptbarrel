//! Runs the on-chain checks natively against a real NEAR AI Cloud report.

use attest_core::{verify_evidence, Event, QuoteCollateralV3};
use serde_json::{json, Value};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/attestations");

struct Fixture {
    quote: Vec<u8>,
    collateral: QuoteCollateralV3,
    key: [u8; 32],
    nonce: [u8; 32],
    app_compose: String,
    events: Vec<Event>,
    now: u64,
}

fn hex_of(bytes: &Value) -> Value {
    let b: Vec<u8> = bytes.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
    json!(hex::encode(b))
}

fn nested(v: &Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(s).unwrap(),
        other => other.clone(),
    }
}

fn load(name: &str) -> Fixture {
    let read = |ext: &str| std::fs::read_to_string(format!("{DIR}/{name}.{ext}")).unwrap();
    let report: Value = serde_json::from_str(&read("json")).unwrap();
    let c = &report["model_attestations"][0];
    let saved: Value = serde_json::from_str(&read("collateral.json")).unwrap();
    let mut col = saved["collateral"].clone();
    for field in ["root_ca_crl", "pck_crl", "tcb_info_signature", "qe_identity_signature"] {
        col[field] = hex_of(&col[field]);
    }
    let tcb = nested(&c["info"]["tcb_info"]);
    let events: Vec<Event> = serde_json::from_value(nested(&c["event_log"])).unwrap();
    let fixed = |s: &str| -> [u8; 32] { hex::decode(s).unwrap().try_into().unwrap() };
    Fixture {
        quote: hex::decode(c["intel_quote"].as_str().unwrap()).unwrap(),
        collateral: serde_json::from_value(col).unwrap(),
        key: fixed(c["signing_address"].as_str().unwrap()),
        nonce: fixed(read("nonce").trim()),
        app_compose: tcb["app_compose"].as_str().unwrap().to_string(),
        events,
        now: saved["fetched_at"].as_u64().unwrap(),
    }
}

fn accepted() -> Vec<String> {
    ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[test]
fn a_real_report_passes_every_check() {
    for name in ["z-ai-glm-5.3-flash.2026-11-13", "qwen3.8-27b.2026-11-12"] {
        let f = load(name);
        let v = verify_evidence(&f.quote, &f.collateral, &f.key, &f.nonce, &f.app_compose, &f.events, &accepted(), f.now)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        println!("{name}: compose {} tcb {} advisories {:?}", v.compose_hash, v.tcb_status, v.advisory_ids);
    }
}

#[test]
fn every_lie_is_caught() {
    let f = load("z-ai-glm-5.3-flash.2026-11-13");
    let run = |key: &[u8; 32], nonce: &[u8; 32], compose: &str, events: &[Event], tcb: &[String], now: u64, quote: &[u8]| {
        verify_evidence(quote, &f.collateral, key, nonce, compose, events, tcb, now).err()
    };
    let mut other = f.key;
    other[0] ^= 1;
    // Another key, another nonce: the quote does not name them.
    assert!(run(&other, &f.nonce, &f.app_compose, &f.events, &accepted(), f.now, &f.quote).unwrap().contains("report data"));
    assert!(run(&f.key, &other, &f.app_compose, &f.events, &accepted(), f.now, &f.quote).unwrap().contains("report data"));
    // A different compose file.
    let edited = f.app_compose.replacen("a", "b", 1);
    assert!(run(&f.key, &f.nonce, &edited, &f.events, &accepted(), f.now, &f.quote).unwrap().contains("MRCONFIGID"));
    // An event log with one event dropped.
    let mut fewer = f.events.clone();
    fewer.pop();
    assert!(run(&f.key, &f.nonce, &f.app_compose, &fewer, &accepted(), f.now, &f.quote).unwrap().contains("RTMR3"));
    // A stricter TCB policy than the machine meets, or none.
    assert!(run(&f.key, &f.nonce, &f.app_compose, &f.events, &[], f.now, &f.quote).unwrap().contains("TCB status"));
    // Collateral that has expired by then.
    assert!(run(&f.key, &f.nonce, &f.app_compose, &f.events, &accepted(), f.now + 400 * 86_400, &f.quote).unwrap().contains("Intel quote"));
    // A quote with one byte of the signed body changed.
    let mut forged = f.quote.clone();
    forged[600] ^= 1;
    assert!(run(&f.key, &f.nonce, &f.app_compose, &f.events, &accepted(), f.now, &forged).unwrap().contains("Intel quote"));
}
