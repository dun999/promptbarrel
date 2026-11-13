import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ackText,
  checkCandidate,
  checkReceipt,
  collateralFromJson,
  formatAmount,
  newKeyPair,
  parseAmount,
  parseTdQuote,
  receiptFromSignature,
  receiptText,
  sha256Hex,
  signEd25519,
  unitsBought,
  unitsFor,
  usdcCeil,
  usdcFloor,
  utf8,
  verifyEd25519,
  type AttestationReport,
} from "./index.ts";

const FIXTURES = new URL("../../../fixtures/attestations/", import.meta.url);
const NAME = "qwen3.8-27b.2026-11-12";

// --- rules: must match contracts/barrel-core byte for byte -----------------

test("signed texts match the Rust implementation", () => {
  const rq = "1".repeat(64);
  const rs = "2".repeat(64);
  assert.equal(receiptText("Qwen/Qwen3.8-27B", rq, rs), `Qwen/Qwen3.8-27B:${rq}:${rs}`);
  assert.equal(ackText("barrel.testnet", 7, 3, rq, rs, 1200n), `barrel:v1:ack:barrel.testnet:7:3:${rq}:${rs}:1200`);
});

test("units: completion tokens plus weighted prompt tokens, rounded up", () => {
  assert.equal(unitsFor({ prompt_tokens: 0, completion_tokens: 10 }, 296), 10n);
  assert.equal(unitsFor({ prompt_tokens: 1, completion_tokens: 0 }, 296), 1n);
  assert.equal(unitsFor({ prompt_tokens: 1000, completion_tokens: 200 }, 296), 230n);
  assert.equal(unitsFor({ prompt_tokens: 1000, completion_tokens: 200 }, 10_000), 1200n);
});

test("escrow arithmetic matches the Rust implementation", () => {
  const price = 300_000n;
  assert.equal(usdcFloor(1000n, price), 300n);
  assert.equal(usdcCeil(1n, price), 1n);
  assert.equal(unitsBought(5_000_000n, 1_000_000n), 5_000_000n);
  assert.equal(parseAmount("1.5"), 1_500_000n);
  assert.equal(formatAmount(4_998_800n), "4.9988");
});

// --- receipts ---------------------------------------------------------------

test("a model-signed receipt is VALID; the same bytes under a gateway signature are REJECTED", () => {
  const model = newKeyPair();
  const gateway = newKeyPair();
  const request = utf8('{"model":"Qwen/Qwen3.8-27B","messages":[{"role":"user","content":"hi"}]}');
  const response = utf8('{"id":"chatcmpl-1","usage":{"prompt_tokens":9,"completion_tokens":3}}');
  const rq = sha256Hex(request);
  const rs = sha256Hex(response);

  const modelText = receiptText("Qwen/Qwen3.8-27B", rq, rs);
  const good = receiptFromSignature("qwen", "Qwen/Qwen3.8-27B", {
    text: modelText,
    signature: signEd25519(modelText, model.secretKey),
    signing_address: model.publicKey,
    signing_algo: "ed25519",
    signature_kind: "provider_tee",
  });
  const goodReport = checkReceipt(good, { request, response });
  assert.equal(goodReport.verdict, "VALID");

  const gatewayText = `${rq}:${rs}`;
  const gw = receiptFromSignature("qwen", "Qwen/Qwen3.8-27B", {
    text: gatewayText,
    signature: signEd25519(gatewayText, gateway.secretKey),
    signing_address: gateway.publicKey,
    signing_algo: "ed25519",
    signature_kind: "gateway",
  });
  const gwReport = checkReceipt(gw, { request, response });
  assert.equal(gwReport.valid, false);
  assert.equal(gwReport.verdict, "REJECTED: not a model signature");

  // Tampered answer: the hash no longer matches the bytes.
  const tampered = checkReceipt(good, { request, response: utf8("something else") });
  assert.equal(tampered.valid, false);

  // A different model's name in the text does not verify for this grade.
  const other = { ...good, model_id: "Qwen/Qwen3.8-27B-abliterated" };
  assert.equal(checkReceipt(other, { request, response }).valid, false);
});

test("ed25519 helper never throws on malformed input", () => {
  assert.equal(verifyEd25519("zz", "x", "00"), false);
  assert.equal(verifyEd25519("00".repeat(64), "x", "00".repeat(32)), false);
});

// --- attestation: real evidence captured from NEAR AI Cloud -----------------

const report = JSON.parse(readFileSync(new URL(`${NAME}.json`, FIXTURES), "utf8")) as AttestationReport;
const nonce = readFileSync(new URL(`${NAME}.nonce`, FIXTURES), "utf8").trim();
const stored = JSON.parse(readFileSync(new URL(`${NAME}.collateral.json`, FIXTURES), "utf8"));
const collateral = collateralFromJson(JSON.stringify(stored.collateral));
const nowSecs = stored.fetched_at as number;

test("captured model attestation passes every check, including Intel DCAP, offline", async () => {
  const candidate = report.model_attestations![0]!;
  const result = await checkCandidate(candidate, { nonce, modelId: "Qwen/Qwen3.8-27B", collateral, nowSecs });
  for (const c of result.checks) assert.ok(c.ok, `${c.name}: ${c.detail}`);
  assert.equal(result.ok, true);
  assert.equal(result.tcb_status, "UpToDate");
  assert.equal(result.signing_address, "89154a43a47684742c3d1753252bb6f49f61da9d8c84fc9b1def2df130cb2d93");
  assert.equal(result.compose_hash, "e8416a02d6f7ce47baaa52e3925b934fd30834b04fc9086b363db9b1d12c729d");
});

test("the gateway's own attestation also passes, and its key differs from the model's", async () => {
  const gateway = report.gateway_attestation!;
  const result = await checkCandidate(gateway, { nonce, collateral: undefined, skipDcap: true });
  const structural = result.checks.filter((c) => c.name !== "Intel DCAP quote verification");
  for (const c of structural) assert.ok(c.ok, `${c.name}: ${c.detail}`);
  assert.notEqual(result.signing_address, report.model_attestations![0]!.signing_address);
});

test("a stale nonce, a swapped key or an unreviewed compose file each fail", async () => {
  const candidate = report.model_attestations![0]!;
  const base = { modelId: "Qwen/Qwen3.8-27B", collateral, nowSecs };

  const replayed = await checkCandidate(candidate, { ...base, nonce: "ab".repeat(32) });
  assert.equal(replayed.ok, false);

  const swapped = await checkCandidate({ ...candidate, signing_address: "11".repeat(32) }, { ...base, nonce });
  assert.equal(swapped.ok, false);
  assert.ok(swapped.checks.some((c) => c.name.startsWith("report data binds") && !c.ok));

  const unreviewed = await checkCandidate(candidate, { ...base, nonce, allowedComposeHashes: ["00".repeat(32)] });
  assert.equal(unreviewed.ok, false);

  const wrongModel = await checkCandidate(candidate, { ...base, nonce, modelId: "some/other-model" });
  assert.equal(wrongModel.ok, false);
});

test("quote parser reads the fields at the documented offsets", () => {
  const q = parseTdQuote(report.model_attestations![0]!.intel_quote);
  assert.equal(q.version, 4);
  assert.equal(q.reportData.length, 128);
  assert.equal(q.reportData.slice(64), nonce);
});
