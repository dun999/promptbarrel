// The paying side. A TankClient holds one tank's session key and nothing
// else: it can ask for answers and acknowledge them, and it cannot move,
// withdraw or transfer anything.
//
// The rule it enforces: no proof, no ack. An ack is the only thing that lets
// the operator be paid, and it is signed only after every check below passes.

import {
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
} from "@barrel/verifier";
import { signAck, type Barrel, type Grade, type Series } from "./barrel.ts";

export interface AskResult {
  /** The model's answer, parsed from the exact bytes the model TEE signed. */
  response: any;
  content: string;
  usage: Usage;
  units: bigint;
  seq: number;
  receipt: Receipt;
  /** Every check that passed before the ack was signed. */
  checks: Check[];
  /** Settlement transaction, when the Pump settles right away. */
  settleTx?: string;
  /** Set on a private request: the model key the prompt was encrypted to. */
  sealedTo?: string;
}

/** One way to pay, as the Pump's HTTP 402 answer lists it (the x402 `accepts[]` shape). */
export interface PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  extra: Record<string, any>;
}

/** The key has no funded tank. `accepts` says how to fund one; the money goes to the contract. */
export class PaymentRequired extends Error {
  constructor(
    message: string,
    readonly accepts: PaymentOption[],
  ) {
    super(message);
    this.name = "PaymentRequired";
  }
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

export interface TankClientOptions {
  barrel: Barrel;
  /**
   * The tank to spend from. Without it the client uses the tank its key
   * owns (one bought with `tank_key`), which is all an agent with no
   * account needs to know.
   */
  tankId?: number;
  /** Ed25519 secret key of the tank, hex. */
  tankSecretKey: string;
  /** Overrides the endpoint recorded in the series. */
  pumpUrl?: string;
  /**
   * Encrypt every prompt to the model's attested key and have the answer
   * encrypted back to this tank's key. The Pump relays ciphertext it cannot
   * read; the model TEE still signs the exact bytes, so payment is unchanged.
   */
  private?: boolean;
}

/**
 * Asks a Pump how a key with no tank can pay for a model. Returns the
 * options of its HTTP 402 answer. `payFrom` and `refundTo` add a route from
 * another chain (mainnet).
 */
export async function paymentOptions(
  pumpUrl: string,
  o: { key: string; model: string; usdc?: bigint; payFrom?: string; refundTo?: string },
): Promise<PaymentOption[]> {
  const res = await fetch(`${pumpUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-barrel-key": o.key,
      ...(o.usdc !== undefined ? { "x-barrel-pay": o.usdc.toString() } : {}),
      ...(o.payFrom ? { "x-barrel-pay-from": o.payFrom } : {}),
      ...(o.refundTo ? { "x-barrel-refund-to": o.refundTo } : {}),
    },
    body: JSON.stringify({ model: o.model, messages: [], max_tokens: 1 }),
  });
  const body = (await res.json().catch(() => ({}))) as { accepts?: PaymentOption[]; message?: string };
  if (res.status !== 402) throw new Error(`pump: HTTP ${res.status} ${body.message ?? ""}`);
  return body.accepts ?? [];
}

export class TankClient {
  private series?: Series;
  private grade?: Grade;
  private nextSeq?: number;
  private id?: number;

  constructor(private readonly opts: TankClientOptions) {
    this.id = opts.tankId;
  }

  /** The tank this client spends from, once known. */
  get tankId(): number | undefined {
    return this.id;
  }

  private async load(): Promise<{ series: Series; grade: Grade; tankId: number }> {
    if (!this.series || !this.grade || this.id === undefined) {
      const key = publicKeyOf(this.opts.tankSecretKey);
      const tank = this.id !== undefined ? await this.opts.barrel.tank(this.id) : await this.opts.barrel.tankForKey(key);
      if (!tank) {
        if (this.id !== undefined) throw new Error(`tank ${this.id} does not exist`);
        throw new PaymentRequired(`key ${key} owns no tank yet: fund one first (see paymentOptions)`, []);
      }
      if (tank.key !== key) throw new Error("this key does not belong to the tank");
      this.id = tank.id;
      this.series = (await this.opts.barrel.series(tank.series_id))!;
      this.grade = (await this.opts.barrel.grade(this.series.grade_id))!;
      this.nextSeq = tank.next_seq;
    }
    return { series: this.series, grade: this.grade, tankId: this.id };
  }

  /** Units left in the tank according to the chain. */
  async balance(): Promise<bigint> {
    const { tankId } = await this.load();
    const tank = await this.opts.barrel.tank(tankId);
    return BigInt(tank?.balance ?? "0");
  }

  /** The model key a private request is encrypted to: the newest live key registered for the grade. */
  private async modelKey(gradeId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const live = (await this.opts.barrel.keys(gradeId)).filter((k) => now < k.expires_at);
    if (live.length === 0) throw new Error("no live attested model key is registered for this grade; a private request has nothing to encrypt to");
    return live.sort((a, b) => b.registered_at - a.registered_at)[0]!.key;
  }

  /**
   * Sends an OpenAI-style chat completion and pays for it only if the answer
   * comes back with a valid signature from the named model's TEE.
   */
  async chat(body: { messages: unknown[]; max_tokens?: number; [key: string]: unknown }): Promise<AskResult> {
    const { series, grade, tankId } = await this.load();
    const { barrel, tankSecretKey } = this.opts;
    const pumpUrl = (this.opts.pumpUrl ?? series.endpoint).replace(/\/+$/, "");
    const maxTokens = body.max_tokens ?? 512;
    // Built once; these exact bytes are what the model TEE will sign.
    const { model: _model, stream: _stream, max_tokens: _max, ...rest } = body;
    // Private: each message is encrypted to the model's attested key before
    // it leaves this process. The tank key doubles as the key the answer is
    // encrypted back to.
    let sealedTo: string | undefined;
    const sealHeaders: Record<string, string> = {};
    if (this.opts.private) {
      sealedTo = await this.modelKey(grade.id);
      rest.messages = (rest.messages as any[]).map((m) => {
        if (typeof m?.content !== "string") throw new Error("a private request takes text messages only");
        return { ...m, content: sealTo(sealedTo!, m.content) };
      });
      Object.assign(sealHeaders, {
        "x-signing-algo": "ed25519",
        "x-client-pub-key": publicKeyOf(tankSecretKey),
        "x-model-pub-key": sealedTo,
        "x-encryption-version": "2",
      });
    }
    const request = utf8(JSON.stringify({ model: grade.model_id, ...rest, max_tokens: maxTokens, stream: false }));
    const requestHash = sha256Hex(request);
    const maxUnits = worstCaseUnits(request.length, maxTokens, grade.input_weight_bps);
    const seq = this.nextSeq!;

    const res = await fetch(`${pumpUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-barrel-tank": String(tankId),
        "x-barrel-seq": String(seq),
        "x-barrel-max-units": maxUnits.toString(),
        "x-barrel-sig": signEd25519(requestAuthText(barrel.contractId, tankId, seq, requestHash, maxUnits), tankSecretKey),
        ...sealHeaders,
      },
      body: request as unknown as BodyInit,
    });
    const response = new Uint8Array(await res.arrayBuffer());
    if (res.status === 402) {
      const offer = JSON.parse(Buffer.from(response).toString("utf8") || "{}") as { accepts?: PaymentOption[]; message?: string };
      if (offer.accepts?.length) throw new PaymentRequired(offer.message ?? "payment required", offer.accepts);
    }
    if (res.status !== 200) {
      throw new Error(`pump: HTTP ${res.status} ${Buffer.from(response).toString("utf8").slice(0, 300)}`);
    }

