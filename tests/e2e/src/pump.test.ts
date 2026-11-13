// The Pump and the paying client on NEAR testnet: no proof, no ack.
//
// A simulated model TEE (a registered Ed25519 key) signs whatever it serves,
// so these tests can play a dishonest upstream or a dishonest Pump and show
// that neither gets paid. The real-model path is covered by loop.test.ts and
// by app.test.ts, which drives the web app's own transactions and ask flow.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
  Barrel,
  Chain,
  NETWORKS,
  ProofError,
  TankClient,
  deployFresh,
  loadWallet,
  sleep,
  type Wallet,
} from "@barrel/sdk";
import {
  newKeyPair,
  receiptText,
  requestAuthText,
  sha256Hex,
  signEd25519,
  utf8,
  worstCaseUnits,
  type SignaturePayload,
} from "@barrel/verifier";
import { startPump, type Pump, type Upstream } from "../../../apps/pump/src/pump.ts";

const chain = new Chain(NETWORKS.testnet);
const MODEL = "sim/model-p";
const BPS = 2000;

let barrel: Barrel;
let root: Wallet, op: Wallet, buyer: Wallet;
let seriesId = 0;
let pump: Pump;
let proxy: Server | undefined;

const tee = newKeyPair(); // registered for the grade
const gatewayKey = newKeyPair(); // never registered
const tanks: Record<string, { id: number; key: ReturnType<typeof newKeyPair> }> = {};

/** What the upstream does with the next request. */
let mode: "honest" | "gateway" | "unsigned" | "no-usage" = "honest";
const signatures = new Map<string, SignaturePayload>();
let answerNo = 0;

const upstream: Upstream = {
  async complete(body) {
    answerNo += 1;
    const id = `sim-${answerNo}`;
    const request = JSON.parse(Buffer.from(body).toString("utf8"));
    const response: any = {
      id,
      model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content: `answer ${answerNo}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 },
    };
    if (mode === "no-usage") delete response.usage;
    const bytes = utf8(JSON.stringify(response));
    const rq = sha256Hex(body);
    const rs = sha256Hex(bytes);
    if (mode === "honest" || mode === "no-usage") {
      const text = receiptText(MODEL, rq, rs);
      signatures.set(id, { text, signature: signEd25519(text, tee.secretKey), signing_address: tee.publicKey, signing_algo: "ed25519", signature_kind: "provider_tee" });
    } else if (mode === "gateway") {
      const text = `${rq}:${rs}`;
      signatures.set(id, { text, signature: signEd25519(text, gatewayKey.secretKey), signing_address: gatewayKey.publicKey, signing_algo: "ed25519", signature_kind: "gateway" });
    }
    return { status: 200, contentType: "application/json", body: bytes };
  },
  async signature(chatId) {
    return signatures.get(chatId) ?? null;
  },
};

async function newTank(name: string, units: bigint): Promise<void> {
  const key = newKeyPair();
  const id = (await barrel.fill(buyer, seriesId, units, key.publicKey)).value;
  tanks[name] = { id, key };
}

function client(name: string, pumpUrl = pump.url): TankClient {
  return new TankClient({ barrel, tankId: tanks[name]!.id, tankSecretKey: tanks[name]!.key.secretKey, pumpUrl });
}

/** A raw request to the Pump, signed by a tank key, for probing its checks. */
async function raw(
  name: string,
  body: Record<string, unknown>,
  opts: { seq?: number; maxUnits?: bigint; signWith?: string } = {},
): Promise<{ status: number; text: string }> {
  const tank = tanks[name]!;
  const bytes = utf8(JSON.stringify(body));
  const onChain = (await barrel.tank(tank.id))!;
  const seq = opts.seq ?? onChain.next_seq;
  const maxUnits = opts.maxUnits ?? worstCaseUnits(bytes.length, Number(body.max_tokens ?? 64), BPS);
  const sig = signEd25519(requestAuthText(barrel.contractId, tank.id, seq, sha256Hex(bytes), maxUnits), opts.signWith ?? tank.key.secretKey);
  const res = await fetch(`${pump.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-barrel-tank": String(tank.id),
      "x-barrel-seq": String(seq),
      "x-barrel-max-units": maxUnits.toString(),
      "x-barrel-sig": sig,
    },
    body: bytes as unknown as BodyInit,
  });
  return { status: res.status, text: await res.text() };
}

async function operatorEarned(): Promise<bigint> {
  return BigInt((await barrel.series(seriesId))!.released);
}

before(async () => {
  root = process.env.BARREL_E2E_ROOT
    ? loadWallet("testnet", process.env.BARREL_E2E_ROOT)
    : await chain.createFaucetAccount("barrel-pumptest");
  const tag = randomBytes(3).toString("hex");
  ({ barrel } = await deployFresh(chain, root, {
    tag,
    unlockDelaySec: 30,
    settleGraceSec: 30,
    maxSeriesUnits: 10_000_000n,
    maxTotalEscrow: 10_000_000n,
  }));
  op = await chain.createSubAccount(root, `op-${tag}`, "0.6");
  buyer = await chain.createSubAccount(root, `buyer-${tag}`, "0.6");
  await barrel.registerUsdc(root, op.accountId);
  await barrel.addGrade(root, { id: "simp", model_id: MODEL, input_weight_bps: BPS, key_ttl_sec: 3600 });
  await barrel.addKey(root, "simp", tee.publicKey, sha256Hex("simulated evidence"));
  seriesId = (
    await barrel.openSeries(op, {
      gradeId: "simp",
      endpoint: "http://127.0.0.1",
      pricePerBarrel: 1_000_000n,
      windowEnd: Math.floor(Date.now() / 1000) + 3600,
      capUnits: 5_000_000n,
    })
  ).value;
  await barrel.faucet(buyer, buyer.accountId, 2_000_000n);
  await barrel.buy(buyer, seriesId, 2_000_000n);
  await newTank("main", 1_000_000n);
  await newTank("tiny", 30n);
  await newTank("silent", 100_000n);
  pump = await startPump({ barrel, seriesId, operator: op, upstream, port: 0 });
});

