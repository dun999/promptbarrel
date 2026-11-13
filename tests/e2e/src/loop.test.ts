// End-to-end test on NEAR testnet.
//
// Deploys fresh copies of the contract and a test stablecoin to accounts the
// testnet faucet funds (no human step, no real money), runs the whole loop
// with exact balance checks, and attempts every way of taking the escrow
// without a valid proof. One settlement uses a real signature captured from a
// NEAR AI Cloud model TEE (fixtures/receipt.json).
//
//   pnpm e2e

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  Barrel,
  Chain,
  NETWORKS,
  REPO_ROOT,
  loadWallet,
  settleItem,
  signAck,
  sleep,
  type SettleItem,
  type Wallet,
} from "@barrel/sdk";
import {
  ackText,
  base64ToBytes,
  checkCandidate,
  checkReceipt,
  collateralFromJson,
  newKeyPair,
  receiptText,
  sha256Hex,
  signEd25519,
  unitsFor,
  utf8,
  type AttestationReport,
  type Receipt,
} from "@barrel/verifier";

const chain = new Chain(NETWORKS.testnet);
const tag = randomBytes(3).toString("hex");

const UNLOCK_DELAY = 20;
const GRACE = 10;
const SIM_MODEL = "sim/model-a";
const SIM_BPS = 2500;
const GLM_MODEL = "z-ai/glm-5.3-flash";
const GLM_BPS = 1600;

let root: Wallet, usdcW: Wallet, barrelW: Wallet, op: Wallet, buyer: Wallet, x: Wallet, agent: Wallet;
let barrel: Barrel;
let contractId = "";

/** Stand-in for a model TEE in the cases that need arbitrary signed texts. */
const tee = newKeyPair();
const stranger = newKeyPair();
const k1 = newKeyPair();
const k2 = newKeyPair();
const k3 = newKeyPair();
/** The agent's key for a job tank the buyer funds. */
const kj = newKeyPair();

let seriesA = 0;
let seriesB = 0;
let seriesR = 0;
let tank1 = 0;
let tank2 = 0;
let tank3 = 0;
let tankJ = 0;
let windowEndB = 0;
let unlockAt = 0;

const nowSec = () => Math.floor(Date.now() / 1000);

/** Reads a value until it matches, to ride out RPC nodes that lag a block. */
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
/** A request, an answer carrying `usage`, and a signature over both. */
function simulate(
  usage: { prompt_tokens: number; completion_tokens: number },
  opts: { signer?: { secretKey: string; publicKey: string }; text?: (rq: string, rs: string) => string } = {},
) {
  counter += 1;
  const request = utf8(JSON.stringify({ model: SIM_MODEL, messages: [{ role: "user", content: `q${counter}-${tag}` }] }));
  const response = utf8(JSON.stringify({ id: `chat-${counter}`, model: SIM_MODEL, usage }));
  const rq = sha256Hex(request);
  const rs = sha256Hex(response);
  const signer = opts.signer ?? tee;
  const text = opts.text ? opts.text(rq, rs) : receiptText(SIM_MODEL, rq, rs);
  const receipt: Receipt = {
    grade_id: "sim",
    model_id: SIM_MODEL,
    request_hash: rq,
    response_hash: rs,
    signing_algo: "ed25519",
    signing_address: signer.publicKey,
    signature: signEd25519(text, signer.secretKey),
    signature_kind: "provider_tee",
    text,
  };
  return { receipt, units: unitsFor(usage, SIM_BPS) };
}

function item(
  receipt: Receipt,
  tankId: number,
  seq: number,
  units: bigint,
  tankKey: { secretKey: string },
  ackUnits: bigint = units,
): SettleItem {
  const ack = signAck(contractId, tankId, seq, receipt.request_hash, receipt.response_hash, ackUnits, tankKey.secretKey);
  return settleItem(receipt, seq, units, ack);
}

// ---------------------------------------------------------------------------

