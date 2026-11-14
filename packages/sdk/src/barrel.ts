// Typed access to the barrel contract and its stablecoin.

import {
  ackText,
  assignText,
  signEd25519,
  type Receipt,
} from "@barrel/verifier";
import { Chain, ONE_YOCTO, RECORD_DEPOSIT, type CallOutcome, type Wallet } from "./chain.ts";

/** Held while a forced request or canary is stored; `clearForced` returns it. */
export const FORCED_DEPOSIT = 25n * 10n ** 22n; // 0.25 NEAR

export interface Config {
  owner: string;
  usdc: string;
  unlock_delay_sec: number;
  settle_grace_sec: number;
  /** Seconds a payer has to answer an operator's claim with their own ack. */
  claim_window_sec: number;
  /** Seconds an owner change, an attestor change or an upgrade waits. */
  timelock_sec: number;
  max_series_units: string;
  max_total_escrow: string;
  /** Smallest purchase (units) that may open a tank directly. */
  min_tank_buy_units: string;
  paused: boolean;
  /** The contract that verifies attestations on-chain and registers keys. */
  attestor: string | null;
  guardian: string | null;
  owner_registers_keys: boolean;
}

export interface Pending {
  kind: string;
  value: string;
  ready_at: number;
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
  /** Who registered it: the attestor contract or the owner. */
  by: string;
}

/** What an operator commits to when it opens a firm series. */
export interface FirmTerms {
  respond_sec: number;
  max_misses: number;
  canary_interval_sec: number;
  /** yoctoNEAR paid to the operator for an answered canary. */
  canary_fee: string;
}

export interface Firm extends FirmTerms {
  /** USDC the operator has at stake right now. */
  bond: string;
  misses: number;
  answered: number;
  canary_sent: number;
  canary_passed: number;
  last_canary_at: number;
  open: number[];
  slashed: string;
  defaulted_at: number | null;
  comp_per_barrel: string;
  comp_units: string;
  comp_paid: string;
}

/** A request sent through the chain: by a tank owner, or as a canary. */
export interface Forced {
  id: number;
  series_id: number;
  tank_id: number | null;
  by: string;
  body: string;
  request_hash: string;
  reserved: string;
  fee: string;
  deposit: string;
  created_at: number;
  deadline: number;
  status: "open" | "answered" | "missed";
  response: string | null;
  response_hash: string | null;
  tee_key: string | null;
  tee_sig: string | null;
  units: string;
}

export interface IndexView {
  grade_id: string;
  /** Volume-weighted USDC base units per Barrel over the window; "0" when nothing settled. */
  price_per_barrel: string;
  units: string;
  usdc: string;
  deliveries: number;
  window_sec: number;
  buckets: { hour: number; units: string; value: string; deliveries: number }[];
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
  /** Set on a firm series: the operator's bond and its duty to answer. */
  firm: Firm | null;
}

