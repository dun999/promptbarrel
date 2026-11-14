// The rules of Barrel that both sides must compute identically.
// This file mirrors contracts/barrel-core/src/lib.rs. If one changes, both change.

export const UNITS_PER_BARREL = 1_000_000n;

/** A SHA-256 digest as NEAR AI Cloud writes it in signed text: 64 lowercase hex chars. */
export function isHashHex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * The text a NEAR AI Cloud model TEE signs for a non-streamed completion.
 * A gateway signature covers only `<request_hash>:<response_hash>` under a
 * different key, so it can never verify against this text.
 */
export function receiptText(modelId: string, requestHash: string, responseHash: string): string {
  return `${modelId}:${requestHash}:${responseHash}`;
}

/** The text a tank key signs after the payer's SDK has verified the receipt. */
export function ackText(
  contractId: string,
  tankId: number | bigint,
  seq: number | bigint,
  requestHash: string,
  responseHash: string,
  units: bigint,
): string {
  return `barrel:v1:ack:${contractId}:${tankId}:${seq}:${requestHash}:${responseHash}:${units}`;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * Units charged for one answer:
 * completion_tokens + ceil(prompt_tokens × input_weight_bps / 10,000).
 * Token counts come from the `usage` field inside the signed response body.
 */
export function unitsFor(usage: Usage, inputWeightBps: number): bigint {
  const prompt = BigInt(usage.prompt_tokens);
  const completion = BigInt(usage.completion_tokens);
  const bps = BigInt(inputWeightBps);
  if (prompt < 0n || completion < 0n || bps < 0n || bps > 10_000n) {
    throw new Error("usage or input weight out of range");
  }
  return completion + (prompt * bps + 9_999n) / 10_000n;
}

/**
 * The most units a request can cost, known before it is sent: every request
 * byte is at most one prompt token, and the answer is capped by `max_tokens`.
 */
export function worstCaseUnits(requestBytes: number, maxTokens: number, inputWeightBps: number): bigint {
  return unitsFor({ prompt_tokens: requestBytes, completion_tokens: maxTokens }, inputWeightBps);
}

/** USDC base units earned by `units` at `price` per Barrel, rounded down. */
export function usdcFloor(units: bigint, pricePerBarrel: bigint): bigint {
  return (units * pricePerBarrel) / UNITS_PER_BARREL;
}

/** USDC base units a buyer pays for `units`, rounded up. */
export function usdcCeil(units: bigint, pricePerBarrel: bigint): bigint {
  return (units * pricePerBarrel + UNITS_PER_BARREL - 1n) / UNITS_PER_BARREL;
}

/** Units that `amount` USDC buys at `price` per Barrel, rounded down. */
export function unitsBought(amount: bigint, pricePerBarrel: bigint): bigint {
  return (amount * UNITS_PER_BARREL) / pricePerBarrel;
}

/** "1.5" Barrels -> 1500000n units. Also used for USDC, which has 6 decimals too. */
export function parseAmount(text: string, decimals = 6): bigint {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a number: ${text}`);
  const [whole, frac = ""] = text.split(".") as [string, string?];
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places: ${text}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatAmount(value: bigint | string, decimals = 6): string {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

/** What a tank key signs to hand a tank it owns to a NEAR account. */
export function assignText(contractId: string, tankId: number | bigint, newOwner: string): string {
  return `barrel:v1:assign:${contractId}:${tankId}:${newOwner}`;
}

/**
 * What a tank key signs to ask the Pump for one answer. It lets the Pump
 * know the request comes from the tank's owner and caps what that request
 * may cost before any tokens are generated. It reaches the chain only when
 * the operator claims an answer the payer did not acknowledge.
 */
export function requestAuthText(
  contractId: string,
  tankId: number | bigint,
  seq: number | bigint,
  requestHash: string,
  maxUnits: bigint,
): string {
  return `barrel:v1:req:${contractId}:${tankId}:${seq}:${requestHash}:${maxUnits}`;
}
