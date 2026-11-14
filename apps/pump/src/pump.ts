// The Pump: an operator's gateway in front of a TEE inference cloud.
//
// It serves a request only to a funded tank, hands back the model's exact
// bytes together with the model TEE's signature over them, and is paid only
// when the contract verifies that proof.
//
// One Pump serves every series its operator runs, one per model. What it does:
//
//   answers   forwards the exact request bytes, returns the exact answer
//             bytes and the receipt. An encrypted request passes through as
//             ciphertext the Pump cannot read.
//   settles   acknowledged answers go to `settle`.
//   claims    an answer nobody acknowledges is claimed on-chain with the
//             payer's own request authorization. The payer's ack still wins
//             inside the claim window.
//   402       a caller with a key and no funded tank is told exactly how to
//             pay: on NEAR, or from another chain through NEAR Intents. The
//             money goes to the contract, never to the Pump.
//   duty      on a firm series, requests sent through the chain and canaries
//             are answered before their deadline.
//   relay     keeps signed resale offers so buyers can find them.
//
// The Pump never holds a buyer's money.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  E2EE_HEADERS,
  attestAndRegister,
  buyRoom,
  fetchSignature,
  postCompletion,
  quoteBuy,
  registerOnChain,
  settleItem,
  tankBuyMsg,
  usdcOrigins,
  type Attestor,
  type Barrel,
  type Config,
  type Forced,
  type Grade,
  type Offer,
  type Series,
  type SettleItem,
  type UpstreamResponse,
  type Wallet,
} from "@barrel/sdk";
import {
  ackText,
  checkReceipt,
  normalizeHex,
  receiptFromSignature,
  requestAuthText,
  sha256Hex,
  unitsFor,
  usdcCeil,
  utf8,
  verifyEd25519,
  worstCaseUnits,
  type Receipt,
  type SignaturePayload,
} from "@barrel/verifier";

/** Where answers and their signatures come from. Replaceable in tests. */
export interface Upstream {
  /** `headers` carries the end-to-end encryption headers of a private request, if any. */
  complete(body: Uint8Array, headers?: Record<string, string>): Promise<UpstreamResponse>;
  signature(chatId: string, modelId: string): Promise<SignaturePayload | null>;
}

export function nearAiUpstream(apiKey: string): Upstream {
  return {
    complete: (body, headers) => postCompletion(apiKey, body, undefined, headers),
    signature: (chatId, modelId) => fetchSignature(apiKey, chatId, modelId),
  };
}

export interface PumpConfig {
  barrel: Barrel;
  /** The series this Pump serves: one per model. `seriesId` is the single-series form. */
  seriesIds?: number[];
  seriesId?: number;
  /** Pays the gas for `settle`. The USDC goes to the series operator regardless. */
  operator: Wallet;
  upstream: Upstream;
  port: number;
  host?: string;
  /** The address callers reach this Pump at, for the links in a 402 answer. */
  publicUrl?: string;
  /** 0 settles as soon as an ack arrives. Otherwise acks are batched. */
  settleIntervalMs?: number;
  /**
   * How long an answer may wait for its ack before the Pump claims it
   * on-chain. 0 turns claiming off. Default 2 minutes.
   */
  claimAfterMs?: number;
  /** How often open claims and forced requests are looked at. Default 5 seconds. */
  dutyIntervalMs?: number;
  /**
   * Optional registrar. When the model's signing key rotates, the Pump
   * re-checks the attestation and registers the new key. Without one, answers
   * signed by an unregistered key are not billed.
   */
  registrar?: { owner: Wallet; allowedComposeHashes?: string[]; evidenceDir?: string };
  /**
   * The attestor contract. With it the Pump registers a rotated key by
   * on-chain attestation, which needs no permission: the operator pays gas.
   */
  attestor?: Attestor;
  /** File that keeps earned-but-unsettled receipts across restarts. */
  journalFile?: string;
  maxTokensLimit?: number;
  /** Stop serving this long before the series ends, so settlement is never rushed. */
  expiryMarginSec?: number;
  /** A 1Click partner token, to quote cross-chain payments without the public fee. */
  oneClickJwt?: string;
  log?: (line: string) => void;
}

