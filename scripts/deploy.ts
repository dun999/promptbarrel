// Deploys Barrel to testnet or mainnet and writes deployments/<network>.json,
// which the Pump, the CLI, the MCP server and the web pages read.
//
//   pnpm deploy:testnet [--tag v3]          test stablecoin, local Pump, sample answers
//   pnpm deploy:mainnet --root promptbarrel.near --funder <implicit account> \
//     --endpoint https://pump.promptbarrel.com [--yes]
//
// Steps:
//   1. attest every model on the list (packages/sdk/src/models.ts) against
//      NEAR AI Cloud and Intel; a model that fails is left out,
//   2. create the root name if it does not exist (paid by --funder),
//   3. deploy the contract, the attestor contract (and on testnet a test
//      stablecoin). The attestor starts with the compose hashes found in
//      step 1 as its reviewed lists; the owner cannot register keys at all,
//   4. per model: add a grade, register its key by on-chain attestation,
//      open a series pointing at the Pump,
//   5. on testnet, serve real answers so there is something on chain to
//      verify: one plain, one private, and one canary on the firm series.
//
// Mainnet uses Circle's USDC and low caps (50 USDC of escrow by default), and
// does nothing until --yes is given. Run it once without --yes to see the plan.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CHEAPEST_MODEL,
  Chain,
  MODELS,
  NETWORKS,
  REPO_ROOT,
  STATE_DIR,
  TankClient,
  attestModel,
  deployFresh,
  deploymentFile,
  inputWeightBps,
  listWallets,
  loadWallet,
  nearForCode,
  pricePerBarrel,
  readWasm,
  registerOnChain,
  requireEnv,
  saveEvidence,
  type ModelSpec,
  type NetworkName,
  type Wallet,
} from "@barrel/sdk";
import { newKeyPair } from "@barrel/verifier";
import { nearAiUpstream, startPump } from "../apps/pump/src/pump.ts";

/** Circle's native USDC on NEAR mainnet (6 decimals). */
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const KEY_TTL_SEC = 86_400;
const CANARY_FEE = 10n ** 22n; // 0.01 NEAR

const { values: o } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    root: { type: "string" },
    funder: { type: "string" },
    "root-near": { type: "string" },
    usdc: { type: "string" },
    endpoint: { type: "string" },
    tag: { type: "string", default: "v1" },
    /** Grade ids from the model list, comma separated. Default: all of them. */
    models: { type: "string" },
    /** The operator's margin over the model's output price, in basis points. */
    margin: { type: "string", default: "2000" },
    "escrow-cap": { type: "string" },
    "series-cap": { type: "string" },
    "window-end": { type: "string", default: "2026-12-31" },
    "unlock-delay": { type: "string", default: "600" },
    "settle-grace": { type: "string", default: "3600" },
    "claim-window": { type: "string", default: "300" },
    timelock: { type: "string" },
    "min-tank-buy": { type: "string", default: "10000" },
    /** USDC the operator bonds on each series, making it firm. 0: not firm. */
    "firm-bond": { type: "string" },
    guardian: { type: "string" },
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
const marginBps = Number(o.margin);
const escrowCap = toUnits(o["escrow-cap"] ?? (mainnet ? "50" : "100000"));
const seriesCapUnits = toUnits(o["series-cap"] ?? (mainnet ? "100" : "1000000")); // Barrels -> units
const windowEnd = Math.floor(Date.parse(`${o["window-end"]}T00:00:00Z`) / 1000);
if (!(windowEnd > Date.now() / 1000)) throw new Error("--window-end must be a future date (YYYY-MM-DD)");
const samples = o.samples ?? !mainnet;
if (samples && mainnet) throw new Error("sample answers mint test USDC; mainnet has none");
const tag = o.tag!;
const timelockSec = Number(o.timelock ?? (mainnet ? 86_400 : 300));
const firmBond = toUnits(o["firm-bond"] ?? (mainnet ? "0" : "2"));
const wanted = o.models ? o.models.split(",").map((g) => g.trim()) : MODELS.map((m) => m.grade);
const unknown = wanted.filter((g) => !MODELS.some((m) => m.grade === g));
if (unknown.length) throw new Error(`not on the model list: ${unknown.join(", ")} (see packages/sdk/src/models.ts)`);

