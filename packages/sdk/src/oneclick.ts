// Buy Barrels with USDC from another chain, through NEAR Intents' 1Click API.
//
// One deposit on the origin chain (Base, Arbitrum, Ethereum, Solana, …) is
// swapped to USDC on NEAR and delivered to the Barrel contract with
// `ft_transfer_call` and the buy message {"series_id": N, "to": <buyer>}. The
// contract mints the Barrels straight to the buyer's NEAR account: the buyer
// never holds USDC on NEAR and signs nothing on NEAR to buy.
//
// With `tankKey` instead of `to`, the message is {"series_id": N, "tank_key": K}
// and the Barrels land in a tank owned by that key: an agent with a key and
// no NEAR account is funded from any chain, and nobody else can take the tank.
//
// Fetch only, no Node APIs: the browser app and the CLI share this file.
//
// Without a 1Click JWT the API adds a 0.25% platform fee; pass `jwt` to use
// the partner fee schedule (partners.near-intents.org).

export const ONECLICK_API = "https://1click.chaindefuser.com";

/** 1Click's execution states for a deposit address. */
export type SwapStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export interface OriginToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress?: string;
}

export interface BuyQuote {
  /** Where to send `amountIn` on the origin chain. Absent on a dry quote. */
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  /** NEAR USDC expected to reach the Barrel contract. */
  amountOut: string;
  minAmountOut: string;
  /** When 1Click refunds the deposit if the swap has not completed. */
  deadline?: string;
  timeEstimate: number;
}

export interface BuyRoute {
  /** 1Click asset id of the USDC (or other token) on the origin chain. */
  originAsset: string;
  /** Base units of the origin token. */
  amount: bigint;
  /** The payer's address on the origin chain: refunds go there. */
  refundTo: string;
  /** The Barrel contract and its USDC. */
  contract: string;
  usdc: string;
  seriesId: number;
  /** The NEAR account that receives the Barrels. */
  to?: string;
  /** Instead of `to`: the Ed25519 key whose tank receives them. */
  tankKey?: string;
  dry?: boolean;
  slippageBps?: number;
  /** Minutes until 1Click refunds an unfinished swap. */
  deadlineMin?: number;
  jwt?: string;
}

async function api<T>(path: string, init: RequestInit & { jwt?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.jwt) headers.authorization = `Bearer ${init.jwt}`;
  const res = await fetch(`${ONECLICK_API}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`1Click ${path}: ${body.message ?? res.status}`);
  return body as T;
}

/** USDC on every origin chain 1Click supports, except NEAR itself. */
export async function usdcOrigins(): Promise<OriginToken[]> {
  const tokens = await api<OriginToken[]>("/v0/tokens");
  return tokens.filter((t) => t.symbol === "USDC" && t.blockchain !== "near").sort((a, b) => a.blockchain.localeCompare(b.blockchain));
}

/** The buy message the Barrel contract reads in `ft_on_transfer`. */
export const buyMsg = (seriesId: number, to: string) => JSON.stringify({ series_id: seriesId, to });

/** The message that puts the purchase straight into a tank owned by `tankKey`. */
export const tankBuyMsg = (seriesId: number, tankKey: string) => JSON.stringify({ series_id: seriesId, tank_key: tankKey });

/** A quote for buying Barrels from another chain. With `dry: false` it carries a deposit address. */
export async function quoteBuy(r: BuyRoute): Promise<BuyQuote> {
  const deadline = new Date(Date.now() + (r.deadlineMin ?? 30) * 60_000).toISOString();
  if (!r.to === !r.tankKey) throw new Error("a route delivers to an account (`to`) or to a tank key (`tankKey`), one of them");
  const out = await api<{ quote: BuyQuote }>("/v0/quote", {
    method: "POST",
    jwt: r.jwt,
    body: JSON.stringify({
      dry: r.dry ?? false,
      swapType: "EXACT_INPUT",
      slippageTolerance: r.slippageBps ?? 50,
      originAsset: r.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: `nep141:${r.usdc}`,
      amount: r.amount.toString(),
      refundTo: r.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: r.contract,
      recipientType: "DESTINATION_CHAIN",
      customRecipientMsg: r.tankKey ? tankBuyMsg(r.seriesId, r.tankKey) : buyMsg(r.seriesId, r.to!),
      deadline,
    }),
  });
  return out.quote;
}

export interface SwapState {
  status: SwapStatus;
  /** NEAR transaction hashes of the delivery, once there are any. */
  nearTxs: string[];
  originTxs: string[];
  amountOut?: string;
  refundedAmount?: string;
}

export async function swapStatus(depositAddress: string, jwt?: string): Promise<SwapState> {
  const s = await api<any>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { jwt });
  const d = s.swapDetails ?? {};
  return {
    status: s.status,
    nearTxs: (d.nearTxHashes ?? []).map((t: any) => (typeof t === "string" ? t : t.hash)),
    originTxs: (d.originChainTxHashes ?? []).map((t: any) => (typeof t === "string" ? t : t.hash)),
    amountOut: d.amountOut,
    refundedAmount: d.refundedAmount,
  };
}

/** Tells 1Click about the deposit transaction so it starts without waiting to notice it. */
export const submitDeposit = (txHash: string, depositAddress: string, jwt?: string) =>
  api("/v0/deposit/submit", { method: "POST", jwt, body: JSON.stringify({ txHash, depositAddress }) });

export const finished = (s: SwapStatus) => s === "SUCCESS" || s === "REFUNDED" || s === "FAILED";

/**
 * How much USDC (base units) the series can still take. A deposit above this
 * is refused by the contract, and a refused `ft_transfer_call` returns the
 * USDC to the 1Click withdrawal, not to the buyer, so quote below it.
 */
export function buyRoom(
  series: { cap_units: string; minted: string; price_per_barrel: string; window_end: number },
  config: { max_total_escrow: string; paused?: boolean },
  totalEscrow: bigint,
  nowSec = Date.now() / 1000,
): bigint {
  if (config.paused || nowSec >= series.window_end) return 0n;
  const units = BigInt(series.cap_units) - BigInt(series.minted);
  const bySeries = (units * BigInt(series.price_per_barrel)) / 1_000_000n;
  const byEscrow = BigInt(config.max_total_escrow) - totalEscrow;
  const room = bySeries < byEscrow ? bySeries : byEscrow;
  return room > 0n ? room : 0n;
}
