// Checks on a NEAR AI Cloud model attestation report.
//
// These are the admission checks a key must pass before Barrel's registrar
// registers it for a grade. They need no API key, so anyone can repeat them.

import * as qvl from "@phala/dcap-qvl";
import { bytesToHex, hexToBytes, normalizeHex, sha256Hex, sha384Bytes, utf8 } from "./crypto.ts";
import type { Check } from "./receipt.ts";

export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai";

/** One entry of `model_attestations[]` (or `gateway_attestation`). */
export interface AttestationCandidate {
  model_name?: string;
  signing_address: string;
  signing_algo: string;
  request_nonce: string;
  intel_quote: string;
  event_log: EventLogEntry[] | string;
  info: { tcb_info: TcbInfo | string; compose_hash?: string; app_id?: string; instance_id?: string };
  nvidia_payload?: string;
}

export interface EventLogEntry {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

export interface TcbInfo {
  app_compose: string;
  rtmr3?: string;
  compose_hash?: string;
}

export interface AttestationReport {
  gateway_attestation?: AttestationCandidate;
  model_attestations?: AttestationCandidate[];
}

export interface TdQuoteFields {
  version: number;
  teeType: number;
  mrTd: string;
  mrConfigId: string;
  rtmr: [string, string, string, string];
  reportData: string;
}

export interface CandidateResult {
  ok: boolean;
  signing_address: string;
  compose_hash: string;
  tcb_status?: string;
  advisory_ids?: string[];
  checks: Check[];
}

const TD_HEADER = 48;
const TD_BODY_V4 = 584;

/** Reads the fields Barrel needs from a version 4 Intel TDX quote. */
export function parseTdQuote(quoteHex: string): TdQuoteFields {
  const q = hexToBytes(quoteHex);
  if (q.length < TD_HEADER + TD_BODY_V4) throw new Error("quote too short");
  const view = new DataView(q.buffer, q.byteOffset, q.byteLength);
  const version = view.getUint16(0, true);
  const teeType = view.getUint32(4, true);
  if (version !== 4) throw new Error(`unsupported quote version ${version}`);
  if (teeType !== 0x81) throw new Error(`not a TDX quote (tee type 0x${teeType.toString(16)})`);
  const body = q.subarray(TD_HEADER, TD_HEADER + TD_BODY_V4);
  const field = (offset: number, len: number) => bytesToHex(body.subarray(offset, offset + len));
  return {
    version,
    teeType,
    mrTd: field(136, 48),
    mrConfigId: field(184, 48),
    rtmr: [field(328, 48), field(376, 48), field(424, 48), field(472, 48)],
    reportData: field(520, 64),
  };
}

function eventLogOf(candidate: AttestationCandidate): EventLogEntry[] {
  return typeof candidate.event_log === "string" ? JSON.parse(candidate.event_log) : candidate.event_log;
}

function tcbInfoOf(candidate: AttestationCandidate): TcbInfo {
  const t = candidate.info.tcb_info;
  return typeof t === "string" ? JSON.parse(t) : t;
}

/**
 * Replays the runtime event log into RTMR3.
 * Boot events carry their digest. Runtime (dstack) events do not, so their
 * digest is recomputed as sha384(event_type_le || ":" || name || ":" || payload),
 * which is what makes the payloads (app id, compose hash, ...) trustworthy.
 */
export function replayRtmr(events: EventLogEntry[], imr: number): string {
  let mr: Uint8Array = new Uint8Array(48);
  for (const e of events) {
    if (e.imr !== imr) continue;
    let digest: Uint8Array;
    if (e.digest) {
      digest = hexToBytes(e.digest);
    } else {
      const type = new Uint8Array(4);
      new DataView(type.buffer).setUint32(0, e.event_type, true);
      digest = sha384Bytes(concat(type, utf8(":"), utf8(e.event), utf8(":"), hexToBytes(e.event_payload)));
    }
    const padded = new Uint8Array(48);
    padded.set(digest.subarray(0, 48));
    mr = sha384Bytes(concat(mr, padded));
  }
  return bytesToHex(mr);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** TCB statuses accepted by default. Anything else fails the quote check. */
export const ACCEPTED_TCB_STATUS: readonly string[] = [
  "UpToDate",
  "SWHardeningNeeded",
  "ConfigurationNeeded",
  "ConfigurationAndSWHardeningNeeded",
];

export interface CheckOptions {
  /** The nonce we sent with the report request. */
  nonce: string;
  /** Expected canonical model ID, when checking a model candidate. */
  modelId?: string;
  /** Reviewed compose hashes for the grade. Empty or missing means "not enforced". */
  allowedComposeHashes?: string[];
  /**
   * Intel collateral for the quote. When given, verification is fully offline
   * and deterministic at `nowSecs`. When omitted, it is fetched from a PCCS.
   */
  collateral?: unknown;
  nowSecs?: number;
  /** Skip Intel DCAP verification entirely. The result then says so. */
  skipDcap?: boolean;
}

/** Runs every structural check plus Intel DCAP verification on one candidate. */
export async function checkCandidate(
  candidate: AttestationCandidate,
  options: CheckOptions,
): Promise<CandidateResult> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const address = normalizeHex(candidate.signing_address, 32);
  add(
    "signing identity is an Ed25519 public key",
    candidate.signing_algo === "ed25519" && address !== null,
    `signing_algo ${candidate.signing_algo}, address ${candidate.signing_address}`,
  );
  if (options.modelId !== undefined) {
    add("report is for the expected model", candidate.model_name === options.modelId, `model_name ${candidate.model_name}`);
  }
  const nonce = options.nonce.toLowerCase();
  add("report echoes our nonce", candidate.request_nonce?.toLowerCase() === nonce, `request_nonce ${candidate.request_nonce}`);

  let quote: TdQuoteFields | undefined;
  try {
    quote = parseTdQuote(candidate.intel_quote);
    add("quote is an Intel TDX v4 quote", true, `MRTD ${quote.mrTd.slice(0, 16)}…`);
  } catch (e) {
    add("quote is an Intel TDX v4 quote", false, String(e));
  }

  const tcb = tcbInfoOf(candidate);
  const composeHash = sha256Hex(tcb.app_compose);

  if (quote) {
    add(
      "report data binds the signing key and our nonce",
      address !== null && quote.reportData === `${address}${nonce}`,
      `report_data ${quote.reportData.slice(0, 16)}…${quote.reportData.slice(-8)}`,
    );
    add(
      "MRCONFIGID commits to the app compose file",
      quote.mrConfigId === `01${composeHash}${"00".repeat(15)}`,
      `sha256(app_compose) ${composeHash}`,
    );
    const events = eventLogOf(candidate);
    add("event log replays to RTMR3", replayRtmr(events, 3) === quote.rtmr[3], `RTMR3 ${quote.rtmr[3].slice(0, 16)}…`);
    const composeEvent = events.find((e) => e.imr === 3 && e.event === "compose-hash");
    add(
      "measured compose-hash event matches the compose file",
      composeEvent?.event_payload === composeHash,
      `event payload ${composeEvent?.event_payload ?? "missing"}`,
    );
  }

  if (options.allowedComposeHashes && options.allowedComposeHashes.length > 0) {
    add(
      "compose hash is on the grade's reviewed list",
      options.allowedComposeHashes.includes(composeHash),
      `compose hash ${composeHash}`,
    );
  }

  let tcbStatus: string | undefined;
  let advisoryIds: string[] | undefined;
  if (options.skipDcap) {
    add("Intel DCAP quote verification", false, "NOT CHECKED (skipped)");
  } else {
    try {
      const raw = hexToBytes(candidate.intel_quote);
      const now = options.nowSecs ?? Math.floor(Date.now() / 1000);
      const collateral = (options.collateral ?? (await qvl.getCollateral(qvl.PHALA_PCCS_URL, raw))) as qvl.Collateral;
      const verified = qvl.verify(raw, collateral, now);
      tcbStatus = verified.status;
      advisoryIds = verified.advisory_ids;
      add(
        "Intel DCAP quote verification",
        ACCEPTED_TCB_STATUS.includes(verified.status),
        `TCB status ${verified.status}${advisoryIds.length ? `, advisories ${advisoryIds.join(", ")}` : ""}`,
      );
    } catch (e) {
      add("Intel DCAP quote verification", false, `failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    signing_address: address ?? candidate.signing_address,
    compose_hash: composeHash,
    tcb_status: tcbStatus,
    advisory_ids: advisoryIds,
    checks,
  };
}

/** Fetches a model attestation report. No API key is needed. */
export async function fetchAttestationReport(
  modelId: string,
  nonce: string,
  baseUrl: string = NEAR_AI_BASE_URL,
): Promise<{ report: AttestationReport; raw: string }> {
  const url = new URL("/v1/attestation/report", baseUrl);
  url.searchParams.set("model", modelId);
  url.searchParams.set("provider", "near");
  url.searchParams.set("include_tls_fingerprint", "false");
  url.searchParams.set("signing_algo", "ed25519");
  url.searchParams.set("nonce", nonce);
  const res = await fetch(url, { headers: { accept: "application/json", "x-no-aliasing": "true" } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`attestation report: HTTP ${res.status} ${raw.slice(0, 200)}`);
  return { report: JSON.parse(raw) as AttestationReport, raw };
}

/**
 * Verifies every candidate in `model_attestations[]`, as NEAR AI's docs
 * require before trusting the model's signing key. Fails on an empty list.
 */
export async function checkModelReport(
  report: AttestationReport,
  options: CheckOptions,
): Promise<{ ok: boolean; candidates: CandidateResult[] }> {
  const list = report.model_attestations ?? [];
  if (list.length === 0) return { ok: false, candidates: [] };
  const candidates: CandidateResult[] = [];
  for (const candidate of list) candidates.push(await checkCandidate(candidate, options));
  return { ok: candidates.every((c) => c.ok), candidates };
}

/** Collateral holds byte arrays; these helpers round-trip it through JSON for fixtures. */
export function collateralToJson(collateral: unknown): string {
  return JSON.stringify(collateral, (_k, v) => (v instanceof Uint8Array ? { __hex: bytesToHex(v) } : v), 1);
}

export function collateralFromJson(json: string): unknown {
  return JSON.parse(json, (_k, v) => {
    if (v && typeof v === "object" && typeof v.__hex === "string") return Buffer.from(v.__hex, "hex");
    if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data);
    return v;
  });
}

export async function fetchCollateral(quoteHex: string): Promise<unknown> {
  return qvl.getCollateral(qvl.PHALA_PCCS_URL, hexToBytes(quoteHex));
}
