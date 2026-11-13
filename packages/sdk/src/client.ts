// The paying side. A TankClient holds one tank's session key and nothing
// else: it can ask for answers and acknowledge them, and it cannot move,
// withdraw or transfer anything.
//
// The rule it enforces: no proof, no ack. An ack is the only thing that lets
// the operator be paid, and it is signed only after every check below passes.

import {
  bytesToBase64,
  checkReceipt,
  publicKeyOf,
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
  tankId: number;
  /** Ed25519 secret key of the tank, hex. */
  tankSecretKey: string;
  /** Overrides the endpoint recorded in the series. */
  pumpUrl?: string;
}

export class TankClient {
  private series?: Series;
  private grade?: Grade;
  private nextSeq?: number;

  constructor(private readonly opts: TankClientOptions) {}

  private async load(): Promise<{ series: Series; grade: Grade }> {
    if (!this.series || !this.grade) {
      const tank = await this.opts.barrel.tank(this.opts.tankId);
      if (!tank) throw new Error(`tank ${this.opts.tankId} does not exist`);
      if (tank.key !== publicKeyOf(this.opts.tankSecretKey)) throw new Error("this key does not belong to the tank");
      this.series = (await this.opts.barrel.series(tank.series_id))!;
      this.grade = (await this.opts.barrel.grade(this.series.grade_id))!;
      this.nextSeq = tank.next_seq;
    }
    return { series: this.series, grade: this.grade };
  }

  /** Units left in the tank according to the chain. */
  async balance(): Promise<bigint> {
    const tank = await this.opts.barrel.tank(this.opts.tankId);
    return BigInt(tank?.balance ?? "0");
  }

  /**
   * Sends an OpenAI-style chat completion and pays for it only if the answer
   * comes back with a valid signature from the named model's TEE.
   */
  async chat(body: { messages: unknown[]; max_tokens?: number; [key: string]: unknown }): Promise<AskResult> {
    const { series, grade } = await this.load();
    const { barrel, tankId, tankSecretKey } = this.opts;
    const pumpUrl = (this.opts.pumpUrl ?? series.endpoint).replace(/\/+$/, "");
    const maxTokens = body.max_tokens ?? 512;
    // Built once; these exact bytes are what the model TEE will sign.
    const { model: _model, stream: _stream, max_tokens: _max, ...rest } = body;
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
      },
      body: request as unknown as BodyInit,
    });
    const response = new Uint8Array(await res.arrayBuffer());
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
    };
  }
}
