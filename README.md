# Barrel

**AI credits with proof of which model ran, or the money back.**

You prepay for inference from one named model. The money sits in a NEAR contract. The operator is paid per answer, and only when the model's own TEE has signed that answer under a key registered after an Intel TDX attestation check. Whatever you do not use is refunded when the series expires.

Built for the NEAR hackathon (tracks: `agents`, `security`). Live on NEAR mainnet with Circle's USDC at [promptbarrel.com](https://promptbarrel.com). Inference comes from [NEAR AI Cloud](https://cloud.near.ai). The full documentation is the site's `/docs` page (`apps/web/docs/`).

## The problem

Inference credits are an IOU. You pay up front and trust that the provider served the model it named, at the quality it named. An agent that needs inference has to be handed an API key or a wallet. Unused credit stays with the provider.

## What Barrel does

NEAR AI Cloud model TEEs sign every non-streamed answer with Ed25519 over `<model_id>:<sha256(request)>:<sha256(response)>`. Barrel makes that signature the payment rule:

```
buy    USDC → Barrels (1 Barrel = 1,000,000 units of one model)   USDC held in escrow
fill   Barrels → a tank under a spend key                          the key can pay for answers, nothing else
ask    request → operator's Pump → NEAR AI model TEE               answer + model signature
settle agent checks the proof, signs an ack                        contract verifies both signatures, pays the operator
refund series expires                                              unused Barrels burn for their USDC
```

No proof, no ack. No ack, no payment.

**Job tanks: fund an agent, pay it what it does not spend.** A client fills a tank with another account as its agent and hands the agent the spend key. The agent pays for its own proven inference out of the tank while it works. When the client accepts the work, whatever is left is paid to the agent in USDC after the unlock delay. When the client rejects it, the rest comes back to the client. An agent that thinks efficiently keeps the difference, and every answer it paid for is on chain with the model's signature, so the client sees what the job cost before deciding.

```
fill(series, units, key, agent)   client funds the job       agent gets the spend key
ask … settle                      agent works                each answer paid on proof
accept(tank)                      client accepts             the Pump stops serving the tank
withdraw(tank)                    after the unlock delay      the leftover's USDC goes to the agent
request_unlock(tank)              or: client rejects          the leftover comes back to the client
```

| | Prepaid credits | Barrel |
| --- | --- | --- |
| When the operator is paid | Up front | Per answer, after the proof checks |
| Which model ran | Trust the provider | Signed by a TEE key registered for that model |
| A cheaper model swapped in | Invisible | Signature fails; nothing is paid |
| Unused balance | Stays with the provider | Refunded from escrow |
| Budget for an agent | Share an API key | A spend-only key, capped by the tank |
| Paying an agent for a job | A separate payment, unrelated to its cost | The tank's leftover, so it earns what it does not spend |

## Use it

Everything below runs against the mainnet deployment with real USDC, under low caps. Every write is a transaction that you sign with your own NEAR wallet or that your agent signs with its tank key; nothing is recorded or replayed.

### In the browser

```bash
pnpm install
pnpm web         # landing page at http://127.0.0.1:8080, the app at /app/, the docs at /docs/
pnpm pump        # the operator's Pump for series 1 (needs the operator key and NEARAI_API_KEY)
```

In `/app/`:

1. **Connect** a NEAR mainnet wallet: MyNearWallet, HOT or Intear.
2. **Buy.** Pay USDC on NEAR for Barrels of a series, or pay USDC on another chain through NEAR Intents (below). The USDC goes into the contract's escrow.
3. **Fill a tank.** Your browser makes a fresh Ed25519 spend key and keeps it in local storage. Your wallet signs `fill` with the key's public half and a 0.01 NEAR storage deposit.
4. **Ask.** The browser signs the request with the tank key and sends it to the series' Pump. When the answer comes back, it checks the model's signature in the browser and with the contract's `verify_receipt` view. Only then does it sign the ack. The Pump settles on-chain, and the app links the settlement transaction. If a check fails, nothing is acked and nothing is paid.
5. **Give the tank to an agent.** The app shows the MCP command with the network, tank id and key filled in, and offers the key as a file.
6. **Take the rest back.** Unlock a tank, then withdraw after the unlock delay. After a series closes, refund unused Barrels for their USDC.