test("deploy the contract and a test stablecoin to faucet-funded accounts", async (t) => {
  root = process.env.BARREL_E2E_ROOT
    ? loadWallet("testnet", process.env.BARREL_E2E_ROOT)
    : await chain.createFaucetAccount("barrel-e2e");
  usdcW = await chain.createSubAccount(root, `usdc-${tag}`, "2.1");
  barrelW = await chain.createSubAccount(root, `barrel-${tag}`, "4.6");
  op = await chain.createSubAccount(root, `op-${tag}`, "0.6");
  buyer = await chain.createSubAccount(root, `buyer-${tag}`, "0.6");
  x = await chain.createSubAccount(root, `x-${tag}`, "0.5");
  contractId = barrelW.accountId;

  await chain.deploy(usdcW, readFileSync(join(REPO_ROOT, "res/test_usdc.wasm")));
  await chain.call(usdcW, usdcW.accountId, "new", {});
  await chain.deploy(barrelW, readFileSync(join(REPO_ROOT, "res/barrel.wasm")));
  await chain.call(barrelW, contractId, "new", {
    owner: root.accountId,
    usdc: usdcW.accountId,
    unlock_delay_sec: UNLOCK_DELAY,
    settle_grace_sec: GRACE,
    max_series_units: "3000000",
    max_total_escrow: "10000000",
  });
  barrel = new Barrel(chain, contractId, usdcW.accountId);
  t.diagnostic(`contract ${contractId}`);

  await barrel.faucet(buyer, buyer.accountId, 20_000_000n);
  await barrel.registerUsdc(root, contractId);
  await eventually(() => barrel.usdcBalance(buyer.accountId), 20_000_000n, "buyer starts with 20 tUSDC");
  const config = await barrel.config();
  assert.equal(config.owner, root.accountId);
  assert.equal(config.paused, false);
});

test("only the owner registers grades and model keys", async () => {
  await rejected(
    barrel.addGrade(x, { id: "evil", model_id: "evil/model", input_weight_bps: 0, key_ttl_sec: 60 }),
    /owner only/,
  );
  await barrel.addGrade(root, { id: "sim", model_id: SIM_MODEL, input_weight_bps: SIM_BPS, key_ttl_sec: 3600 });
  await barrel.addGrade(root, { id: "ttl", model_id: "sim/model-ttl", input_weight_bps: 10_000, key_ttl_sec: 8 });
  await rejected(
    barrel.addGrade(root, { id: "sim", model_id: "sim/other", input_weight_bps: 1, key_ttl_sec: 60 }),
    /grade exists/,
  );
  await rejected(barrel.addKey(x, "sim", stranger.publicKey, sha256Hex("x")), /owner only/);
  await barrel.addKey(root, "sim", tee.publicKey, sha256Hex("simulated evidence"));
  await barrel.addKey(root, "ttl", tee.publicKey, sha256Hex("simulated evidence"));
  const keys = await barrel.keys("sim");
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!.key, tee.publicKey);
  assert.equal(keys[0]!.expires_at - keys[0]!.registered_at, 3600);
});

test("buy: USDC goes into escrow, Barrels come out, the cap returns the excess", async () => {
  await rejected(
    barrel.openSeries(op, { gradeId: "sim", endpoint: "", pricePerBarrel: 1n, windowEnd: nowSec() + 3600, capUnits: 3_000_001n }),
    /cap outside limits/,
  );
  await rejected(
    chain.call(op, contractId, "open_series", {
      grade_id: "sim",
      endpoint: "",
      price_per_barrel: "1",
      window_end: nowSec() + 3600,
      cap_units: "1",
    }),
    /attach 0.01 NEAR/,
  );
  const opened = await barrel.openSeries(op, {
    gradeId: "sim",
    endpoint: "https://pump.example",
    pricePerBarrel: 2_500_000n,
    windowEnd: nowSec() + 3600,
    capUnits: 3_000_000n,
  });
  seriesA = opened.value;
  assert.equal(seriesA, 1);

  // The operator can move its Pump; nobody else can.
  await rejected(barrel.setSeriesEndpoint(x, seriesA, "https://evil.example"), /series operator only/);
  await barrel.setSeriesEndpoint(op, seriesA, "https://pump.example");
  assert.equal((await barrel.series(seriesA))!.endpoint, "https://pump.example");

  // 5 USDC at 2.5 USDC per Barrel = 2 Barrels = 2,000,000 units.
  const first = await barrel.buy(buyer, seriesA, 5_000_000n);
  assert.equal(first.value, 5_000_000n);
  await eventually(() => barrel.balanceOf(buyer.accountId, seriesA), 2_000_000n, "2 Barrels minted");
  await eventually(() => barrel.usdcBalance(buyer.accountId), 15_000_000n, "5 USDC left the buyer");
  await eventually(() => barrel.usdcBalance(contractId), 5_000_000n, "5 USDC in escrow");
  assert.equal(await barrel.totalEscrow(), 5_000_000n);

  // Only 1 Barrel of room is left: 2.5 USDC is used and 2.5 USDC comes back.
  const second = await barrel.buy(buyer, seriesA, 5_000_000n);
  assert.equal(second.value, 2_500_000n);
  await eventually(() => barrel.balanceOf(buyer.accountId, seriesA), 3_000_000n, "series is sold out");
  await eventually(() => barrel.usdcBalance(buyer.accountId), 12_500_000n, "excess USDC returned");

  // Sold out: everything comes back.
  const third = await barrel.buy(buyer, seriesA, 1_000_000n);
  assert.equal(third.value, 0n);
  assert.match(third.failures.join(" "), /sold out/);
  await eventually(() => barrel.usdcBalance(buyer.accountId), 12_500_000n, "nothing taken");

  // Nobody can fake a deposit by calling the hook directly.
  await rejected(
    chain.call(x, contractId, "ft_on_transfer", { sender_id: x.accountId, amount: "1000000", msg: `{"series_id":${seriesA}}` }),
    /only the configured USDC token/,
  );
});

