// Spike S1: does a non-streaming, canonical-ID request return a `provider_tee`
// Ed25519 signature whose signed bytes include `usage`?
//
// Verifies one live response end to end and saves the raw bytes as fixtures,
// plus one `gateway`-kind sample that must be rejected.
//
//   pnpm spike:s1 [model-id]

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bytesToBase64,
  checkModelReport,
  checkReceipt,
  collateralToJson,
  fetchAttestationReport,
  fetchCollateral,
  receiptFromSignature,
  sha256Hex,
  unitsFor,
  utf8,
} from "@barrel/verifier";
import { REPO_ROOT } from "../packages/sdk/src/chain.ts";
import { requireEnv } from "../packages/sdk/src/env.ts";
import { fetchSignature, postCompletion } from "../packages/sdk/src/upstream.ts";

const model = process.argv[2] ?? "z-ai/glm-5.3-flash";
const apiKey = requireEnv("NEARAI_API_KEY");
const slug = model.replace(/[^A-Za-z0-9.]+/g, "-").toLowerCase();
/** Grade ID used in saved receipts: the model name without its publisher. */
const gradeId = model.split("/").pop()!.toLowerCase();
const dir = join(REPO_ROOT, "fixtures");
mkdirSync(join(dir, "attestations"), { recursive: true });

function line(ok: boolean, text: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${text}`);
}

// 1. Preflight: verify every attestation candidate before sending anything.
console.log(`Model: ${model}`);
console.log("1. Attestation preflight (no API key needed)");
const nonce = randomBytes(32).toString("hex");
const { report, raw } = await fetchAttestationReport(model, nonce);
const candidate0 = report.model_attestations?.[0];
if (!candidate0) throw new Error("no model_attestations[] in the report");
const collateral = await fetchCollateral(candidate0.intel_quote);
const nowSecs = Math.floor(Date.now() / 1000);
const preflight = await checkModelReport(report, { nonce, modelId: model, collateral, nowSecs });
for (const c of preflight.candidates) for (const check of c.checks) line(check.ok, `${check.name} — ${check.detail}`);
if (!preflight.ok) throw new Error("attestation preflight failed");
const attestedKeys = preflight.candidates.map((c) => c.signing_address);
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(join(dir, "attestations", `${slug}.${stamp}.json`), raw);
writeFileSync(join(dir, "attestations", `${slug}.${stamp}.nonce`), `${nonce}\n`);
writeFileSync(
  join(dir, "attestations", `${slug}.${stamp}.collateral.json`),
  `{"fetched_at": ${nowSecs}, "collateral": ${collateralToJson(collateral)}}\n`,
);

// 2. One non-streaming completion. The body is built once and sent byte for byte.
console.log("2. Non-streaming completion with the canonical model ID");
const request = utf8(
  JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly one word: barrel" }],
    max_tokens: 64,
    stream: false,
  }),
);
const upstream = await postCompletion(apiKey, request);
if (upstream.status !== 200) {
  throw new Error(`completion: HTTP ${upstream.status} ${Buffer.from(upstream.body).toString("utf8").slice(0, 300)}`);
}
const parsed = JSON.parse(Buffer.from(upstream.body).toString("utf8"));
line(true, `HTTP 200, id ${parsed.id}, model ${parsed.model}`);
line(Boolean(parsed.usage), `usage is inside the response body: ${JSON.stringify(parsed.usage)}`);
console.log(`     answer: ${JSON.stringify(parsed.choices?.[0]?.message?.content)}`);

// 3. The model's signature over these exact bytes.
console.log("3. Signature");
const payload = await fetchSignature(apiKey, parsed.id, model);
if (!payload) throw new Error("no signature within the retry window");
console.log(`     ${JSON.stringify({ ...payload, signature: `${payload.signature.slice(0, 16)}…` })}`);
const receipt = receiptFromSignature(gradeId, model, payload, { chatId: parsed.id });
receipt.request_b64 = bytesToBase64(request);
receipt.response_b64 = bytesToBase64(upstream.body);
const result = checkReceipt(receipt, { request, response: upstream.body });
for (const check of result.checks) line(check.ok, `${check.name} — ${check.detail}`);
const keyAttested = attestedKeys.includes(receipt.signing_address);
line(keyAttested, `signing key equals the attested model key ${attestedKeys[0]}`);
line(sha256Hex(request) === receipt.request_hash, "request hash is sha256 of the bytes we sent, lowercase hex");
console.log(`   Verdict: ${result.verdict}`);
writeFileSync(join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

// 4. The same request streamed: the gateway signs, not the model.
console.log("4. Streamed completion (expect a gateway signature)");
const streamRequest = utf8(
  JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly one word: barrel" }],
    max_tokens: 64,
    stream: true,
  }),
);
const streamed = await postCompletion(apiKey, streamRequest);
const streamText = Buffer.from(streamed.body).toString("utf8");
const streamId = /"id"\s*:\s*"([^"]+)"/.exec(streamText)?.[1];
if (streamed.status === 200 && streamId) {
  const gw = await fetchSignature(apiKey, streamId, model);
  if (gw) {
    const gwReceipt = receiptFromSignature(gradeId, model, gw, { chatId: streamId });
    gwReceipt.request_b64 = bytesToBase64(streamRequest);
    gwReceipt.response_b64 = bytesToBase64(streamed.body);
    const gwResult = checkReceipt(gwReceipt, { request: streamRequest, response: streamed.body });
    console.log(`     signature_kind ${gw.signature_kind}, text has ${gw.text.split(":").length} parts, key ${gw.signing_address}`);
    for (const check of gwResult.checks) line(check.ok, `${check.name} — ${check.detail}`);
    console.log(`   Verdict: ${gwResult.verdict}`);
    if (!gwResult.valid) writeFileSync(join(dir, "gateway-kind.json"), `${JSON.stringify(gwReceipt, null, 2)}\n`);
  } else {
    console.log("     no signature for the streamed response");
  }
} else {
  console.log(`     streamed request: HTTP ${streamed.status}`);
}

// 5. Summary
const usage = parsed.usage;
console.log("\nS1 result");
const pass = result.valid && keyAttested && Boolean(usage);
console.log(`  ${pass ? "PASS" : "FAIL"}: provider_tee Ed25519 signature over bytes that include usage`);
if (usage) {
  console.log(`  usage ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion tokens`);
  console.log(`  units at a 16% input weight: ${unitsFor(usage, 1600)}`);
}
console.log(`  fixtures written under ${dir}`);
process.exit(pass ? 0 : 1);
