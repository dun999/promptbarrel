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
//   barrel ask <tank> "<question>"       ask through the series' Pump; pay only with proof
//   barrel unlock <tank> | withdraw <tank> | refund <series> [units]
//
// Options: --contract <id> (default: deployments/<network>.json), --account <id>,
//          --pump <url>, --json. ONECLICK_JWT avoids 1Click's 0.25% unauthenticated fee. BARREL_NETWORK=testnet switches network (default mainnet).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  attestModel,
  Barrel,
  Chain,
  STATE_DIR,
  TankClient,
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

async function ask(tankId: number, question: string): Promise<boolean> {
  const barrel = await connect();
  const saved = JSON.parse(readFileSync(tankFile(barrel.contractId, tankId), "utf8")) as { secret_key: string };
  const client = new TankClient({ barrel, tankId, tankSecretKey: saved.secret_key, pumpUrl: opts.pump });
  // This model reasons before answering; "low" keeps short questions short.
  const result = await client.chat({ messages: [{ role: "user", content: question }], max_tokens: 800, reasoning_effort: "low" });
  say(result.content.trim() || "(no visible answer: the token limit was spent on reasoning)");
  say();
  result.checks.forEach(mark);
  say(`Paid ${result.units} units for ${result.usage.prompt_tokens} prompt + ${result.usage.completion_tokens} completion tokens.`);
  if (result.settleTx) say(`${chain.net.explorerTx}${result.settleTx}`);
  const dir = join(STATE_DIR, "receipts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${barrel.contractId}-${tankId}-${result.seq}.json`);
  writeFileSync(file, `${JSON.stringify(result.receipt, null, 2)}\n`);
  say(`Receipt: ${file}`);
  return true;
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
      return ask(Number(need(rest[0], 'ask <tank> "<question>"')), need(rest.slice(1).join(" "), 'ask <tank> "<question>"'));
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
      say(text.split("\n").filter((l) => l.startsWith("//")).slice(1, 17).map((l) => l.slice(3)).join("\n"));
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