interface Outstanding {
  seq: number;
  units: bigint;
  receipt: Receipt;
  servedAt: number;
  /** The payer's request authorization: what a claim rests on. */
  maxUnits: bigint;
  authSig: string;
  /** Set once the answer was claimed on-chain. Unix seconds. */
  claimReadyAt?: number;
}

interface Journal {
  outstanding: Record<string, Omit<Outstanding, "units" | "maxUnits"> & { units: string; maxUnits: string }>;
  pending: Record<string, SettleItem[]>;
  offers?: Offer[];
}

export interface Pump {
  url: string;
  server: Server;
  /** Settles everything acknowledged so far. Returns the transaction hashes. */
  flush(): Promise<string[]>;
  /** Runs one round of claims and forced answers now. */
  duty(): Promise<void>;
  close(): Promise<void>;
  stats: { served: number; settledUnits: bigint; refused: number; claimed: number; forcedAnswered: number };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_ITEMS_PER_SETTLE = 40;
const MAX_FORCED_RESPONSE_BYTES = 16_384;
const MAX_OFFERS = 200;

interface Line {
  series: Series;
  grade: Grade;
}

export async function startPump(config: PumpConfig): Promise<Pump> {
  const { barrel, operator, upstream } = config;
  const log = config.log ?? (() => {});
  const ids = config.seriesIds ?? (config.seriesId !== undefined ? [config.seriesId] : []);
  if (ids.length === 0) throw new Error("the Pump needs at least one series");
  const lines = new Map<number, Line>();
  for (const id of ids) {
    const series = await barrel.series(id);
    if (!series) throw new Error(`series ${id} does not exist`);
    lines.set(id, { series, grade: (await barrel.grade(series.grade_id))! });
  }
  const contractConfig: Config = await barrel.config();
  const maxTokensLimit = config.maxTokensLimit ?? 4096;
  const claimAfterMs = config.claimAfterMs ?? 120_000;
  const mainnet = barrel.chain.net.name === "mainnet";

  const outstanding = new Map<number, Outstanding>();
  const pending = new Map<number, SettleItem[]>();
  const busy = new Set<number>();
  let offers: Offer[] = [];
  const stats = { served: 0, settledUnits: 0n, refused: 0, claimed: 0, forcedAnswered: 0 };

  // --- journal ---------------------------------------------------------------
  const save = () => {
    if (!config.journalFile) return;
    const journal: Journal = { outstanding: {}, pending: {}, offers };
    for (const [id, o] of outstanding) journal.outstanding[id] = { ...o, units: o.units.toString(), maxUnits: o.maxUnits.toString() };
    for (const [id, items] of pending) if (items.length) journal.pending[id] = items;
    mkdirSync(dirname(config.journalFile), { recursive: true });
    writeFileSync(config.journalFile, JSON.stringify(journal, null, 1));
  };
  if (config.journalFile && existsSync(config.journalFile)) {
    const journal = JSON.parse(readFileSync(config.journalFile, "utf8")) as Journal;
    for (const [id, o] of Object.entries(journal.outstanding ?? {})) {
      // An entry written before claims existed has no authorization: it can be acked, not claimed.
      outstanding.set(Number(id), { ...o, units: BigInt(o.units), maxUnits: BigInt(o.maxUnits ?? "0"), authSig: o.authSig ?? "" });
    }
    for (const [id, items] of Object.entries(journal.pending ?? {})) pending.set(Number(id), items);
    offers = journal.offers ?? [];
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
  const keyIsAccepted = async (receipt: Receipt, grade: Grade): Promise<{ ok: boolean; reason: string }> => {
    let check = await barrel.verifyReceipt(receipt);
    if (check.signature_ok && (!check.key_registered || !check.key_live) && (config.attestor || config.registrar)) {
      // The model's key changed or is about to lapse. Attest again, then look again.
      log(`key ${receipt.signing_address.slice(0, 12)}… is not live on-chain; re-attesting ${grade.model_id}`);
      try {
        if (config.attestor) {
          await registerOnChain(config.attestor, barrel, operator, grade.id, { evidenceDir: config.registrar?.evidenceDir });
        } else {
          await attestAndRegister(barrel, config.registrar!.owner, grade.id, {
            allowedComposeHashes: config.registrar!.allowedComposeHashes,
            evidenceDir: config.registrar!.evidenceDir,
          });
        }
        check = await barrel.verifyReceipt(receipt);
      } catch (e) {
        return { ok: false, reason: `re-attestation failed: ${e instanceof Error ? e.message : e}` };
      }
    }
    return { ok: check.valid && check.key_live, reason: check.reason ?? (check.key_live ? "" : "key expired") };
  };

  /** Asks the model and returns the answer with a receipt the contract accepts. */
  const prove = async (line: Line, body: Uint8Array, headers?: Record<string, string>) => {
    const answer = await upstream.complete(body, headers);
    if (answer.status !== 200) return { answer };
    const answerJson = JSON.parse(Buffer.from(answer.body).toString("utf8"));
    const payload = await upstream.signature(String(answerJson.id), line.grade.model_id);
    if (!payload) throw new HttpError(502, "the model returned no signature for this answer; it is not billed");
    const receipt = receiptFromSignature(line.grade.id, line.grade.model_id, payload, { chatId: String(answerJson.id) });
    const local = checkReceipt(receipt, { request: body, response: answer.body });
    if (!local.valid) {
      stats.refused += 1;
      throw new HttpError(502, `upstream proof unusable (${local.verdict}); the answer is not billed`);
    }
    const accepted = await keyIsAccepted(receipt, line.grade);
    if (!accepted.ok) {
      stats.refused += 1;
      throw new HttpError(502, `the contract would not accept this signature (${accepted.reason}); the answer is not billed`);
    }
    if (!answerJson.usage) throw new HttpError(502, "the signed answer has no usage; it is not billed");
    return { answer, receipt, usage: answerJson.usage as { prompt_tokens: number; completion_tokens: number } };
  };

  // --- 402: how to pay ---------------------------------------------------------
  const lineForModel = (model: unknown): Line | undefined => {
    const now = Math.floor(Date.now() / 1000);
    const open = [...lines.values()].filter((l) => l.grade.model_id === model && now < l.series.window_end);
    // Several series of one model: the cheapest serves.
    return open.sort((a, b) => (BigInt(a.series.price_per_barrel) < BigInt(b.series.price_per_barrel) ? -1 : 1))[0];
  };

  const paymentOffers = async (req: IncomingMessage, line: Line, key: string, reason: string): Promise<Record<string, unknown>> => {
    const series = (await barrel.series(line.series.id)) ?? line.series;
    const minUsdc = usdcCeil(BigInt(contractConfig.min_tank_buy_units), BigInt(series.price_per_barrel));
    const wanted = BigInt(/^\d{1,18}$/.test(String(req.headers["x-barrel-pay"] ?? "")) ? String(req.headers["x-barrel-pay"]) : "1000000");
    const room = buyRoom(series, contractConfig, await barrel.totalEscrow());
    let amount = wanted < minUsdc ? minUsdc : wanted;
    if (amount > room) amount = room;
    const base = config.publicUrl ?? url;
    const msg = tankBuyMsg(series.id, key);
    const common = {
      scheme: "exact",
      resource: `${base}/v1/chat/completions`,
      description: `Prepaid ${line.grade.model_id} inference: Barrels in a tank owned by key ${key.slice(0, 12)}…, paid out only against the model's own signature`,
      mimeType: "application/json",
      maxTimeoutSeconds: 600,
    };
    const extra = {
      contract: barrel.contractId,
      series_id: series.id,
      model: line.grade.model_id,
      price_per_barrel: series.price_per_barrel,
      tank_key: key,
      min_amount: minUsdc.toString(),
      /** Poll this until it returns a tank, then send the request again with the tank headers. */
      tank: `${base}/v1/tank?key=${key}`,
    };
    const accepts: Record<string, unknown>[] = [];
    if (amount > 0n) {
      accepts.push({
        ...common,
        network: `near-${barrel.chain.net.name}`,
        asset: barrel.usdcId,
        payTo: barrel.contractId,
        maxAmountRequired: amount.toString(),
        extra: { ...extra, method: "ft_transfer_call", msg },
      });
      // From another chain: the deposit address belongs to NEAR Intents, and
      // what it delivers is the same purchase into the same tank.
      const from = String(req.headers["x-barrel-pay-from"] ?? "");
      const refundTo = String(req.headers["x-barrel-refund-to"] ?? "");
      if (mainnet && from && refundTo) {
        try {
          const origin = (await usdcOrigins()).find((t) => t.blockchain === from);
          if (origin) {
            const q = await quoteBuy({
              originAsset: origin.assetId,
              amount,
              refundTo,
              contract: barrel.contractId,
              usdc: barrel.usdcId,
              seriesId: series.id,
              tankKey: key,
              jwt: config.oneClickJwt,
            });
            accepts.push({
              ...common,
              network: from,
              asset: origin.contractAddress ?? origin.assetId,
              payTo: q.depositAddress,
              maxAmountRequired: q.amountIn,
              extra: { ...extra, via: "near-intents-1click", delivers: q.minAmountOut, deadline: q.deadline, refund_to: refundTo, msg },
            });
          }
        } catch (e) {
          log(`no cross-chain quote from ${from}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    return { x402Version: 1, error: reason, accepts };
  };

  // --- handlers --------------------------------------------------------------
  const handleCompletion = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      throw new HttpError(400, "body is not JSON");
    }

    // A caller with a key and no tank yet: say how to pay.
    if (req.headers["x-barrel-tank"] === undefined) {
      const key = normalizeHex(String(req.headers["x-barrel-key"] ?? ""), 32);
      if (!key) throw new HttpError(401, "send x-barrel-tank, x-barrel-seq, x-barrel-max-units and x-barrel-sig; or x-barrel-key to learn how to pay");
      const line = lineForModel(parsed.model);
      if (!line) throw new HttpError(400, `this Pump serves ${[...new Set([...lines.values()].map((l) => l.grade.model_id))].join(", ")}`);
      const tank = await barrel.tankForKey(key);
      if (tank && !tank.closed && lines.has(tank.series_id)) {
        throw new HttpError(409, `this key owns tank ${tank.id}; sign the request with it`, { tank_id: tank.id });
      }
      const offer = await paymentOffers(req, line, key, "this key has no funded tank");
      throw new HttpError(402, "this key has no funded tank", offer);
    }

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
      const line = tank ? lines.get(tank.series_id) : undefined;
      if (!tank || !line) throw new HttpError(404, `tank ${tankId} is not on a series this Pump serves (${ids.join(", ")})`);
      const { series, grade } = line;
      if (tank.closed) throw new HttpError(402, "tank is closed");
      if (tank.accepted) throw new HttpError(402, "the client accepted this job; the tank is paying out its leftover");
      if (tank.unlock_at !== null) throw new HttpError(402, "tank is unlocking; top it up to keep using it");
      const now = Math.floor(Date.now() / 1000);
      if (now >= series.window_end - (config.expiryMarginSec ?? 60)) throw new HttpError(402, "series has expired");
      if (outstanding.has(tankId)) throw new HttpError(402, "acknowledge the previous answer first");
      if (tank.claim) throw new HttpError(402, "a claim is open on this tank; acknowledge that answer first");

      const requestHash = sha256Hex(body);
      const auth = requestAuthText(barrel.contractId, tankId, seq, requestHash, maxUnits);
      if (!verifyEd25519(sig, auth, tank.key)) throw new HttpError(401, "request is not signed by the tank key");
      const queued = pending.get(tankId) ?? [];
      if (seq !== tank.next_seq + queued.length) {
        throw new HttpError(409, `expected sequence number ${tank.next_seq + queued.length}`);
      }

      if (parsed.model !== grade.model_id) throw new HttpError(400, `this tank's series serves ${grade.model_id} only`);
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
      if (available < maxUnits) {
        const reason = `tank holds ${available} units; this request may need ${maxUnits}`;
        // A tank its own key owns can be topped up by anyone, the same way it was opened.
        const offer = tank.owner === tank.key ? await paymentOffers(req, line, tank.key, reason) : undefined;
        throw new HttpError(402, reason, offer);
      }

      // Forward the exact bytes. Nothing is re-serialized in either direction.
      // A private request arrives encrypted to the model: its headers name
      // the keys and pass through untouched.
      const e2ee: Record<string, string> = {};
      for (const h of E2EE_HEADERS) if (typeof req.headers[h] === "string") e2ee[h] = req.headers[h] as string;
      const proven = await prove(line, body, Object.keys(e2ee).length ? e2ee : undefined);
      if (!proven.receipt) {
        res.writeHead(proven.answer.status, { "content-type": proven.answer.contentType });
        res.end(proven.answer.body);
        return;
      }
      const metered = unitsFor(proven.usage, grade.input_weight_bps);
      const units = metered < maxUnits ? metered : maxUnits;

      outstanding.set(tankId, { seq, units, receipt: proven.receipt, servedAt: now, maxUnits, authSig: sig });
      save();
      stats.served += 1;
      log(`served tank ${tankId} seq ${seq}: ${units} units, awaiting ack`);
      res.writeHead(200, {
        "content-type": proven.answer.contentType,
        "x-barrel-receipt": Buffer.from(JSON.stringify(proven.receipt)).toString("base64"),
        "x-barrel-units": units.toString(),
        "x-barrel-seq": String(seq),
      });
      res.end(proven.answer.body);
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
    // An ack that arrives after a claim was filed replaces the claim on-chain.
    const items = pending.get(input.tank_id) ?? [];
    items.push(settleItem(o.receipt, o.seq, o.units, input.ack_sig));
    pending.set(input.tank_id, items);
    outstanding.delete(input.tank_id);
    save();
    let settleTx: string | undefined;
    if (interval === 0 || o.claimReadyAt !== undefined) settleTx = (await flush()).at(-1);
    json(res, 200, { ok: true, queued: pending.get(input.tank_id)?.length ?? 0, settle_tx: settleTx });
  };

  /** The tank a key owns, so a caller that just paid can find it. */
  const handleTank = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const key = normalizeHex(new URL(req.url ?? "/", "http://x").searchParams.get("key") ?? "", 32);
    if (!key) throw new HttpError(400, "pass ?key=<64 hex characters>");
    const tank = await barrel.tankForKey(key);
    if (!tank) throw new HttpError(404, "no tank for this key yet");
    json(res, 200, { tank_id: tank.id, series_id: tank.series_id, balance: tank.balance, next_seq: tank.next_seq, served_here: lines.has(tank.series_id) });
  };

  // --- resale relay ------------------------------------------------------------
  const liveOffers = () => {
    const now = Date.now();
    offers = offers.filter((o) => Date.parse(o.deadline) > now);
    return offers;
  };
  const handleOfferPost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const offer = JSON.parse(Buffer.from(await readBody(req)).toString("utf8")) as Offer;
    const ok =
      offer &&
      typeof offer.id === "string" &&
      offer.contract === barrel.contractId &&
      Number.isSafeInteger(offer.series_id) &&
      /^\d+$/.test(offer.units ?? "") &&
      /^\d+$/.test(offer.price ?? "") &&
      Date.parse(offer.deadline) > Date.now() &&
      offer.signed?.standard === "nep413" &&
      typeof offer.signed.payload?.message === "string" &&
      offer.signed.payload.message.length < 4000;
    if (!ok) throw new HttpError(400, "not an offer for this contract");
    // The relay only carries offers. The buyer checks the signed terms, and
    // the Verifier checks the signature: a false offer cannot settle.
    liveOffers();
    if (!offers.some((o) => o.id === offer.id)) offers.push(offer);
    if (offers.length > MAX_OFFERS) offers = offers.slice(-MAX_OFFERS);
    save();
    json(res, 200, { ok: true, id: offer.id });
  };
  const handleOfferDelete = (req: IncomingMessage, res: ServerResponse): void => {
    const id = (req.url ?? "").split("?")[0]!.split("/").pop();
    offers = offers.filter((o) => o.id !== id);
    save();
    json(res, 200, { ok: true });
  };

  // --- duty: claims, and the answers a firm series owes --------------------------
  const forcedInFlight = new Set<number>();
  const answerForced = async (line: Line, f: Forced): Promise<void> => {
    const proven = await prove(line, utf8(f.body));
    if (!proven.receipt) throw new Error(`the model answered HTTP ${proven.answer.status}`);
    if (proven.answer.body.length > MAX_FORCED_RESPONSE_BYTES) throw new Error("the answer is larger than the contract takes");
    const text = Buffer.from(proven.answer.body).toString("utf8");
    const out = await barrel.answerForced(operator, f.id, text, proven.receipt.signing_address, proven.receipt.signature);
    stats.forcedAnswered += 1;
    stats.settledUnits += out.value;
    log(`answered ${f.tank_id === null ? "canary" : "forced request"} ${f.id} on series ${f.series_id}: ${out.value} units, tx ${out.txHash}`);
  };

  const dutyNow = async (): Promise<void> => {
    const now = Math.floor(Date.now() / 1000);
    // 1. Answers nobody acknowledged.
    for (const [tankId, o] of outstanding) {
      try {
        if (o.claimReadyAt === undefined) {
          if (claimAfterMs === 0 || !o.authSig || (now - o.servedAt) * 1000 < claimAfterMs) continue;
          const out = await barrel.claimUnacked(operator, {
            tankId,
            seq: o.seq,
            requestHash: o.receipt.request_hash,
            maxUnits: o.maxUnits,
            authSig: o.authSig,
            responseHash: o.receipt.response_hash,
            teeKey: o.receipt.signing_address,
            teeSig: o.receipt.signature,
          });
          o.claimReadyAt = out.value;
          stats.claimed += 1;
          save();
          log(`claimed tank ${tankId} seq ${o.seq}: no ack came; ${o.maxUnits} units payable from ${new Date(out.value * 1000).toISOString()} unless the payer acknowledges`);
        } else if (now >= o.claimReadyAt) {
          const out = await barrel.finalizeClaim(operator, tankId);
          stats.settledUnits += out.value;
          outstanding.delete(tankId);
          save();
          log(`claim on tank ${tankId} seq ${o.seq} paid ${out.value} units, tx ${out.txHash}`);
        }
      } catch (e) {
        log(`claim on tank ${tankId} seq ${o.seq}: ${e instanceof Error ? e.message : e}`);
        // Settled or resolved some other way: nothing is owed for it any more.
        const tank = await barrel.tank(tankId).catch(() => null);
        if (tank && (tank.next_seq > o.seq || tank.closed)) {
          outstanding.delete(tankId);
          save();
        }
      }
    }
    // 2. Requests sent through the chain to a firm series, and canaries.
    for (const line of lines.values()) {
      if (!line.series.firm) continue;
      const open = await barrel.openForced(line.series.id).catch(() => [] as Forced[]);
      for (const f of open) {
        if (forcedInFlight.has(f.id)) continue;
        forcedInFlight.add(f.id);
        try {
          await answerForced(line, f);
        } catch (e) {
          log(`forced request ${f.id}: ${e instanceof Error ? e.message : e}`);
        } finally {
          forcedInFlight.delete(f.id);
        }
      }
    }
  };
  let dutyRun: Promise<void> = Promise.resolve();
  const duty = (): Promise<void> => {
    dutyRun = dutyRun.then(dutyNow, dutyNow);
    return dutyRun;
  };
  const dutyInterval = config.dutyIntervalMs ?? 5000;
  const dutyTimer = dutyInterval > 0 ? setInterval(() => void duty().catch(() => {}), dutyInterval) : undefined;
  dutyTimer?.unref();

  // --- info ------------------------------------------------------------------
  const info = async () => {
    const list = [];
    for (const { series, grade } of lines.values()) {
      const index = await barrel.index(grade.id).catch(() => null);
      list.push({
        series_id: series.id,
        grade_id: grade.id,
        model: grade.model_id,
        price_per_barrel: series.price_per_barrel,
        input_weight_bps: grade.input_weight_bps,
        window_end: series.window_end,
        firm: series.firm ? { bond: series.firm.bond, respond_sec: series.firm.respond_sec } : null,
        index_price_per_barrel: index?.price_per_barrel ?? "0",
      });
    }
    const first = list[0]!;
    return {
      name: "barrel-pump",
      contract: barrel.contractId,
      operator: [...lines.values()][0]!.series.operator,
      series: list,
      // The single-series fields, for callers written before a Pump served several models.
      series_id: first.series_id,
      grade_id: first.grade_id,
      model: first.model,
      price_per_barrel: first.price_per_barrel,
      input_weight_bps: first.input_weight_bps,
      window_end: first.window_end,
      unlock_delay_sec: contractConfig.unlock_delay_sec,
      claim_window_sec: contractConfig.claim_window_sec,
      rule: "An answer is billed only with a model TEE signature that the contract verifies.",
      served: stats.served,
      settled_units: stats.settledUnits.toString(),
    };
  };
  const models = () => ({
    object: "list",
    data: [...lines.values()].map(({ series, grade }) => ({
      id: grade.model_id,
      object: "model",
      owned_by: series.operator,
      barrel: { series_id: series.id, grade_id: grade.id, price_per_barrel: series.price_per_barrel, input_weight_bps: grade.input_weight_bps },
    })),
  });

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const route = `${req.method} ${path}`;
    // Browsers call the Pump straight from promptbarrel.com/app. Nothing here
    // relies on cookies or origin: every request is authorized by a tank-key signature.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-expose-headers", "x-barrel-receipt, x-barrel-units, x-barrel-seq");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": `content-type, x-barrel-tank, x-barrel-seq, x-barrel-max-units, x-barrel-sig, x-barrel-key, x-barrel-pay, x-barrel-pay-from, x-barrel-refund-to, ${E2EE_HEADERS.join(", ")}`,
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }
    const run = async () => {
      if (route === "POST /v1/chat/completions") return handleCompletion(req, res);
      if (route === "POST /v1/ack") return handleAck(req, res);
      if (route === "GET /v1/tank") return handleTank(req, res);
      if (route === "GET /v1/models") return json(res, 200, models());
      if (route === "GET /v1/offers") return json(res, 200, { offers: liveOffers() });
      if (route === "POST /v1/offers") return handleOfferPost(req, res);
      if (req.method === "DELETE" && path.startsWith("/v1/offers/")) return handleOfferDelete(req, res);
      if (route === "GET /" || route === "GET /v1/info") return json(res, 200, await info());
      throw new HttpError(404, "not found");
    };
    run().catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log(`error on ${route}: ${e instanceof Error ? e.message : e}`);
      const message = e instanceof Error ? e.message : String(e);
      // A 402 carries its payment offers; x402 puts the reason in `error` as text.
      const extra = e instanceof HttpError ? e.body : undefined;
      if (!res.headersSent) json(res, status, { error: { message }, ...extra, message });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(config.port, config.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const url = `http://${config.host ?? "127.0.0.1"}:${port}`;
  log(`pump for series ${ids.join(", ")} (${[...lines.values()].map((l) => l.grade.model_id).join(", ")}) listening on ${url}`);

  return {
    url,
    server,
    flush,
    duty,
    stats,
    close: async () => {
      if (timer) clearInterval(timer);
      if (dutyTimer) clearInterval(dutyTimer);
      await flush();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
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
