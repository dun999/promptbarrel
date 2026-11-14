// Which network every tool works on, and that network's deployment record.
//
//   BARREL_NETWORK=mainnet (default) | testnet
//
// The Pump, the CLI, the MCP server and the web build all read the same
// setting, so one variable moves the whole product between networks.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NETWORKS, REPO_ROOT, type NetworkConfig, type NetworkName } from "./chain.ts";

/** What deployments/<network>.json records. */
export interface Deployment {
  network: NetworkName;
  rpc: string;
  contract: string;
  usdc: string;
  owner: string;
  operator: string;
  wasm_sha256: string;
  deployed_at: string;
  /** The attestor contract that registers model keys by on-chain attestation, if deployed. */
  attestor?: string;
  config: { unlock_delay_sec: number; settle_grace_sec: number; claim_window_sec?: number; timelock_sec?: number; min_tank_buy_units?: string };
  grades: { id: string; model_id: string; input_weight_bps: number; key_ttl_sec: number; evidence?: string }[];
  series: { id: number; grade_id: string; model_id: string; endpoint: string; price_per_barrel: string; window_end: number }[];
  sample_receipts: { file: string; settle_tx?: string; units: string }[];
  [extra: string]: unknown;
}

export function networkName(): NetworkName {
  const name = process.env.BARREL_NETWORK ?? "mainnet";
  if (name !== "testnet" && name !== "mainnet") throw new Error(`BARREL_NETWORK must be testnet or mainnet, not ${name}`);
  return name;
}

export function network(): NetworkConfig {
  return NETWORKS[networkName()];
}

export function deploymentFile(name: NetworkName = networkName()): string {
  return join(REPO_ROOT, "deployments", `${name}.json`);
}

export function readDeployment(name: NetworkName = networkName()): Deployment | undefined {
  const file = deploymentFile(name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Deployment) : undefined;
}

export function requireDeployment(name: NetworkName = networkName()): Deployment {
  const d = readDeployment(name);
  if (!d) throw new Error(`${deploymentFile(name)} is missing; deploy with pnpm deploy:${name}`);
  return d;
}

/** The stablecoin's name as people see it: test USDC on testnet, USDC on mainnet. */
export function stablecoinName(name: NetworkName = networkName()): string {
  return name === "testnet" ? "tUSDC" : "USDC";
}
