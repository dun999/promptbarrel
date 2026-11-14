#!/usr/bin/env -S node --import tsx
// barrel: verify receipts, audit model keys, and use a tank from the terminal.
//
//   barrel verify <receipt.json>         check a receipt locally and against the chain
//   barrel status                        grades, keys, series and recent settlements
//   barrel attest <model-id>             run every attestation check on a model now
//   barrel audit [grade]                 compare registered keys with a fresh attestation
//   barrel account                       create a faucet-funded account (BARREL_NETWORK=testnet only)
//   barrel buy <series> <usdc>           buy Barrels (on testnet, mints test USDC first)
//   barrel buy-from <chain> <series> <usdc> --refund-to <address> [--to <near account>]
//                                        buy with USDC on another chain (NEAR Intents 1Click, mainnet)
//   barrel fill <series> <units> [--agent <account>]
//                                        move Barrels into a tank under a new spend key; with
//                                        --agent it is a job tank whose leftover pays the agent
//   barrel accept <tank>                 accept a job tank's work: the leftover goes to the agent
//   barrel ask <tank|key> "<question>" [--private]
//                                        ask through the series' Pump; pay only with proof.
//                                        --private: the Pump relays ciphertext it cannot read
//   barrel unlock <tank> | withdraw <tank> | refund <series> [units]
//   barrel models                        the models on offer: price, input weight, index price
//   barrel key                           a new tank key, for an agent with no NEAR account
//   barrel fund <series> <usdc> [--key <public key>]
//                                        buy straight into a tank that the key owns
//   barrel fund-from <chain> <series> <usdc> --refund-to <address> [--key <public key>]
//                                        the same from another chain (NEAR Intents 1Click, mainnet)
//   barrel assign <tank> <account>       a key-owned tank hands itself to a NEAR account
//   barrel force <tank> "<question>"     send a request through the chain to a firm series
//   barrel canary <series>               make a firm series' operator prove it is serving
//   barrel forced <id> | slash <id>      a forced request; record a missed deadline
//   barrel index [grade]                 the settlement price index, from proven deliveries
//   barrel register <grade>              register the model's key by on-chain attestation (anyone)
//   barrel sell <series> <units> <usdc> | offers | take <offer id> | unsell <series>
//                                        resell Barrels inside NEAR Intents (mainnet)
//
// Options: --contract <id> (default: deployments/<network>.json), --account <id>,
//          --pump <url>, --json. ONECLICK_JWT avoids 1Click's 0.25% unauthenticated fee. BARREL_NETWORK=testnet switches network (default mainnet).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  attestModel,
  Attestor,
  Barrel,
  Chain,
  Intents,
  MODELS,
  PaymentRequired,
  STATE_DIR,
  TankClient,
  inputWeightBps,
  pricePerBarrel,
  registerOnChain,
  signAssign,
  type Offer,
  listWallets,
  loadWallet,
  network,
  networkName,
  readDeployment,
  stablecoinName,
  type Wallet,
} from "./index.ts";
import { buyRoom, finished, quoteBuy, swapStatus, usdcOrigins } from "./oneclick.ts";
import {
  checkReceipt,
  formatAmount,
  newKeyPair,
  parseAmount,
  publicKeyOf,
  RECEIPT_LIMITS,
  type Check,
  type Receipt,
} from "@barrel/verifier";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    contract: { type: "string" },
    account: { type: "string" },
    pump: { type: "string" },
    agent: { type: "string" },
    "refund-to": { type: "string" },
    to: { type: "string" },
    key: { type: "string" },
    private: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [command, ...rest] = positionals;

const net = networkName();
const chain = new Chain(network());
const coin = stablecoinName(net);
const say = (text = "") => console.log(text);
const mark = (c: Check) => say(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);

async function connect(): Promise<Barrel> {
  const contract = opts.contract ?? process.env.BARREL_CONTRACT ?? readDeployment(net)?.contract;
  if (!contract) throw new Error(`no contract: pass --contract <account>, or deploy to ${net} first`);
  const config = await chain.view<{ usdc: string }>(contract, "get_config");
  return new Barrel(chain, contract, config.usdc);
}

function wallet(): Wallet {
  const id = opts.account ?? process.env.BARREL_ACCOUNT;
  if (id) return loadWallet(net, id);
  const mine = listWallets(net).filter((w) => w.startsWith("barrel-user-"));
  if (mine.length === 0) throw new Error(net === "testnet" ? "no local account: run `barrel account` first, or pass --account <id>" : `pass --account <id> with its key in ${join(STATE_DIR, net)}/`);
  return loadWallet(net, mine[mine.length - 1]!);
}

function tankFile(contract: string, tankId: number): string {
  return join(STATE_DIR, "tanks", contract, `${tankId}.json`);
}

function keyFile(publicKey: string): string {
  return join(STATE_DIR, "keys", `${publicKey}.json`);
}

