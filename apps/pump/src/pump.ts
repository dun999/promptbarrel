// The Pump: an operator's gateway in front of a TEE inference cloud.
//
// It serves a request only to a funded tank, hands back the model's exact
// bytes together with the model TEE's signature over them, and is paid only
// when the payer acknowledges that proof and the contract verifies it.
//
// The Pump never holds a buyer's money. The most it can lose is one answer
// that a tank refuses to acknowledge; that tank is then not served again.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  attestAndRegister,
  fetchSignature,
  postCompletion,
  settleItem,
  type Barrel,
  type Grade,
  type Series,
  type SettleItem,
  type UpstreamResponse,
  type Wallet,
} from "@barrel/sdk";
import {
  ackText,
  checkReceipt,
  receiptFromSignature,
  requestAuthText,
  sha256Hex,
  unitsFor,
  verifyEd25519,
  worstCaseUnits,
  type Receipt,
  type SignaturePayload,
} from "@barrel/verifier";

/** Where answers and their signatures come from. Replaceable in tests. */
export interface Upstream {
  complete(body: Uint8Array): Promise<UpstreamResponse>;
  signature(chatId: string, modelId: string): Promise<SignaturePayload | null>;
}

export function nearAiUpstream(apiKey: string): Upstream {
  return {
    complete: (body) => postCompletion(apiKey, body),
    signature: (chatId, modelId) => fetchSignature(apiKey, chatId, modelId),
  };
}

export interface PumpConfig {
  barrel: Barrel;
  seriesId: number;
  /** Pays the gas for `settle`. The USDC goes to the series operator regardless. */
  operator: Wallet;
  upstream: Upstream;
  port: number;
  host?: string;
  /** 0 settles as soon as an ack arrives. Otherwise acks are batched. */
  settleIntervalMs?: number;
  /**
   * Optional registrar. When the model's signing key rotates, the Pump
   * re-checks the attestation and registers the new key. Without it, answers
   * signed by an unregistered key are not billed.
   */
  registrar?: { owner: Wallet; allowedComposeHashes?: string[]; evidenceDir?: string };
  /** File that keeps earned-but-unsettled receipts across restarts. */
  journalFile?: string;
  maxTokensLimit?: number;
  /** Stop serving this long before the series ends, so settlement is never rushed. */
  expiryMarginSec?: number;
  log?: (line: string) => void;
}

interface Outstanding {
  seq: number;
  units: bigint;
  receipt: Receipt;
  servedAt: number;
}

interface Journal {
  outstanding: Record<string, { seq: number; units: string; receipt: Receipt; servedAt: number }>;
  pending: Record<string, SettleItem[]>;
}

