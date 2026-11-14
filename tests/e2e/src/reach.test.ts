// What the Pump does beyond the plain loop, on NEAR testnet:
//
//   several models from one Pump, each with its own series and price
//   HTTP 402: a key with no account learns how to pay, is paid for by
//     someone else, and is served from a tank only it controls
//   private requests: the Pump relays ciphertext it cannot read
//   claims: an answer nobody acknowledges is still paid, and an ack that
//     comes late still wins
//   duty: requests sent through the chain to a firm series, and canaries,
//     are answered before their deadline
//   relay: signed resale offers are kept for buyers to find
//
// A simulated model TEE signs the answers. It holds the key that prompts
// are encrypted to, as the real model does.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  Barrel,
  Chain,
  NETWORKS,
  PaymentRequired,
  TankClient,
  barrelToken,
  deployFresh,
  loadWallet,
  paymentOptions,
  signIntents,
  sleep,
  usdcToken,
  type Offer,
  type Wallet,
} from "@barrel/sdk";
import {
  looksSealed,
  newKeyPair,
  openWith,
  receiptText,
  requestAuthText,
  sealTo,
  sha256Hex,
  signEd25519,
  unitsFor,
  utf8,
  worstCaseUnits,
  type SignaturePayload,
} from "@barrel/verifier";
import { startPump, type Pump, type Upstream } from "../../../apps/pump/src/pump.ts";

const chain = new Chain(NETWORKS.testnet);
const MODEL_A = "sim/model-a";
const MODEL_B = "sim/model-b";
const BPS_A = 2000;
const BPS_B = 1000;
const CLAIM_WINDOW = 12;
const CANARY_FEE = 10n ** 21n;

let barrel: Barrel;
let root: Wallet, op: Wallet, buyer: Wallet;
let seriesA = 0;
let seriesB = 0;
let pump: Pump;

const tee = newKeyPair();
const agent = newKeyPair(); // an agent: a key, no account, no NEAR
const quiet = newKeyPair(); // a payer that never acknowledges
const late = newKeyPair(); // a payer that acknowledges after the claim
const holder = newKeyPair(); // a tank on the firm series
let tankQuiet = 0;
let tankLate = 0;
let tankHolder = 0;

/** Everything the upstream was sent, as the Pump relayed it. */
const relayed: string[] = [];
const signatures = new Map<string, SignaturePayload>();
let answerNo = 0;

const upstream: Upstream = {
  async complete(body, headers) {
    answerNo += 1;
    const id = `sim-${answerNo}`;
    const text = Buffer.from(body).toString("utf8");
    relayed.push(text);
    const request = JSON.parse(text);
    let content = `answer ${answerNo} from ${request.model}`;
    // The model TEE holds the key prompts are encrypted to. Nobody else does.
    if (headers?.["x-model-pub-key"] === tee.publicKey) {
      const prompt = openWith(tee.secretKey, request.messages.at(-1).content);
      content = sealTo(headers["x-client-pub-key"]!, `you said: ${prompt}`);
    }
    const response = {
      id,
      model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 },
    };
    const bytes = utf8(JSON.stringify(response));
    const signed = receiptText(request.model, sha256Hex(body), sha256Hex(bytes));
    signatures.set(id, { text: signed, signature: signEd25519(signed, tee.secretKey), signing_address: tee.publicKey, signing_algo: "ed25519", signature_kind: "provider_tee" });
    return { status: 200, contentType: "application/json", body: bytes };
  },
  async signature(chatId) {
    return signatures.get(chatId) ?? null;
  },
};

const nowSec = () => Math.floor(Date.now() / 1000);

