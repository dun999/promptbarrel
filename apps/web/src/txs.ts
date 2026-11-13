// Every transaction the app asks a wallet to sign, as plain data. The app sends
// these through the connected wallet; the e2e test signs the same specs with a
// key so the exact calls are proven against the live contract.

export interface TxSpec {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas: number;
  deposit: bigint;
}

const ONE_YOCTO = 1n;
/** Storage for a new tank or series record; the unused part is refunded. */
export const RECORD_DEPOSIT = 10n ** 22n; // 0.01 NEAR
/** The test stablecoin's faucet mints at most this per call. */
export const FAUCET_MAX = 1_000_000_000n; // 1,000 tUSDC

export interface Contracts {
  barrel: string;
  usdc: string;
}

/** Testnet only: the test stablecoin has a public mint. */
export const mintTestUsdc = (c: Contracts, to: string, amount: bigint): TxSpec => ({
  receiverId: c.usdc,
  methodName: "mint",
  args: { account_id: to, amount: amount.toString() },
  gasTgas: 30,
  deposit: 0n,
});

/** Registers an account with the stablecoin so it can receive USDC (a job tank's agent, say). */
export const registerUsdc = (c: Contracts, accountId: string): TxSpec => ({
  receiverId: c.usdc,
  methodName: "storage_deposit",
  args: { account_id: accountId, registration_only: true },
  gasTgas: 30,
  deposit: 125n * 10n ** 19n, // 0.00125 NEAR, the token's storage price
});

/** USDC in, Barrels out. Unused USDC is returned by the token contract. */
export const buy = (c: Contracts, seriesId: number, amount: bigint): TxSpec => ({
  receiverId: c.usdc,
  methodName: "ft_transfer_call",
  args: { receiver_id: c.barrel, amount: amount.toString(), msg: JSON.stringify({ series_id: seriesId }) },
  gasTgas: 80,
  deposit: ONE_YOCTO,
});

/**
 * Moves Barrels into a new tank that only `tankPublicKey` can spend from.
 * With `agent`, a job tank: the key is the agent's, and accepting the work
 * pays the agent whatever the tank has left.
 */
export const fill = (c: Contracts, seriesId: number, units: bigint, tankPublicKey: string, agent?: string): TxSpec => ({
  receiverId: c.barrel,
  methodName: "fill",
  args: { series_id: seriesId, units: units.toString(), key: tankPublicKey, ...(agent ? { agent } : {}) },
  gasTgas: 30,
  deposit: RECORD_DEPOSIT,
});

export const topUp = (c: Contracts, tankId: number, units: bigint): TxSpec => ({
  receiverId: c.barrel,
  methodName: "top_up",
  args: { tank_id: tankId, units: units.toString() },
  gasTgas: 30,
  deposit: 0n,
});

export const requestUnlock = (c: Contracts, tankId: number): TxSpec => ({
  receiverId: c.barrel,
  methodName: "request_unlock",
  args: { tank_id: tankId },
  gasTgas: 30,
  deposit: 0n,
});

/** Job tanks: the client accepts the work. After the unlock delay the leftover pays the agent. */
export const accept = (c: Contracts, tankId: number): TxSpec => ({
  receiverId: c.barrel,
  methodName: "accept",
  args: { tank_id: tankId },
  gasTgas: 30,
  deposit: 0n,
});

/** Leftover back to the owner, or for an accepted job, USDC to the agent. */
export const withdraw = (c: Contracts, tankId: number): TxSpec => ({
  receiverId: c.barrel,
  methodName: "withdraw",
  args: { tank_id: tankId },
  gasTgas: 60,
  deposit: 0n,
});

export const refund = (c: Contracts, seriesId: number, units: bigint): TxSpec => ({
  receiverId: c.barrel,
  methodName: "refund",
  args: { series_id: seriesId, units: units.toString() },
  gasTgas: 60,
  deposit: 0n,
});
