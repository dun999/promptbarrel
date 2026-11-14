// One paid-on-proof answer from a tank, in the browser. The same rule as the
// SDK's TankClient: no proof, no ack. The ack is the only thing that lets the
// operator be paid, and it is signed only after every check below passes.

import {
  ackText,
  bytesToBase64,
  checkReceipt,
  looksSealed,
  openWith,
  publicKeyOf,
  sealTo,
  SEALED_RESPONSE_FIELDS,
  requestAuthText,
  sha256Hex,
  signEd25519,
  unitsFor,
  utf8,
  worstCaseUnits,
  type Check,
  type Receipt,
  type Usage,
} from "@barrel/verifier/core";

export type View = (contractId: string, method: string, args?: Record<string, unknown>) => Promise<any>;

export interface AskInput {
  view: View;
  contractId: string;
  tank: { id: number; key: string; next_seq: number };
  grade: { id: string; model_id: string; input_weight_bps: number };
  /** The Pump URL recorded in the tank's series. */
  endpoint: string;
  /** The tank's Ed25519 spend key, hex. */
  secretKey: string;
  question: string;
  maxTokens?: number;
  /**
   * Encrypt the question to the model's attested key, and have the answer
   * encrypted back to the tank key. The Pump relays ciphertext it cannot read.
   */
  private?: boolean;
}

export interface AskResult {
  content: string;
  usage: Usage;
  units: bigint;
  seq: number;
  receipt: Receipt;
  checks: Check[];
  settleTx?: string;
  /** Set on a private ask: the model key the question was encrypted to. */
  sealedTo?: string;
}

export class ProofError extends Error {
  constructor(
    message: string,
    readonly checks: Check[],
  ) {
    super(message);
    this.name = "ProofError";
  }
}

const decoder = new TextDecoder();

function lastSeqKey(contractId: string, tankId: number) {
  return `barrel.seq.${contractId}.${tankId}`;
}
function lastSeq(contractId: string, tankId: number): number {
  try {
    const v = localStorage.getItem(lastSeqKey(contractId, tankId));
    return v === null ? -1 : Number(v);
  } catch {
    return -1;
  }
}
function rememberSeq(contractId: string, tankId: number, seq: number) {
  try {
    localStorage.setItem(lastSeqKey(contractId, tankId), String(seq));
  } catch {
    /* the Pump tells us the right number next time */
  }
}

/** Refuses endpoints a browser on this page cannot reach, with the reason. */
export function reachable(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `the series endpoint "${endpoint}" is not a URL`;
  }
  const local = /^(127\.|localhost$|\[::1\]$|0\.0\.0\.0$)/.test(url.hostname);
  // Outside a browser (the e2e test) there is no page to compare with.
  const page = typeof location === "undefined" ? null : location;
  const pageLocal = !page || /^(127\.|localhost$|\[::1\]$)/.test(page.hostname);
  if (local && !pageLocal) return `this series is served from ${url.host}, a private address only its operator's machine can reach`;
  if (page?.protocol === "https:" && url.protocol === "http:" && !local) return `this series is served over plain http (${url.host}); an https page cannot call it`;
  return null;
}