`/app/` also shows the escrow split, every settled answer, the registered model key and its time to live, a receipt verifier and the contract config. The landing page `/` reads the contract live and walks through how a payment is proven. `/docs/` documents the whole product and re-reads its numbers from the contract. All pages read the chain from your browser through a public RPC; there is no Barrel backend between you and the contract.

**Who can ask.** A browser can reach a Pump only over HTTPS, or on its own machine. Series 1 was opened with the endpoint `http://127.0.0.1:8787`, which only the operator's own machine can reach. For anyone else to ask, the operator serves the Pump at a public HTTPS address (`PUMP_HOST`, `PUMP_PORT`, behind TLS) and moves the series there with the contract's `set_series_endpoint`, signed by the operator (`Barrel.setSeriesEndpoint` in `packages/sdk`). Payment rules do not change with the address. The app marks a series whose Pump it cannot reach before you buy, and `/docs/` shows where each series points right now.

### From the command line

The CLI, the Pump and the MCP server use mainnet unless `BARREL_NETWORK=testnet`.

```bash
# Check a receipt against the deployment. No keys.
pnpm barrel verify fixtures/receipt.json                               # → VALID
pnpm barrel verify fixtures/gateway-kind.json                          # → REJECTED: not a model signature

# Attest the model yourself: Intel DCAP, report-data binding, RTMR3 replay.
pnpm barrel attest z-ai/glm-5.3-flash                                  # → ATTESTED
pnpm barrel audit                                                      # registered keys vs. a fresh attestation

# State of the deployment.
pnpm barrel status

# Tests.
pnpm test        # verifier (9) + Rust rules (5), offline
pnpm e2e         # 21 tests on NEAR testnet: full loop, every attack, refunds, the app's own transactions (about 8 minutes)
```

### Give an agent a tank (MCP)

With a tank filled in the app, use the command it shows:

```bash
claude mcp add barrel -e BARREL_NETWORK=mainnet -e BARREL_CONTRACT=barrel-v1.promptbarrel.near \
  -e BARREL_TANK=<tank id> -e BARREL_TANK_KEY=<spend key> -- node "$PWD/apps/mcp/bin/barrel-mcp.mjs"
```

Or do it from the command line with your own NEAR account, whose key file is in `.barrel/mainnet/<account>.json`:

```bash
pnpm barrel buy 1 1.0 --account you.near            # 1 USDC of Barrels of series 1
pnpm barrel fill 1 500000 --account you.near        # tank with a fresh spend key → .barrel/tanks/…
claude mcp add barrel -e BARREL_TANK=<tank id> -- node "$PWD/apps/mcp/bin/barrel-mcp.mjs"
```

Tools: `barrel_ask`, `barrel_balance`, `barrel_verify`. On a job tank `barrel_balance` also tells the agent what the leftover will pay it. The agent holds only the tank's spend key. It cannot transfer, withdraw or refund. `barrel_ask` needs the series' Pump to be running and reachable.

### Buy from another chain

The app and the CLI take USDC from the chains NEAR Intents' 1Click API offers it on (Base, Arbitrum, Ethereum, Solana, …). The quote names the Barrel contract as recipient with the buy message `{"series_id": N, "to": "<your NEAR account>"}`, so 1Click delivers the swapped USDC with `ft_transfer_call` and the contract mints the Barrels straight to your account. You send one deposit on the origin chain; you never hold USDC on NEAR. Unfinished swaps are refunded to your address on the origin chain.

```bash
pnpm barrel buy-from base 1 1.0 --refund-to 0xYourBaseAddress --account <your.near>
```

Quotes are kept under the series' room and the global escrow cap, because a delivery the contract refuses would go back to NEAR Intents rather than to the buyer. Without `ONECLICK_JWT` 1Click adds a 0.25% fee.

### HTTP 402 and x402

Barrel v1 does not implement x402: there is no x402 payment-requirements response, no `X-PAYMENT` header and no facilitator. Inference is paid from a tank and settled on NEAR per answer against the model's signature. The Pump does answer `402 Payment Required` with a JSON error when a tank cannot pay (closed, accepted, unlocking, series expired, previous answer not acknowledged, not enough units). x402 is on the roadmap as a way to fund a tank for an agent with no NEAR account, not as a per-answer payment, because an x402 payment settles before the answer exists.