/** The secret key of a tank: from its tank file, or from the key file of a tank its key owns. */
async function tankSecret(barrel: Barrel, ref: string): Promise<{ tankId?: number; secret: string }> {
  if (/^[0-9a-f]{64}$/.test(ref)) {
    if (!existsSync(keyFile(ref))) throw new Error(`no secret for key ${ref} in ${join(STATE_DIR, "keys")}/`);
    const tank = await barrel.tankForKey(ref);
    return { tankId: tank?.id, secret: JSON.parse(readFileSync(keyFile(ref), "utf8")).secret_key };
  }
  const tankId = Number(ref);
  return { tankId, secret: JSON.parse(readFileSync(tankFile(barrel.contractId, tankId), "utf8")).secret_key };
}

function saveTank(contract: string, tankId: number, secret: string): string {
  const file = tankFile(contract, tankId);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ tank_id: tankId, contract, secret_key: secret, public_key: publicKeyOf(secret) }, null, 2), { mode: 0o600 });
  return file;
}

/** A key from --key (its secret must be on this machine), or a new one. */
function useKey(): { publicKey: string; secretKey: string; created: boolean } {
  if (opts.key) {
    if (!existsSync(keyFile(opts.key))) throw new Error(`no secret for key ${opts.key}; make one with barrel key`);
    return { publicKey: opts.key, secretKey: JSON.parse(readFileSync(keyFile(opts.key), "utf8")).secret_key, created: false };
  }
  const k = newKeyPair();
  mkdirSync(join(STATE_DIR, "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(k.publicKey), JSON.stringify({ public_key: k.publicKey, secret_key: k.secretKey }, null, 2), { mode: 0o600 });
  return { ...k, created: true };
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`usage: barrel ${usage}`);
  return value;
}

// ---------------------------------------------------------------------------

async function verify(file: string): Promise<boolean> {
  const receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt;
  say(`Receipt for ${receipt.model_id} (grade ${receipt.grade_id})`);
  say("Local checks (no network):");
  const local = checkReceipt(receipt);
  local.checks.forEach(mark);
  let valid = local.valid;
  let chainChecked = false;
  try {
    const barrel = await connect();
    const view = await barrel.verifyReceipt(receipt);
    say(`Chain checks (${barrel.contractId}, free view call):`);
    mark({ name: "signature verifies over the grade's model name", ok: view.signature_ok, detail: view.text ? "" : view.reason ?? "" });
    mark({ name: "signing key is registered for the grade", ok: view.key_registered, detail: view.key_registered ? "" : "a gateway key is never registered" });
    say(`  · key ${view.key_live ? "is live" : "is no longer live (expired or revoked; old receipts stay checkable)"}`);
    valid = valid && view.valid;
    chainChecked = true;
    if (opts.json) say(JSON.stringify(view, null, 2));
  } catch (e) {
    say(`Chain checks skipped: ${e instanceof Error ? e.message : e}`);
  }
  say();
  say(valid ? (chainChecked ? "VALID" : "VALID (local checks only; pass --contract to check the key registry)") : local.valid ? "REJECTED by the chain" : local.verdict);
  say();
  say("What this proves and what it does not:");
  RECEIPT_LIMITS.forEach((l) => say(`  - ${l}`));
  return valid;
}

async function status(): Promise<void> {
  const barrel = await connect();
  const config = await barrel.config();
  say(`Contract ${barrel.contractId} on ${net}${config.paused ? " (PAUSED)" : ""}`);
  say(`  owner ${config.owner}, stablecoin ${config.usdc}`);
  say(`  escrow ${formatAmount(await barrel.totalEscrow())} ${coin}, unlock delay ${config.unlock_delay_sec}s, settle grace ${config.settle_grace_sec}s`);
  const now = Math.floor(Date.now() / 1000);
  for (const grade of await barrel.grades()) {
    say(`Grade ${grade.id}: ${grade.model_id}, input weight ${grade.input_weight_bps / 100}%, key lifetime ${grade.key_ttl_sec}s`);
    for (const k of await barrel.keys(grade.id)) {
      say(`  key ${k.key} ${now < k.expires_at ? `live until ${new Date(k.expires_at * 1000).toISOString()}` : "expired"}, evidence ${k.evidence_hash.slice(0, 16)}…`);
    }
  }
  for (const s of await barrel.seriesList()) {
    const state = now < s.window_end ? `open until ${new Date(s.window_end * 1000).toISOString()}` : "expired";
    say(`Series ${s.id} by ${s.operator}: ${s.grade_id} at ${formatAmount(s.price_per_barrel)} ${coin}/Barrel, ${state}`);
    say(`  minted ${s.minted}, delivered ${s.burned}, refunded ${s.refunded}, in tanks ${s.in_tanks}; operator earned ${formatAmount(s.released)} ${coin}`);
    if (s.endpoint) say(`  pump ${s.endpoint}`);
  }
  const recent = await barrel.recentSettlements(5);
  say(`Settlements: ${await barrel.settlementCount()} total${recent.length ? ", latest:" : ""}`);
  for (const r of recent) {
    say(`  tank ${r.tank_id} #${r.seq}: ${r.units} units, model key ${r.tee_key.slice(0, 12)}…, ${new Date(r.at * 1000).toISOString()}`);
  }
}

async function attest(modelId: string): Promise<boolean> {
  say(`Fetching a fresh attestation for ${modelId} with a new nonce (no API key needed)…`);
  const outcome = await attestModel(modelId);
  outcome.candidates.forEach((c, i) => {
    say(`Candidate ${i + 1}: signing key ${c.signing_address}`);
    c.checks.forEach(mark);
  });
  say(outcome.ok ? "ATTESTED" : "NOT ATTESTED");
  say(`evidence sha256 ${outcome.evidenceHash}`);
  return outcome.ok;
}

async function audit(gradeId?: string): Promise<boolean> {
  const barrel = await connect();
  const grades = (await barrel.grades()).filter((g) => !gradeId || g.id === gradeId);
  let allOk = true;
  const now = Math.floor(Date.now() / 1000);
  for (const grade of grades) {
    say(`Grade ${grade.id} (${grade.model_id})`);
    const outcome = await attestModel(grade.model_id);
    const attested = new Set(outcome.candidates.filter((c) => c.ok).map((c) => c.signing_address));
    outcome.candidates.forEach((c) => c.checks.filter((k) => !k.ok).forEach(mark));
    say(`  fresh attestation: ${outcome.ok ? "passes every check" : "FAILS"}; attested keys: ${[...attested].map((k) => k.slice(0, 12) + "…").join(", ") || "none"}`);
    for (const k of await barrel.keys(grade.id)) {
      const live = now < k.expires_at;
      const ok = !live || attested.has(k.key);
      allOk &&= ok;
      say(`  ${ok ? "✓" : "✗"} registered key ${k.key.slice(0, 12)}… ${live ? "live" : "expired"}${live ? (attested.has(k.key) ? ", matches the attested key" : ", NOT the key the model attests today") : ""}`);
    }
  }
  return allOk;
}

async function account(): Promise<void> {
  if (net !== "testnet") throw new Error("only testnet has a faucet; on mainnet use your own account with --account");
  const w = await chain.createFaucetAccount("barrel-user");
  say(`Created ${w.accountId} with testnet NEAR from the faucet.`);
  say(`Key saved to ${join(STATE_DIR, net, `${w.accountId}.json`)} (git-ignored).`);
}

async function buy(seriesId: number, usdcText: string): Promise<void> {
  const barrel = await connect();
  const me = wallet();
  const amount = parseAmount(usdcText);
  const have = await barrel.usdcBalance(me.accountId).catch(() => 0n);
  if (have < amount) {
    if (net !== "testnet") throw new Error(`${me.accountId} holds ${formatAmount(have)} USDC, less than ${usdcText}`);
    await barrel.faucet(me, me.accountId, amount);
    say(`Minted ${usdcText} test USDC from the faucet (testnet only, no value).`);
  }
  const out = await barrel.buy(me, seriesId, amount);
  if (out.failures.length) throw new Error(out.failures.join("; "));
  say(`Paid ${formatAmount(out.value)} ${coin} into escrow; you hold ${await barrel.balanceOf(me.accountId, seriesId)} units of series ${seriesId}.`);
  say(`${chain.net.explorerTx}${out.txHash}`);
}

async function fill(seriesId: number, units: bigint): Promise<void> {
  const barrel = await connect();
  const me = wallet();
  const key = newKeyPair();
  const out = await barrel.fill(me, seriesId, units, key.publicKey, opts.agent);
  const file = tankFile(barrel.contractId, out.value);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ tank_id: out.value, contract: barrel.contractId, secret_key: key.secretKey, public_key: key.publicKey }, null, 2), { mode: 0o600 });
  say(`Tank ${out.value} holds ${units} units. Its spend key is in ${file}.`);
  say("Give that file to an agent: it can ask and pay for answers, and cannot move or withdraw anything.");
  if (opts.agent) say(`Job tank for ${opts.agent}: when you accept the work (barrel accept ${out.value}), the leftover is paid to the agent.`);
}

