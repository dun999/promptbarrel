// Deploys the contract under a funded account, with either a fresh test
// stablecoin (testnet) or an existing token such as Circle's USDC (mainnet).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Barrel } from "./barrel.ts";
import { REPO_ROOT, type Chain, type Wallet } from "./chain.ts";

export interface DeployOptions {
  /** Distinguishes sub-accounts when one root is reused. Random by default. */
  tag?: string;
  unlockDelaySec: number;
  settleGraceSec: number;
  /** Per-series cap, in units (1 Barrel = 1,000,000 units). */
  maxSeriesUnits: bigint;
  /** Global cap on USDC held, in base units. */
  maxTotalEscrow: bigint;
  /** An existing NEP-141 stablecoin. Without it a test stablecoin is deployed. */
  usdc?: string;
}

export interface Deployed {
  barrel: Barrel;
  contract: Wallet;
  /** The test stablecoin's account, when this deploy created one. */
  usdc?: Wallet;
  usdcId: string;
  tag: string;
  wasmSha256: string;
}

export function readWasm(name: "barrel" | "test_usdc"): Uint8Array {
  const file = join(REPO_ROOT, "res", `${name}.wasm`);
  if (!existsSync(file)) throw new Error(`${file} is missing. Run: pnpm build:contract`);
  return readFileSync(file);
}

/** NEAR a contract account needs: its code's storage (1 NEAR per 100 kB) plus room for its records. */
export function nearForCode(wasm: Uint8Array, headroomNear = 0.4): string {
  return (wasm.length / 100_000 + headroomNear).toFixed(3);
}

/**
 * Contract code is paid for by storage staking: about 4.7 NEAR on `root` for
 * the contract, plus about 2.2 NEAR when a test stablecoin is deployed too.
 */
export async function deployFresh(chain: Chain, root: Wallet, opts: DeployOptions): Promise<Deployed> {
  const tag = opts.tag ?? randomBytes(3).toString("hex");
  const barrelWasm = readWasm("barrel");
  let usdc: Wallet | undefined;
  if (!opts.usdc) {
    const tokenWasm = readWasm("test_usdc");
    usdc = await chain.createSubAccount(root, `usdc-${tag}`, nearForCode(tokenWasm, 0.3));
    await chain.deploy(usdc, tokenWasm);
    await chain.call(usdc, usdc.accountId, "new", {});
  }
  const usdcId = opts.usdc ?? usdc!.accountId;
  const contract = await chain.createSubAccount(root, `barrel-${tag}`, nearForCode(barrelWasm));
  await chain.deploy(contract, barrelWasm);
  await chain.call(contract, contract.accountId, "new", {
    owner: root.accountId,
    usdc: usdcId,
    unlock_delay_sec: opts.unlockDelaySec,
    settle_grace_sec: opts.settleGraceSec,
    max_series_units: opts.maxSeriesUnits.toString(),
    max_total_escrow: opts.maxTotalEscrow.toString(),
  });
  const barrel = new Barrel(chain, contract.accountId, usdcId);
  await barrel.registerUsdc(root, contract.accountId);
  return { barrel, contract, usdc, usdcId, tag, wasmSha256: createHash("sha256").update(barrelWasm).digest("hex") };
}
