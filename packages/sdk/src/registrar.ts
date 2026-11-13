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
  type CandidateResult,
} from "@barrel/verifier";
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
  const collateral = await fetchCollateral(first.intel_quote);
  const checkedAt = Math.floor(Date.now() / 1000);
  const result = await checkModelReport(report, {
    nonce,
    modelId,
    collateral,
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