const rootId = o.root ?? (mainnet ? undefined : listWallets("testnet").find((w) => /^barrel-[0-9a-f]{8}\.testnet$/.test(w)));
if (!rootId) throw new Error(`pass --root <account>; its key must be in ${join(STATE_DIR, net)}/ unless --funder creates it`);
const rootExists = await chain.nearBalance(rootId).then(() => true, () => false);

// --- 1. which models pass attestation today ------------------------------------------
// Nothing is deployed for a model whose TEE cannot prove itself.
const evidenceDir = join(REPO_ROOT, "deployments", "evidence");
interface Line {
  spec: ModelSpec;
  composeHashes: string[];
  machines: number;
  evidence: string;
}
const lines: Line[] = [];
console.log("Attestation      (NEAR AI Cloud report, Intel collateral, every machine)");
for (const spec of MODELS.filter((m) => wanted.includes(m.grade))) {
  try {
    const outcome = await attestModel(spec.model);
    if (!outcome.ok) {
      const failed = [...new Set(outcome.candidates.flatMap((c) => c.checks.filter((k) => !k.ok).map((k) => k.name)))];
      console.log(`  left out  ${spec.model}: ${failed.join("; ")}`);
      continue;
    }
    saveEvidence(evidenceDir, outcome);
    lines.push({
      spec,
      composeHashes: [...new Set(outcome.candidates.map((c) => c.compose_hash))],
      machines: outcome.candidates.length,
      evidence: `deployments/evidence/${outcome.evidenceHash}.json`,
    });
    console.log(`  passed    ${spec.model}: ${outcome.candidates.length} machine(s), key ${outcome.candidates[0]!.signing_address.slice(0, 16)}…`);
  } catch (e) {
    console.log(`  left out  ${spec.model}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
  }
}
if (lines.length === 0) throw new Error("no model passed attestation; nothing to deploy");
if (samples && !lines.some((l) => l.spec === CHEAPEST_MODEL)) throw new Error(`sample answers use ${CHEAPEST_MODEL.model}, which did not pass attestation today`);

// --- the plan, and what it costs -----------------------------------------------------
const contractNear = Number(nearForCode(readWasm("barrel")));
const attestorNear = Number(nearForCode(readWasm("attestor"), 0.3));
const tokenNear = usdcId ? 0 : Number(nearForCode(readWasm("test_usdc"), 0.3));
const operatorNear = mainnet ? 0.3 : 0.6; // a settlement costs about 0.0009 NEAR of gas
const buyerNear = samples ? 0.8 : 0;
// One on-chain attestation per machine, about 125 TGas each.
const gasNear = 0.2 + lines.reduce((n, l) => n + l.machines, 0) * 0.02;
const needOnRoot = contractNear + attestorNear + tokenNear + operatorNear + buyerNear + gasNear;
const rootNear = o["root-near"] ?? (needOnRoot + 0.1).toFixed(2);

console.log(`Network          ${net}`);
console.log(`Root (owner)     ${rootId}${rootExists ? "" : `  (new; created with ${rootNear} NEAR from ${o.funder ?? "?"})`}`);
console.log(`Contract         barrel-${tag}.${rootId}  ${contractNear} NEAR (code storage, comes back if the contract is removed)`);
console.log(`Attestor         attestor-${tag}.${rootId}  ${attestorNear} NEAR; the only way a model key gets registered`);
console.log(`Stablecoin       ${usdcId ?? `usdc-${tag}.${rootId} (test token, ${tokenNear} NEAR)`}`);
console.log(`Operator         op-${tag}.${rootId}  ${operatorNear} NEAR (pays settlement gas)`);
console.log(`Series           open until ${o["window-end"]}, cap ${Number(seriesCapUnits) / 1e6} Barrels each, Pump ${endpoint}`);
for (const { spec } of lines) {
  console.log(`  ${spec.model.padEnd(38)} ${(Number(pricePerBarrel(spec, marginBps)) / 1e6).toFixed(2)} per Barrel, input tokens weighted ${inputWeightBps(spec) / 100}%`);
}
console.log(`Firm             ${firmBond > 0n ? `yes: the operator bonds ${Number(firmBond) / 1e6} on each series and answers forced requests within 5 minutes` : "no (pass --firm-bond <USDC> to bond each series)"}`);
console.log(`Caps             ${Number(escrowCap) / 1e6} USDC escrow in total; unlock delay ${o["unlock-delay"]} s; claim window ${o["claim-window"]} s; settle grace ${o["settle-grace"]} s`);
console.log(`Changes          owner, attestor and code changes wait ${timelockSec} s after they are announced${o.guardian ? `; guardian ${o.guardian} can pause and cancel` : ""}`);
console.log(`Sample answers   ${samples ? "one plain, one private, one canary; paid on proof" : "none (the first answers come from real users)"}`);
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

const { barrel, contract, usdc, wasmSha256, attestor } = await deployFresh(chain, root, {
  tag,
  usdc: usdcId,
  unlockDelaySec: Number(o["unlock-delay"]),
  settleGraceSec: Number(o["settle-grace"]),
  claimWindowSec: Number(o["claim-window"]),
  timelockSec,
  minTankBuyUnits: BigInt(o["min-tank-buy"]!),
  maxSeriesUnits: seriesCapUnits,
  maxTotalEscrow: escrowCap,
  guardian: o.guardian,
  attestor: true,
  attestorCompose: Object.fromEntries(lines.map((l) => [l.spec.grade, l.composeHashes])),
  ownerRegistersKeys: false,
});
console.log(`contract ${contract.accountId}, attestor ${attestor!.contractId}, stablecoin ${barrel.usdcId}`);
const operator = await chain.createSubAccount(root, `op-${tag}`, String(operatorNear));
await barrel.registerUsdc(root, operator.accountId);

const series: { id: number; spec: ModelSpec; price: bigint; firm: boolean }[] = [];
for (const { spec } of lines) {
  await barrel.addGrade(root, { id: spec.grade, model_id: spec.model, input_weight_bps: inputWeightBps(spec), key_ttl_sec: KEY_TTL_SEC });
  // The attestor contract checks Intel's signatures itself. The root only pays gas here.
  const reg = await registerOnChain(attestor!, barrel, root, spec.grade, { evidenceDir });
  if (reg.registered.length === 0) throw new Error(`no key was registered for ${spec.model}`);
  const price = pricePerBarrel(spec, marginBps);
  const id = (
    await barrel.openSeries(operator, {
      gradeId: spec.grade,
      endpoint,
      pricePerBarrel: price,
      windowEnd,
      capUnits: seriesCapUnits,
      firm: firmBond > 0n ? { respond_sec: 300, max_misses: 3, canary_interval_sec: 600, canary_fee: CANARY_FEE.toString() } : undefined,
    })
  ).value;
  if (firmBond > 0n) {
    if (usdc) await barrel.faucet(operator, operator.accountId, firmBond);
    await barrel.addBond(operator, id, firmBond);
  }
  series.push({ id, spec, price, firm: firmBond > 0n });
  console.log(`series ${id}: ${spec.model}, key ${reg.registered[0]!.key.slice(0, 16)}… registered on-chain (${reg.gasTgas.map((g) => g.toFixed(0)).join(" + ")} TGas)`);
}

// --- testnet: real answers, so the chain holds settlements anyone can verify ------------
const receipts: { file: string; settle_tx?: string; units: string; private?: boolean }[] = [];
if (samples) {
  const line = series.find((s) => s.spec === CHEAPEST_MODEL)!;
  const buyer = await chain.createSubAccount(root, `buyer-${tag}`, String(buyerNear));
  await barrel.faucet(buyer, buyer.accountId, 1_000_000n);
  // Bought straight into a tank that the key owns: the way an agent with no account is funded.
  const tankKey = newKeyPair();
  await barrel.buyTank(buyer, line.id, 1_000_000n, tankKey.publicKey);
  const tankId = (await barrel.tankForKey(tankKey.publicKey))!.id;
  const tankDir = join(STATE_DIR, "tanks", contract.accountId);
  mkdirSync(tankDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tankDir, `${tankId}.json`),
    JSON.stringify({ tank_id: tankId, contract: contract.accountId, secret_key: tankKey.secretKey, public_key: tankKey.publicKey }, null, 2),
    { mode: 0o600 },
  );
  const pump = await startPump({
    barrel,
    seriesIds: series.map((s) => s.id),
    operator,
    upstream: nearAiUpstream(apiKey),
    port: 0,
    attestor,
    dutyIntervalMs: 0,
    log: (text) => console.log(`  [pump] ${text}`),
  });
  const receiptsDir = join(REPO_ROOT, "deployments", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const questions: [string, boolean][] = [
    ["In one sentence: what does a TEE attestation prove?", false],
    ["Name one risk of paying for AI inference before it is delivered. One sentence.", true],
  ];
  for (const [question, isPrivate] of questions) {
    const client = new TankClient({ barrel, tankSecretKey: tankKey.secretKey, pumpUrl: pump.url, private: isPrivate });
    const result = await client.chat({ messages: [{ role: "user", content: question }], max_tokens: 400, reasoning_effort: "low" });
    const name = `${contract.accountId.split(".")[0]}-tank${tankId}-seq${result.seq}.json`;
    writeFileSync(join(receiptsDir, name), `${JSON.stringify(result.receipt, null, 2)}\n`);
    receipts.push({ file: `deployments/receipts/${name}`, settle_tx: result.settleTx, units: result.units.toString(), ...(isPrivate ? { private: true } : {}) });
    console.log(`  Q${isPrivate ? " (private: the Pump saw only ciphertext)" : ""}: ${question}\n  A: ${result.content.trim().slice(0, 200)}\n  ${result.units} units, tx ${result.settleTx}`);
  }
  if (line.firm) {
    // Anyone may ask the operator to prove it is alive. The answer goes on chain.
    const id = (await barrel.canary(buyer, line.id, CANARY_FEE)).value;
    await pump.duty();
    const canary = await barrel.forced(id);
    if (canary?.status !== "answered") throw new Error(`the canary was not answered (${canary?.status})`);
    console.log(`  canary ${id} answered on chain by the model's own signature: ${canary.units} units`);
  }
  await pump.close();
}

const out = {
  network: net,
  rpc: NETWORKS[net].rpcUrl,
  contract: contract.accountId,
  attestor: attestor!.contractId,
  usdc: barrel.usdcId,
  owner: root.accountId,
  operator: operator.accountId,
  wasm_sha256: wasmSha256,
  attestor_wasm_sha256: createHash("sha256").update(readWasm("attestor")).digest("hex"),
  ...(usdc ? { test_usdc_wasm_sha256: createHash("sha256").update(readWasm("test_usdc")).digest("hex") } : {}),
  deployed_at: new Date().toISOString(),
  config: {
    unlock_delay_sec: Number(o["unlock-delay"]),
    settle_grace_sec: Number(o["settle-grace"]),
    claim_window_sec: Number(o["claim-window"]),
    timelock_sec: timelockSec,
    min_tank_buy_units: o["min-tank-buy"]!,
  },
  caps: { max_total_escrow: escrowCap.toString(), max_series_units: seriesCapUnits.toString() },
  grades: lines.map((l) => ({
    id: l.spec.grade,
    model_id: l.spec.model,
    label: l.spec.label,
    input_weight_bps: inputWeightBps(l.spec),
    key_ttl_sec: KEY_TTL_SEC,
    compose_hashes: l.composeHashes,
    evidence: l.evidence,
  })),
  series: series.map((s) => ({
    id: s.id,
    grade_id: s.spec.grade,
    model_id: s.spec.model,
    endpoint,
    price_per_barrel: s.price.toString(),
    window_end: windowEnd,
    ...(s.firm ? { firm_bond: firmBond.toString() } : {}),
  })),
  sample_receipts: receipts,
};
writeFileSync(deploymentFile(net), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${deploymentFile(net)}`);
