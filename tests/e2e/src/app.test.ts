// The web app's own write path, against the live deployment.
//
// The transactions are the exact specs the app hands a wallet
// (apps/web/src/txs.ts); here a fresh faucet account signs them with its key.
// The answer goes through the browser's own ask code (apps/web/src/tank.ts) to
// the series' running Pump, a real model, and a real on-chain settlement.
//
// Needs the series' Pump to be up (`BARREL_NETWORK=testnet PUMP_PORT=8788 pnpm pump`);
// without it this test is skipped, never faked.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Barrel, CHEAPEST_MODEL, Chain, NETWORKS, REPO_ROOT, loadWallet, type Wallet } from "@barrel/sdk";
import { newKeyPair } from "@barrel/verifier";
import * as txs from "../../../apps/web/src/txs.ts";
import { ask } from "../../../apps/web/src/tank.ts";

const deployment = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "testnet.json"), "utf8")) as {
  contract: string;
  usdc: string;
  series: { id: number; model_id: string }[];
};
const chain = new Chain(NETWORKS.testnet);
const barrel = new Barrel(chain, deployment.contract, deployment.usdc);
const c = { barrel: deployment.contract, usdc: deployment.usdc };
const run = (w: Wallet, s: txs.TxSpec) => chain.call(w, s.receiverId, s.methodName, s.args, { gasTgas: s.gasTgas, deposit: s.deposit });

// Tests run on the cheapest model.
const seriesId = (deployment.series.find((s) => s.model_id === CHEAPEST_MODEL.model) ?? deployment.series.at(-1)!).id;
// A funded testnet account to create users under, when the faucet is rate-limited.
const funder = process.env.BARREL_E2E_ROOT ? loadWallet("testnet", process.env.BARREL_E2E_ROOT) : undefined;
const newUser = (name: string, near = "0.4") =>
  funder ? chain.createSubAccount(funder, `${name}-${Date.now().toString(36)}`, near) : chain.createFaucetAccount(`barrel-${name}`);
const series = (await barrel.series(seriesId))!;
const pumpUp = await fetch(`${series.endpoint.replace(/\/+$/, "")}/v1/info`)
  .then((r) => r.ok)
  .catch(() => false);

test("buy, fill, ask and unlock with the app's transactions and ask code", { skip: pumpUp ? false : `the Pump at ${series.endpoint} is not running` }, async () => {
  const grade = (await barrel.grade(series.grade_id))!;
  const user = await newUser("app");

  // Mint test USDC and buy one tUSDC of Barrels.
  await run(user, txs.mintTestUsdc(c, user.accountId, 2_000_000n));
  assert.equal(await barrel.usdcBalance(user.accountId), 2_000_000n);
  const bought = await run(user, txs.buy(c, seriesId, 1_000_000n));
  assert.deepEqual(bought.failures, []);
  const held = await barrel.balanceOf(user.accountId, seriesId);
  assert.equal(held, (1_000_000n * 1_000_000n) / BigInt(series.price_per_barrel));

  // Fill a tank under a key made the way the browser makes it.
  const key = newKeyPair();
  const filled = await run(user, txs.fill(c, seriesId, held, key.publicKey));
  const tankId = Number(filled.value);
  const tank = (await barrel.tank(tankId))!;
  assert.equal(tank.key, key.publicKey);
  assert.equal(BigInt(tank.balance), held);

  // One real answer, paid only after the proof checks pass.
  const answer = await ask({
    view: (contract, method, args) => chain.view(contract, method, args),
    contractId: deployment.contract,
    tank,
    grade,
    endpoint: series.endpoint,
    secretKey: key.secretKey,
    question: "Reply with the single word: ready",
    maxTokens: 300,
  });
  assert.ok(answer.checks.every((x) => x.ok), JSON.stringify(answer.checks));
  assert.ok(answer.units > 0n);
  assert.ok(answer.settleTx, "the Pump settles each ack right away");
  const after = (await barrel.tank(tankId))!;
  assert.equal(after.next_seq, 1);
  assert.equal(BigInt(after.balance), held - answer.units);

  // The same ask with "Private" ticked: the browser encrypts the question to
  // the model's registered key and opens the answer itself.
  const secret = await ask({
    view: (contract, method, args) => chain.view(contract, method, args),
    contractId: deployment.contract,
    tank: after,
    grade,
    endpoint: series.endpoint,
    secretKey: key.secretKey,
    question: "Reply with the single word: sealed",
    maxTokens: 300,
    private: true,
  });
  assert.ok(secret.checks.every((x) => x.ok), JSON.stringify(secret.checks));
  assert.ok(secret.sealedTo);
  assert.ok(secret.checks.some((x) => x.name === "the answer came back encrypted to this tank's key" && x.ok));
  assert.equal(JSON.stringify(secret.receipt).includes("sealed\""), false, "the signed bytes carry ciphertext only");
  assert.ok(secret.settleTx);

  // The owner can always take the rest back: unlock starts the delay.
  await run(user, txs.requestUnlock(c, tankId));
  assert.notEqual((await barrel.tank(tankId))!.unlock_at, null);
});

