// Resale inside NEAR Intents (`intents.near`), with no exchange contract.
//
// A holder deposits Barrels into Intents and signs an offer: "I give these
// Barrels, I get this much USDC". A buyer with USDC in Intents signs the
// mirror image. Anyone submits both to `execute_intents`, and the Verifier
// settles them atomically: either both sides move or neither does.
//
//   seller   deposit Barrels (mt_transfer_call) -> sign token_diff -> publish
//   buyer    deposit USDC (ft_transfer_call)    -> sign the mirror -> execute
//   both     withdraw to their NEAR accounts
//
// Intents runs on mainnet only.

import { createHash, randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import type { Barrel } from "./barrel.ts";
import { ONE_YOCTO, type CallOutcome, type Chain, type Wallet } from "./chain.ts";

export const INTENTS = "intents.near";

/** One signed message for `execute_intents`, in the NEP-413 standard. */
export interface SignedIntents {
  standard: "nep413";
  payload: { recipient: string; nonce: string; message: string };
  public_key: string;
  signature: string;
}

/** A resale offer as a relay carries it: the terms and the maker's signature over them. */
export interface Offer {
  id: string;
  maker: string;
  contract: string;
  usdc: string;
  series_id: number;
  /** Units of the series on offer. */
  units: string;
  /** USDC base units asked for all of them. */
  price: string;
  deadline: string;
  signed: SignedIntents;
}

/** What `simulate_intents` returns. `invariant_violated` is set when the diffs do not net to zero. */
export interface Simulation {
  intents_executed: { intent_hash: string; account_id: string; nonce: string }[];
  logs: string[];
  invariant_violated?: { error: string; unmatched_deltas?: [string, string][] | Record<string, string> } | null;
  state?: { fee: number; current_salt: string };
}

function unmatchedDeltas(sim: Simulation): Record<string, string> | null {
  const v = sim.invariant_violated;
  if (!v) return null;
  const d = v.unmatched_deltas;
  if (!d) throw new Error(`the Verifier refused the trade: ${v.error}`);
  return Array.isArray(d) ? Object.fromEntries(d) : d;
}

export const barrelToken = (contract: string, seriesId: number) => `nep245:${contract}:${seriesId}`;
export const usdcToken = (usdc: string) => `nep141:${usdc}`;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/**
 * A nonce the Verifier accepts once: a fixed prefix, the Verifier's current
 * salt, the deadline in nanoseconds and 15 random bytes.
 */
export function intentNonce(saltHex: string, deadlineMs: number): Uint8Array {
  const nonce = new Uint8Array(32);
  nonce.set([0x56, 0x28, 0xf6, 0xc6, 0x00]);
  nonce.set(Buffer.from(saltHex, "hex"), 5);
  new DataView(nonce.buffer).setBigUint64(9, BigInt(deadlineMs) * 1_000_000n, true);
  nonce.set(randomBytes(15), 17);
  return nonce;
}

/** The bytes NEP-413 has a wallet sign: a tag, then the Borsh of the payload. */
function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const text = Buffer.from(message, "utf8");
  const to = Buffer.from(recipient, "utf8");
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const payload = Buffer.concat([u32(2 ** 31 + 413), u32(text.length), text, nonce, u32(to.length), to, Buffer.from([0])]);
  return createHash("sha256").update(payload).digest();
}

/** Signs a list of intents with the account's own key. */
export function signIntents(
  wallet: Wallet,
  intents: Record<string, unknown>[],
  opts: { salt: string; deadlineMs: number; verifier?: string },
): SignedIntents {
  const verifier = opts.verifier ?? INTENTS;
  const nonce = intentNonce(opts.salt, opts.deadlineMs);
  const message = JSON.stringify({
    signer_id: wallet.accountId,
    verifying_contract: verifier,
    deadline: new Date(opts.deadlineMs).toISOString(),
    nonce: Buffer.from(nonce).toString("base64"),
    intents,
  });
  const key = KeyPair.fromString(wallet.privateKey as any);
  const { signature } = key.sign(nep413Hash(message, nonce, verifier));
  return {
    standard: "nep413",
    payload: { recipient: verifier, nonce: Buffer.from(nonce).toString("base64"), message },
    public_key: wallet.publicKey,
    signature: `ed25519:${base58(signature)}`,
  };
}

export class Intents {
  constructor(
    readonly chain: Chain,
    readonly barrel: Barrel,
    readonly verifier: string = INTENTS,
  ) {}

  salt = () => this.chain.view<string>(this.verifier, "current_salt");

  /** An account's balance inside Intents, by token id. */
  async balance(accountId: string, tokenId: string): Promise<bigint> {
    return BigInt(await this.chain.view<string>(this.verifier, "mt_balance_of", { account_id: accountId, token_id: tokenId }));
  }
  barrels = (accountId: string, seriesId: number) => this.balance(accountId, barrelToken(this.barrel.contractId, seriesId));
  usdc = (accountId: string) => this.balance(accountId, usdcToken(this.barrel.usdcId));

  /**
   * A named account signs intents with a key it has registered with the
   * Verifier (an implicit account's own key works without this).
   */
  async ensureKey(wallet: Wallet): Promise<boolean> {
    const has = await this.chain.view<boolean>(this.verifier, "has_public_key", { account_id: wallet.accountId, public_key: wallet.publicKey });
    if (has) return false;
    await this.chain.call(wallet, this.verifier, "add_public_key", { public_key: wallet.publicKey }, { deposit: ONE_YOCTO });
    return true;
  }

  /** Moves Barrels from the NEAR account into its Intents balance. */
  depositBarrels = (wallet: Wallet, seriesId: number, units: bigint) => this.barrel.transferCall(wallet, this.verifier, seriesId, units, "");

