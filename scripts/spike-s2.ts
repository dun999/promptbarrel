// Spike S2: does an end-to-end encrypted request still get a `provider_tee`
// signature, and does `usage` stay readable?
//
// Sends one encrypted request to the model, checks the model's signature over
// the exact ciphertext bytes, and decrypts the answer with the client key.
//
//   pnpm spike:s2 [model-id] [model-ed25519-key-hex]
//
// Without a key argument, the model key is read from a fresh, fully checked
// attestation report.

import { randomBytes } from "node:crypto";
import {
  checkModelReport,
  checkReceipt,
  fetchAttestationReport,
  fetchCollateral,
  looksSealed,
  newKeyPair,
  openWith,
  receiptFromSignature,
  sealTo,
  utf8,
} from "@barrel/verifier";
import { requireEnv } from "../packages/sdk/src/env.ts";
import { fetchSignature } from "../packages/sdk/src/upstream.ts";

const model = process.argv[2] ?? "z-ai/glm-5.3-flash";
const apiKey = requireEnv("NEARAI_API_KEY");
const line = (ok: boolean, text: string) => console.log(`  ${ok ? "✓" : "✗"} ${text}`);

let modelKey = process.argv[3];
if (!modelKey) {
  const nonce = randomBytes(32).toString("hex");
  const { report } = await fetchAttestationReport(model, nonce);
  const collateral = await fetchCollateral(report.model_attestations![0]!.intel_quote);
  const checked = await checkModelReport(report, { nonce, modelId: model, collateral, nowSecs: Math.floor(Date.now() / 1000) });
  if (!checked.ok) throw new Error("attestation failed; no key to encrypt to");
  modelKey = checked.candidates[0]!.signing_address;
}
console.log(`Model ${model}, key ${modelKey}`);

const client = newKeyPair();
const question = "Reply with the single word: sealed";
const body = utf8(JSON.stringify({
  model,
  messages: [{ role: "user", content: sealTo(modelKey, question) }],
  max_tokens: 200,
  stream: false,
}));
const res = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
    "accept-encoding": "identity",
    "x-no-aliasing": "true",
    "x-signing-algo": "ed25519",
    "x-client-pub-key": client.publicKey,
    "x-model-pub-key": modelKey,
    "x-encryption-version": "2",
  },
  body: body as unknown as BodyInit,
});
const raw = new Uint8Array(await res.arrayBuffer());
if (res.status !== 200) throw new Error(`HTTP ${res.status} ${Buffer.from(raw).toString("utf8").slice(0, 300)}`);
const answer = JSON.parse(Buffer.from(raw).toString("utf8"));
const message = answer.choices?.[0]?.message ?? {};
line(looksSealed(message.content) || looksSealed(message.reasoning_content), "the answer on the wire is ciphertext");
for (const field of ["reasoning_content", "reasoning", "content"]) {
  if (looksSealed(message[field])) console.log(`    ${field}: ${JSON.stringify(openWith(client.secretKey, message[field]).slice(0, 80))}`);
  else if (message[field]) console.log(`    ${field} (PLAINTEXT): ${JSON.stringify(String(message[field]).slice(0, 80))}`);
}
line(Boolean(answer.usage), `usage is readable: ${JSON.stringify(answer.usage)}`);

const payload = await fetchSignature(apiKey, String(answer.id), model);
if (!payload) throw new Error("no signature returned");
line(payload.signature_kind === "provider_tee", `signature_kind is ${payload.signature_kind}`);
line(payload.signing_address.replace(/^0x/, "") === modelKey, "signed by the key the prompt was encrypted to");
const receipt = receiptFromSignature("spike", model, payload, { chatId: String(answer.id) });
const report = checkReceipt(receipt, { request: body, response: raw });
for (const c of report.checks) line(c.ok, `${c.name} — ${c.detail.slice(0, 90)}`);
console.log(report.valid ? "S2 PASS: encrypted requests get model receipts over the ciphertext bytes." : `S2 FAIL: ${report.verdict}`);
process.exit(report.valid ? 0 : 1);
