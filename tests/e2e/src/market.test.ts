// The mechanisms around the loop, on NEAR testnet with exact balance checks:
//
//   key tanks   a purchase lands in a tank owned by an Ed25519 key, so an
//               agent with a key and no account can be funded by anyone
//   claims      an operator is paid for an answer the payer never acknowledged,
//               unless the payer's ack replaces the claim inside the window
//   firm series a bonded operator must answer requests sent through the chain,
//               or it is slashed and the series defaults
//   index       a 24-hour price per grade built only from proven deliveries
//   governance  owner changes and upgrades wait out a timelock
//
// A simulated model TEE (a registered Ed25519 key) signs the answers, so each
// case can be played exactly. No real money and no human step.
//
//   pnpm e2e

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  Barrel,
  Chain,
  FORCED_DEPOSIT,
  NETWORKS,
  deployFresh,
  loadWallet,
  readWasm,
  settleItem,
  signAck,
  signAssign,
  sleep,
  type SettleItem,
  type Wallet,
} from "@barrel/sdk";
import {
  newKeyPair,
  receiptText,
  requestAuthText,
  sha256Hex,
  signEd25519,
  unitsFor,
  utf8,
  worstCaseUnits,
} from "@barrel/verifier";

const chain = new Chain(NETWORKS.testnet);
const tag = randomBytes(3).toString("hex");
const MODEL = "sim/model-m";
const BPS = 2000;
const UNLOCK_DELAY = 40;
const GRACE = 20;
const CLAIM_WINDOW = 12;
const TIMELOCK = 15;
const RESPOND = 60;
const CANARY_FEE = 10n ** 21n; // 0.001 NEAR

let root: Wallet, op: Wallet, buyer: Wallet, x: Wallet;
let barrel: Barrel;
let contractId = "";
let spot = 0; // ordinary series, 1.0 USDC per Barrel
let firm = 0; // firm series, 0.5 USDC per Barrel

const tee = newKeyPair();
const agentKey = newKeyPair();
const k1 = newKeyPair();
const kf = newKeyPair();
let tankA = 0; // owned by agentKey
let tank1 = 0; // on the ordinary series
let tankF = 0; // on the firm series

const nowSec = () => Math.floor(Date.now() / 1000);

async function eventually<T>(read: () => Promise<T>, expected: T, label: string): Promise<void> {
  let last: T | undefined;
  for (let i = 0; i < 12; i++) {
    last = await read();
    try {
      assert.deepEqual(last, expected);
      return;
    } catch {
      await sleep(500);
    }
  }
  assert.deepEqual(last, expected, label);
}

async function rejected(action: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, (e: Error) => {
    assert.match(e.message, pattern);
    return true;
  });
}

async function waitUntil(unixSec: number): Promise<void> {
  const ms = (unixSec + 3) * 1000 - Date.now();
  if (ms > 0) await sleep(ms);
}

let counter = 0;
/** One served request: its hashes, the model's signature and the unit count. */
function serve(usage: { prompt_tokens: number; completion_tokens: number }, maxTokens = 64) {
  counter += 1;
  const request = utf8(JSON.stringify({ model: MODEL, messages: [{ role: "user", content: `q${counter}-${tag}` }], max_tokens: maxTokens }));
  const response = utf8(JSON.stringify({ id: `chat-${counter}`, model: MODEL, usage }));
  const requestHash = sha256Hex(request);
  const responseHash = sha256Hex(response);
  return {
    requestHash,
    responseHash,
    teeSig: signEd25519(receiptText(MODEL, requestHash, responseHash), tee.secretKey),
    units: unitsFor(usage, BPS),
    maxUnits: worstCaseUnits(request.length, maxTokens, BPS),
  };
}

function ackItem(s: ReturnType<typeof serve>, tankId: number, seq: number, key: { secretKey: string }): SettleItem {
  const receipt = { request_hash: s.requestHash, response_hash: s.responseHash, signing_address: tee.publicKey, signature: s.teeSig } as any;
  return settleItem(receipt, seq, s.units, signAck(contractId, tankId, seq, s.requestHash, s.responseHash, s.units, key.secretKey));
}