test("fill: a tank holds Barrels under a key that can sign acks and nothing else", async () => {
  await rejected(barrel.fill(buyer, seriesA, 9_000_000n, k1.publicKey), /not enough Barrels/);
  const filled = await barrel.fill(buyer, seriesA, 1_000_000n, k1.publicKey);
  tank1 = filled.value;
  assert.equal(tank1, 1);
  const tank = (await barrel.tank(tank1))!;
  assert.equal(tank.owner, buyer.accountId);
  assert.equal(tank.key, k1.publicKey);
  assert.equal(tank.balance, "1000000");
  assert.equal(tank.next_seq, 0);
  await eventually(() => barrel.balanceOf(buyer.accountId, seriesA), 2_000_000n, "1 Barrel moved into the tank");
  assert.equal(await barrel.balanceOf(contractId, seriesA), 1_000_000n);
  assert.equal(await barrel.supply(seriesA), 3_000_000n);

  // Someone who is not the owner cannot pull the tank's balance.
  await rejected(barrel.withdraw(x, tank1), /tank owner only/);
  await rejected(barrel.requestUnlock(x, tank1), /tank owner only/);
});

test("settle: a model signature plus the payer's ack releases exactly the earned USDC", async (t) => {
  // 1,000 completion tokens + 804 prompt tokens at a 25% input weight = 1,201 units.
  const { receipt, units } = simulate({ prompt_tokens: 804, completion_tokens: 1000 });
  assert.equal(units, 1201n);
  const onChainText = await barrel.ackTextFor(tank1, 0, receipt.request_hash, receipt.response_hash, units);
  assert.equal(onChainText, ackText(contractId, tank1, 0, receipt.request_hash, receipt.response_hash, units));

  const check = await barrel.verifyReceipt(receipt);
  assert.equal(check.valid, true);
  assert.equal(check.key_live, true);
  assert.equal(check.model_id, SIM_MODEL);

  // The operator has no USDC account yet, so the payout bounces. The units
  // still burn and the money waits for `claim`: nothing is lost either way.
  const first = item(receipt, tank1, 0, units, k1);
  const settled = await barrel.settle(op, tank1, [first]);
  assert.equal(settled.value, 1201n);
  t.diagnostic(`gas: 1 item settled for ${Number(settled.gasBurnt / 10n ** 9n) / 1000} TGas (incl. the bounced payout)`);
  await eventually(async () => (await barrel.series(seriesA))!.payable, "3002", "earned USDC is waiting");
  let s = (await barrel.series(seriesA))!;
  assert.equal(s.burned, "1201");
  assert.equal(s.in_tanks, "998799");
  assert.equal(s.released, "3002"); // floor(1201 x 2.5)
  assert.equal(await barrel.totalEscrow(), 7_500_000n);
  assert.equal(await barrel.usdcBalance(op.accountId), 0n);

  await barrel.registerUsdc(root, op.accountId);
  await barrel.claim(x, seriesA); // anyone can trigger it; the money goes to the operator
  await eventually(() => barrel.usdcBalance(op.accountId), 3002n, "operator paid");
  s = (await barrel.series(seriesA))!;
  assert.equal(s.payable, "0");
  assert.equal(await barrel.totalEscrow(), 7_496_998n);
  assert.equal(await barrel.usdcBalance(contractId), 7_496_998n);
  assert.equal(await barrel.settlementCount(), 1);
});

