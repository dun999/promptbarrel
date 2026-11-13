// Typed access to the barrel contract and its stablecoin.

import {
  ackText,
  signEd25519,
  type Receipt,
} from "@barrel/verifier";
import { Chain, ONE_YOCTO, RECORD_DEPOSIT, type CallOutcome, type Wallet } from "./chain.ts";

export interface Config {
  owner: string;
  usdc: string;
  unlock_delay_sec: number;
  settle_grace_sec: number;
  max_series_units: string;
  max_total_escrow: string;
  paused: boolean;
}

export interface Grade {
  id: string;
  model_id: string;
  input_weight_bps: number;
  key_ttl_sec: number;
}

export interface KeyInfo {
  key: string;
  registered_at: number;
  expires_at: number;
  evidence_hash: string;
}

export interface Series {
  id: number;
  operator: string;
  grade_id: string;
  endpoint: string;
  price_per_barrel: string;
  window_end: number;
  cap_units: string;
  minted: string;
  burned: string;
  refunded: string;
  in_tanks: string;
  escrow_in: string;
  released: string;
  refund_paid: string;
  payable: string;
}

export interface Tank {
  id: number;
  series_id: number;
  owner: string;
  key: string;
  balance: string;
  spent: string;
  next_seq: number;
  unlock_at: number | null;
  closed: boolean;
  /** Job tanks: the account paid the leftover when the owner accepts. */
  agent: string | null;
  accepted: boolean;
}

export interface SettleItem {
  seq: number;
  request_hash: string;
  response_hash: string;
  units: string;
  ack_sig: string;
  tee_key: string;
  tee_sig: string;
}

export interface SettleRecord {
  tank_id: number;
  series_id: number;
  seq: number;
  units: string;
  request_hash: string;
  response_hash: string;
  tee_key: string;
  tee_sig: string;
  at: number;
}

export interface ReceiptCheck {
  valid: boolean;
  signature_ok: boolean;
  key_registered: boolean;
  key_live: boolean;
  key_expires_at: number | null;
  model_id: string | null;
  text: string | null;
  reason: string | null;
}

/** An ack is the payer's signed statement: "this answer, this many units". */
export function signAck(
  contractId: string,
  tankId: number,
  seq: number,
  requestHash: string,
  responseHash: string,
  units: bigint,
  tankSecretKey: string,
): string {
  return signEd25519(ackText(contractId, tankId, seq, requestHash, responseHash, units), tankSecretKey);
}

export function settleItem(receipt: Receipt, seq: number, units: bigint, ackSig: string): SettleItem {
  return {
    seq,
    request_hash: receipt.request_hash,
    response_hash: receipt.response_hash,
    units: units.toString(),
    ack_sig: ackSig,
    tee_key: receipt.signing_address,
    tee_sig: receipt.signature,
  };
}