/** The model's answer to a request the contract holds, as the operator posts it. */
function answer(requestHash: string, usage: { prompt_tokens: number; completion_tokens: number }, content = "ok") {
  counter += 1;
  const response = JSON.stringify({
    id: `forced-${counter}`,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  });
  return { response, teeSig: signEd25519(receiptText(MODEL, requestHash, sha256Hex(utf8(response))), tee.secretKey) };
}

// ---------------------------------------------------------------------------

test("deploy with a claim window, a timelock and a guardian", async (t) => {
  root = process.env.BARREL_E2E_ROOT ? loadWallet("testnet", process.env.BARREL_E2E_ROOT) : await chain.createFaucetAccount("barrel-mkt");
  // The stranger sends canaries and an upgrade, which hold a deposit or
  // prepay a lot of gas, so it gets its own faucet account too.
  x = process.env.BARREL_E2E_X ? loadWallet("testnet", process.env.BARREL_E2E_X) : await chain.createFaucetAccount("barrel-mkt-x");
  ({ barrel } = await deployFresh(chain, root, {
    tag,
    unlockDelaySec: UNLOCK_DELAY,
    settleGraceSec: GRACE,
    claimWindowSec: CLAIM_WINDOW,
    timelockSec: TIMELOCK,
    minTankBuyUnits: 1000n,
    maxSeriesUnits: 10_000_000n,
    maxTotalEscrow: 20_000_000n,
    guardian: x.accountId,
  }));
  contractId = barrel.contractId;
  t.diagnostic(`contract ${contractId}`);
  op = await chain.createSubAccount(root, `op-${tag}`, "0.5");
  // Forced requests hold 0.25 NEAR each while they are open, so the buyer
  // gets its own faucet account.
  buyer = process.env.BARREL_E2E_BUYER ? loadWallet("testnet", process.env.BARREL_E2E_BUYER) : await chain.createFaucetAccount("barrel-mkt-buyer");
  await barrel.registerUsdc(root, op.accountId);
  await barrel.registerUsdc(root, buyer.accountId);
  await barrel.registerUsdc(root, x.accountId);
  await barrel.faucet(buyer, buyer.accountId, 12_000_000n);
  await barrel.faucet(op, op.accountId, 1_000_000n);

  await barrel.addGrade(root, { id: "simm", model_id: MODEL, input_weight_bps: BPS, key_ttl_sec: 7200 });
  const key = (await barrel.addKey(root, "simm", tee.publicKey, sha256Hex("simulated evidence"))).value;
  assert.equal(key.by, root.accountId);

  const windowEnd = nowSec() + 3600;
  spot = (await barrel.openSeries(op, { gradeId: "simm", endpoint: "http://127.0.0.1", pricePerBarrel: 1_000_000n, windowEnd, capUnits: 5_000_000n })).value;
  firm = (
    await barrel.openSeries(op, {
      gradeId: "simm",
      endpoint: "http://127.0.0.1",
      pricePerBarrel: 500_000n,
      windowEnd,
      capUnits: 5_000_000n,
      firm: { respond_sec: RESPOND, max_misses: 2, canary_interval_sec: 0, canary_fee: CANARY_FEE.toString() },
    })
  ).value;
  const config = await barrel.config();
  assert.equal(config.claim_window_sec, CLAIM_WINDOW);
  assert.equal(config.guardian, x.accountId);
  assert.equal(config.owner_registers_keys, true);
  assert.equal((await barrel.series(spot))!.firm, null);
  assert.equal((await barrel.series(firm))!.firm!.max_misses, 2);
});

