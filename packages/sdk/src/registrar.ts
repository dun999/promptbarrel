// The registrar: checks a model's attestation and registers its signing key.
//
// In v1 this runs off-chain under the contract owner's account. The evidence
// it acted on is saved and its hash is stored with the key, so anyone can
// repeat the checks later (`barrel audit`).

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkModelReport,
  collateralToJson,
  fetchAttestationReport,
  fetchCollateral,
  sha256Hex,
  type AttestationCandidate,
  type CandidateResult,
} from "@barrel/verifier";
import type { Attestor } from "./attestor.ts";
import type { Barrel, KeyInfo } from "./barrel.ts";
import type { Wallet } from "./chain.ts";

export interface AttestOutcome {
  ok: boolean;
  modelId: string;
  nonce: string;
  evidenceHash: string;
  /** Raw report bytes exactly as fetched. `evidenceHash` is their SHA-256. */
  raw: string;
  collateralJson: string;
  checkedAt: number;
  candidates: CandidateResult[];
}

/** Fetches a fresh attestation report for a model and runs every check. No keys needed. */
export async function attestModel(
  modelId: string,
  opts: { allowedComposeHashes?: string[] } = {},
): Promise<AttestOutcome> {
  const nonce = randomBytes(32).toString("hex");
  const { report, raw } = await fetchAttestationReport(modelId, nonce);
  const first = report.model_attestations?.[0];
  if (!first) throw new Error(`no model attestation returned for ${modelId}`);
  // Each machine's quote is checked against Intel's collateral for that machine.
  const collaterals = new Map<string, unknown>();
  for (const c of report.model_attestations!) collaterals.set(c.intel_quote, await fetchCollateral(c.intel_quote));
  const collateral = collaterals.get(first.intel_quote);
  const checkedAt = Math.floor(Date.now() / 1000);
  const result = await checkModelReport(report, {
    nonce,
    modelId,
    collateralFor: (c) => collaterals.get(c.intel_quote),
    nowSecs: checkedAt,
    allowedComposeHashes: opts.allowedComposeHashes,
  });
  return {
    ok: result.ok,
    modelId,
    nonce,
    evidenceHash: sha256Hex(raw),
    raw,
    collateralJson: collateralToJson(collateral),
    checkedAt,
    candidates: result.candidates,
  };
}

export function saveEvidence(dir: string, outcome: AttestOutcome): string {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, outcome.evidenceHash);
  writeFileSync(`${base}.json`, outcome.raw);
  writeFileSync(`${base}.nonce`, `${outcome.nonce}\n`);
  writeFileSync(`${base}.collateral.json`, `{"fetched_at": ${outcome.checkedAt}, "collateral": ${outcome.collateralJson}}\n`);
  return `${base}.json`;
}

export interface RegisterResult {
  outcome: AttestOutcome;
  /** Keys added or renewed by this run. */
  registered: KeyInfo[];
  /** Keys that were already registered with plenty of lifetime left. */
  unchanged: string[];
}

/**
 * Attests the grade's model and registers every signing key that passed.
 * Refuses to register anything if any candidate fails a check.
 */
export async function attestAndRegister(
  barrel: Barrel,
  owner: Wallet,
  gradeId: string,
  opts: { allowedComposeHashes?: string[]; evidenceDir?: string } = {},
): Promise<RegisterResult> {
  const grade = await barrel.grade(gradeId);
  if (!grade) throw new Error(`unknown grade ${gradeId}`);
  const outcome = await attestModel(grade.model_id, { allowedComposeHashes: opts.allowedComposeHashes });
  if (!outcome.ok) {
    const failed = outcome.candidates.flatMap((c) => c.checks.filter((k) => !k.ok).map((k) => `${k.name}: ${k.detail}`));
    throw new Error(`attestation failed for ${grade.model_id}; no key registered. ${failed.join("; ")}`);
  }
  if (opts.evidenceDir) saveEvidence(opts.evidenceDir, outcome);

  const now = Math.floor(Date.now() / 1000);
  const existing = await barrel.keys(gradeId);
  const registered: KeyInfo[] = [];
  const unchanged: string[] = [];
  for (const candidate of outcome.candidates) {
    const current = existing.find((k) => k.key === candidate.signing_address);
    // Renew once less than half the lifetime is left.
    if (current && current.expires_at - now > grade.key_ttl_sec / 2) {
      unchanged.push(candidate.signing_address);
      continue;
    }
    const added = await barrel.addKey(owner, gradeId, candidate.signing_address, outcome.evidenceHash);
    registered.push(added.value);
  }
  return { outcome, registered, unchanged };
}