export class Barrel {
  constructor(
    readonly chain: Chain,
    readonly contractId: string,
    readonly usdcId: string,
  ) {}

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.chain.view<T>(this.contractId, method, args);
  }

  private call<T = unknown>(
    wallet: Wallet,
    method: string,
    args: Record<string, unknown> = {},
    opts: { gasTgas?: number; deposit?: bigint } = {},
  ): Promise<CallOutcome<T>> {
    return this.chain.call<T>(wallet, this.contractId, method, args, opts);
  }

  // --- views ---------------------------------------------------------------

  config = () => this.view<Config>("get_config");
  totalEscrow = async () => BigInt(await this.view<string>("get_total_escrow"));
  grades = () => this.view<Grade[]>("get_grades");
  grade = (gradeId: string) => this.view<Grade | null>("get_grade", { grade_id: gradeId });
  keys = (gradeId: string) => this.view<KeyInfo[]>("get_keys", { grade_id: gradeId });
  series = (seriesId: number) => this.view<Series | null>("get_series", { series_id: seriesId });
  seriesList = () => this.view<Series[]>("get_series_list", {});
  refundOpensAt = (seriesId: number) => this.view<number>("refund_opens_at", { series_id: seriesId });
  tank = (tankId: number) => this.view<Tank | null>("get_tank", { tank_id: tankId });
  tanksFor = (owner: string) => this.view<Tank[]>("get_tanks_for", { owner });
  recentSettlements = (limit = 20) => this.view<SettleRecord[]>("get_recent_settlements", { limit });
  settlementCount = () => this.view<number>("get_settlement_count");
  /** The exact text the contract expects a tank key to sign. */
  ackTextFor = (tankId: number, seq: number, requestHash: string, responseHash: string, units: bigint) =>
    this.view<string>("ack_text_for", {
      tank_id: tankId,
      seq,
      request_hash: requestHash,
      response_hash: responseHash,
      units: units.toString(),
    });

  async balanceOf(accountId: string, seriesId: number): Promise<bigint> {
    return BigInt(await this.view<string>("mt_balance_of", { account_id: accountId, token_id: String(seriesId) }));
  }

  async supply(seriesId: number): Promise<bigint> {
    return BigInt((await this.view<string | null>("mt_supply", { token_id: String(seriesId) })) ?? "0");
  }

  async usdcBalance(accountId: string): Promise<bigint> {
    return BigInt(await this.chain.view<string>(this.usdcId, "ft_balance_of", { account_id: accountId }));
  }

  /** Free view call: is this receipt's signature valid under a key registered for the grade? */
  verifyReceipt(receipt: Pick<Receipt, "grade_id" | "request_hash" | "response_hash" | "signing_address" | "signature">) {
    return this.view<ReceiptCheck>("verify_receipt", {
      grade_id: receipt.grade_id,
      request_hash: receipt.request_hash,
      response_hash: receipt.response_hash,
      tee_key: receipt.signing_address,
      tee_sig: receipt.signature,
    });
  }

  // --- registry (owner) ----------------------------------------------------

  addGrade = (owner: Wallet, grade: Grade) => this.call(owner, "add_grade", { grade });
  addKey = (owner: Wallet, gradeId: string, key: string, evidenceHash: string) =>
    this.call<KeyInfo>(owner, "add_key", { grade_id: gradeId, key, evidence_hash: evidenceHash });
  revokeKey = (owner: Wallet, gradeId: string, key: string) =>
    this.call(owner, "revoke_key", { grade_id: gradeId, key });
  pause = (owner: Wallet) => this.call(owner, "pause");
  unpause = (owner: Wallet) => this.call(owner, "unpause");

  // --- the loop ------------------------------------------------------------

  /** The series' operator moves its Pump. Payment rules do not change. */
  setSeriesEndpoint = (operator: Wallet, seriesId: number, endpoint: string) =>
    this.call(operator, "set_series_endpoint", { series_id: seriesId, endpoint });

  openSeries(
    operator: Wallet,
    s: { gradeId: string; endpoint: string; pricePerBarrel: bigint; windowEnd: number; capUnits: bigint },
  ) {
    return this.call<number>(
      operator,
      "open_series",
      {
        grade_id: s.gradeId,
        endpoint: s.endpoint,
        price_per_barrel: s.pricePerBarrel.toString(),
        window_end: s.windowEnd,
        cap_units: s.capUnits.toString(),
      },
      { deposit: RECORD_DEPOSIT },
    );
  }

  /** Testnet only: the test stablecoin has a public faucet. */
  faucet = (anyone: Wallet, to: string, amount: bigint) =>
    this.chain.call(anyone, this.usdcId, "mint", { account_id: to, amount: amount.toString() });

  registerUsdc = (payer: Wallet, accountId: string) =>
    this.chain.call(payer, this.usdcId, "storage_deposit", { account_id: accountId, registration_only: true }, { deposit: 125n * 10n ** 19n });

  /** Buy: USDC in, Barrels out. Returns the USDC actually spent. */
  async buy(buyer: Wallet, seriesId: number, usdc: bigint, to?: string): Promise<CallOutcome<bigint>> {
    const out = await this.chain.call<string>(
      buyer,
      this.usdcId,
      "ft_transfer_call",
      {
        receiver_id: this.contractId,
        amount: usdc.toString(),
        msg: JSON.stringify(to ? { series_id: seriesId, to } : { series_id: seriesId }),
      },
      { gasTgas: 80, deposit: ONE_YOCTO },
    );
    return { ...out, value: BigInt(out.value ?? "0") };
  }

  /** With `agent`, a job tank: the key is the agent's, and `accept` pays the agent the leftover. */
  fill = (owner: Wallet, seriesId: number, units: bigint, tankPublicKey: string, agent?: string) =>
    this.call<number>(
      owner,
      "fill",
      { series_id: seriesId, units: units.toString(), key: tankPublicKey, ...(agent ? { agent } : {}) },
      { deposit: RECORD_DEPOSIT },
    );

  topUp = (owner: Wallet, tankId: number, units: bigint) =>
    this.call(owner, "top_up", { tank_id: tankId, units: units.toString() });

  /** Anyone can submit; the USDC always goes to the series operator. */
  async settle(caller: Wallet, tankId: number, items: SettleItem[]): Promise<CallOutcome<bigint>> {
    // Measured on testnet: 8.6 TGas for one item including the payout, and
    // about 1 TGas for each further item. The unused allowance is refunded.
    const gasTgas = Math.min(300, 30 + 3 * items.length);
    const out = await this.call<string>(caller, "settle", { tank_id: tankId, items }, { gasTgas });
    return { ...out, value: BigInt(out.value ?? "0") };
  }

  requestUnlock = (owner: Wallet, tankId: number) => this.call<number>(owner, "request_unlock", { tank_id: tankId });
  /** Accepts a job tank's work. Returns when the leftover pays out to the agent. */
  accept = (owner: Wallet, tankId: number) => this.call<number>(owner, "accept", { tank_id: tankId });
  /** Returns the leftover Barrels to the owner, or for an accepted job pays the agent USDC. */
  withdraw = (caller: Wallet, tankId: number) => this.call<string>(caller, "withdraw", { tank_id: tankId }, { gasTgas: 60 });
  refund = (holder: Wallet, seriesId: number, units: bigint) =>
    this.call<string>(holder, "refund", { series_id: seriesId, units: units.toString() }, { gasTgas: 60 });
  claim = (anyone: Wallet, seriesId: number) => this.call<string>(anyone, "claim", { series_id: seriesId }, { gasTgas: 60 });

  transfer = (from: Wallet, to: string, seriesId: number, units: bigint) =>
    this.call(from, "mt_transfer", { receiver_id: to, token_id: String(seriesId), amount: units.toString() }, { deposit: ONE_YOCTO });

  transferCall = (from: Wallet, to: string, seriesId: number, units: bigint, msg: string) =>
    this.call<string[]>(
      from,
      "mt_transfer_call",
      { receiver_id: to, token_id: String(seriesId), amount: units.toString(), msg },
      { deposit: ONE_YOCTO, gasTgas: 80 },
    );
}
