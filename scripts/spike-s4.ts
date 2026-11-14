// Spike S4: does a full TEE attestation check fit in one NEAR transaction?
//
// Deploys the attestor to a faucet-funded testnet account and runs its
// `check` method, as a transaction, on a real NEAR AI Cloud report saved in
// fixtures/attestations. Prints the gas the check burnt.
//
//   pnpm spike:s4

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chain, NETWORKS, REPO_ROOT } from "@barrel/sdk";
import { attestorArgs } from "../packages/sdk/src/registrar.ts";

const chain = new Chain(NETWORKS.testnet);
const dir = join(REPO_ROOT, "fixtures", "attestations");
const name = process.argv[2] ?? "z-ai-glm-5.3-flash.2026-11-13";
const report = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
const nonce = readFileSync(join(dir, `${name}.nonce`), "utf8").trim();
const collateral = JSON.parse(readFileSync(join(dir, `${name}.collateral.json`), "utf8")).collateral;

const account = await chain.createFaucetAccount("barrel-s4");
await chain.deploy(account, readFileSync(join(REPO_ROOT, "res", "attestor.wasm")));
await chain.call(account, account.accountId, "new", {
  config: {
    owner: account.accountId,
    barrel: account.accountId,
    timelock_sec: 0,
    nonce_ttl_sec: 3600,
    accepted_tcb: ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"],
  },
});
const args = attestorArgs("spike", report.model_attestations[0], nonce, collateral);
const bytes = Buffer.byteLength(JSON.stringify(args));
const out = await chain.call<any>(account, account.accountId, "check", args, { gasTgas: 300 });
console.log(`attestor ${account.accountId}`);
console.log(`arguments ${bytes} bytes`);
console.log(`result ${JSON.stringify(out.value)}`);
console.log(`gas burnt ${(Number(out.gasBurnt) / 1e12).toFixed(1)} TGas of 300 (tx ${out.txHash})`);
