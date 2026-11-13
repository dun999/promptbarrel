// A Barrel receipt and the checks anyone can run on it with no keys and no funds.

import { base64ToBytes, normalizeHex, sha256Hex, verifyEd25519 } from "./crypto.ts";
import { isHashHex, receiptText } from "./rules.ts";

/** What NEAR AI Cloud returns from GET /v1/signature/<chat_id>. */
export interface SignaturePayload {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

export interface Receipt {
  grade_id: string;
  model_id: string;
  request_hash: string;
  response_hash: string;
  signing_algo: string;
  /** Ed25519 public key of the model TEE, hex. */
  signing_address: string;
  signature: string;
  signature_kind?: string;
  chat_id?: string;
  /** The signed text exactly as the provider returned it. */
  text: string;
  /** Optional raw bodies (base64), so a third party can recompute the hashes. */
  request_b64?: string;
  response_b64?: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReceiptReport {
  valid: boolean;
  /** One line a human can read, e.g. "REJECTED: not a model signature". */
  verdict: string;
  checks: Check[];
}

/** Builds a receipt from a provider signature payload. Does not judge it. */
export function receiptFromSignature(
  gradeId: string,
  modelId: string,
  payload: SignaturePayload,
  extra: { chatId?: string; requestBytes?: Uint8Array; responseBytes?: Uint8Array } = {},
): Receipt {
  const parts = payload.text.split(":");
  // provider_tee text is <model>:<req>:<resp>; gateway text is <req>:<resp>.
  const responseHash = parts[parts.length - 1] ?? "";
  const requestHash = parts[parts.length - 2] ?? "";
  return {
    grade_id: gradeId,
    model_id: modelId,
    request_hash: requestHash,
    response_hash: responseHash,
    signing_algo: payload.signing_algo,
    signing_address: normalizeHex(payload.signing_address, 32) ?? payload.signing_address,
    signature: normalizeHex(payload.signature, 64) ?? payload.signature,
    signature_kind: payload.signature_kind,
    chat_id: extra.chatId,
    text: payload.text,
  };
}

/**
 * Local checks: everything that can be decided from the receipt and the raw
 * bytes alone. Whether the signing key is registered for the grade is a
 * chain question, answered separately by the contract's `verify_receipt`.
 */
export function checkReceipt(
  receipt: Receipt,
  bytes: { request?: Uint8Array; response?: Uint8Array } = {},
): ReceiptReport {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // 1. Kind. Only a model TEE signature is a delivery receipt.
  const kind = receipt.signature_kind;
  const partCount = receipt.text.split(":").length;
  if (kind !== undefined) {
    add("signature kind is provider_tee", kind === "provider_tee", `signature_kind is ${kind}`);
  } else {
    add("signature kind is provider_tee", false, "signature_kind is missing; it is never inferred from the text");
  }

  // 2. Algorithm. The contract verifies Ed25519 with the native host function.
  add("signing algorithm is ed25519", receipt.signing_algo === "ed25519", `signing_algo is ${receipt.signing_algo}`);

  // 3. The signed text names the model and both hashes.
  const expected = receiptText(receipt.model_id, receipt.request_hash, receipt.response_hash);
  const hashesOk = isHashHex(receipt.request_hash) && isHashHex(receipt.response_hash);
  add(
    "signed text is <model_id>:<request_hash>:<response_hash>",
    hashesOk && receipt.text === expected,
    receipt.text === expected
      ? `model ${receipt.model_id}`
      : partCount === 2
        ? "text has two parts: it covers the bytes but names no model"
        : `text does not match model ${receipt.model_id}`,
  );

  // 4. The hashes are the hashes of the actual bytes, when the bytes are available.
  const request = bytes.request ?? (receipt.request_b64 ? base64ToBytes(receipt.request_b64) : undefined);
  const response = bytes.response ?? (receipt.response_b64 ? base64ToBytes(receipt.response_b64) : undefined);
  if (request) {
    const h = sha256Hex(request);
    add("request bytes hash to request_hash", h === receipt.request_hash, `sha256 = ${h}`);
  }
  if (response) {
    const h = sha256Hex(response);
    add("response bytes hash to response_hash", h === receipt.response_hash, `sha256 = ${h}`);
  }

  // 5. The signature itself.
  const sigOk = verifyEd25519(receipt.signature, receipt.text, receipt.signing_address);
  add("Ed25519 signature verifies under signing_address", sigOk, `key ${receipt.signing_address}`);

  const valid = checks.every((c) => c.ok);
  let verdict = "VALID";
  if (!valid) {
    const first = checks.find((c) => !c.ok)!;
    verdict =
      kind === "gateway" || (kind === undefined && partCount === 2)
        ? "REJECTED: not a model signature"
        : `REJECTED: ${first.name} failed (${first.detail})`;
  }
  return { valid, verdict, checks };
}

/** What a receipt does and does not prove. Printed wherever a receipt is shown. */
export const RECEIPT_LIMITS: readonly string[] = [
  "Proves a TEE holding the model's signing key signed these exact bytes. It does not identify the serving instance.",
  "Gateway and model evidence do not yet form one complete chain.",
  "In v1 the key was registered by Barrel's registrar after off-chain attestation checks. Anyone can repeat them with `barrel audit`.",
  "NVIDIA GPU evidence is not checked yet.",
  "TEE guarantees rest on Intel TDX and NVIDIA confidential-computing assumptions.",
];
