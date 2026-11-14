// Typed access to the attestor contract: on-chain attestation checks and
// permissionless key registration.

import type { AttestationCandidate } from "@barrel/verifier";
import type { Chain, CallOutcome, Wallet } from "./chain.ts";
import { attestorArgs } from "./registrar.ts";

export interface AttestorConfig {
  owner: string;
  barrel: string;
  timelock_sec: number;
  nonce_ttl_sec: number;
  accepted_tcb: string[];
}

export interface OnChainCheck {
  ok: boolean;
  reason: string | null;
  compose_hash: string | null;
  tcb_status: string | null;
  advisory_ids: string[];
  on_reviewed_list: boolean;
}

export class Attestor {
  constructor(
    readonly chain: Chain,
    readonly contractId: string,
  ) {}

  config = () => this.chain.view<AttestorConfig>(this.contractId, "get_config");
  /** Reviewed compose hashes of a grade: the software a key may run under. */
  compose = (gradeId: string) => this.chain.view<string[]>(this.contractId, "get_compose", { grade_id: gradeId });
  pending = (kind: string) =>
    this.chain.view<{ kind: string; value: string; ready_at: number } | null>(this.contractId, "get_pending", { kind });

  /** The contract issues a nonce from the block's random seed. Anyone can ask. */
  async requestNonce(anyone: Wallet): Promise<string> {
    return (await this.chain.call<string>(anyone, this.contractId, "request_nonce")).value;
  }

  /**
   * Verifies one attestation on-chain and registers its signing key.
   * Anyone can call it. Measured on testnet at about 125 TGas.
   */
  register(anyone: Wallet, gradeId: string, candidate: AttestationCandidate, nonce: string, collateral: unknown): Promise<CallOutcome<unknown>> {
    return this.chain.call(anyone, this.contractId, "register", attestorArgs(gradeId, candidate, nonce, collateral), { gasTgas: 300 });
  }

  /** The same checks as a free view call, with no registration and no contract nonce. */
  check(gradeId: string, candidate: AttestationCandidate, nonce: string, collateral: unknown): Promise<OnChainCheck> {
    return this.chain.view<OnChainCheck>(this.contractId, "check", attestorArgs(gradeId, candidate, nonce, collateral));
  }

  /** Owner: announce a compose hash for a grade's reviewed list. It waits out the timelock. */
  proposeCompose = (owner: Wallet, gradeId: string, composeHash: string) =>
    this.chain.call(owner, this.contractId, "propose", { kind: `compose:${gradeId}`, value: composeHash });
  /** Anyone: apply a proposal whose timelock has passed. */
  applyCompose = (anyone: Wallet, gradeId: string) => this.chain.call(anyone, this.contractId, "apply", { kind: `compose:${gradeId}` });
  removeCompose = (owner: Wallet, gradeId: string, composeHash: string) =>
    this.chain.call(owner, this.contractId, "remove_compose", { grade_id: gradeId, compose_hash: composeHash });
}
