// Runs a Pump for one series.
//
//   pnpm pump                         series from deployments/<network>.json
//   PUMP_SERIES=3 PUMP_PORT=8787 pnpm pump
//   BARREL_NETWORK=testnet pnpm pump      the development deployment
//
// Needs NEARAI_API_KEY in .env and the operator's key in .barrel/<network>/.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Barrel, Chain, STATE_DIR, loadWallet, network, networkName, requireDeployment, requireEnv } from "@barrel/sdk";
import { nearAiUpstream, startPump } from "./pump.ts";

const net = networkName();
const deployment = requireDeployment(net);
const chain = new Chain(network());
const barrel = new Barrel(chain, deployment.contract, deployment.usdc);
const seriesId = Number(process.env.PUMP_SERIES ?? deployment.series.at(-1)!.id);
const operator = loadWallet(net, process.env.PUMP_OPERATOR ?? deployment.operator);
// Only the contract owner can register keys. When this machine holds the
// owner key, the Pump re-attests and re-registers the model key on rotation.
const ownerKey = join(STATE_DIR, net, `${deployment.owner}.json`);

const pump = await startPump({
  barrel,
  seriesId,
  operator,
  upstream: nearAiUpstream(requireEnv("NEARAI_API_KEY")),
  port: Number(process.env.PUMP_PORT ?? 8787),
  host: process.env.PUMP_HOST ?? "127.0.0.1",
  settleIntervalMs: Number(process.env.PUMP_SETTLE_MS ?? 0),
  journalFile: join(STATE_DIR, "pump", `${deployment.contract}-${seriesId}.json`),
  registrar: existsSync(ownerKey)
    ? { owner: loadWallet(net, deployment.owner), evidenceDir: join(STATE_DIR, "evidence") }
    : undefined,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});

const stop = async () => {
  console.log("flushing acknowledged answers to the chain before exit…");
  await pump.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