test("settle rejects every attempt to be paid without a valid proof", async () => {
  const usage = { prompt_tokens: 0, completion_tokens: 500 };

  // A signature from a key that is not registered for the grade. This is
  // what a gateway signature is: valid Ed25519, wrong signer.
  const unregistered = simulate(usage, { signer: stranger });
  await rejected(
    barrel.settle(op, tank1, [item(unregistered.receipt, tank1, 1, 500n, k1)]),
    /not a live registered model key/,
  );
  const view = await barrel.verifyReceipt(unregistered.receipt);
  assert.equal(view.valid, false);
  assert.equal(view.signature_ok, true);
  assert.equal(view.key_registered, false);

  // Gateway-shaped text (two parts, no model name), even under a registered key.
  const twoPart = simulate(usage, { text: (rq, rs) => `${rq}:${rs}` });
  await rejected(barrel.settle(op, tank1, [item(twoPart.receipt, tank1, 1, 500n, k1)]), /model signature does not verify/);

  // A registered key that signed for a different model.
  const otherModel = simulate(usage, { text: (rq, rs) => receiptText("sim/model-b", rq, rs) });
  await rejected(barrel.settle(op, tank1, [item(otherModel.receipt, tank1, 1, 500n, k1)]), /model signature does not verify/);

  // A real receipt, but the payer never acknowledged it.
  const good = simulate(usage);
  await rejected(
    barrel.settle(op, tank1, [item(good.receipt, tank1, 1, 500n, stranger)]),
    /ack is not signed by the tank key/,
  );

  // Overcharge: the payer signed for 500 units, the operator claims 5,000.
  await rejected(
    barrel.settle(op, tank1, [item(good.receipt, tank1, 1, 5000n, k1, 500n)]),
    /ack is not signed by the tank key/,
  );

  // An ack written for another deployment does not carry over.
  const foreignAck = signEd25519(
    ackText("other.testnet", tank1, 1, good.receipt.request_hash, good.receipt.response_hash, 500n),
    k1.secretKey,
  );
  await rejected(
    barrel.settle(op, tank1, [settleItem(good.receipt, 1, 500n, foreignAck)]),
    /ack is not signed by the tank key/,
  );

  // Replay of the request that was already paid.
  await rejected(barrel.settle(op, tank1, [item(good.receipt, tank1, 0, 500n, k1)]), /wrong sequence number/);

  // More than the tank holds, even with a valid ack.
  await rejected(
    barrel.settle(op, tank1, [item(good.receipt, tank1, 1, 2_000_000n, k1)]),
    /more units than the tank holds/,
  );

  const tank = (await barrel.tank(tank1))!;
  assert.equal(tank.next_seq, 1);
  assert.equal(tank.balance, "998799");
  assert.equal(await barrel.totalEscrow(), 7_496_998n);
});

test("settle takes a batch, and a revoked or expired model key stops payment", async (t) => {
  const a = simulate({ prompt_tokens: 0, completion_tokens: 1 });
  const b = simulate({ prompt_tokens: 0, completion_tokens: 400 });
  const c = simulate({ prompt_tokens: 0, completion_tokens: 2000 });
  const batch = await barrel.settle(op, tank1, [
    item(a.receipt, tank1, 1, 1n, k1),
    item(b.receipt, tank1, 2, 400n, k1),
    item(c.receipt, tank1, 3, 2000n, k1),
  ]);
  assert.equal(batch.value, 2401n);
  t.diagnostic(`gas: 3 items settled for ${Number(batch.gasBurnt / 10n ** 9n) / 1000} TGas`);
  // Cumulative: floor(3602 x 2.5) = 9005, so this batch earned 6003.
  await eventually(() => barrel.usdcBalance(op.accountId), 9005n, "batch paid");

  const d = simulate({ prompt_tokens: 0, completion_tokens: 10 });
  await barrel.revokeKey(root, "sim", tee.publicKey);
  await rejected(barrel.settle(op, tank1, [item(d.receipt, tank1, 4, 10n, k1)]), /not a live registered model key/);
  const revoked = await barrel.verifyReceipt(d.receipt);
  assert.equal(revoked.key_registered, true);
  assert.equal(revoked.key_live, false);

  // Re-registering the key (after a fresh attestation check) restores it.
  await barrel.addKey(root, "sim", tee.publicKey, sha256Hex("simulated evidence, renewed"));
  const renewed = await barrel.settle(op, tank1, [item(d.receipt, tank1, 4, 10n, k1)]);
  assert.equal(renewed.value, 10n);
  await eventually(() => barrel.usdcBalance(op.accountId), 9030n, "paid after renewal");

  // A key registered with an 8 second lifetime has expired on its own by now.
  const ttl = await barrel.verifyReceipt({ ...d.receipt, grade_id: "ttl" });
  assert.equal(ttl.key_registered, true);
  assert.equal(ttl.key_live, false);
});

