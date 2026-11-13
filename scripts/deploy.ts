// Deploys Barrel to testnet or mainnet and writes deployments/<network>.json,
// which the Pump, the CLI, the MCP server and the web pages read.
//
//   pnpm deploy:testnet [--tag v2]          test stablecoin, local Pump, two sample answers
//   pnpm deploy:mainnet --root promptbarrel.near --funder <implicit account> \
//     --endpoint https://pump.promptbarrel.com [--yes]
//
// Steps: create the root name if it does not exist (paid by --funder), deploy
// the contract (and on testnet a test stablecoin), register the model key after
// a live attestation check, create the operator, open a series pointing at the
// Pump. On testnet it then serves two real answers so there is something on
// chain to verify; on mainnet the first answers come from real users.
//
// Mainnet uses Circle's USDC and low caps (50 USDC of escrow by default), and
// does nothing until --yes is given. Run it once without --yes to see the plan.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  Chain,
  NETWORKS,
  REPO_ROOT,
  STATE_DIR,
  TankClient,
  attestAndRegister,
  deployFresh,
  deploymentFile,
  listWallets,
  loadWallet,
  nearForCode,
  readWasm,
  requireEnv,
  type NetworkName,
  type Wallet,
} from "@barrel/sdk";
import { newKeyPair } from "@barrel/verifier";
import { nearAiUpstream, startPump } from "../apps/pump/src/pump.ts";

/** Circle's native USDC on NEAR mainnet (6 decimals). */
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const MODEL = "z-ai/glm-5.3-flash";
const GRADE = "glm-5.3-flash";
const INPUT_WEIGHT_BPS = 1600;
const KEY_TTL_SEC = 86_400;

const { values: o } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    root: { type: "string" },
    funder: { type: "string" },
    "root-near": { type: "string" },
    usdc: { type: "string" },
    endpoint: { type: "string" },
    tag: { type: "string", default: "v1" },
    price: { type: "string", default: "0.6" },
    "escrow-cap": { type: "string" },
    "series-cap": { type: "string" },
    "window-end": { type: "string", default: "2026-12-31" },
    "unlock-delay": { type: "string", default: "600" },
    "settle-grace": { type: "string", default: "3600" },
    samples: { type: "boolean" },
    yes: { type: "boolean", default: false },
  },
});

const net = o.network as NetworkName;
if (net !== "testnet" && net !== "mainnet") throw new Error("--network must be testnet or mainnet");
const mainnet = net === "mainnet";
const chain = new Chain(NETWORKS[net]);
const apiKey = requireEnv("NEARAI_API_KEY");
const toUnits = (decimal: string) => BigInt(Math.round(Number(decimal) * 1_000_000));
const nearOf = (yocto: bigint) => Number(yocto / 10n ** 21n) / 1000;

// --- settings ------------------------------------------------------------------
const usdcId = o.usdc ?? (mainnet ? MAINNET_USDC : undefined);
const endpoint = o.endpoint ?? (mainnet ? undefined : "http://127.0.0.1:8787");
if (!endpoint) throw new Error("--endpoint is required on mainnet: the public HTTPS address of the Pump");
// A browser reaches a Pump only over HTTPS or on its own machine. A local
// endpoint is for running the Pump here until it has a public address; the
// operator then moves it with set_series_endpoint.
const localEndpoint = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(endpoint);
if (mainnet && !endpoint.startsWith("https://") && !localEndpoint) throw new Error("a mainnet Pump must be served over HTTPS (or on this machine)");
const pricePerBarrel = toUnits(o.price!);
const escrowCap = toUnits(o["escrow-cap"] ?? (mainnet ? "50" : "100000"));
const seriesCapUnits = toUnits(o["series-cap"] ?? (mainnet ? "100" : "1000000")); // Barrels -> units
const windowEnd = Math.floor(Date.parse(`${o["window-end"]}T00:00:00Z`) / 1000);
if (!(windowEnd > Date.now() / 1000)) throw new Error("--window-end must be a future date (YYYY-MM-DD)");
const samples = o.samples ?? !mainnet;
if (samples && mainnet) throw new Error("sample answers mint test USDC; mainnet has none");
const tag = o.tag!;