async function eventually<T>(read: () => Promise<T>, expected: T, label: string): Promise<void> {
  let last: T | undefined;
  for (let i = 0; i < 14; i++) {
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

/** A signed request that is sent and then, on purpose, never acknowledged here. */
async function askWithoutAck(tankId: number, key: { secretKey: string }, model: string, bps: number) {
  const bytes = utf8(JSON.stringify({ model, messages: [{ role: "user", content: `no ack ${randomBytes(4).toString("hex")}` }], max_tokens: 64, stream: false }));
  const tank = (await barrel.tank(tankId))!;
  const maxUnits = worstCaseUnits(bytes.length, 64, bps);
  const res = await fetch(`${pump.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-barrel-tank": String(tankId),
      "x-barrel-seq": String(tank.next_seq),
      "x-barrel-max-units": maxUnits.toString(),
      "x-barrel-sig": signEd25519(requestAuthText(barrel.contractId, tankId, tank.next_seq, sha256Hex(bytes), maxUnits), key.secretKey),
    },
    body: bytes as unknown as BodyInit,
  });
  assert.equal(res.status, 200);
  const response = new Uint8Array(await res.arrayBuffer());
  return { seq: tank.next_seq, maxUnits, requestHash: sha256Hex(bytes), responseHash: sha256Hex(response), units: BigInt(res.headers.get("x-barrel-units")!) };
}

before(async () => {
  root = process.env.BARREL_E2E_ROOT ? loadWallet("testnet", process.env.BARREL_E2E_ROOT) : await chain.createFaucetAccount("barrel-reach");
  const tag = randomBytes(3).toString("hex");
  ({ barrel } = await deployFresh(chain, root, {
    tag,
    unlockDelaySec: 40,
    settleGraceSec: 30,
    claimWindowSec: CLAIM_WINDOW,
    timelockSec: 60,
    minTankBuyUnits: 1000n,
    maxSeriesUnits: 10_000_000n,
    maxTotalEscrow: 20_000_000n,
  }));
  op = await chain.createSubAccount(root, `op-${tag}`, "0.8");
  buyer = process.env.BARREL_E2E_BUYER ? loadWallet("testnet", process.env.BARREL_E2E_BUYER) : await chain.createFaucetAccount("barrel-reach-buyer");
  await barrel.registerUsdc(root, op.accountId);
  await barrel.registerUsdc(root, buyer.accountId);
  await barrel.faucet(buyer, buyer.accountId, 10_000_000n);
  await barrel.faucet(op, op.accountId, 1_000_000n);
  await barrel.addGrade(root, { id: "sim-a", model_id: MODEL_A, input_weight_bps: BPS_A, key_ttl_sec: 7200 });
  await barrel.addGrade(root, { id: "sim-b", model_id: MODEL_B, input_weight_bps: BPS_B, key_ttl_sec: 7200 });
  await barrel.addKey(root, "sim-a", tee.publicKey, sha256Hex("simulated evidence"));
  await barrel.addKey(root, "sim-b", tee.publicKey, sha256Hex("simulated evidence"));
  const windowEnd = nowSec() + 3600;
  seriesA = (await barrel.openSeries(op, { gradeId: "sim-a", endpoint: "http://127.0.0.1", pricePerBarrel: 1_000_000n, windowEnd, capUnits: 5_000_000n })).value;
  seriesB = (
    await barrel.openSeries(op, {
      gradeId: "sim-b",
      endpoint: "http://127.0.0.1",
      pricePerBarrel: 2_000_000n,
      windowEnd,
      capUnits: 5_000_000n,
      firm: { respond_sec: 120, max_misses: 3, canary_interval_sec: 0, canary_fee: CANARY_FEE.toString() },
    })
  ).value;
  await barrel.addBond(op, seriesB, 200_000n);
  await barrel.buy(buyer, seriesA, 1_000_000n);
  await barrel.buy(buyer, seriesB, 1_000_000n); // 500,000 units at 2.0
  tankQuiet = (await barrel.fill(buyer, seriesA, 100_000n, quiet.publicKey)).value;
  tankLate = (await barrel.fill(buyer, seriesA, 100_000n, late.publicKey)).value;
  tankHolder = (await barrel.fill(buyer, seriesB, 400_000n, holder.publicKey)).value;
  // Claims are filed after one second without an ack, and the duty round is
  // run by hand, so each test decides when the Pump acts.
  pump = await startPump({ barrel, seriesIds: [seriesA, seriesB], operator: op, upstream, port: 0, claimAfterMs: 1000, dutyIntervalMs: 0 });
});

after(async () => {
  await pump?.close();
});

test("one Pump serves several models, each from its own series at its own price", async () => {
  const models = (await (await fetch(`${pump.url}/v1/models`)).json()) as any;
  assert.deepEqual(models.data.map((m: any) => m.id), [MODEL_A, MODEL_B]);
  assert.equal(models.data[1].barrel.price_per_barrel, "2000000");
  const info = (await (await fetch(`${pump.url}/v1/info`)).json()) as any;
  assert.equal(info.series.length, 2);
  assert.equal(info.series[1].firm.bond, "200000");

  // The same tank key works only for its own series' model.
  const b = await new TankClient({ barrel, tankId: tankHolder, tankSecretKey: holder.secretKey, pumpUrl: pump.url }).chat({
    messages: [{ role: "user", content: "hello b" }],
    max_tokens: 64,
  });
  assert.match(b.content, /from sim\/model-b/);
  // 25 completion + ceil(40 x 10%) = 29 units, at 2.0 USDC per Barrel = 58 base units.
  assert.equal(b.units, 29n);
  assert.equal((await barrel.series(seriesB))!.released, "58");
});

test("HTTP 402: a key with no account is told how to pay, someone pays, and it is served", async () => {
  // The agent has a key and nothing else. It asks; the Pump answers 402.
  const client = new TankClient({ barrel, tankSecretKey: agent.secretKey, pumpUrl: pump.url });
  await assert.rejects(client.chat({ messages: [{ role: "user", content: "hi" }] }), PaymentRequired);
  const res = await fetch(`${pump.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-barrel-key": agent.publicKey, "x-barrel-pay": "50000" },
    body: JSON.stringify({ model: MODEL_A, messages: [{ role: "user", content: "hi" }], max_tokens: 64 }),
  });
  assert.equal(res.status, 402);
  const offer = (await res.json()) as any;
  assert.equal(offer.x402Version, 1);
  const [option] = await paymentOptions(pump.url, { key: agent.publicKey, model: MODEL_A, usdc: 50_000n });
  assert.deepEqual(option, offer.accepts[0]);
  assert.equal(option!.network, "near-testnet");
  assert.equal(option!.payTo, barrel.contractId, "the money goes to the contract, never to the Pump");
  assert.equal(option!.asset, barrel.usdcId);
  assert.equal(option!.maxAmountRequired, "50000");
  assert.deepEqual(JSON.parse(option!.extra.msg), { series_id: seriesA, tank_key: agent.publicKey });
  assert.equal((await fetch(option!.extra.tank)).status, 404, "no tank yet");

  // Anyone can pay it exactly as written. Here the buyer does.
  await chain.call(
    buyer,
    option!.asset,
    option!.extra.method,
    { receiver_id: option!.payTo, amount: option!.maxAmountRequired, msg: option!.extra.msg },
    { gasTgas: 80, deposit: 1n },
  );
  await eventually(async () => (await fetch(option!.extra.tank)).status, 200, "the tank appears for the key");
  const found = (await (await fetch(option!.extra.tank)).json()) as any;
  assert.equal(found.balance, "50000");
  assert.equal((await barrel.tank(found.tank_id))!.owner, agent.publicKey);

  // Now the same client, still holding only its key, is served and pays on proof.
  const result = await client.chat({ messages: [{ role: "user", content: "hi again" }], max_tokens: 64 });
  assert.equal(client.tankId, found.tank_id);
  assert.equal(result.units, 33n);
  assert.ok(result.settleTx);

  // A request the tank cannot cover gets the same kind of answer: how to add to it.
  // (300,000 request bytes at 20% are 60,000 units; the tank holds under 50,000.)
  await assert.rejects(client.chat({ messages: [{ role: "user", content: "x".repeat(300_000) }], max_tokens: 4096 }), (e: unknown) => {
    assert.ok(e instanceof PaymentRequired);
    assert.equal(e.accepts[0]!.extra.tank_key, agent.publicKey);
    return true;
  });
  // A key that already owns a tank is pointed at it instead of being asked to pay.
  const again = await fetch(`${pump.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-barrel-key": agent.publicKey },
    body: JSON.stringify({ model: MODEL_A, messages: [], max_tokens: 1 }),
  });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as any).tank_id, found.tank_id);
});

test("private: the Pump relays a prompt and an answer it cannot read, and is still paid on proof", async () => {
  const secret = `the launch code is ${randomBytes(6).toString("hex")}`;
  const client = new TankClient({ barrel, tankSecretKey: agent.secretKey, pumpUrl: pump.url, private: true });
  const before = relayed.length;
  const result = await client.chat({ messages: [{ role: "user", content: secret }], max_tokens: 64 });

  assert.equal(result.content, `you said: ${secret}`, "the payer reads the answer");
  assert.equal(result.sealedTo, tee.publicKey);
  assert.ok(result.checks.every((c) => c.ok));
  // What passed through the Pump, in both directions, is ciphertext.
  const sent = relayed[before]!;
  assert.equal(sent.includes(secret), false);
  assert.equal(looksSealed(JSON.parse(sent).messages[0].content), true);
  const signedAnswer = JSON.parse(Buffer.from(result.receipt.response_b64!, "base64").toString("utf8"));
  assert.equal(looksSealed(signedAnswer.choices[0].message.content), true);
  assert.equal(JSON.stringify(signedAnswer).includes(secret), false);
  // Token counts stay readable, so the units are metered and settled as usual.
  assert.equal(result.units, unitsFor(signedAnswer.usage, BPS_A));
  assert.ok(result.settleTx);
  assert.equal((await barrel.verifyReceipt(result.receipt)).valid, true);
});

test("claim: the Pump is paid for an answer nobody acknowledged, and a late ack still wins", async () => {
  const earned = async () => BigInt((await barrel.series(seriesA))!.released);
  const start = await earned();

  // Two payers take an answer and stay silent.
  const q = await askWithoutAck(tankQuiet, quiet, MODEL_A, BPS_A);
  const l = await askWithoutAck(tankLate, late, MODEL_A, BPS_A);
  assert.equal(q.units, 33n);
  // The Pump serves neither again until this is resolved.
  const blocked = await fetch(`${pump.url}/v1/chat/completions`, { method: "POST", headers: { "x-barrel-tank": String(tankQuiet), "x-barrel-seq": "1", "x-barrel-max-units": "1", "x-barrel-sig": "00" }, body: "{}" });
  assert.equal(blocked.status, 402);

  await sleep(1500);
  await pump.duty();
  assert.equal(pump.stats.claimed, 2);
  const claimed = (await barrel.tank(tankQuiet))!;
  assert.equal(claimed.claim!.units, q.maxUnits.toString());
  assert.equal(claimed.claim!.request_hash, q.requestHash);
  assert.equal(await earned(), start, "a claim pays nothing until its window passes");

  // One payer comes back with the ack: the true 33 units are charged.
  const ackSig = signEd25519(`barrel:v1:ack:${barrel.contractId}:${tankLate}:${l.seq}:${l.requestHash}:${l.responseHash}:${l.units}`, late.secretKey);
  const ack = await fetch(`${pump.url}/v1/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tank_id: tankLate, seq: l.seq, ack_sig: ackSig }) });
  assert.equal(ack.status, 200);
  const lateTank = (await barrel.tank(tankLate))!;
  assert.equal(lateTank.claim, null);
  assert.equal(lateTank.spent, "33");
  assert.equal(await earned(), start + 33n);

  // The other never does: after the window the authorized maximum is paid.
  await sleep((claimed.claim!.ready_at + 3) * 1000 - Date.now());
  await pump.duty();
  const quietTank = (await barrel.tank(tankQuiet))!;
  assert.equal(quietTank.claim, null);
  assert.equal(quietTank.spent, q.maxUnits.toString());
  assert.equal(quietTank.next_seq, 1);
  assert.equal(await earned(), start + 33n + q.maxUnits);
  assert.equal((await barrel.recentSettlements(1))[0]!.kind, "claim");
});