## Mainnet deployment

| | |
| --- | --- |
| Contract | [`barrel-v1.promptbarrel.near`](https://nearblocks.io/address/barrel-v1.promptbarrel.near), owner `promptbarrel.near`, operator `op-v1.promptbarrel.near` |
| Stablecoin | Circle's USDC on NEAR (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) |
| Grade | `glm-5.3-flash` → `z-ai/glm-5.3-flash`, input tokens weighted 16%, model key time to live 24 hours |
| Series 1 | 0.60 USDC per Barrel, open until 2026-12-31 00:00 UTC, Pump endpoint `http://127.0.0.1:8787` until the operator moves it |
| Caps | 50 USDC of escrow in total, 100 Barrels per series, while this is new |
| Delays | unlock 10 minutes, settle grace 1 hour |
| Evidence for the registered key | `deployments/evidence/0d62ea7e….json` (report, nonce, Intel collateral) |

Recorded in `deployments/mainnet.json`, including the WASM SHA-256. The operator moves its Pump with `set_series_endpoint`; payment rules do not change with the address.

## Testnet, for development

| | |
| --- | --- |
| Contract | [`barrel-v2.barrel-131c6dfe.testnet`](https://testnet.nearblocks.io/address/barrel-v2.barrel-131c6dfe.testnet) (v1 is recorded in `deployments/testnet-v1.json`) |
| Test stablecoin | `usdc-v1.barrel-131c6dfe.testnet` (6 decimals, public `mint`, no value) |
| Series 1 | 0.60 tUSDC per Barrel, open until 2026-12-31, Pump endpoint `http://127.0.0.1:8788` |
| Paid receipts | `deployments/receipts/` |

Recorded in `deployments/testnet.json`. It runs the end-to-end tests. Set `BARREL_NETWORK=testnet` and the Pump, CLI, MCP server and web pages read it instead of mainnet; `pnpm barrel account` makes a faucet-funded account there.

## How it is built

```
contracts/barrel        Rust, near-sdk 5.30. Registry, series + escrow, NEP-245 token, tanks, settle.
contracts/barrel-core   Pure rules shared by the contract and its unit tests (signed texts, units, rounding).
contracts/test-usdc     NEP-141 test stablecoin with a public faucet (testnet only).
packages/verifier       Receipt checks and attestation checks (TDX quote, DCAP, RTMR3 replay). Node and browser.
packages/sdk            Chain client, TankClient (no proof, no ack), registrar, deploy helper, 1Click, `barrel` CLI.
apps/pump               Operator gateway: serves funded tanks, relays exact bytes, settles acks.
apps/mcp                MCP server over stdio.
apps/web                Landing page (/), app (/app/) and docs (/docs/): wallet transactions, browser-held tank keys, ask with proof checks.
tests/e2e               Testnet end-to-end tests.
fixtures/               Real request/response bytes, signatures and attestations captured from NEAR AI Cloud.
res/                    Committed contract WASM (built by scripts/build-contract.sh).
```

### What the contract checks in `settle`

For each item, synchronously, before any money moves:

1. The sequence number is the tank's next one (no replay, no reordering).
2. The ack verifies under the tank's key, over `barrel:v1:ack:<contract>:<tank>:<seq>:<request_hash>:<response_hash>:<units>`.
3. The model key is registered for the series' grade and has not expired or been revoked.
4. The model signature verifies over `<model_id>:<request_hash>:<response_hash>`, with `model_id` taken from the grade, not from the caller.
5. The units fit in the tank.

Then it burns the units and releases `floor(cumulative_burned × price)` minus what was already released, so rounding never accumulates. Signatures use NEAR's native `ed25519_verify` host function: one item costs about 8.6 TGas including the payout, each further item in a batch about 1 TGas.

### What the tests prove

`tests/e2e/src/loop.test.ts` (15 tests) deploys fresh contracts on testnet and asserts exact balances through: buying with cap overflow refunded, filling, settling, a payout that bounces and is recovered with `claim`, batch settlement, key revocation and expiry, the unlock delay, NEP-245 transfers and a bounced `mt_transfer_call`, pause, refunds after expiry (including a bounced refund), the global escrow cap, a **real NEAR AI receipt settled on-chain**, a gateway receipt refused, and a job tank: the agent spends, the client accepts, a payout to an unregistered agent bounces and is retried, and the agent is paid exactly the leftover's USDC. It ends by checking that the contract's USDC equals its accounting to the last base unit.

`tests/e2e/src/pump.test.ts` (4 tests) plays a dishonest upstream and a dishonest Pump: gateway-signed, unsigned and usage-less answers are not billed; an altered answer or an inflated unit count gets no ack and the operator earns nothing; a tank that withholds an ack is not served again.

`tests/e2e/src/app.test.ts` (2 tests) runs the web app's write path on the testnet deployment. A fresh faucet account signs the exact transactions the app hands a wallet (`apps/web/src/txs.ts`): mint, buy, fill. The browser's ask code (`apps/web/src/tank.ts`) then gets one real answer through the running Pump, and the test checks the on-chain settlement and unlocks the tank. The second funds a job tank for another account, gets a real answer on it, accepts the work and checks that the Pump stops serving it. Both are skipped when the testnet series' Pump is not running (`BARREL_NETWORK=testnet PUMP_PORT=8788 pnpm pump`).

## What a receipt does not prove

- It proves a TEE holding the model's signing key signed these exact bytes. It does not identify the serving machine.
- In this version, keys are registered by Barrel's registrar after off-chain attestation checks. The evidence is published and anyone can repeat the checks with `barrel attest` and `barrel audit`. Moving the check on-chain is stage 3.
- NVIDIA GPU evidence is not checked yet. TEE guarantees rest on Intel TDX and NVIDIA confidential-computing assumptions.
- The operator's Pump sees prompts and answers in plaintext.
- Streamed answers are signed by the gateway, not the model, so the Pump refuses streaming.
- An operator can refuse to serve: the money is safe, but the refund waits for expiry. An operator can lose at most one unpaid answer per tank.
- Mainnet runs with low caps (50 USDC of escrow). The contract is upgradeable by its owner key.

## Roadmap

1. **Proof** (live on mainnet): the loop above, one operator, one model, job tanks, refunds.
2. **Reach** (started): pay from any chain via NEAR Intents 1Click is done. Not yet: resale of Barrels inside `intents.near` (they are NEP-245 tokens), and x402 top-ups for agents with no NEAR account.
3. **Trustless**: on-chain attestation so anyone can register a key; prompts encrypted to the model.
4. **Market**: a second supplier, firm series with operator bonds, a settlement price index.

Details in the docs, under [Roadmap](apps/web/docs/index.html#roadmap) (served at `/docs/#roadmap`).

## Running your own

```bash
cp .env.example .env                     # add NEARAI_API_KEY (needed for live inference)
pnpm build:contract                      # optional: rebuild res/*.wasm (stable Rust + wasm32-unknown-unknown)
pnpm deploy:mainnet --root <name>.near --funder <account> --endpoint https://<pump>   # prints the plan; add --yes to deploy
pnpm pump                                # the operator's Pump on 127.0.0.1:8787 (PUMP_HOST, PUMP_PORT to expose it)
pnpm web --build                         # static pages in apps/web for mainnet: host the folder anywhere
pnpm deploy:testnet --tag v3             # a development deployment: contract, test stablecoin, grade, attested key, series, two paid answers
pnpm spike:s1 [model-id]                 # capture a fresh receipt and gateway sample for any model
```

## Prior work and libraries

`near-sdk` and `near-contract-standards` (contracts), `near-api-js` (chain client), NEAR Wallet Selector (browser wallets), esbuild (bundles the app's wallet code), `@noble/curves` and `@noble/hashes` (Ed25519, SHA-2), `@phala/dcap-qvl` (Intel DCAP quote verification), `tsx`. The web pages use the Geist, Geist Mono and Geist Pixel fonts (SIL Open Font License), self-hosted in `apps/web/assets/fonts/`. The NEAR, NEAR AI, Intel and NVIDIA logos in `apps/web/assets/img/logos.svg` are trademarks of their owners, shown only to name the technology Barrel runs on. The attestation and signature checks follow NEAR AI's reference verifier, [`nearai/nearai-cloud-verifier`](https://github.com/nearai/nearai-cloud-verifier); no code was copied from it. Everything else was written for this hackathon.

## License

MIT. See `LICENSE`.