    // --- Proof checks. Nothing is acknowledged unless all of them pass. ---
    const checks: Check[] = [];
    const fail = (message: string): never => {
      throw new ProofError(`${message}. Nothing was acknowledged, so nothing can be charged.`, checks);
    };
    const header = res.headers.get("x-barrel-receipt");
    if (!header) fail("the Pump sent no receipt");
    let receipt!: Receipt;
    try {
      receipt = JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as Receipt;
    } catch {
      fail("the receipt is not readable");
    }
    // Our own view of the facts, never the Pump's.
    receipt = { ...receipt, grade_id: grade.id, model_id: grade.model_id };
    const local = checkReceipt(receipt, { request, response });
    checks.push(...local.checks);
    if (!local.valid) fail(local.verdict);

    const onChain = await barrel.verifyReceipt(receipt);
    checks.push({
      name: "the contract has this key registered for the grade, and it is live",
      ok: onChain.valid && onChain.key_live,
      detail: onChain.reason ?? `key expires at ${onChain.key_expires_at}`,
    });
    if (!onChain.valid || !onChain.key_live) fail(`the contract does not accept this signature: ${onChain.reason ?? "key expired"}`);

    const parsed = JSON.parse(Buffer.from(response).toString("utf8"));
    if (sealedTo) {
      // The signature above covers the ciphertext. Only now is it opened, here.
      checks.push({
        name: "the answer was signed by the key the prompt was encrypted to",
        ok: receipt.signing_address === sealedTo,
        detail: `model key ${sealedTo.slice(0, 12)}…`,
      });
      if (receipt.signing_address !== sealedTo) fail("the answer was signed by a different key than the prompt was encrypted to");
      const message = parsed.choices?.[0]?.message ?? {};
      let opened = 0;
      for (const field of SEALED_RESPONSE_FIELDS) {
        if (typeof message[field] === "string" && looksSealed(message[field])) {
          message[field] = openWith(tankSecretKey, message[field]);
          opened += 1;
        }
      }
      checks.push({
        name: "the answer came back encrypted to this tank's key",
        ok: opened > 0,
        detail: `${opened} field(s) decrypted locally`,
      });
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
    const ackSig = signAck(barrel.contractId, tankId, seq, receipt.request_hash, receipt.response_hash, units, tankSecretKey);
    this.nextSeq = seq + 1;
    const ack = await fetch(`${pumpUrl}/v1/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tank_id: tankId, seq, ack_sig: ackSig }),
    });
    const ackBody = (await ack.json().catch(() => ({}))) as { settle_tx?: string; error?: string };
    if (!ack.ok) throw new Error(`pump refused the ack: ${ackBody.error ?? ack.status}`);

    receipt.request_b64 = bytesToBase64(request);
    receipt.response_b64 = bytesToBase64(response);
    return {
      response: parsed,
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
}