test("duty: the Pump answers a request sent through the chain, and a canary, in time", async () => {
  const body = JSON.stringify({ model: MODEL_B, messages: [{ role: "user", content: "Answer me through the chain." }], max_tokens: 200 });
  const forcedId = (await barrel.forceRequest(buyer, tankHolder, body)).value;
  const canaryId = (await barrel.canary(buyer, seriesB, CANARY_FEE)).value;
  await eventually(async () => (await barrel.openForced(seriesB)).map((f) => f.id), [forcedId, canaryId], "both wait for the operator");

  await pump.duty();
  assert.equal(pump.stats.forcedAnswered, 2);
  const forced = (await barrel.forced(forcedId))!;
  assert.equal(forced.status, "answered");
  assert.match(JSON.parse(forced.response!).choices[0].message.content, /from sim\/model-b/);
  assert.equal(forced.units, "29");
  assert.equal(relayed.includes(body), true, "the model was sent the exact bytes the contract hashed");
  const canary = (await barrel.forced(canaryId))!;
  assert.equal(canary.status, "answered");
  const firm = (await barrel.series(seriesB))!.firm!;
  assert.equal(firm.misses, 0);
  assert.equal(firm.canary_passed, 1);
  assert.equal(firm.answered, 2);
  assert.deepEqual(firm.open, []);
  assert.equal((await barrel.tank(tankHolder))!.reserved, "0");
});