after(async () => {
  await pump?.close();
  proxy?.close();
});

test("an honest answer is checked, acknowledged and settled on-chain", async () => {
  mode = "honest";
  const result = await client("main").chat({ messages: [{ role: "user", content: "hello" }], max_tokens: 64 });
  // 25 completion tokens + ceil(40 x 20%) = 33 units.
  assert.equal(result.units, 33n);
  assert.equal(result.content, "answer 1");
  assert.ok(result.checks.every((c) => c.ok));
  assert.ok(result.settleTx);
  const tank = (await barrel.tank(tanks.main!.id))!;
  assert.equal(tank.next_seq, 1);
  assert.equal(tank.spent, "33");
  assert.equal(await operatorEarned(), 33n);
});

test("the Pump refuses requests the tank did not sign or cannot pay for", async () => {
  const body = { model: MODEL, messages: [{ role: "user", content: "x" }], max_tokens: 64, stream: false };
  assert.equal((await raw("main", body, { signWith: newKeyPair().secretKey })).status, 401);
  assert.equal((await raw("main", body, { seq: 7 })).status, 409);
  assert.match((await raw("main", { ...body, stream: true })).text, /gateway, not by the model/);
  assert.match((await raw("main", { ...body, model: "sim/other" })).text, /serves sim\/model-p only/);
  assert.match((await raw("main", { ...body, max_tokens: 100_000 })).text, /set max_tokens/);
  assert.match((await raw("main", body, { maxUnits: 5n })).text, /x-barrel-max-units must be at least/);
  const poor = await raw("tiny", body);
  assert.equal(poor.status, 402);
  assert.match(poor.text, /tank holds 30 units/);
  assert.equal(answerNo, 1, "nothing reached the upstream");
});

test("an answer signed by the gateway instead of the model is never billed", async () => {
  mode = "gateway";
  const before = await operatorEarned();
  await assert.rejects(
    client("main").chat({ messages: [{ role: "user", content: "gw" }], max_tokens: 64 }),
    /not a model signature.*not billed/,
  );
  mode = "unsigned";
  await assert.rejects(
    client("main").chat({ messages: [{ role: "user", content: "none" }], max_tokens: 64 }),
    /no signature for this answer; it is not billed/,
  );
  mode = "no-usage";
  await assert.rejects(
    client("main").chat({ messages: [{ role: "user", content: "nousage" }], max_tokens: 64 }),
    /no usage; it is not billed/,
  );
  mode = "honest";
  assert.equal(await operatorEarned(), before);
  assert.equal((await barrel.tank(tanks.main!.id))!.next_seq, 1);
});

test("a Pump that alters the answer or overstates usage gets no ack and no money", async () => {
  // A dishonest Pump sits between the agent and the honest one.
  let tamper: "body" | "units" = "body";
  proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    const hop = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding"]);
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !hop.has(k)) headers[k] = v;
    const upstreamRes = await fetch(`${pump.url}${req.url}`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
    let body = Buffer.from(await upstreamRes.arrayBuffer());
    const out: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => (out[k] = v));
    for (const k of hop) delete out[k];
    if (req.url === "/v1/chat/completions" && upstreamRes.status === 200) {
      if (tamper === "body") body = Buffer.from(body.toString("utf8").replace(/answer \d+/, "a different answer"));
      if (tamper === "units") out["x-barrel-units"] = String(Number(out["x-barrel-units"]) * 10);
    }
    res.writeHead(upstreamRes.status, out);
    res.end(body);
  });
  await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", r));
  const address = proxy.address();
  const proxyUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const before = await operatorEarned();

  await assert.rejects(
    client("silent", proxyUrl).chat({ messages: [{ role: "user", content: "tamper" }], max_tokens: 64 }),
    (e: unknown) => {
      assert.ok(e instanceof ProofError);
      assert.ok(e.checks.some((c) => c.name === "response bytes hash to response_hash" && !c.ok));
      assert.match(e.message, /Nothing was acknowledged/);
      return true;
    },
  );

  // The honest Pump served that answer and is still waiting for an ack it
  // will never get: the tank is not served again until it acknowledges.
  const blocked = await raw("silent", { model: MODEL, messages: [{ role: "user", content: "again" }], max_tokens: 64 });
  assert.equal(blocked.status, 402);
  assert.match(blocked.text, /acknowledge the previous answer first/);

  tamper = "units";
  await assert.rejects(
    client("main", proxyUrl).chat({ messages: [{ role: "user", content: "overcharge" }], max_tokens: 64 }),
    (e: unknown) => {
      assert.ok(e instanceof ProofError);
      assert.match(e.message, /different number of units/);
      return true;
    },
  );
  await sleep(1000);
  assert.equal(await operatorEarned(), before);
  assert.equal((await barrel.tank(tanks.silent!.id))!.spent, "0");
});