export interface Pump {
  url: string;
  server: Server;
  /** Settles everything acknowledged so far. Returns the transaction hashes. */
  flush(): Promise<string[]>;
  close(): Promise<void>;
  stats: { served: number; settledUnits: bigint; refused: number };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_ITEMS_PER_SETTLE = 40;

export async function startPump(config: PumpConfig): Promise<Pump> {
  const { barrel, seriesId, operator, upstream } = config;
  const log = config.log ?? (() => {});
  const series = await barrel.series(seriesId);
  if (!series) throw new Error(`series ${seriesId} does not exist`);
  const grade = (await barrel.grade(series.grade_id))!;
  const contractConfig = await barrel.config();
  const maxTokensLimit = config.maxTokensLimit ?? 4096;

  const outstanding = new Map<number, Outstanding>();
  const pending = new Map<number, SettleItem[]>();
  const busy = new Set<number>();
  const stats = { served: 0, settledUnits: 0n, refused: 0 };

  // --- journal ---------------------------------------------------------------
  const save = () => {
    if (!config.journalFile) return;
    const journal: Journal = { outstanding: {}, pending: {} };
    for (const [id, o] of outstanding) journal.outstanding[id] = { ...o, units: o.units.toString() };
    for (const [id, items] of pending) if (items.length) journal.pending[id] = items;
    mkdirSync(dirname(config.journalFile), { recursive: true });
    writeFileSync(config.journalFile, JSON.stringify(journal, null, 1));
  };
  if (config.journalFile && existsSync(config.journalFile)) {
    const journal = JSON.parse(readFileSync(config.journalFile, "utf8")) as Journal;
    for (const [id, o] of Object.entries(journal.outstanding ?? {})) {
      outstanding.set(Number(id), { ...o, units: BigInt(o.units) });
    }
    for (const [id, items] of Object.entries(journal.pending ?? {})) pending.set(Number(id), items);
  }

  const pendingUnits = (tankId: number) =>
    (pending.get(tankId) ?? []).reduce((sum, item) => sum + BigInt(item.units), 0n);

  // --- settlement ------------------------------------------------------------
  let settling: Promise<string[]> = Promise.resolve([]);
  const flushNow = async (): Promise<string[]> => {
    const hashes: string[] = [];
    for (const [tankId, items] of pending) {
      while (items.length > 0) {
        const batch = items.slice(0, MAX_ITEMS_PER_SETTLE);
        try {
          const out = await barrel.settle(operator, tankId, batch);
          items.splice(0, batch.length);
          stats.settledUnits += out.value;
          hashes.push(out.txHash);
          log(`settled ${batch.length} request(s) for tank ${tankId}: ${out.value} units, tx ${out.txHash}`);
        } catch (e) {
          log(`settle failed for tank ${tankId}: ${e instanceof Error ? e.message : e}`);
          // Already settled by someone else (anyone may submit): drop what the chain has.
          const tank = await barrel.tank(tankId);
          const before = items.length;
          while (items.length > 0 && tank && items[0]!.seq < tank.next_seq) items.shift();
          if (items.length === before) break;
        }
      }
    }
    save();
    return hashes;
  };
  const flush = (): Promise<string[]> => {
    settling = settling.then(flushNow, flushNow);
    return settling;
  };
  const interval = config.settleIntervalMs ?? 0;
  const timer = interval > 0 ? setInterval(() => void flush(), interval) : undefined;
  timer?.unref();

  // --- key registration ------------------------------------------------------
  const keyIsAccepted = async (receipt: Receipt): Promise<{ ok: boolean; reason: string }> => {
    let check = await barrel.verifyReceipt(receipt);
    if (check.signature_ok && (!check.key_registered || !check.key_live) && config.registrar) {
      // The model's key changed or is about to lapse. Attest again, then look again.
      log(`key ${receipt.signing_address.slice(0, 12)}… is not live on-chain; re-attesting ${grade.model_id}`);
      try {
        await attestAndRegister(barrel, config.registrar.owner, grade.id, {
          allowedComposeHashes: config.registrar.allowedComposeHashes,
          evidenceDir: config.registrar.evidenceDir,
        });
        check = await barrel.verifyReceipt(receipt);
      } catch (e) {
        return { ok: false, reason: `re-attestation failed: ${e instanceof Error ? e.message : e}` };
      }
    }
    return { ok: check.valid && check.key_live, reason: check.reason ?? (check.key_live ? "" : "key expired") };
  };

  // --- handlers --------------------------------------------------------------
  const handleCompletion = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const tankId = Number(req.headers["x-barrel-tank"]);
    const seq = Number(req.headers["x-barrel-seq"]);
    const maxUnitsText = String(req.headers["x-barrel-max-units"] ?? "");
    const sig = String(req.headers["x-barrel-sig"] ?? "");
    if (!Number.isSafeInteger(tankId) || !Number.isSafeInteger(seq) || !/^\d{1,30}$/.test(maxUnitsText)) {
      throw new HttpError(401, "send x-barrel-tank, x-barrel-seq, x-barrel-max-units and x-barrel-sig");
    }
    const maxUnits = BigInt(maxUnitsText);
    if (busy.has(tankId)) throw new HttpError(409, "this tank already has a request in flight");
    busy.add(tankId);
    try {
      const tank = await barrel.tank(tankId);
      if (!tank || tank.series_id !== seriesId) throw new HttpError(404, `tank ${tankId} is not on series ${seriesId}`);
      if (tank.closed) throw new HttpError(402, "tank is closed");
      if (tank.accepted) throw new HttpError(402, "the client accepted this job; the tank is paying out its leftover");
      if (tank.unlock_at !== null) throw new HttpError(402, "tank is unlocking; top it up to keep using it");
      const now = Math.floor(Date.now() / 1000);
      if (now >= series.window_end - (config.expiryMarginSec ?? 60)) throw new HttpError(402, "series has expired");
      if (outstanding.has(tankId)) throw new HttpError(402, "acknowledge the previous answer first");

      const requestHash = sha256Hex(body);
      const auth = requestAuthText(barrel.contractId, tankId, seq, requestHash, maxUnits);
      if (!verifyEd25519(sig, auth, tank.key)) throw new HttpError(401, "request is not signed by the tank key");
      const queued = pending.get(tankId) ?? [];
      if (seq !== tank.next_seq + queued.length) {
        throw new HttpError(409, `expected sequence number ${tank.next_seq + queued.length}`);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      } catch {
        throw new HttpError(400, "body is not JSON");
      }
      if (parsed.model !== grade.model_id) throw new HttpError(400, `this series serves ${grade.model_id} only`);
      if (parsed.stream === true) {
        throw new HttpError(400, "streaming is not offered: a streamed answer is signed by the gateway, not by the model");
      }
      const maxTokens = Number(parsed.max_tokens ?? parsed.max_completion_tokens);
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > maxTokensLimit) {
        throw new HttpError(400, `set max_tokens between 1 and ${maxTokensLimit}`);
      }
      const worst = worstCaseUnits(body.length, maxTokens, grade.input_weight_bps);
      if (maxUnits < worst) throw new HttpError(400, `x-barrel-max-units must be at least ${worst}`);
      const available = BigInt(tank.balance) - pendingUnits(tankId);
      if (available < maxUnits) throw new HttpError(402, `tank holds ${available} units; this request may need ${maxUnits}`);

      // Forward the exact bytes. Nothing is re-serialized in either direction.
      const answer = await upstream.complete(body);
      if (answer.status !== 200) {
        res.writeHead(answer.status, { "content-type": answer.contentType });
        res.end(answer.body);
        return;
      }
      const answerJson = JSON.parse(Buffer.from(answer.body).toString("utf8"));
      const payload = await upstream.signature(String(answerJson.id), grade.model_id);
      if (!payload) throw new HttpError(502, "the model returned no signature for this answer; it is not billed");
      const receipt = receiptFromSignature(grade.id, grade.model_id, payload, { chatId: String(answerJson.id) });
      const local = checkReceipt(receipt, { request: body, response: answer.body });
      if (!local.valid) {
        stats.refused += 1;
        throw new HttpError(502, `upstream proof unusable (${local.verdict}); the answer is not billed`);
      }
      const accepted = await keyIsAccepted(receipt);
      if (!accepted.ok) {
        stats.refused += 1;
        throw new HttpError(502, `the contract would not accept this signature (${accepted.reason}); the answer is not billed`);
      }
      if (!answerJson.usage) throw new HttpError(502, "the signed answer has no usage; it is not billed");
      const metered = unitsFor(answerJson.usage, grade.input_weight_bps);
      const units = metered < maxUnits ? metered : maxUnits;

      outstanding.set(tankId, { seq, units, receipt, servedAt: now });
      save();
      stats.served += 1;
      log(`served tank ${tankId} seq ${seq}: ${units} units, awaiting ack`);
      res.writeHead(200, {
        "content-type": answer.contentType,
        "x-barrel-receipt": Buffer.from(JSON.stringify(receipt)).toString("base64"),
        "x-barrel-units": units.toString(),
        "x-barrel-seq": String(seq),
      });
      res.end(answer.body);
    } finally {
      busy.delete(tankId);
    }
  };

  const handleAck = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const input = JSON.parse(Buffer.from(await readBody(req)).toString("utf8")) as {
      tank_id: number;
      seq: number;
      ack_sig: string;
    };
    const o = outstanding.get(input.tank_id);
    if (!o || o.seq !== input.seq) throw new HttpError(404, "no answer is waiting for this ack");
    const tank = await barrel.tank(input.tank_id);
    if (!tank) throw new HttpError(404, "unknown tank");
    const text = ackText(barrel.contractId, input.tank_id, o.seq, o.receipt.request_hash, o.receipt.response_hash, o.units);
    if (typeof input.ack_sig !== "string" || !verifyEd25519(input.ack_sig, text, tank.key)) {
      throw new HttpError(400, "ack is not signed by the tank key for this answer and unit count");
    }
    const items = pending.get(input.tank_id) ?? [];
    items.push(settleItem(o.receipt, o.seq, o.units, input.ack_sig));
    pending.set(input.tank_id, items);
    outstanding.delete(input.tank_id);
    save();
    let settleTx: string | undefined;
    if (interval === 0) settleTx = (await flush()).at(-1);
    json(res, 200, { ok: true, queued: pending.get(input.tank_id)?.length ?? 0, settle_tx: settleTx });
  };

  const server = createServer((req, res) => {
    const route = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    // Browsers call the Pump straight from promptbarrel.com/app. Nothing here
    // relies on cookies or origin: every request is authorized by a tank-key signature.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-expose-headers", "x-barrel-receipt, x-barrel-units, x-barrel-seq");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-barrel-tank, x-barrel-seq, x-barrel-max-units, x-barrel-sig",
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }
    const run = async () => {
      if (route === "POST /v1/chat/completions") return handleCompletion(req, res);
      if (route === "POST /v1/ack") return handleAck(req, res);
      if (route === "GET /" || route === "GET /v1/info") return json(res, 200, info(barrel, series, grade, contractConfig.unlock_delay_sec, stats));
      throw new HttpError(404, "not found");
    };
    run().catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log(`error on ${route}: ${e instanceof Error ? e.message : e}`);
      if (!res.headersSent) json(res, status, { error: { message: e instanceof Error ? e.message : String(e) } });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(config.port, config.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const url = `http://${config.host ?? "127.0.0.1"}:${port}`;
  log(`pump for series ${seriesId} (${grade.model_id}) listening on ${url}`);

  return {
    url,
    server,
    flush,
    stats,
    close: async () => {
      if (timer) clearInterval(timer);
      await flush();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function info(barrel: Barrel, series: Series, grade: Grade, unlockDelay: number, stats: Pump["stats"]) {
  return {
    name: "barrel-pump",
    contract: barrel.contractId,
    series_id: series.id,
    operator: series.operator,
    grade_id: grade.id,
    model: grade.model_id,
    price_per_barrel: series.price_per_barrel,
    input_weight_bps: grade.input_weight_bps,
    window_end: series.window_end,
    unlock_delay_sec: unlockDelay,
    rule: "An answer is billed only with a model TEE signature that the contract verifies.",
    served: stats.served,
    settled_units: stats.settledUnits.toString(),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