  depositUsdc = (wallet: Wallet, amount: bigint) =>
    this.chain.call<string>(
      wallet,
      this.barrel.usdcId,
      "ft_transfer_call",
      { receiver_id: this.verifier, amount: amount.toString(), msg: "" },
      { gasTgas: 80, deposit: ONE_YOCTO },
    );

  /** Signs "I give `units` of the series and get `price` USDC". */
  async offer(maker: Wallet, seriesId: number, units: bigint, price: bigint, ttlMs = 24 * 3600_000): Promise<Offer> {
    const deadlineMs = Date.now() + ttlMs;
    const signed = signIntents(
      maker,
      [{ intent: "token_diff", diff: { [barrelToken(this.barrel.contractId, seriesId)]: `-${units}`, [usdcToken(this.barrel.usdcId)]: `${price}` } }],
      { salt: await this.salt(), deadlineMs, verifier: this.verifier },
    );
    return {
      id: createHash("sha256").update(signed.signature).digest("hex").slice(0, 16),
      maker: maker.accountId,
      contract: this.barrel.contractId,
      usdc: this.barrel.usdcId,
      series_id: seriesId,
      units: units.toString(),
      price: price.toString(),
      deadline: new Date(deadlineMs).toISOString(),
      signed,
    };
  }

  /**
   * The mirror image of an offer: "I give the USDC and get the Barrels".
   * `receive` lowers the units taken, which is how the Verifier's fee is left
   * out (see `take`).
   */
  async mirror(taker: Wallet, offer: Offer, receive?: bigint): Promise<SignedIntents> {
    if (offer.contract !== this.barrel.contractId || offer.usdc !== this.barrel.usdcId) throw new Error("the offer is for another contract");
    // Never trust the relay's summary: the terms are whatever the maker signed.
    const signedTerms = JSON.parse(offer.signed.payload.message) as { signer_id: string; intents: { intent: string; diff?: Record<string, string> }[] };
    const diff = signedTerms.intents.length === 1 && signedTerms.intents[0]!.intent === "token_diff" ? signedTerms.intents[0]!.diff ?? {} : {};
    const barrels = barrelToken(offer.contract, offer.series_id);
    const usdc = usdcToken(offer.usdc);
    if (Object.keys(diff).length !== 2 || diff[barrels] !== `-${offer.units}` || diff[usdc] !== offer.price || signedTerms.signer_id !== offer.maker) {
      throw new Error("the signed offer does not say what the relay says it does");
    }
    return signIntents(taker, [{ intent: "token_diff", diff: { [barrels]: (receive ?? BigInt(offer.units)).toString(), [usdc]: `-${offer.price}` } }], {
      salt: await this.salt(),
      deadlineMs: Date.now() + 10 * 60_000,
      verifier: this.verifier,
    });
  }

  /** A free view call: would these signed intents settle right now? Throws with the Verifier's reason if not. */
  simulate = (signed: SignedIntents[]) => this.chain.view<Simulation>(this.verifier, "simulate_intents", { signed });

  /**
   * Takes an offer: signs the mirror, checks it with the free simulation and
   * settles both sides in one transaction. The taker must already hold the
   * USDC inside Intents (`depositUsdc`).
   *
   * The Verifier keeps a small fee out of what each side receives, so the
   * two diffs only net to zero once the fee is left out. The simulation
   * reports exactly what is unmatched; the mirror is signed again without it.
   * Nothing moves before the simulation passes.
   */
  async take(taker: Wallet, offer: Offer): Promise<{ received: bigint; outcome: CallOutcome<unknown> }> {
    const barrels = barrelToken(offer.contract, offer.series_id);
    let receive = BigInt(offer.units);
    let mine = await this.mirror(taker, offer, receive);
    for (let attempt = 0; attempt < 3; attempt++) {
      const sim = await this.simulate([offer.signed, mine]);
      const unmatched = unmatchedDeltas(sim);
      if (!unmatched) {
        const outcome = await this.execute(taker, [offer.signed, mine]);
        if (outcome.failures.length) throw new Error(`execute_intents failed: ${outcome.failures.join("; ")}`);
        return { received: receive, outcome };
      }
      const keys = Object.keys(unmatched);
      if (keys.some((k) => k !== barrels)) throw new Error(`the trade does not balance: ${JSON.stringify(unmatched)}`);
      // The unmatched delta is what the two diffs sum to once the fee is
      // counted: positive means more would be received than was given.
      receive -= BigInt(unmatched[barrels]!);
      if (receive <= 0n) throw new Error("the fee is larger than the trade");
      mine = await this.mirror(taker, offer, receive);
    }
    throw new Error("could not balance the trade against the Verifier's fee");
  }

  /** Settles both sides atomically. Anyone can send it. */
  execute = (anyone: Wallet, signed: SignedIntents[]): Promise<CallOutcome<unknown>> =>
    this.chain.call(anyone, this.verifier, "execute_intents", { signed }, { gasTgas: 300 });

  /** Moves Barrels from the Intents balance back to a NEAR account. */
  withdrawBarrels = (wallet: Wallet, seriesId: number, units: bigint, to = wallet.accountId) =>
    this.chain.call(
      wallet,
      this.verifier,
      "mt_withdraw",
      { token: this.barrel.contractId, receiver_id: to, token_ids: [String(seriesId)], amounts: [units.toString()] },
      { gasTgas: 100, deposit: ONE_YOCTO },
    );

  withdrawUsdc = (wallet: Wallet, amount: bigint, to = wallet.accountId) =>
    this.chain.call(
      wallet,
      this.verifier,
      "ft_withdraw",
      { token: this.barrel.usdcId, receiver_id: to, amount: amount.toString() },
      { gasTgas: 100, deposit: ONE_YOCTO },
    );
}
