// Deploys the contract under a funded account, with either a fresh test
// stablecoin (testnet) or an existing token such as Circle's USDC (mainnet).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Attestor } from "./attestor.ts";
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
  /** Seconds a payer has to answer an operator claim. Must be below the unlock delay. */
  claimWindowSec?: number;
  /** Seconds an owner change, an attestor change or an upgrade waits. */
  timelockSec?: number;
  /** Smallest purchase (units) that opens a tank directly. */
  minTankBuyUnits?: bigint;
  /**
   * Deploy the attestor contract too and point the contract at it: `true`
   * for a sub-account of the root, or a funded account to deploy it onto
   * (its code needs about 7.5 NEAR of storage).
   */
  attestor?: boolean | Wallet;
  /** Reviewed compose hashes per grade that the attestor starts with. */
  attestorCompose?: Record<string, string[]>;
  guardian?: string;
  /** False from the start: only the attestor contract can register keys. */
  ownerRegistersKeys?: boolean;
}

export interface Deployed {
  barrel: Barrel;
  contract: Wallet;
  /** The test stablecoin's account, when this deploy created one. */
  usdc?: Wallet;
  usdcId: string;
  tag: string;
  wasmSha256: string;
  /** The attestor contract, when this deploy created one. */
  attestor?: Attestor;
  attestorWallet?: Wallet;
}

/** TCB statuses the attestor accepts, the same list the off-chain checks use. */
export const ACCEPTED_TCB = ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"];

export function readWasm(name: "barrel" | "test_usdc" | "attestor"): Uint8Array {
  const file = join(REPO_ROOT, "res", `${name}.wasm`);
  if (!existsSync(file)) throw new Error(`${file} is missing. Run: pnpm build:contract`);
  return readFileSync(file);
}

/** Deploys the attestor onto a funded account and points it at a Barrel contract. */
export async function deployAttestor(
  chain: Chain,
  account: Wallet,
  cfg: { owner: string; barrel: string; timelockSec: number; nonceTtlSec?: number; compose?: Record<string, string[]> },
): Promise<Attestor> {
  await chain.deploy(account, readWasm("attestor"));
  await chain.call(account, account.accountId, "new", {
    config: {
      owner: cfg.owner,
      barrel: cfg.barrel,
      timelock_sec: cfg.timelockSec,
      nonce_ttl_sec: cfg.nonceTtlSec ?? 3600,
      accepted_tcb: ACCEPTED_TCB,
    },
    // The reviewed compose hashes each grade starts with. Later additions wait out the timelock.
    compose: Object.entries(cfg.compose ?? {}),
  });
  return new Attestor(chain, account.accountId);
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
  const timelockSec = opts.timelockSec ?? 86_400;
  let attestor: Attestor | undefined;
  let attestorWallet: Wallet | undefined;
  if (opts.attestor) {
    attestorWallet =
      opts.attestor === true
        ? await chain.createSubAccount(root, `attestor-${tag}`, nearForCode(readWasm("attestor"), 0.3))
        : opts.attestor;
    attestor = await deployAttestor(chain, attestorWallet, {
      owner: root.accountId,
      barrel: contract.accountId,
      timelockSec,
      compose: opts.attestorCompose,
    });
  }
  await chain.deploy(contract, barrelWasm);
  await chain.call(contract, contract.accountId, "new", {
    args: {
      owner: root.accountId,
      usdc: usdcId,
      unlock_delay_sec: opts.unlockDelaySec,
      settle_grace_sec: opts.settleGraceSec,
      claim_window_sec: opts.claimWindowSec ?? Math.floor(opts.unlockDelaySec / 2),
      timelock_sec: timelockSec,
      max_series_units: opts.maxSeriesUnits.toString(),
      max_total_escrow: opts.maxTotalEscrow.toString(),
      min_tank_buy_units: (opts.minTankBuyUnits ?? 10_000n).toString(),
      attestor: attestorWallet?.accountId ?? null,
      guardian: opts.guardian ?? null,
      owner_registers_keys: opts.ownerRegistersKeys ?? true,
    },
  });
  const barrel = new Barrel(chain, contract.accountId, usdcId);
  await barrel.registerUsdc(root, contract.accountId);
  return {
    barrel,
    contract,
    usdc,
    usdcId,
    tag,
    wasmSha256: createHash("sha256").update(barrelWasm).digest("hex"),
    attestor,
    attestorWallet,
  };
}