/**
 * Registers a grade's model keys through the attestor contract, which
 * verifies the attestation on-chain. `anyone` only pays gas: no permission
 * from the contract owner is involved.
 *
 *   1. the attestor issues a nonce,
 *   2. the TEE cloud answers with a report that carries it,
 *   3. every instance in the report is verified on-chain and its key registered.
 */
export async function registerOnChain(
  attestor: Attestor,
  barrel: Barrel,
  anyone: Wallet,
  gradeId: string,
  opts: { evidenceDir?: string } = {},
): Promise<{ nonce: string; registered: KeyInfo[]; txs: string[]; gasTgas: number[] }> {
  const grade = await barrel.grade(gradeId);
  if (!grade) throw new Error(`unknown grade ${gradeId}`);
  const nonce = await attestor.requestNonce(anyone);
  const { report, raw } = await fetchAttestationReport(grade.model_id, nonce);
  const candidates = report.model_attestations ?? [];
  if (candidates.length === 0) throw new Error(`no model attestation returned for ${grade.model_id}`);
  if (opts.evidenceDir) {
    mkdirSync(opts.evidenceDir, { recursive: true });
    const base = join(opts.evidenceDir, sha256Hex(raw));
    writeFileSync(`${base}.json`, raw);
    writeFileSync(`${base}.nonce`, `${nonce}\n`);
  }
  const txs: string[] = [];
  const gasTgas: number[] = [];
  for (const candidate of candidates) {
    const collateral = await fetchCollateral(candidate.intel_quote);
    const out = await attestor.register(anyone, gradeId, candidate, nonce, collateral);
    if (out.failures.length) throw new Error(`the attestor refused ${candidate.signing_address}: ${out.failures.join("; ")}`);
    txs.push(out.txHash);
    gasTgas.push(Number(out.gasBurnt) / 1e12);
  }
  const keys = await barrel.keys(gradeId);
  const mine = new Set(candidates.map((c) => c.signing_address.replace(/^0x/, "").toLowerCase()));
  return { nonce, registered: keys.filter((k) => mine.has(k.key)), txs, gasTgas };
}

/**
 * The arguments of the attestor contract's `register` and `check`: one
 * candidate of a report, with Intel's collateral for its quote. Byte fields
 * of the collateral travel as hex.
 */
export function attestorArgs(gradeId: string, candidate: AttestationCandidate, nonce: string, collateral: unknown) {
  const hexOf = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && typeof (v as any).__hex === "string") return (v as any).__hex;
    return Buffer.from(v as Uint8Array | number[]).toString("hex");
  };
  const c = collateral as Record<string, unknown>;
  const tcb = typeof candidate.info.tcb_info === "string" ? JSON.parse(candidate.info.tcb_info) : candidate.info.tcb_info;
  const events = typeof candidate.event_log === "string" ? JSON.parse(candidate.event_log) : candidate.event_log;
  return {
    grade_id: gradeId,
    signing_key: candidate.signing_address.replace(/^0x/, "").toLowerCase(),
    nonce: nonce.toLowerCase(),
    quote: candidate.intel_quote.replace(/^0x/, ""),
    collateral: {
      pck_crl_issuer_chain: c.pck_crl_issuer_chain,
      root_ca_crl: hexOf(c.root_ca_crl),
      pck_crl: hexOf(c.pck_crl),
      tcb_info_issuer_chain: c.tcb_info_issuer_chain,
      tcb_info: c.tcb_info,
      tcb_info_signature: hexOf(c.tcb_info_signature),
      qe_identity_issuer_chain: c.qe_identity_issuer_chain,
      qe_identity: c.qe_identity,
      qe_identity_signature: hexOf(c.qe_identity_signature),
      ...(c.pck_certificate_chain ? { pck_certificate_chain: c.pck_certificate_chain } : {}),
    },
    app_compose: tcb.app_compose as string,
    event_log: (events as any[]).map((e) => ({
      imr: e.imr,
      event_type: e.event_type,
      digest: e.digest ?? "",
      event: e.event,
      event_payload: e.event_payload ?? "",
    })),
  };
}