test("key tank: a purchase lands in a tank only its key controls, whoever paid", async () => {
  // The buyer pays; the tank belongs to the agent's key, which has no account.
  const bought = await barrel.buyTank(buyer, spot, 50_000n, agentKey.publicKey);
  assert.equal(bought.value, 50_000n);
  let tank = (await barrel.tankForKey(agentKey.publicKey))!;
  tankA = tank.id;
  assert.equal(tank.owner, agentKey.publicKey, "the owner is the key's own implicit account");
  assert.equal(tank.key, agentKey.publicKey);
  assert.equal(tank.balance, "50000");
  assert.equal(await barrel.balanceOf(buyer.accountId, spot), 0n, "nothing passed through the payer's balance");
  assert.equal((await barrel.series(spot))!.in_tanks, "50000");

  // Anyone else can add to it. It is the same tank.
  await barrel.faucet(x, x.accountId, 30_000n);
  await barrel.buyTank(x, spot, 30_000n, agentKey.publicKey);
  tank = (await barrel.tank(tankA))!;
  assert.equal(tank.balance, "80000");
  assert.equal((await barrel.tanksFor(agentKey.publicKey)).length, 1);

  // Dust cannot open tanks at the contract's expense.
  const dust = await barrel.buyTank(buyer, spot, 999n, newKeyPair().publicKey);
  assert.equal(dust.value, 0n);
  assert.match(dust.failures.join(" "), /smallest purchase that opens a tank/);

  // The key pays for answers like any tank key.
  const s = serve({ prompt_tokens: 100, completion_tokens: 80 });
  assert.equal(s.units, 100n);
  await barrel.settle(op, tankA, [ackItem(s, tankA, 0, agentKey)]);
  await eventually(() => barrel.usdcBalance(op.accountId), 1_000_100n, "operator paid 100 units at 1.0");

  // Nobody but the key can take the tank: not the payer, not a stranger.
  await rejected(barrel.requestUnlock(buyer, tankA), /tank owner only/);
  await rejected(barrel.assign(x, tankA, x.accountId, signAssign(contractId, tankA, x.accountId, newKeyPair().secretKey)), /not signed by the tank key/);
  await rejected(barrel.assign(x, tankA, x.accountId, signAssign(contractId, tankA, buyer.accountId, agentKey.secretKey)), /not signed by the tank key/);

  // The key hands the tank to an account of its choice. Anyone relays it.
  await barrel.assign(x, tankA, buyer.accountId, signAssign(contractId, tankA, buyer.accountId, agentKey.secretKey));
  tank = (await barrel.tank(tankA))!;
  assert.equal(tank.owner, buyer.accountId);
  assert.equal(await barrel.tankForKey(agentKey.publicKey), null);
  await rejected(barrel.assign(x, tankA, x.accountId, signAssign(contractId, tankA, x.accountId, agentKey.secretKey)), /only a tank owned by its key/);
  assert.equal((await barrel.tanksFor(buyer.accountId)).some((t) => t.id === tankA), true);
});

test("index: the price of a grade is what proven deliveries were paid", async () => {
  assert.equal((await barrel.index("simm")).price_per_barrel, "1000000", "100 units so far, all at 1.0");
  await barrel.buy(buyer, spot, 1_000_000n);
  await barrel.buy(buyer, firm, 1_000_000n); // 2,000,000 units at 0.5
  tank1 = (await barrel.fill(buyer, spot, 1_000_000n, k1.publicKey)).value;
  tankF = (await barrel.fill(buyer, firm, 2_000_000n, kf.publicKey)).value;

  // 300 units on the firm series at 0.5. With the 100 units at 1.0:
  // (100 x 1.0 + 300 x 0.5) / 400 = 0.625 USDC per Barrel.
  const s = serve({ prompt_tokens: 500, completion_tokens: 200 });
  assert.equal(s.units, 300n);
  await barrel.settle(op, tankF, [ackItem(s, tankF, 0, kf)]);
  const index = await barrel.index("simm");
  assert.equal(index.price_per_barrel, "625000");
  assert.equal(index.units, "400");
  assert.equal(index.deliveries, 2);
  assert.equal(index.window_sec, 86_400);
  assert.equal((await barrel.index("no-such-grade")).price_per_barrel, "0");
});

