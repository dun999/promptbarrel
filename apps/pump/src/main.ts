// Runs a Pump for every series of the deployment: one per model.
//
//   pnpm pump                         series from deployments/<network>.json
//   PUMP_SERIES=1,3 PUMP_PORT=8787 pnpm pump
//   BARREL_NETWORK=testnet pnpm pump      the development deployment
//
// Needs NEARAI_API_KEY in .env and the operator's key in .barrel/<network>/.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Attestor, Barrel, Chain, STATE_DIR, loadWallet, network, networkName, requireDeployment, requireEnv } from "@barrel/sdk";
import { nearAiUpstream, startPump } from "./pump.ts";

const net = networkName();
const deployment = requireDeployment(net);
const chain = new Chain(network());
const barrel = new Barrel(chain, deployment.contract, deployment.usdc);
const seriesIds = process.env.PUMP_SERIES ? process.env.PUMP_SERIES.split(",").map(Number) : deployment.series.map((s) => s.id);
const operator = loadWallet(net, process.env.PUMP_OPERATOR ?? deployment.operator);
// With an attestor contract, a rotated model key is registered by on-chain
// attestation and the operator only pays gas. Without one, only the contract
// owner can register keys, so the Pump does it when this machine holds the owner key.
const ownerKey = join(STATE_DIR, net, `${deployment.owner}.json`);

const pump = await startPump({
  barrel,
  seriesIds,
  operator,
  upstream: nearAiUpstream(requireEnv("NEARAI_API_KEY")),
  port: Number(process.env.PUMP_PORT ?? 8787),
  host: process.env.PUMP_HOST ?? "127.0.0.1",
  publicUrl: process.env.PUMP_PUBLIC_URL,
  settleIntervalMs: Number(process.env.PUMP_SETTLE_MS ?? 0),
  claimAfterMs: Number(process.env.PUMP_CLAIM_AFTER_MS ?? 120_000),
  journalFile: join(STATE_DIR, "pump", `${deployment.contract}.json`),
  attestor: deployment.attestor ? new Attestor(chain, deployment.attestor) : undefined,
  registrar:
    !deployment.attestor && existsSync(ownerKey)
      ? { owner: loadWallet(net, deployment.owner), evidenceDir: join(STATE_DIR, "evidence") }
      : undefined,
  oneClickJwt: process.env.ONECLICK_JWT,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});

const stop = async () => {
  console.log("flushing acknowledged answers to the chain before exit…");
  await pump.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