const rootId = o.root ?? (mainnet ? undefined : listWallets("testnet").find((w) => /^barrel-[0-9a-f]{8}\.testnet$/.test(w)));
if (!rootId) throw new Error(`pass --root <account>; its key must be in ${join(STATE_DIR, net)}/ unless --funder creates it`);
const rootExists = await chain.nearBalance(rootId).then(() => true, () => false);

// --- the plan, and what it costs -----------------------------------------------------
const contractNear = Number(nearForCode(readWasm("barrel")));
const tokenNear = usdcId ? 0 : Number(nearForCode(readWasm("test_usdc"), 0.3));
const operatorNear = mainnet ? 0.2 : 0.3; // a settlement costs about 0.0009 NEAR of gas
const buyerNear = samples ? 0.3 : 0;
const gasNear = 0.15;
const needOnRoot = contractNear + tokenNear + operatorNear + buyerNear + gasNear;
const rootNear = o["root-near"] ?? (needOnRoot + 0.1).toFixed(2);

console.log(`Network          ${net}`);
console.log(`Root (owner)     ${rootId}${rootExists ? "" : `  (new; created with ${rootNear} NEAR from ${o.funder ?? "?"})`}`);
console.log(`Contract         barrel-${tag}.${rootId}  ${contractNear} NEAR (code storage, comes back if the contract is removed)`);
console.log(`Stablecoin       ${usdcId ?? `usdc-${tag}.${rootId} (test token, ${tokenNear} NEAR)`}`);
console.log(`Operator         op-${tag}.${rootId}  ${operatorNear} NEAR (pays settlement gas)`);
console.log(`Model            ${MODEL}, input tokens weighted ${INPUT_WEIGHT_BPS / 100}%, key lifetime ${KEY_TTL_SEC / 3600} h`);
console.log(`Series           ${o.price} per Barrel, open until ${o["window-end"]}, cap ${Number(seriesCapUnits) / 1e6} Barrels, Pump ${endpoint}`);
console.log(`Caps             ${Number(escrowCap) / 1e6} USDC escrow in total; unlock delay ${o["unlock-delay"]} s; settle grace ${o["settle-grace"]} s`);
console.log(`Sample answers   ${samples ? "two, paid on proof" : "none (the first answers come from real users)"}`);
console.log(`NEAR needed      about ${needOnRoot.toFixed(2)} on the root`);
if (localEndpoint && mainnet) console.log("Note             the Pump endpoint is this machine; move it with set_series_endpoint once it has an HTTPS address");

if (!rootExists) {
  if (!o.funder) throw new Error(`${rootId} does not exist: pass --funder <account> to create it`);
  const have = nearOf(await chain.nearBalance(o.funder));
  console.log(`Funder           ${o.funder} holds ${have} NEAR`);
  if (have < Number(rootNear) + 0.05) throw new Error(`the funder needs at least ${(Number(rootNear) + 0.05).toFixed(2)} NEAR`);
} else {
  const have = nearOf(await chain.nearBalance(rootId));
  console.log(`Root holds       ${have} NEAR`);
  if (have < needOnRoot) throw new Error(`${rootId} needs about ${needOnRoot.toFixed(2)} NEAR`);
}
if (existsSync(deploymentFile(net))) console.log(`Replaces         ${deploymentFile(net)} (the old contract stays on chain)`);
if (mainnet && !o.yes) {
  console.log("\nNothing was sent. Add --yes to deploy.");
  process.exit(0);
}

// --- deploy ----------------------------------------------------------------------
let root: Wallet;
if (rootExists) {
  root = loadWallet(net, rootId);
} else {
  root = await chain.createTopLevelAccount(loadWallet(net, o.funder!), rootId, rootNear);
  console.log(`created ${rootId}; its key is in ${join(STATE_DIR, net, `${rootId}.json`)}`);
}

const { barrel, contract, usdc, wasmSha256 } = await deployFresh(chain, root, {
  tag,
  usdc: usdcId,
  unlockDelaySec: Number(o["unlock-delay"]),
  settleGraceSec: Number(o["settle-grace"]),
  maxSeriesUnits: seriesCapUnits,
  maxTotalEscrow: escrowCap,
});
console.log(`contract ${contract.accountId}, stablecoin ${barrel.usdcId}`);
const operator = await chain.createSubAccount(root, `op-${tag}`, String(operatorNear));
await barrel.registerUsdc(root, operator.accountId);