test("claim: an unacknowledged answer is paid at the authorized maximum, unless the ack arrives", async () => {
  // The payer signed this request and capped its cost; the model answered; no ack came.
  const s = serve({ prompt_tokens: 100, completion_tokens: 30 }, 64);
  assert.equal(s.units, 50n);
  const authSig = signEd25519(requestAuthText(contractId, tank1, 0, s.requestHash, s.maxUnits), k1.secretKey);
  const claim = { tankId: tank1, seq: 0, requestHash: s.requestHash, maxUnits: s.maxUnits, authSig, responseHash: s.responseHash, teeKey: tee.publicKey, teeSig: s.teeSig };

  await rejected(barrel.claimUnacked(x, claim), /series operator only/);
  await rejected(barrel.claimUnacked(op, { ...claim, maxUnits: s.maxUnits + 1n }), /not signed by the tank key/);
  await rejected(barrel.claimUnacked(op, { ...claim, responseHash: sha256Hex("another answer") }), /model signature does not verify/);
  await rejected(barrel.claimUnacked(op, { ...claim, seq: 1 }), /wrong sequence number/);

  const earnedBefore = BigInt((await barrel.series(spot))!.released);
  const readyAt = (await barrel.claimUnacked(op, claim)).value;
  let tank = (await barrel.tank(tank1))!;
  assert.equal(tank.claim!.units, s.maxUnits.toString());
  assert.equal(tank.reserved, s.maxUnits.toString());
  assert.equal(BigInt(tank.balance), 1_000_000n - s.maxUnits);
  assert.equal((await barrel.series(spot))!.released, earnedBefore.toString(), "a claim pays nothing yet");
  await rejected(barrel.claimUnacked(op, claim), /already open/);
  await rejected(barrel.finalizeClaim(op, tank1), /claim window has not passed/);

  // The payer answers with the ack: the true 50 units are charged, not the maximum.
  await barrel.settle(buyer, tank1, [ackItem(s, tank1, 0, k1)]);
  tank = (await barrel.tank(tank1))!;
  assert.equal(tank.claim, null);
  assert.equal(tank.reserved, "0");
  assert.equal(tank.spent, "50");
  assert.equal(tank.next_seq, 1);
  assert.equal(BigInt((await barrel.series(spot))!.released), earnedBefore + 50n);
  assert.ok(readyAt > nowSec() - 60);

  // A second answer, and this time the payer stays silent.
  const s2 = serve({ prompt_tokens: 100, completion_tokens: 30 }, 64);
  const authSig2 = signEd25519(requestAuthText(contractId, tank1, 1, s2.requestHash, s2.maxUnits), k1.secretKey);
  const readyAt2 = (
    await barrel.claimUnacked(op, { tankId: tank1, seq: 1, requestHash: s2.requestHash, maxUnits: s2.maxUnits, authSig: authSig2, responseHash: s2.responseHash, teeKey: tee.publicKey, teeSig: s2.teeSig })
  ).value;

  // The payer cannot leave with the tank while the claim is open.
  await barrel.requestUnlock(buyer, tank1);
  const other = serve({ prompt_tokens: 1, completion_tokens: 1 });
  await rejected(barrel.settle(op, tank1, [ackItem(other, tank1, 1, k1)]), /claim is open for a different request/);

  await waitUntil(readyAt2);
  const paid = await barrel.finalizeClaim(x, tank1);
  assert.equal(paid.value, s2.maxUnits, "silence costs the authorized maximum");
  tank = (await barrel.tank(tank1))!;
  assert.equal(tank.claim, null);
  assert.equal(tank.next_seq, 2);
  assert.equal(BigInt(tank.spent), 50n + s2.maxUnits);
  const record = (await barrel.recentSettlements(1))[0]!;
  assert.equal(record.kind, "claim");
  assert.equal(record.units, s2.maxUnits.toString());
  assert.equal(BigInt((await barrel.series(spot))!.released), earnedBefore + 50n + s2.maxUnits);
});