export async function ask(input: AskInput): Promise<AskResult> {
  const { view, contractId, tank, grade, secretKey } = input;
  if (publicKeyOf(secretKey) !== tank.key) throw new Error("this key does not belong to the tank");
  const blocked = reachable(input.endpoint);
  if (blocked) throw new Error(blocked);
  const pumpUrl = input.endpoint.replace(/\/+$/, "");
  const maxTokens = input.maxTokens ?? 800;

  // Private: the question leaves this browser encrypted to the newest live
  // key the contract has registered for the model, the key that signs answers.
  let sealedTo: string | undefined;
  if (input.private) {
    const now = Date.now() / 1000;
    const keys = ((await view(contractId, "get_keys", { grade_id: grade.id })) as { key: string; expires_at: number; registered_at: number }[])
      .filter((k) => now < k.expires_at)
      .sort((a, b) => b.registered_at - a.registered_at);
    if (!keys[0]) throw new Error("no live attested model key is registered, so there is nothing to encrypt to");
    sealedTo = keys[0].key;
  }
  const e2ee: Record<string, string> = sealedTo
    ? { "x-signing-algo": "ed25519", "x-client-pub-key": tank.key, "x-model-pub-key": sealedTo, "x-encryption-version": "2" }
    : {};

  // Built once: these exact bytes are what the model TEE signs.
  const request = utf8(
    JSON.stringify({
      model: grade.model_id,
      messages: [{ role: "user", content: sealedTo ? sealTo(sealedTo, input.question) : input.question }],
      // This model reasons before answering; "low" keeps short questions short.
      reasoning_effort: "low",
      max_tokens: maxTokens,
      stream: false,
    }),
  );
  const requestHash = sha256Hex(request);
  const maxUnits = worstCaseUnits(request.length, maxTokens, grade.input_weight_bps);

  const send = (seq: number) =>
    fetch(`${pumpUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-barrel-tank": String(tank.id),
        "x-barrel-seq": String(seq),
        "x-barrel-max-units": maxUnits.toString(),
        "x-barrel-sig": signEd25519(requestAuthText(contractId, tank.id, seq, requestHash, maxUnits), secretKey),
        ...e2ee,
      },
      body: request as Uint8Array<ArrayBuffer>, // the exact bytes that were hashed and signed
    });

  let seq = Math.max(tank.next_seq, lastSeq(contractId, tank.id) + 1);
  let res: Response;
  try {
    res = await send(seq);
    if (res.status === 409) {
      // Acks the Pump has queued but not yet settled move the sequence on.
      const text = await res.text();
      const expected = /expected sequence number (\d+)/.exec(text);
      if (!expected) throw new Error(`pump: ${errorText(text)}`);
      seq = Number(expected[1]);
      res = await send(seq);
    }
  } catch (e) {
    if (e instanceof TypeError) throw new Error(`could not reach the Pump at ${pumpUrl}`);
    throw e;
  }
  const response = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 200) throw new Error(`pump: ${errorText(decoder.decode(response))}`);

  // --- Proof checks. Nothing is acknowledged unless all of them pass. ---
  const checks: Check[] = [];
  const fail = (message: string): never => {
    throw new ProofError(`${message}. Nothing was acknowledged, so nothing is charged.`, checks);
  };
  const header = res.headers.get("x-barrel-receipt");
  if (!header) fail("the Pump sent no receipt");
  let receipt!: Receipt;
  try {
    receipt = JSON.parse(decoder.decode(Uint8Array.from(atob(header!), (c) => c.charCodeAt(0)))) as Receipt;
  } catch {
    fail("the receipt is not readable");
  }
  // Our own view of the facts, never the Pump's.
  receipt = { ...receipt, grade_id: grade.id, model_id: grade.model_id };
  const local = checkReceipt(receipt, { request, response });
  checks.push(...local.checks);
  if (!local.valid) fail(local.verdict);

  const onChain = await view(contractId, "verify_receipt", {
    grade_id: receipt.grade_id,
    request_hash: receipt.request_hash,
    response_hash: receipt.response_hash,
    tee_key: receipt.signing_address,
    tee_sig: receipt.signature,
  });
  checks.push({
    name: "the contract has this key registered for the model, and it is live",
    ok: onChain.valid && onChain.key_live,
    detail: onChain.reason ?? `key expires at ${onChain.key_expires_at}`,
  });
  if (!onChain.valid || !onChain.key_live) fail(`the contract does not accept this signature: ${onChain.reason ?? "key expired"}`);

  const parsed = JSON.parse(decoder.decode(response));
  if (sealedTo) {
    // The signature covers the ciphertext; it is opened only here, after the checks.
    checks.push({
      name: "the answer was signed by the key the question was encrypted to",
      ok: receipt.signing_address === sealedTo,
      detail: `model key ${sealedTo.slice(0, 12)}…`,
    });
    if (receipt.signing_address !== sealedTo) fail("the answer was signed by a different key than the question was encrypted to");
    const message = parsed.choices?.[0]?.message ?? {};
    let opened = 0;
    for (const field of SEALED_RESPONSE_FIELDS) {
      if (looksSealed(message[field])) {
        message[field] = openWith(secretKey, message[field]);
        opened += 1;
      }
    }
    checks.push({ name: "the answer came back encrypted to this tank's key", ok: opened > 0, detail: `${opened} field(s) decrypted in this browser` });
    if (opened === 0) fail("the answer was not encrypted to this tank's key");
  }
  const usage = parsed.usage as Usage | undefined;
  if (!usage) fail("the signed answer has no usage object");
  const metered = unitsFor(usage!, grade.input_weight_bps);
  const units = metered < maxUnits ? metered : maxUnits;
  const claimed = BigInt(res.headers.get("x-barrel-units") ?? "-1");
  checks.push({
    name: "the unit count follows from the signed usage",
    ok: claimed === units,
    detail: `${usage!.prompt_tokens} prompt + ${usage!.completion_tokens} completion tokens = ${units} units; the Pump asked for ${claimed}`,
  });
  if (claimed !== units) fail("the Pump asked for a different number of units than the signed usage gives");

  // --- All good: acknowledge exactly this answer and this unit count. ---
  const ackSig = signEd25519(ackText(contractId, tank.id, seq, receipt.request_hash, receipt.response_hash, units), secretKey);
  rememberSeq(contractId, tank.id, seq);
  const ack = await fetch(`${pumpUrl}/v1/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tank_id: tank.id, seq, ack_sig: ackSig }),
  });
  const ackBody = (await ack.json().catch(() => ({}))) as { settle_tx?: string; error?: { message?: string } };
  if (!ack.ok) throw new Error(`the Pump refused the ack: ${ackBody.error?.message ?? ack.status}`);

  receipt.request_b64 = bytesToBase64(request);
  receipt.response_b64 = bytesToBase64(response);
  return {
    content: parsed.choices?.[0]?.message?.content ?? "",
    usage: usage!,
    units,
    seq,
    receipt,
    checks,
    settleTx: ackBody.settle_tx,
    sealedTo,
  };
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body);
    return j.error?.message ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