test("the payer cannot run off with a tank before the operator can settle", async () => {
  await rejected(barrel.withdraw(buyer, tank1), /request_unlock/);
  const requested = await barrel.requestUnlock(buyer, tank1);
  unlockAt = requested.value;
  assert.ok(unlockAt >= nowSec() + UNLOCK_DELAY - 10);
  await rejected(barrel.withdraw(buyer, tank1), /request_unlock/);

  // During the delay the operator still settles what it already served.
  const e = simulate({ prompt_tokens: 0, completion_tokens: 100 });
  await barrel.settle(op, tank1, [item(e.receipt, tank1, 5, 100n, k1)]);
  await eventually(() => barrel.usdcBalance(op.accountId), 9280n, "settled during the unlock delay");
});

test("Barrels transfer like any NEP-245 token, and a failed transfer call comes back", async () => {
  await barrel.transfer(buyer, x.accountId, seriesA, 100_000n);
  await eventually(() => barrel.balanceOf(x.accountId, seriesA), 100_000n, "x received Barrels");
  await rejected(
    chain.call(buyer, contractId, "mt_transfer", { receiver_id: x.accountId, token_id: String(seriesA), amount: "1" }),
    /exactly 1 yoctoNEAR/,
  );
  await rejected(barrel.transfer(buyer, contractId, seriesA, 1n), /use fill/);
  await rejected(barrel.transfer(x, buyer.accountId, seriesA, 100_001n), /not enough Barrels/);

  // The receiver has no `mt_on_transfer`: the call fails and everything returns.
  const bounced = await barrel.transferCall(x, usdcW.accountId, seriesA, 40_000n, "");
  assert.deepEqual(bounced.value, ["0"]);
  await eventually(() => barrel.balanceOf(x.accountId, seriesA), 100_000n, "bounced transfer returned");
  assert.equal(await barrel.balanceOf(usdcW.accountId, seriesA), 0n);
});

test("pause stops new money and settlement, but nobody is locked in", async () => {
  await rejected(barrel.pause(x), /owner only/);
  await barrel.pause(root);

  const paused = await barrel.buy(buyer, seriesA, 1_000_000n);
  assert.equal(paused.value, 0n);
  assert.match(paused.failures.join(" "), /paused/);
  await rejected(barrel.fill(buyer, seriesA, 1n, k2.publicKey), /paused/);
  const f = simulate({ prompt_tokens: 0, completion_tokens: 1 });
  await rejected(barrel.settle(op, tank1, [item(f.receipt, tank1, 6, 1n, k1)]), /paused/);
  await rejected(
    barrel.openSeries(op, { gradeId: "sim", endpoint: "", pricePerBarrel: 1n, windowEnd: nowSec() + 60, capUnits: 1n }),
    /paused/,
  );

  // Exits stay open while paused.
  await barrel.transfer(x, buyer.accountId, seriesA, 100_000n);
  await eventually(() => barrel.balanceOf(x.accountId, seriesA), 0n, "transfer works while paused");
  await waitUntil(unlockAt);
  const out = await barrel.withdraw(buyer, tank1);
  assert.equal(out.value, "996288"); // 1,000,000 - 3,712 delivered
  await eventually(() => barrel.balanceOf(buyer.accountId, seriesA), 2_996_288n, "tank balance returned");

  await barrel.unpause(root);
  const closed = (await barrel.tank(tank1))!;
  assert.equal(closed.closed, true);
  assert.equal(closed.balance, "0");
  await rejected(barrel.settle(op, tank1, [item(f.receipt, tank1, 6, 1n, k1)]), /tank closed/);
  await eventually(() => barrel.usdcBalance(buyer.accountId), 12_500_000n, "the refused buy took nothing");
});