await barrel.addGrade(root, { id: GRADE, model_id: MODEL, input_weight_bps: INPUT_WEIGHT_BPS, key_ttl_sec: KEY_TTL_SEC });
const evidenceDir = join(REPO_ROOT, "deployments", "evidence");
const { outcome, registered } = await attestAndRegister(barrel, root, GRADE, { evidenceDir });
console.log(`attestation ${outcome.ok ? "passed" : "FAILED"}; registered ${registered.map((k) => k.key).join(", ")}`);
if (!outcome.ok || registered.length === 0) throw new Error("no attested model key was registered; not opening a series");

const seriesId = (
  await barrel.openSeries(operator, {
    gradeId: GRADE,
    endpoint,
    pricePerBarrel,
    windowEnd,
    capUnits: seriesCapUnits,
  })
).value;
console.log(`series ${seriesId} open until ${new Date(windowEnd * 1000).toISOString()}`);

// --- testnet: two real answers, so the chain holds settlements anyone can verify --------
const receipts: { file: string; settle_tx?: string; units: string }[] = [];
if (samples) {
  const buyer = await chain.createSubAccount(root, `buyer-${tag}`, String(buyerNear));
  await barrel.faucet(buyer, buyer.accountId, 1_000_000n);
  await barrel.buy(buyer, seriesId, 1_000_000n);
  const tankKey = newKeyPair();
  const tankId = (await barrel.fill(buyer, seriesId, 1_000_000n, tankKey.publicKey)).value;
  const tankDir = join(STATE_DIR, "tanks", contract.accountId);
  mkdirSync(tankDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tankDir, `${tankId}.json`),
    JSON.stringify({ tank_id: tankId, contract: contract.accountId, secret_key: tankKey.secretKey, public_key: tankKey.publicKey }, null, 2),
    { mode: 0o600 },
  );
  const pump = await startPump({
    barrel,
    seriesId,
    operator,
    upstream: nearAiUpstream(apiKey),
    port: 0,
    registrar: { owner: root, evidenceDir: join(STATE_DIR, "evidence") },
    log: (line) => console.log(`  [pump] ${line}`),
  });
  const client = new TankClient({ barrel, tankId, tankSecretKey: tankKey.secretKey, pumpUrl: pump.url });
  const receiptsDir = join(REPO_ROOT, "deployments", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const questions = [
    "In one sentence: what does a TEE attestation prove?",
    "Name one risk of paying for AI inference before it is delivered. One sentence.",
  ];
  for (const question of questions) {
    const result = await client.chat({ messages: [{ role: "user", content: question }], max_tokens: 400, reasoning_effort: "low" });
    const name = `${contract.accountId.split(".")[0]}-tank${tankId}-seq${result.seq}.json`;
    writeFileSync(join(receiptsDir, name), `${JSON.stringify(result.receipt, null, 2)}\n`);
    receipts.push({ file: `deployments/receipts/${name}`, settle_tx: result.settleTx, units: result.units.toString() });
    console.log(`  Q: ${question}\n  A: ${result.content.trim().slice(0, 200)}\n  ${result.units} units, tx ${result.settleTx}`);
  }
  await pump.close();
}

const out = {
  network: net,
  rpc: NETWORKS[net].rpcUrl,
  contract: contract.accountId,
  usdc: barrel.usdcId,
  owner: root.accountId,
  operator: operator.accountId,
  wasm_sha256: wasmSha256,
  ...(usdc ? { test_usdc_wasm_sha256: createHash("sha256").update(readWasm("test_usdc")).digest("hex") } : {}),
  deployed_at: new Date().toISOString(),
  config: { unlock_delay_sec: Number(o["unlock-delay"]), settle_grace_sec: Number(o["settle-grace"]) },
  caps: { max_total_escrow: escrowCap.toString(), max_series_units: seriesCapUnits.toString() },
  grades: [{ id: GRADE, model_id: MODEL, input_weight_bps: INPUT_WEIGHT_BPS, key_ttl_sec: KEY_TTL_SEC, evidence: `deployments/evidence/${outcome.evidenceHash}.json` }],
  series: [{ id: seriesId, grade_id: GRADE, model_id: MODEL, endpoint, price_per_barrel: pricePerBarrel.toString(), window_end: windowEnd }],
  sample_receipts: receipts,
};
writeFileSync(deploymentFile(net), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${deploymentFile(net)}`);