export interface Claim {
  seq: number;
  request_hash: string;
  response_hash: string;
  units: string;
  tee_key: string;
  tee_sig: string;
  at: number;
  ready_at: number;
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
  /** Units set aside for an open claim or forced request. */
  reserved: string;
  /** An answer the operator says was served and never acknowledged. */
  claim: Claim | null;
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
  /** "ack" (the payer signed), "claim" (operator claim, no ack came) or "forced". */
  kind: "ack" | "claim" | "forced";
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

/** A tank key hands a tank it owns to a NEAR account. */
export function signAssign(contractId: string, tankId: number, newOwner: string, tankSecretKey: string): string {
  return signEd25519(assignText(contractId, tankId, newOwner), tankSecretKey);
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
  totalBond = async () => BigInt(await this.view<string>("get_total_bond"));
  /** The 24-hour price of a grade, built only from proven deliveries. */
  index = (gradeId: string) => this.view<IndexView>("get_index", { grade_id: gradeId });
  pending = (kind: "owner" | "attestor" | "upgrade") => this.view<Pending | null>("get_pending", { kind });
  forced = (id: number) => this.view<Forced | null>("get_forced", { id });
  openForced = (seriesId: number) => this.view<Forced[]>("get_open_forced", { series_id: seriesId });
  owed = async (accountId: string) => BigInt(await this.view<string>("get_owed", { account_id: accountId }));
  /** The tank a purchase with `tank_key` opened for this key. */
  tankForKey = (key: string) => this.view<Tank | null>("get_tank_for_key", { key });
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
  pause = (ownerOrGuardian: Wallet) => this.call(ownerOrGuardian, "pause");
  unpause = (owner: Wallet) => this.call(owner, "unpause");

  // --- governance ----------------------------------------------------------

  /** Announces an owner change, an attestor change ("" clears it) or an upgrade (sha256 of the code). */
  propose = (owner: Wallet, kind: "owner" | "attestor" | "upgrade", value: string) =>
    this.call<Pending>(owner, "propose", { kind, value });
  /** Applies an owner or attestor change whose timelock has passed. Anyone can call it. */
  apply = (anyone: Wallet, kind: "owner" | "attestor") => this.call(anyone, "apply", { kind });
  cancel = (ownerOrGuardian: Wallet, kind: string) => this.call(ownerOrGuardian, "cancel", { kind });
  setGuardian = (owner: Wallet, guardian: string | null) => this.call(owner, "set_guardian", { guardian });
  /** From then on only the attestor contract registers keys. Cannot be undone. */
  renounceKeyRegistration = (owner: Wallet) => this.call(owner, "renounce_key_registration");
  /** Replaces the code with the one proposed. The timelock must have passed; anyone can send it. */
  upgrade = (anyone: Wallet, wasm: Uint8Array) =>
    this.chain.callRaw(anyone, this.contractId, "upgrade", wasm, { gasTgas: 300 });

  // --- the loop ------------------------------------------------------------

  /** The series' operator moves its Pump. Payment rules do not change. */
  setSeriesEndpoint = (operator: Wallet, seriesId: number, endpoint: string) =>
    this.call(operator, "set_series_endpoint", { series_id: seriesId, endpoint });

  openSeries(
    operator: Wallet,
    s: { gradeId: string; endpoint: string; pricePerBarrel: bigint; windowEnd: number; capUnits: bigint; firm?: FirmTerms },
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
        firm: s.firm ?? null,
      },
      { deposit: RECORD_DEPOSIT },
    );
  }

  private async sendUsdc(from: Wallet, usdc: bigint, msg: Record<string, unknown>): Promise<CallOutcome<bigint>> {
    const out = await this.chain.call<string>(
      from,
      this.usdcId,
      "ft_transfer_call",
      { receiver_id: this.contractId, amount: usdc.toString(), msg: JSON.stringify(msg) },
      { gasTgas: 80, deposit: ONE_YOCTO },
    );
    return { ...out, value: BigInt(out.value ?? "0") };
  }

  /**
   * Buy straight into a tank owned by an Ed25519 key. Whoever pays, only the
   * key can use the tank or hand it on. Returns the USDC actually spent.
   */
  buyTank = (payer: Wallet, seriesId: number, usdc: bigint, tankKey: string) =>
    this.sendUsdc(payer, usdc, { series_id: seriesId, tank_key: tankKey });

  /** The operator adds to the bond of its firm series. */
  addBond = (operator: Wallet, seriesId: number, usdc: bigint) => this.sendUsdc(operator, usdc, { bond_series: seriesId });
  withdrawBond = (operator: Wallet, seriesId: number) =>
    this.call<string>(operator, "withdraw_bond", { series_id: seriesId }, { gasTgas: 60 });

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

  /**
   * The operator claims an answer the payer never acknowledged: the payer's
   * request authorization plus the model's signature. Returns when the claim
   * can be finalized. The payer's ack, sent through `settle`, replaces it.
   */
  claimUnacked = (
    operator: Wallet,
    c: { tankId: number; seq: number; requestHash: string; maxUnits: bigint; authSig: string; responseHash: string; teeKey: string; teeSig: string },
  ) =>
    this.call<number>(operator, "claim_unacked", {
      tank_id: c.tankId,
      seq: c.seq,
      request_hash: c.requestHash,
      max_units: c.maxUnits.toString(),
      auth_sig: c.authSig,
      response_hash: c.responseHash,
      tee_key: c.teeKey,
      tee_sig: c.teeSig,
    });
  /** Pays a claim whose window passed with no ack. Anyone can call it. */
  finalizeClaim = async (anyone: Wallet, tankId: number): Promise<CallOutcome<bigint>> => {
    const out = await this.call<string>(anyone, "finalize_claim", { tank_id: tankId }, { gasTgas: 60 });
    return { ...out, value: BigInt(out.value ?? "0") };
  };

  /** Hands a tank that its own key owns to a NEAR account. Anyone can relay the signature. */
  assign = (relayer: Wallet, tankId: number, newOwner: string, sig: string) =>
    this.call(relayer, "assign", { tank_id: tankId, new_owner: newOwner, sig });

  // --- firm series ---------------------------------------------------------

  /** Sends a request through the chain. `body` must be exactly {model, messages, max_tokens}. */
  forceRequest = (owner: Wallet, tankId: number, body: string) =>
    this.call<number>(owner, "force_request", { tank_id: tankId, body }, { deposit: FORCED_DEPOSIT, gasTgas: 60 });
  /** Asks a firm series' operator to prove it is serving. */
  canary = (anyone: Wallet, seriesId: number, fee: bigint) =>
    this.call<number>(anyone, "canary", { series_id: seriesId }, { deposit: FORCED_DEPOSIT + fee, gasTgas: 60 });
  answerForced = async (anyone: Wallet, id: number, response: string, teeKey: string, teeSig: string): Promise<CallOutcome<bigint>> => {
    const out = await this.call<string>(anyone, "answer_forced", { id, response, tee_key: teeKey, tee_sig: teeSig }, { gasTgas: 100 });
    return { ...out, value: BigInt(out.value ?? "0") };
  };
  /** Records a miss after the deadline; a forced request's worst-case cost is paid from the bond. */
  slashForced = async (anyone: Wallet, id: number): Promise<CallOutcome<bigint>> => {
    const out = await this.call<string>(anyone, "slash_forced", { id }, { gasTgas: 80 });
    return { ...out, value: BigInt(out.value ?? "0") };
  };
  clearForced = (sender: Wallet, id: number) => this.call(sender, "clear_forced", { id });
  claimOwed = (account: Wallet) => this.call<string>(account, "claim_owed", {}, { gasTgas: 60 });

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