test("a short series: deliver some, then set up the expiry checks", async () => {
  windowEndB = nowSec() + 75;
  const opened = await barrel.openSeries(op, {
    gradeId: "sim",
    endpoint: "https://pump.example",
    pricePerBarrel: 1_000_000n,
    windowEnd: windowEndB,
    capUnits: 1_000_000n,
  });
  seriesB = opened.value;
  const bought = await barrel.buy(buyer, seriesB, 1_000_000n);
  assert.equal(bought.value, 1_000_000n);
  tank2 = (await barrel.fill(buyer, seriesB, 400_000n, k2.publicKey)).value;

  const g = simulate({ prompt_tokens: 0, completion_tokens: 150_000 });
  await barrel.settle(op, tank2, [item(g.receipt, tank2, 0, 150_000n, k2)]);
  await eventually(() => barrel.usdcBalance(op.accountId), 159_280n, "0.15 USDC earned on the short series");

  await rejected(barrel.refund(buyer, seriesB, 100n), /refunds open after the series expires/);
  await barrel.transfer(buyer, x.accountId, seriesB, 50_000n);
  await eventually(() => barrel.balanceOf(buyer.accountId, seriesB), 550_000n, "buyer keeps 550,000 liquid units");
  assert.ok(nowSec() < windowEndB, "the series was still open while this ran");
});

test("a real model TEE signature from NEAR AI Cloud settles on-chain; the gateway's does not", async (t) => {
  const fixtures = join(REPO_ROOT, "fixtures");
  const receipt: Receipt = {
    ...(JSON.parse(readFileSync(join(fixtures, "receipt.json"), "utf8")) as Receipt),
    grade_id: "glm-5.3-flash",
  };
  const request = base64ToBytes(receipt.request_b64!);
  const response = base64ToBytes(receipt.response_b64!);
  assert.equal(checkReceipt(receipt, { request, response }).verdict, "VALID");

  // The key being registered is the one Intel's attestation vouches for.
  const name = "z-ai-glm-5.3-flash.2026-11-13";
  const evidence = readFileSync(join(fixtures, "attestations", `${name}.json`));
  const report = JSON.parse(evidence.toString("utf8")) as AttestationReport;
  const nonce = readFileSync(join(fixtures, "attestations", `${name}.nonce`), "utf8").trim();
  const stored = JSON.parse(readFileSync(join(fixtures, "attestations", `${name}.collateral.json`), "utf8"));
  const attested = await checkCandidate(report.model_attestations![0]!, {
    nonce,
    modelId: GLM_MODEL,
    collateral: collateralFromJson(JSON.stringify(stored.collateral)),
    nowSecs: stored.fetched_at,
  });
  assert.equal(attested.ok, true, JSON.stringify(attested.checks.filter((c) => !c.ok)));
  assert.equal(attested.signing_address, receipt.signing_address);

  await barrel.addGrade(root, { id: "glm-5.3-flash", model_id: GLM_MODEL, input_weight_bps: GLM_BPS, key_ttl_sec: 86_400 });
  await barrel.addKey(root, "glm-5.3-flash", attested.signing_address, sha256Hex(evidence));
  seriesR = (
    await barrel.openSeries(op, {
      gradeId: "glm-5.3-flash",
      endpoint: "https://pump.example",
      pricePerBarrel: 600_000n,
      windowEnd: nowSec() + 3600,
      capUnits: 3_000_000n,
    })
  ).value;
  const bought = await barrel.buy(buyer, seriesR, 600_000n);
  assert.equal(bought.value, 600_000n);
  tank3 = (await barrel.fill(buyer, seriesR, 500_000n, k3.publicKey)).value;

  // The global escrow cap holds. Escrow is 8,940,720 now (A 7,490,720 +
  // B 850,000 + R 600,000), so 1.2 USDC more would pass the 10 USDC cap.
  assert.equal(await barrel.totalEscrow(), 8_940_720n);
  const capped = await barrel.buy(buyer, seriesR, 1_200_000n);
  assert.equal(capped.value, 0n);
  assert.match(capped.failures.join(" "), /global escrow cap reached/);

  // Units come from the `usage` object inside the bytes the TEE signed.
  const usage = JSON.parse(Buffer.from(response).toString("utf8")).usage;
  const units = unitsFor(usage, GLM_BPS);
  t.diagnostic(`real receipt: ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion tokens = ${units} units`);

  const view = await barrel.verifyReceipt(receipt);
  assert.equal(view.valid, true);
  assert.equal(view.key_live, true);
  assert.equal(view.text, receipt.text);

  const settled = await barrel.settle(op, tank3, [item(receipt, tank3, 0, units, k3)]);
  assert.equal(settled.value, units);
  t.diagnostic(`settled in ${settled.txHash}`);
  const earned = (units * 600_000n) / 1_000_000n;
  await eventually(() => barrel.usdcBalance(op.accountId), 159_280n + earned, "operator paid for the real answer");
  const latest = (await barrel.recentSettlements(1))[0]!;
  assert.equal(latest.tee_sig, receipt.signature);
  assert.equal(latest.request_hash, receipt.request_hash);

  // Same provider, same model name in the request, but signed by the gateway.
  const gateway: Receipt = {
    ...(JSON.parse(readFileSync(join(fixtures, "gateway-kind.json"), "utf8")) as Receipt),
    grade_id: "glm-5.3-flash",
  };
  assert.equal(checkReceipt(gateway).verdict, "REJECTED: not a model signature");
  const gatewayView = await barrel.verifyReceipt(gateway);
  assert.equal(gatewayView.valid, false);
  assert.equal(gatewayView.key_registered, false);
  await rejected(
    barrel.settle(op, tank3, [item(gateway, tank3, 1, 10n, k3)]),
    /not a live registered model key/,
  );
});