test("job tank: fund an agent, it asks on the client's money, the client accepts", { skip: pumpUp ? false : `the Pump at ${series.endpoint} is not running` }, async () => {
  const grade = (await barrel.grade(series.grade_id))!;
  const client = await newUser("client");
  const agent = await newUser("agent", "0.1");

  await run(client, txs.mintTestUsdc(c, client.accountId, 1_000_000n));
  await run(client, txs.buy(c, seriesId, 1_000_000n));
  const held = await barrel.balanceOf(client.accountId, seriesId);

  // The client funds a job: the agent gets the spend key, the client keeps the say.
  const key = newKeyPair();
  const filled = await run(client, txs.fill(c, seriesId, held, key.publicKey, agent.accountId));
  assert.deepEqual(filled.failures, []);
  const tankId = Number(filled.value);
  let tank = (await barrel.tank(tankId))!;
  assert.equal(tank.agent, agent.accountId);
  assert.equal(tank.accepted, false);

  // The agent thinks on the client's money: a real answer, paid on proof.
  const answer = await ask({
    view: (contract, method, args) => chain.view(contract, method, args),
    contractId: deployment.contract,
    tank,
    grade,
    endpoint: series.endpoint,
    secretKey: key.secretKey,
    question: "Reply with the single word: done",
    maxTokens: 300,
  });
  assert.ok(answer.checks.every((x) => x.ok), JSON.stringify(answer.checks));
  assert.ok(answer.settleTx);

  // Only the client accepts, and the agent can be made ready to receive USDC.
  const notOwner = await run(agent, txs.accept(c, tankId)).catch((e: Error) => e);
  assert.ok(notOwner instanceof Error || (notOwner as { failures: string[] }).failures.length > 0, "the agent cannot accept its own work");
  await run(client, txs.registerUsdc(c, agent.accountId));
  const accepted = await run(client, txs.accept(c, tankId));
  assert.deepEqual(accepted.failures, []);
  tank = (await barrel.tank(tankId))!;
  assert.equal(tank.accepted, true);
  assert.equal(Number(accepted.value), tank.unlock_at);
  assert.equal(BigInt(tank.balance), held - answer.units);

  // Once accepted the Pump stops serving the tank: the leftover is the agent's pay.
  const after = await ask({
    view: (contract, method, args) => chain.view(contract, method, args),
    contractId: deployment.contract,
    tank,
    grade,
    endpoint: series.endpoint,
    secretKey: key.secretKey,
    question: "one more",
    maxTokens: 50,
  }).catch((e: Error) => e);
  assert.ok(after instanceof Error && /accepted/.test(after.message), String(after));
});