test("relay: signed resale offers are kept, listed and dropped", async () => {
  // Signed exactly as for NEAR Intents (mainnet settles it; here only the relay is exercised).
  const deadlineMs = Date.now() + 3600_000;
  const signed = signIntents(buyer, [{ intent: "token_diff", diff: { [barrelToken(barrel.contractId, seriesA)]: "-500000", [usdcToken(barrel.usdcId)]: "450000" } }], { salt: "00000000", deadlineMs });
  const offer: Offer = {
    id: sha256Hex(signed.signature).slice(0, 16),
    maker: buyer.accountId,
    contract: barrel.contractId,
    usdc: barrel.usdcId,
    series_id: seriesA,
    units: "500000",
    price: "450000",
    deadline: new Date(deadlineMs).toISOString(),
    signed,
  };
  const post = (o: unknown) => fetch(`${pump.url}/v1/offers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
  assert.equal((await post(offer)).status, 200);
  assert.equal((await post(offer)).status, 200, "posting it twice keeps one");
  assert.equal((await post({ ...offer, contract: "other.testnet" })).status, 400);
  assert.equal((await post({ ...offer, id: "x", deadline: new Date(Date.now() - 1000).toISOString() })).status, 400);
  const listed = ((await (await fetch(`${pump.url}/v1/offers`)).json()) as any).offers as Offer[];
  assert.equal(listed.length, 1);
  assert.deepEqual(JSON.parse(listed[0]!.signed.payload.message).intents[0].diff, { [barrelToken(barrel.contractId, seriesA)]: "-500000", [usdcToken(barrel.usdcId)]: "450000" });
  await fetch(`${pump.url}/v1/offers/${offer.id}`, { method: "DELETE" });
  assert.equal((((await (await fetch(`${pump.url}/v1/offers`)).json()) as any).offers as Offer[]).length, 0);
});