test("job tank: the agent thinks on the client's money, and accepting pays it the leftover", async () => {
  agent = await chain.createSubAccount(root, `agent-${tag}`, "0.3");
  await rejected(barrel.fill(buyer, seriesA, 1n, kj.publicKey, buyer.accountId), /another account/);

  // The client funds a tank whose key belongs to the agent.
  tankJ = (await barrel.fill(buyer, seriesA, 1_000_000n, kj.publicKey, agent.accountId)).value;
  let tank = (await barrel.tank(tankJ))!;
  assert.equal(tank.owner, buyer.accountId);
  assert.equal(tank.agent, agent.accountId);
  assert.equal(tank.accepted, false);

  // The agent pays for its thinking from the tank, answer by answer, on proof.
  const think = simulate({ prompt_tokens: 0, completion_tokens: 200_000 });
  await barrel.settle(op, tankJ, [item(think.receipt, tankJ, 0, 200_000n, kj)]);

  // Only the client decides. The agent cannot accept its own work or pull the money.
  await rejected(barrel.accept(agent, tankJ), /tank owner only/);
  await rejected(barrel.withdraw(agent, tankJ), /tank owner only/);
  await rejected(barrel.accept(buyer, tank3), /no agent/);

  const paysOutAt = (await barrel.accept(buyer, tankJ)).value;
  assert.ok(paysOutAt >= nowSec() + UNLOCK_DELAY - 10);
  tank = (await barrel.tank(tankJ))!;
  assert.equal(tank.accepted, true);
  assert.equal(tank.unlock_at, paysOutAt);
  await rejected(barrel.accept(buyer, tankJ), /already accepted/);
  await rejected(barrel.requestUnlock(buyer, tankJ), /job accepted/);
  await rejected(barrel.topUp(buyer, tankJ, 1n), /job accepted/);
  await rejected(barrel.withdraw(agent, tankJ), /paid after the unlock delay/);

  // The operator still settles an answer it served before the acceptance.
  const late = simulate({ prompt_tokens: 0, completion_tokens: 50_000 });
  await barrel.settle(op, tankJ, [item(late.receipt, tankJ, 1, 50_000n, kj)]);
  await waitUntil(paysOutAt);

  // The agent has no USDC account yet: the payout bounces and the tank is
  // restored, so it can be retried. Nothing is lost.
  await rejected(barrel.withdraw(x, tankJ), /tank owner or agent only/);
  const escrowBefore = await barrel.totalEscrow();
  const bounced = await barrel.withdraw(agent, tankJ);
  assert.equal(bounced.value, "0");
  await eventually(async () => (await barrel.tank(tankJ))!.balance, "750000", "bounced payout restored the tank");
  tank = (await barrel.tank(tankJ))!;
  assert.equal(tank.closed, false);
  assert.equal(tank.accepted, true);
  assert.equal(await barrel.totalEscrow(), escrowBefore);

  // 1,000,000 - 200,000 - 50,000 = 750,000 units left, worth 1.875 USDC at 2.5 USDC per Barrel.
  await barrel.registerUsdc(root, agent.accountId);
  const paid = await barrel.withdraw(buyer, tankJ); // the client can trigger it too; the money goes to the agent
  assert.equal(paid.value, "1875000");
  await eventually(() => barrel.usdcBalance(agent.accountId), 1_875_000n, "agent paid the leftover");
  tank = (await barrel.tank(tankJ))!;
  assert.equal(tank.closed, true);
  assert.equal(tank.balance, "0");
  assert.equal(tank.spent, "250000");
  assert.equal(await barrel.totalEscrow(), escrowBefore - 1_875_000n);
  await rejected(barrel.withdraw(agent, tankJ), /tank closed/);
  const s = (await barrel.series(seriesA))!;
  assert.equal(s.refunded, "750000");
  assert.equal(s.refund_paid, "1875000");
});