test("firm series: the operator posts a bond and answers what is sent through the chain", async () => {
  // Only the operator bonds, and only a firm series takes one.
  const stranger = await barrel.addBond(buyer, firm, 1_000n);
  assert.match(stranger.failures.join(" "), /only the operator posts a bond/);
  const wrong = await barrel.addBond(op, spot, 1_000n);
  assert.match(wrong.failures.join(" "), /not a firm series/);
  await barrel.addBond(op, firm, 400_000n);
  assert.equal((await barrel.series(firm))!.firm!.bond, "400000");
  assert.equal(await barrel.totalBond(), 400_000n);

  // The contract accepts only a request the model can always answer.
  const body = (o: Record<string, unknown>) => JSON.stringify(o);
  const good = { model: MODEL, messages: [{ role: "user", content: "What is a canary?" }], max_tokens: 100 };
  await rejected(barrel.forceRequest(x, tankF, body(good)), /tank owner only/);
  await rejected(barrel.forceRequest(buyer, tank1, body(good)), /not a firm series/);
  await rejected(barrel.forceRequest(buyer, tankF, body({ ...good, model: "sim/other" })), /grade's model id/);
  await rejected(barrel.forceRequest(buyer, tankF, body({ ...good, stream: true })), /exactly model, messages and max_tokens/);
  await rejected(barrel.forceRequest(buyer, tankF, body({ ...good, messages: [{ role: "tool", content: "x" }] })), /roles are system, user or assistant/);
  await rejected(barrel.forceRequest(buyer, tankF, body({ ...good, max_tokens: 5000 })), /max_tokens must be between/);

  const text = body(good);
  const id = (await barrel.forceRequest(buyer, tankF, text)).value;
  let forced = (await barrel.forced(id))!;
  const reserved = worstCaseUnits(utf8(text).length, 100, BPS);
  assert.equal(forced.request_hash, sha256Hex(utf8(text)), "the contract hashed the body itself");
  assert.equal(forced.reserved, reserved.toString());
  assert.equal(forced.status, "open");
  let tank = (await barrel.tank(tankF))!;
  assert.equal(tank.reserved, reserved.toString());
  assert.deepEqual((await barrel.openForced(firm)).map((f) => f.id), [id]);

  // An answer the model did not sign, or signed for another request, is refused.
  const a = answer(forced.request_hash, { prompt_tokens: 20, completion_tokens: 40 }, "A canary is a liveness check.");
  await rejected(barrel.answerForced(op, id, a.response, tee.publicKey, answer(sha256Hex("other"), { prompt_tokens: 20, completion_tokens: 40 }).teeSig), /model signature does not verify/);
  await rejected(barrel.answerForced(op, id, `${a.response} `, tee.publicKey, a.teeSig), /model signature does not verify/);

  // The real answer: the contract reads the token counts out of the signed
  // bytes and charges 40 + ceil(20 x 20%) = 44 units at 0.5 = 22 base units.
  const opBefore = await barrel.usdcBalance(op.accountId);
  const charged = await barrel.answerForced(op, id, a.response, tee.publicKey, a.teeSig);
  assert.equal(charged.value, 44n);
  forced = (await barrel.forced(id))!;
  assert.equal(forced.status, "answered");
  assert.equal(JSON.parse(forced.response!).choices[0].message.content, "A canary is a liveness check.");
  tank = (await barrel.tank(tankF))!;
  assert.equal(tank.reserved, "0");
  assert.equal(tank.spent, "344");
  assert.equal(BigInt(tank.balance), 2_000_000n - 344n);
  await eventually(() => barrel.usdcBalance(op.accountId), opBefore + 22n, "operator paid for the forced answer");
  assert.equal((await barrel.recentSettlements(1))[0]!.kind, "forced");
  await rejected(barrel.answerForced(op, id, a.response, tee.publicKey, a.teeSig), /already resolved/);

  // The sender deletes the record and gets the storage deposit back.
  await rejected(barrel.clearForced(x, id), /only its sender/);
  const nearBefore = await chain.nearBalance(buyer.accountId);
  await barrel.clearForced(buyer, id);
  assert.equal(await barrel.forced(id), null);
  assert.ok((await chain.nearBalance(buyer.accountId)) > nearBefore + FORCED_DEPOSIT - 10n ** 22n, "0.25 NEAR came back");
});

test("canary: anyone makes the operator prove it is serving, on a request the contract wrote", async () => {
  await rejected(barrel.canary(x, spot, CANARY_FEE), /not a firm series/);
  await rejected(barrel.canary(buyer, firm, 0n), /plus the canary fee/);
  const id = (await barrel.canary(buyer, firm, CANARY_FEE)).value;
  const canary = (await barrel.forced(id))!;
  assert.equal(canary.tank_id, null);
  const written = JSON.parse(canary.body);
  assert.equal(written.model, MODEL);
  assert.match(written.messages[0].content, /^Barrel canary \d+-[0-9a-f]{16}\./);
  assert.equal(canary.request_hash, sha256Hex(utf8(canary.body)));

  const opNear = await chain.nearBalance(op.accountId);
  const a = answer(canary.request_hash, { prompt_tokens: 18, completion_tokens: 1 });
  await barrel.answerForced(x, id, a.response, tee.publicKey, a.teeSig);
  const f = (await barrel.series(firm))!.firm!;
  assert.equal(f.canary_sent, 1);
  assert.equal(f.canary_passed, 1);
  assert.equal(f.misses, 0);
  await eventually(async () => (await chain.nearBalance(op.accountId)) - opNear, CANARY_FEE, "the fee went to the operator");
  await barrel.clearForced(buyer, id);
});

test("default: an operator that stops answering is slashed, and holders leave at once with the bond", async () => {
  const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Are you there?" }], max_tokens: 2000 });
  const reserved = worstCaseUnits(utf8(body).length, 2000, BPS);
  const first = (await barrel.forceRequest(buyer, tankF, body)).value;
  const second = (await barrel.canary(x, firm, CANARY_FEE)).value;
  const deadline = Math.max((await barrel.forced(first))!.deadline, (await barrel.forced(second))!.deadline);
  await rejected(barrel.slashForced(x, first), /still has time to answer/);
  await rejected(barrel.withdrawBond(op, firm), /forced requests are still open/);

  // Before the default, nobody refunds early.
  await barrel.requestUnlock(buyer, tankF);
  await rejected(barrel.refund(buyer, firm, 1n), /refunds open after the series expires/);

  await waitUntil(deadline);
  // Miss 1: the request's worst-case cost, at the series price, goes to the tank owner.
  const slash = (reserved * 500_000n + 999_999n) / 1_000_000n;
  const buyerBefore = await barrel.usdcBalance(buyer.accountId);
  const slashed = await barrel.slashForced(x, first);
  assert.equal(slashed.value, slash);
  await eventually(() => barrel.usdcBalance(buyer.accountId), buyerBefore + slash, "the tank owner was paid from the bond");
  let s = (await barrel.series(firm))!;
  assert.equal(s.firm!.misses, 1);
  assert.equal(s.firm!.bond, (400_000n - slash).toString());
  assert.equal(s.firm!.defaulted_at, null);
  assert.equal((await barrel.tank(tankF))!.reserved, "0", "the units went back to the tank");

  // Miss 2 reaches max_misses: the series defaults.
  const xNear = await chain.nearBalance(x.accountId);
  await barrel.slashForced(buyer, second);
  await eventually(async () => (await chain.nearBalance(x.accountId)) >= xNear + CANARY_FEE, true, "the unanswered canary returned its fee");
  s = (await barrel.series(firm))!;
  assert.equal(s.firm!.misses, 2);
  assert.ok(s.firm!.defaulted_at);
  const outstanding = BigInt(s.minted) - BigInt(s.burned) - BigInt(s.refunded);
  const bond = 400_000n - slash;
  assert.equal(s.firm!.comp_per_barrel, ((bond * 1_000_000n) / outstanding).toString());

  // No new money enters a defaulted series; the bond is the holders' now.
  const late = await barrel.buy(buyer, firm, 1_000n);
  assert.match(late.failures.join(" "), /series defaulted/);
  await rejected(barrel.withdrawBond(op, firm), /belongs to its holders/);
  await rejected(barrel.forceRequest(buyer, tankF, body), /series defaulted/);

  // The holder leaves now, long before expiry: price back plus the bond share.
  await waitUntil((await barrel.tank(tankF))!.unlock_at!);
  await barrel.withdraw(buyer, tankF);
  const units = await barrel.balanceOf(buyer.accountId, firm);
  assert.equal(units, outstanding);
  const before = await barrel.usdcBalance(buyer.accountId);
  const refund = (units * 500_000n) / 1_000_000n;
  const share = (units * BigInt(s.firm!.comp_per_barrel)) / 1_000_000n;
  const out = await barrel.refund(buyer, firm, units);
  assert.equal(BigInt(out.value), refund + share);
  await eventually(() => barrel.usdcBalance(buyer.accountId), before + refund + share, "refund plus bond share");
  s = (await barrel.series(firm))!;
  assert.equal(s.firm!.comp_paid, share.toString());
  assert.ok(share > 0n && bond - share < 2n, "the whole bond went to the holders, to the last base unit");
});

test("governance: the guardian only pauses, and changes wait out the timelock", async () => {
  await rejected(barrel.propose(x, "owner", x.accountId), /owner only/);
  await rejected(barrel.renounceKeyRegistration(root), /set an attestor first/);

  // The guardian can stop things. It cannot start them, and cannot change anything.
  await barrel.pause(x);
  assert.equal((await barrel.config()).paused, true);
  await rejected(barrel.unpause(x), /owner only/);
  await barrel.unpause(root);

  // An upgrade is fixed by its hash when proposed, and cannot run early.
  const wasm = readWasm("barrel");
  const hash = createHash("sha256").update(wasm).digest("hex");
  await rejected(barrel.propose(root, "upgrade", "not-a-hash"), /sha256 of the new code/);
  const pending = (await barrel.propose(root, "upgrade", hash)).value;
  await rejected(barrel.upgrade(x, wasm), /timelock has not passed/);
  await rejected(barrel.upgrade(x, readWasm("test_usdc")), /not the code that was proposed/);
  await barrel.propose(root, "owner", x.accountId);
  await rejected(barrel.apply(x, "owner"), /timelock has not passed/);
  // The guardian vetoes the owner change.
  await barrel.cancel(x, "owner");
  assert.equal(await barrel.pending("owner"), null);

  await waitUntil(pending.ready_at);
  const seriesBefore = await barrel.series(spot);
  await barrel.upgrade(x, wasm); // anyone may send the code that was approved
  await eventually(() => barrel.pending("upgrade"), null, "the proposal was consumed");
  assert.deepEqual(await barrel.series(spot), seriesBefore, "state survived the upgrade");
  assert.equal((await barrel.config()).owner, root.accountId);
  await rejected(barrel.upgrade(x, wasm), /no upgrade is pending/);

  // An attestor is set the same way; then the owner gives up registering keys for good.
  await barrel.propose(root, "attestor", x.accountId);
  await waitUntil((await barrel.pending("attestor"))!.ready_at);
  await barrel.apply(buyer, "attestor");
  assert.equal((await barrel.config()).attestor, x.accountId);
  await barrel.renounceKeyRegistration(root);
  await rejected(barrel.addKey(root, "simm", newKeyPair().publicKey, sha256Hex("x")), /registered by the attestor contract/);
  const viaAttestor = (await barrel.addKey(x, "simm", newKeyPair().publicKey, sha256Hex("quote"))).value;
  assert.equal(viaAttestor.by, x.accountId);
});

test("the books balance: escrow plus bonds plus debts is exactly what the contract holds", async () => {
  const held = await barrel.usdcBalance(contractId);
  const escrow = await barrel.totalEscrow();
  const bond = await barrel.totalBond();
  let payable = 0n;
  for (const s of await barrel.seriesList()) {
    payable += BigInt(s.payable);
    assert.equal(BigInt(s.escrow_in) - BigInt(s.released) - BigInt(s.refund_paid) >= 0n, true);
  }
  assert.equal(payable, 0n);
  assert.equal(held, escrow + bond, `contract holds ${held}, escrow ${escrow}, bond ${bond}`);
  assert.ok(bond < 2n, "the defaulted bond was paid out");
});