async function accept(tankId: number): Promise<void> {
  const barrel = await connect();
  const out = await barrel.accept(wallet(), tankId);
  if (out.failures.length) throw new Error(out.failures.join("; "));
  const tank = (await barrel.tank(tankId))!;
  say(`Accepted job tank ${tankId}. From ${new Date(out.value * 1000).toISOString()} anyone of you two can pay ${tank.agent} the leftover: barrel withdraw ${tankId}.`);
  say(`${chain.net.explorerTx}${out.txHash}`);
}

/** Buy with USDC on another chain: one deposit there, Barrels land on the NEAR account. */
async function buyFrom(chainName: string, seriesId: number, usdcText: string): Promise<void> {
  if (net !== "mainnet") throw new Error("NEAR Intents runs on mainnet only; set BARREL_NETWORK=mainnet");
  const refundTo = need(opts["refund-to"], "buy-from needs --refund-to <your address on the origin chain>");
  const barrel = await connect();
  const to = opts.to ?? wallet().accountId;
  const origins = await usdcOrigins();
  const origin = origins.find((t) => t.blockchain === chainName);
  if (!origin) throw new Error(`no USDC route from ${chainName}; try one of ${origins.map((t) => t.blockchain).join(", ")}`);
  const amount = parseAmount(usdcText);
  const [series, config, escrow] = await Promise.all([barrel.series(seriesId), barrel.config(), barrel.totalEscrow()]);
  if (!series) throw new Error(`unknown series ${seriesId}`);
  const room = buyRoom(series, config, escrow);
  // A refused delivery would return the USDC to 1Click, not to you: stay under the caps.
  if (amount > room) throw new Error(`series ${seriesId} can take at most ${formatAmount(room)} USDC right now`);
  const jwt = process.env.ONECLICK_JWT;
  const q = await quoteBuy({ originAsset: origin.assetId, amount, refundTo, contract: barrel.contractId, usdc: barrel.usdcId, seriesId, to, jwt });
  say(`Send exactly ${q.amountInFormatted} USDC on ${chainName} to:`);
  say(`  ${q.depositAddress}`);
  say(`About ${formatAmount(BigInt(q.amountOut))} USDC reaches Barrel (at least ${formatAmount(BigInt(q.minAmountOut))}); the Barrels go to ${to}.`);
  say(`Unfinished by ${q.deadline}, the deposit is refunded to ${refundTo}. Usually about ${q.timeEstimate}s.`);
  say("Waiting for the deposit… (Ctrl-C stops watching; the swap continues)");
  const before = await barrel.balanceOf(to, seriesId);
  let last = "";
  for (;;) {
    const st = await swapStatus(q.depositAddress!, jwt).catch(() => null);
    if (st && st.status !== last) {
      last = st.status;
      say(`  ${new Date().toISOString().slice(11, 19)} ${st.status}`);
    }
    if (st && finished(st.status)) {
      if (st.status !== "SUCCESS") throw new Error(`the swap ended ${st.status}${st.refundedAmount ? `; refunded ${st.refundedAmount}` : ""}`);
      const after = await barrel.balanceOf(to, seriesId);
      say(`${to} now holds ${after} units of series ${seriesId} (+${after - before}).`);
      for (const h of st.nearTxs) say(`${chain.net.explorerTx}${h}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function ask(ref: string, question: string): Promise<boolean> {
  const barrel = await connect();
  const { tankId, secret } = await tankSecret(barrel, ref);
  if (tankId === undefined) throw new Error(`key ${ref} owns no tank yet: barrel fund <series> <usdc> --key ${ref}`);
  const client = new TankClient({ barrel, tankId, tankSecretKey: secret, pumpUrl: opts.pump, private: opts.private });
  let result;
  try {
    // Reasoning models think before answering; "low" keeps short questions short.
    result = await client.chat({ messages: [{ role: "user", content: question }], max_tokens: 800, reasoning_effort: "low" });
  } catch (e) {
    if (!(e instanceof PaymentRequired)) throw e;
    say(`The tank cannot cover this request. The Pump offers:`);
    for (const a of e.accepts) say(`  ${a.network}: send ${formatAmount(BigInt(a.maxAmountRequired))} ${a.asset === barrel.usdcId ? coin : a.asset} to ${a.payTo}${a.extra?.msg ? ` with msg ${a.extra.msg}` : ""}`);
    return false;
  }
  say(result.content.trim() || "(no visible answer: the token limit was spent on reasoning)");
  say();
  result.checks.forEach(mark);
  if (result.sealedTo) say(`Private: the prompt and the answer crossed the Pump encrypted to model key ${result.sealedTo.slice(0, 16)}… and to this tank's key.`);
  say(`Paid ${result.units} units for ${result.usage.prompt_tokens} prompt + ${result.usage.completion_tokens} completion tokens.`);
  if (result.settleTx) say(`${chain.net.explorerTx}${result.settleTx}`);
  const dir = join(STATE_DIR, "receipts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${barrel.contractId}-${tankId}-${result.seq}.json`);
  writeFileSync(file, `${JSON.stringify(result.receipt, null, 2)}\n`);
  say(`Receipt: ${file}`);
  return true;
}

// --- the model list and the price index -----------------------------------------

async function models(): Promise<void> {
  let barrel: Barrel | undefined;
  try {
    barrel = await connect();
  } catch {}
  const grades = barrel ? await barrel.grades() : [];
  const series = barrel ? await barrel.seriesList() : [];
  const now = Math.floor(Date.now() / 1000);
  say(`Models NEAR AI Cloud serves from its own attested TEEs${barrel ? `, as offered on ${barrel.contractId}` : ""}:`);
  for (const m of MODELS) {
    const grade = grades.find((g) => g.model_id === m.model);
    const open = series.filter((s) => s.grade_id === grade?.id && now < s.window_end);
    say(`${m.model}${m.cheapest ? "  (cheapest)" : ""}`);
    say(`  list price $${m.inputUsd} in / $${m.outputUsd} out per million tokens; input tokens count at ${inputWeightBps(m) / 100}% of a unit`);
    if (!grade) {
      say(`  not offered here (suggested price ${formatAmount(pricePerBarrel(m))} ${coin} per Barrel)`);
      continue;
    }
    const live = (await barrel!.keys(grade.id)).filter((k) => now < k.expires_at).length;
    const index = await barrel!.index(grade.id).catch(() => null);
    for (const s of open) {
      say(`  series ${s.id}: ${formatAmount(s.price_per_barrel)} ${coin} per Barrel${s.firm ? `, firm (bond ${formatAmount(s.firm.bond)} ${coin})` : ""}, until ${new Date(s.window_end * 1000).toISOString().slice(0, 10)}`);
    }
    say(`  ${live} live attested key(s)${index && index.deliveries ? `; index ${formatAmount(index.price_per_barrel)} ${coin} per Barrel over ${index.deliveries} proven deliveries in 24 h` : ""}`);
  }
}

async function priceIndex(gradeId?: string): Promise<void> {
  const barrel = await connect();
  for (const g of (await barrel.grades()).filter((x) => !gradeId || x.id === gradeId)) {
    const i = await barrel.index(g.id);
    say(`${g.id} (${g.model_id}): ${i.deliveries ? `${formatAmount(i.price_per_barrel)} ${coin} per Barrel` : "no deliveries yet"}`);
    say(`  ${i.deliveries} proven deliveries, ${i.units} units, ${formatAmount(i.usdc)} ${coin} over the last ${i.window_sec / 3600} h`);
  }
  say("The index only counts deliveries the contract verified: a model signature, then an ack, a claim or a forced answer.");
}

// --- key-owned tanks --------------------------------------------------------------

async function key(): Promise<void> {
  const k = useKey();
  say(`Public key ${k.publicKey}`);
  say(`Secret saved to ${keyFile(k.publicKey)} (git-ignored, mode 0600).`);
  say("Anyone can fund a tank for this key; only the key can spend it:");
  say(`  barrel fund <series> <usdc> --key ${k.publicKey}`);
  say("Or send it to a Pump as x-barrel-key: the HTTP 402 answer says exactly how to pay.");
}

async function fund(seriesId: number, usdcText: string): Promise<void> {
  const barrel = await connect();
  const me = wallet();
  const k = useKey();
  const amount = parseAmount(usdcText);
  const have = await barrel.usdcBalance(me.accountId).catch(() => 0n);
  if (have < amount) {
    if (net !== "testnet") throw new Error(`${me.accountId} holds ${formatAmount(have)} USDC, less than ${usdcText}`);
    await barrel.faucet(me, me.accountId, amount);
  }
  const existed = (await barrel.tankForKey(k.publicKey)) !== null;
  const out = await barrel.buyTank(me, seriesId, amount, k.publicKey);
  if (out.failures.length) throw new Error(out.failures.join("; "));
  const tank = (await barrel.tankForKey(k.publicKey))!;
  saveTank(barrel.contractId, tank.id, k.secretKey);
  say(`Tank ${tank.id} holds ${tank.balance} units, owned by key ${k.publicKey.slice(0, 16)}… (${existed ? "topped up" : "new tank"}; secret in ${keyFile(k.publicKey)}).`);
  say(`No NEAR account is needed to use it: barrel ask ${k.publicKey} "<question>"`);
  say(`${chain.net.explorerTx}${out.txHash}`);
}

async function fundFrom(chainName: string, seriesId: number, usdcText: string): Promise<void> {
  if (net !== "mainnet") throw new Error("NEAR Intents runs on mainnet only; set BARREL_NETWORK=mainnet");
  const refundTo = need(opts["refund-to"], "fund-from needs --refund-to <your address on the origin chain>");
  const barrel = await connect();
  const k = useKey();
  const origin = (await usdcOrigins()).find((t) => t.blockchain === chainName);
  if (!origin) throw new Error(`no USDC route from ${chainName}`);
  const amount = parseAmount(usdcText);
  const [series, config, escrow] = await Promise.all([barrel.series(seriesId), barrel.config(), barrel.totalEscrow()]);
  if (!series) throw new Error(`unknown series ${seriesId}`);
  if (amount > buyRoom(series, config, escrow)) throw new Error(`series ${seriesId} can take at most ${formatAmount(buyRoom(series, config, escrow))} USDC right now`);
  const q = await quoteBuy({ originAsset: origin.assetId, amount, refundTo, contract: barrel.contractId, usdc: barrel.usdcId, seriesId, tankKey: k.publicKey, jwt: process.env.ONECLICK_JWT });
  say(`Send exactly ${q.amountInFormatted} USDC on ${chainName} to ${q.depositAddress}`);
  say(`The purchase lands in a tank owned by key ${k.publicKey} (secret in ${keyFile(k.publicKey)}).`);
  say(`Unfinished by ${q.deadline}, the deposit is refunded to ${refundTo}. Then: barrel ask ${k.publicKey} "<question>"`);
}

async function assign(tankId: number, to: string): Promise<void> {
  const barrel = await connect();
  const { secret } = await tankSecret(barrel, String(tankId));
  const out = await barrel.assign(wallet(), tankId, to, signAssign(barrel.contractId, tankId, to, secret));
  if (out.failures.length) throw new Error(out.failures.join("; "));
  say(`Tank ${tankId} now belongs to ${to}: it can unlock, withdraw or top it up. The key still spends it.`);
  say(`${chain.net.explorerTx}${out.txHash}`);
}

// --- firm series --------------------------------------------------------------------

async function force(tankId: number, question: string): Promise<void> {
  const barrel = await connect();
  const tank = await barrel.tank(tankId);
  if (!tank) throw new Error(`no tank ${tankId}`);
  const grade = (await barrel.grade((await barrel.series(tank.series_id))!.grade_id))!;
  // Exactly these three fields, in this order: the contract hashes the bytes and the model signs them.
  const body = JSON.stringify({ model: grade.model_id, messages: [{ role: "user", content: question }], max_tokens: 800 });
  const out = await barrel.forceRequest(wallet(), tankId, body);
  const f = (await barrel.forced(out.value))!;
  say(`Forced request ${f.id} is on chain. The operator must answer by ${new Date(f.deadline * 1000).toISOString()}.`);
  const series = (await barrel.series(tank.series_id))!;
  const worth = (BigInt(f.reserved) * BigInt(series.price_per_barrel) + 999_999n) / 1_000_000n;
  say(`If it does not: barrel slash ${f.id}. The ${f.reserved} reserved units return to the tank and ${formatAmount(worth)} ${coin} of the bond is paid to you.`);
  say(`${chain.net.explorerTx}${out.txHash}`);
}

async function canary(seriesId: number): Promise<void> {
  const barrel = await connect();
  const s = await barrel.series(seriesId);
  if (!s?.firm) throw new Error(`series ${seriesId} is not firm`);
  const out = await barrel.canary(wallet(), seriesId, BigInt(s.firm.canary_fee));
  const f = (await barrel.forced(out.value))!;
  say(`Canary ${f.id} sent. The contract wrote the prompt from a random seed; the operator must answer by ${new Date(f.deadline * 1000).toISOString()}.`);
  say(`Watch: barrel forced ${f.id}. Missed: barrel slash ${f.id} (it counts toward default).`);
}

async function showForced(id: number): Promise<void> {
  const barrel = await connect();
  const f = await barrel.forced(id);
  if (!f) throw new Error(`no forced request ${id}`);
  say(`${f.tank_id === null ? `Canary ${f.id}` : `Forced request ${f.id} on tank ${f.tank_id}`}, series ${f.series_id}: ${f.status}`);
  say(`  asked ${new Date(f.created_at * 1000).toISOString()}, deadline ${new Date(f.deadline * 1000).toISOString()}, reserved ${f.reserved} units`);
  if (f.status === "answered") {
    const answer = JSON.parse(f.response!);
    say(`  answered for ${f.units} units, signed by model key ${f.tee_key!.slice(0, 16)}…`);
    say(`  ${String(answer.choices?.[0]?.message?.content ?? "").trim().slice(0, 500)}`);
  }
  if (opts.json) say(JSON.stringify(f, null, 2));
}

async function slash(id: number): Promise<void> {
  const barrel = await connect();
  const out = await barrel.slashForced(wallet(), id);
  if (out.failures.length) throw new Error(out.failures.join("; "));
  say(`Missed deadline recorded. ${formatAmount(out.value)} ${coin} of the bond paid out.`);
  say(`${chain.net.explorerTx}${out.txHash}`);
}

async function register(gradeId: string): Promise<void> {
  const barrel = await connect();
  const config = await barrel.config();
  if (!config.attestor) throw new Error(`${barrel.contractId} has no attestor contract; its owner registers keys`);
  const attestor = new Attestor(chain, config.attestor);
  say(`Attesting ${gradeId} on chain through ${config.attestor} (you pay gas; nobody's permission is needed)…`);
  const r = await registerOnChain(attestor, barrel, wallet(), gradeId);
  r.txs.forEach((tx, i) => say(`  machine ${i + 1}: verified on chain in ${r.gasTgas[i]!.toFixed(0)} TGas, ${chain.net.explorerTx}${tx}`));
  for (const k of r.registered) say(`  key ${k.key} live until ${new Date(k.expires_at * 1000).toISOString()}`);
}

// --- resale inside NEAR Intents -------------------------------------------------------

async function relayUrl(barrel: Barrel, seriesId?: number): Promise<string> {
  if (opts.pump) return opts.pump.replace(/\/+$/, "");
  const s = seriesId !== undefined ? await barrel.series(seriesId) : (await barrel.seriesList())[0];
  if (!s?.endpoint) throw new Error("pass --pump <url>: the relay that carries offers");
  return s.endpoint.replace(/\/+$/, "");
}

async function sell(seriesId: number, units: bigint, usdcText: string): Promise<void> {
  if (net !== "mainnet") throw new Error("NEAR Intents runs on mainnet only; set BARREL_NETWORK=mainnet");
  const barrel = await connect();
  const me = wallet();
  const ix = new Intents(chain, barrel);
  const price = parseAmount(usdcText);
  const inside = await ix.barrels(me.accountId, seriesId);
  if (inside < units) {
    await ix.depositBarrels(me, seriesId, units - inside);
    say(`Deposited ${units - inside} units into NEAR Intents.`);
  }
  if (await ix.ensureKey(me)) say(`Registered ${me.publicKey} with NEAR Intents.`);
  const offer = await ix.offer(me, seriesId, units, price);
  const relay = await relayUrl(barrel, seriesId);
  const res = await fetch(`${relay}/v1/offers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(offer) });
  if (!res.ok) throw new Error(`relay: HTTP ${res.status} ${await res.text()}`);
  say(`Offer ${offer.id}: ${units} units of series ${seriesId} for ${usdcText} ${coin}, until ${offer.deadline}.`);
  say("It settles only as signed: both sides move in one transaction or nothing moves. To cancel, withdraw: barrel unsell " + seriesId);
}

async function offers(seriesId?: number): Promise<void> {
  const barrel = await connect();
  const list = ((await (await fetch(`${await relayUrl(barrel, seriesId)}/v1/offers`)).json()) as { offers: Offer[] }).offers;
  const shown = list.filter((o) => seriesId === undefined || o.series_id === seriesId);
  if (!shown.length) say("No live offers.");
  for (const o of shown) {
    const perBarrel = (BigInt(o.price) * 1_000_000n) / BigInt(o.units);
    say(`${o.id}  series ${o.series_id}: ${o.units} units for ${formatAmount(o.price)} ${coin} (${formatAmount(perBarrel)} per Barrel) from ${o.maker}, until ${o.deadline}`);
  }
}

async function take(offerId: string): Promise<void> {
  if (net !== "mainnet") throw new Error("NEAR Intents runs on mainnet only; set BARREL_NETWORK=mainnet");
  const barrel = await connect();
  const me = wallet();
  const ix = new Intents(chain, barrel);
  const list = ((await (await fetch(`${await relayUrl(barrel)}/v1/offers`)).json()) as { offers: Offer[] }).offers;
  const offer = list.find((o) => o.id === offerId);
  if (!offer) throw new Error(`no live offer ${offerId}`);
  const price = BigInt(offer.price);
  const inside = await ix.usdc(me.accountId);
  if (inside < price) await ix.depositUsdc(me, price - inside);
  if (await ix.ensureKey(me)) say(`Registered ${me.publicKey} with NEAR Intents.`);
  const { received, outcome } = await ix.take(me, offer);
  say(`Bought ${received} units of series ${offer.series_id} for ${formatAmount(price)} ${coin} (the Verifier kept ${BigInt(offer.units) - received} units as its fee).`);
  say(`${chain.net.explorerTx}${outcome.txHash}`);
  await ix.withdrawBarrels(me, offer.series_id, received);
  say(`Withdrawn to ${me.accountId}: barrel fill ${offer.series_id} ${received} to put them in a tank.`);
}

async function unsell(seriesId: number): Promise<void> {
  const barrel = await connect();
  const me = wallet();
  const ix = new Intents(chain, barrel);
  const inside = await ix.barrels(me.accountId, seriesId);
  const usdc = await ix.usdc(me.accountId);
  if (inside > 0n) await ix.withdrawBarrels(me, seriesId, inside);
  if (usdc > 0n) await ix.withdrawUsdc(me, usdc);
  say(`Withdrew ${inside} units and ${formatAmount(usdc)} ${coin} from NEAR Intents. Any open offer can no longer settle.`);
}

async function main(): Promise<boolean> {
  switch (command) {
    case "verify":
      return verify(need(rest[0], "verify <receipt.json>"));
    case "status":
      await status();
      return true;
    case "attest":
      return attest(need(rest[0], "attest <model-id>"));
    case "audit":
      return audit(rest[0]);
    case "account":
      await account();
      return true;
    case "buy":
      await buy(Number(need(rest[0], "buy <series> <usdc>")), need(rest[1], "buy <series> <usdc>"));
      return true;
    case "buy-from":
      await buyFrom(need(rest[0], "buy-from <chain> <series> <usdc>"), Number(need(rest[1], "buy-from <chain> <series> <usdc>")), need(rest[2], "buy-from <chain> <series> <usdc>"));
      return true;
    case "accept":
      await accept(Number(need(rest[0], "accept <tank>")));
      return true;
    case "fill":
      await fill(Number(need(rest[0], "fill <series> <units>")), BigInt(need(rest[1], "fill <series> <units>")));
      return true;
    case "ask":
      return ask(need(rest[0], 'ask <tank|key> "<question>"'), need(rest.slice(1).join(" "), 'ask <tank|key> "<question>"'));
    case "models":
      await models();
      return true;
    case "index":
      await priceIndex(rest[0]);
      return true;
    case "key":
      await key();
      return true;
    case "fund":
      await fund(Number(need(rest[0], "fund <series> <usdc>")), need(rest[1], "fund <series> <usdc>"));
      return true;
    case "fund-from":
      await fundFrom(need(rest[0], "fund-from <chain> <series> <usdc>"), Number(need(rest[1], "fund-from <chain> <series> <usdc>")), need(rest[2], "fund-from <chain> <series> <usdc>"));
      return true;
    case "assign":
      await assign(Number(need(rest[0], "assign <tank> <account>")), need(rest[1], "assign <tank> <account>"));
      return true;
    case "force":
      await force(Number(need(rest[0], 'force <tank> "<question>"')), need(rest.slice(1).join(" "), 'force <tank> "<question>"'));
      return true;
    case "canary":
      await canary(Number(need(rest[0], "canary <series>")));
      return true;
    case "forced":
      await showForced(Number(need(rest[0], "forced <id>")));
      return true;
    case "slash":
      await slash(Number(need(rest[0], "slash <id>")));
      return true;
    case "register":
      await register(need(rest[0], "register <grade>"));
      return true;
    case "sell":
      await sell(Number(need(rest[0], "sell <series> <units> <usdc>")), BigInt(need(rest[1], "sell <series> <units> <usdc>")), need(rest[2], "sell <series> <units> <usdc>"));
      return true;
    case "offers":
      await offers(rest[0] !== undefined ? Number(rest[0]) : undefined);
      return true;
    case "take":
      await take(need(rest[0], "take <offer id>"));
      return true;
    case "unsell":
      await unsell(Number(need(rest[0], "unsell <series>")));
      return true;
    case "unlock": {
      const barrel = await connect();
      const out = await barrel.requestUnlock(wallet(), Number(need(rest[0], "unlock <tank>")));
      say(`Unlock requested. Withdraw after ${new Date(out.value * 1000).toISOString()}.`);
      return true;
    }
    case "withdraw": {
      const barrel = await connect();
      const tankId = Number(need(rest[0], "withdraw <tank>"));
      const tank = await barrel.tank(tankId);
      const out = await barrel.withdraw(wallet(), tankId);
      if (out.failures.length) throw new Error(out.failures.join("; "));
      if (tank?.accepted) {
        if (out.value === "0" && tank.balance !== "0") throw new Error(`${tank.agent} could not receive ${coin} (not registered with the token); the tank is restored, register it and try again`);
        say(`Paid ${tank.agent} ${formatAmount(BigInt(out.value))} ${coin}: the leftover of job tank ${tankId} (${tank.balance} units).`);
      } else {
        say(`${out.value} units returned from the tank to your balance.`);
      }
      say(`${chain.net.explorerTx}${out.txHash}`);
      return true;
    }
    case "refund": {
      const barrel = await connect();
      const me = wallet();
      const seriesId = Number(need(rest[0], "refund <series> [units]"));
      const units = rest[1] ? BigInt(rest[1]) : await barrel.balanceOf(me.accountId, seriesId);
      const out = await barrel.refund(me, seriesId, units);
      say(`${units} units burned for ${formatAmount(out.value)} ${coin}.`);
      return true;
    }
    default: {
      const text = readFileSync(new URL(import.meta.url), "utf8");
      // The usage text is the comment block at the top of this file.
      const top = text.split("\n").slice(1);
      say(top.slice(0, top.findIndex((l) => !l.startsWith("//"))).map((l) => l.slice(3)).join("\n"));
      return command === undefined || opts.help;
    }
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => {
    console.error(`barrel: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