test("after expiry: no more settlement, and every unused Barrel refunds its USDC", async () => {
  const opensAt = await barrel.refundOpensAt(seriesB);
  assert.equal(opensAt, windowEndB + GRACE);
  await waitUntil(opensAt);

  const late = simulate({ prompt_tokens: 0, completion_tokens: 5 });
  await rejected(barrel.settle(op, tank2, [item(late.receipt, tank2, 1, 5n, k2)]), /settlement closed/);
  await rejected(barrel.fill(buyer, seriesB, 1n, k2.publicKey), /series expired/);

  // x holds 50,000 units but has no USDC account: the refund bounces and the
  // Barrels come back, so it can be retried.
  const bounced = await barrel.refund(x, seriesB, 50_000n);
  assert.equal(bounced.value, "0");
  await eventually(() => barrel.balanceOf(x.accountId, seriesB), 50_000n, "bounced refund restored the Barrels");
  await barrel.registerUsdc(root, x.accountId);
  const retried = await barrel.refund(x, seriesB, 50_000n);
  assert.equal(retried.value, "50000");
  await eventually(() => barrel.usdcBalance(x.accountId), 50_000n, "x refunded");

  // No unlock wait once settlement has closed.
  const out = await barrel.withdraw(buyer, tank2);
  assert.equal(out.value, "250000");
  await eventually(() => barrel.balanceOf(buyer.accountId, seriesB), 800_000n, "tank emptied back to the buyer");
  const refunded = await barrel.refund(buyer, seriesB, 800_000n);
  assert.equal(refunded.value, "800000");
  await rejected(barrel.refund(buyer, seriesB, 1n), /not enough Barrels/);

  const s = (await barrel.series(seriesB))!;
  assert.equal(s.minted, "1000000");
  assert.equal(s.burned, "150000");
  assert.equal(s.refunded, "850000");
  assert.equal(s.in_tanks, "0");
  assert.equal(s.payable, "0");
  assert.equal(BigInt(s.released) + BigInt(s.refund_paid), BigInt(s.escrow_in));
  assert.equal(await barrel.supply(seriesB), 0n);
});

test("the books balance to the last base unit", async () => {
  // Buyer: 20 - 7.5 (A) - 1 (B) - 0.6 (R) + 0.8 (B refund).
  await eventually(() => barrel.usdcBalance(buyer.accountId), 11_700_000n, "buyer's final USDC");
  // Operator: everything settled, on every series. Series A is 3,712 units
  // from tank 1 plus 250,000 from the job tank: floor(253,712 x 2.5).
  assert.equal((await barrel.series(seriesA))!.released, "634280");
  let opTotal = 0n;
  for (const s of await barrel.seriesList()) opTotal += BigInt(s.released);
  await eventually(() => barrel.usdcBalance(op.accountId), opTotal, "operator's final USDC");

  // What the contract holds equals what it says it holds, and equals what
  // buyers paid in minus what operators earned and holders took back.
  const held = await barrel.usdcBalance(contractId);
  assert.equal(held, await barrel.totalEscrow());
  let expected = 0n;
  for (const s of await barrel.seriesList()) {
    expected += BigInt(s.escrow_in) - BigInt(s.released) - BigInt(s.refund_paid) + BigInt(s.payable);
    // Outstanding Barrels are always fully backed.
    const outstanding = BigInt(s.minted) - BigInt(s.burned) - BigInt(s.refunded);
    const backing = BigInt(s.escrow_in) - BigInt(s.released) - BigInt(s.refund_paid);
    assert.ok(backing * 1_000_000n >= outstanding * BigInt(s.price_per_barrel) - 1_000_000n, `series ${s.id} is backed`);
  }
  assert.equal(held, expected);
  const outside = await Promise.all([op, buyer, x, agent].map((w) => barrel.usdcBalance(w.accountId)));
  assert.equal(held + outside.reduce((a, b) => a + b, 0n), 20_000_000n);
});
