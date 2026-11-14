# Barrel

**AI credits with proof of which model ran, or the money back.**

You prepay for inference from a named model. The money sits in a NEAR contract. The operator is paid per answer, and only when the model's own TEE has signed that answer under a key registered after an Intel TDX attestation check. Whatever you do not use is refunded when the series expires.

Built for the NEAR hackathon (tracks: `agents`, `security`). Live on NEAR mainnet with Circle's USDC at [promptbarrel.com](https://promptbarrel.com). Inference comes from [NEAR AI Cloud](https://cloud.near.ai). The full documentation is the site's `/docs` page (`apps/web/docs/`).

> **Mainnet runs the current code** at `barrel-v2.promptbarrel.near`: five models, on-chain attestation, private prompts, key-owned tanks with HTTP 402 funding, claims, the price index and timelocked changes. Firm series are built and tested on testnet; the mainnet series start without a bond.

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

Around that loop:

- **Every NEAR-attested model.** Each model NEAR AI Cloud serves from its own attested TEEs is a grade with its own series and price; a model is only listed if its attestation passes the day it is added. Five today, from `z-ai/glm-5.3-flash` at 0.60 USDC per Barrel.
- **Anyone registers keys, on chain.** An attestor contract checks the model's Intel TDX quote with Intel DCAP, the nonce it issued, and the compose hash against a reviewed list, and only then registers the signing key.
- **Private prompts.** The client encrypts each message to the model's registered key; the Pump relays ciphertext, and the model signs the ciphertext, so payment works unchanged.
- **Agents with only a key.** A purchase can land in a tank owned by an Ed25519 key. A Pump answers such a key with `402 Payment Required` and an x402 body saying how to fund it, on NEAR or from another chain.
- **No free answers either.** An answer nobody acknowledges is claimed by the Pump with the payer's own signed ceiling; an ack inside the claim window replaces the claim with the true units.
- **Firm series.** A bonded operator must answer requests sent through the chain, and canaries, before a deadline, or pay from the bond; at the miss limit the series defaults and refunds open at once.
- **A price index and resale.** Every proven delivery feeds a 24-hour price per model. Barrels are NEP-245 tokens and trade inside NEAR Intents with signed offers.
- **Changes wait in public.** Owner, attestor and code changes are announced and apply only after a timelock.

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
| An operator that stops serving | Credit stuck | On a firm series: bond pays out, refunds open |

## Use it

The tools use mainnet with real USDC, under low caps, unless `BARREL_NETWORK=testnet`. Every write is a transaction that you sign with your own NEAR wallet or that your agent signs with its tank key; nothing is recorded or replayed.

### In the browser

```bash
pnpm install
pnpm web         # landing page at http://127.0.0.1:8080, the app at /app/, the docs at /docs/
pnpm pump        # the operator's Pump for all its series (needs the operator key and NEARAI_API_KEY)
```

In `/app/`:

1. **Connect** a NEAR mainnet wallet: MyNearWallet, HOT or Intear.
2. **Buy.** Pick a model's series and pay USDC on NEAR for its Barrels, or pay USDC on another chain through NEAR Intents (below). The USDC goes into the contract's escrow.
3. **Fill a tank.** Your browser makes a fresh Ed25519 spend key and keeps it in local storage. Your wallet signs `fill` with the key's public half and a 0.01 NEAR storage deposit.
4. **Ask.** The browser signs the request with the tank key and sends it to the series' Pump; tick **Private** to encrypt it to the model. When the answer comes back, it checks the model's signature in the browser and with the contract's `verify_receipt` view. Only then does it sign the ack. The Pump settles on-chain, and the app links the settlement transaction. If a check fails, nothing is acked and nothing is paid.
5. **Give the tank to an agent.** The app shows the MCP command with the network, tank id and key filled in, and offers the key as a file.
6. **Take the rest back.** Unlock a tank, then withdraw after the unlock delay. After a series closes, refund unused Barrels for their USDC.

`/app/` also shows the escrow split per series, every settled answer, the registered model keys and their time to live, a receipt verifier and the contract config. The landing page `/` reads the contract live and walks through how a payment is proven. `/docs/` documents the whole product and re-reads its numbers from the contract. All pages read the chain from your browser through a public RPC; there is no Barrel backend between you and the contract.

**Who can ask.** A browser can reach a Pump only over HTTPS, or on its own machine. The mainnet Pump runs at `https://promptbarrel.com/pump` (served by Caddy in front of `PUMP_HOST`/`PUMP_PORT`, with `PUMP_PUBLIC_URL` set to that address), and every series points there through the contract's `set_series_endpoint`, signed by the operator (`Barrel.setSeriesEndpoint` in `packages/sdk`). Payment rules do not change with the address. The app marks a series whose Pump it cannot reach before you buy, and `/docs/` shows where each series points right now.

### From the command line

The CLI, the Pump and the MCP server use mainnet unless `BARREL_NETWORK=testnet`.

```bash
# Check a receipt against the deployment. No keys.
pnpm barrel verify fixtures/receipt.json                               # → VALID
pnpm barrel verify fixtures/gateway-kind.json                          # → REJECTED: not a model signature

# Attest a model yourself: Intel DCAP, report-data binding, RTMR3 replay.
pnpm barrel attest z-ai/glm-5.3-flash                                  # → ATTESTED
pnpm barrel audit                                                      # registered keys vs. a fresh attestation
pnpm barrel register glm-5.3-flash                                     # register its key on chain, as anyone

# State of the deployment.
pnpm barrel status
pnpm barrel models                                                     # every model, its series and price
pnpm barrel index glm-5.3-flash                                        # 24-hour price from proven deliveries

# Tests.
pnpm test        # verifier (9) + Rust rules (6) + on-chain attestation checks against real reports (2), offline
pnpm e2e         # 36 tests on NEAR testnet: full loop, every attack, refunds, the app's own transactions, 402 funding, private asks, claims, firm series, index, governance
```

### Give an agent a tank (MCP)

With a tank filled in the app, use the command it shows:

```bash
claude mcp add barrel -e BARREL_NETWORK=mainnet -e BARREL_CONTRACT=barrel-v2.promptbarrel.near \
  -e BARREL_TANK=<tank id> -e BARREL_TANK_KEY=<spend key> -- node "$PWD/apps/mcp/bin/barrel-mcp.mjs"
```

Or do it from the command line with your own NEAR account, whose key file is in `.barrel/mainnet/<account>.json`:

```bash
pnpm barrel buy 1 1.0 --account you.near            # 1 USDC of Barrels of series 1
pnpm barrel fill 1 500000 --account you.near        # tank with a fresh spend key → .barrel/tanks/…
claude mcp add barrel -e BARREL_TANK=<tank id> -- node "$PWD/apps/mcp/bin/barrel-mcp.mjs"
```

Tools: `barrel_ask`, `barrel_balance`, `barrel_models`, `barrel_verify`. On a job tank `barrel_balance` also tells the agent what the leftover will pay it. The agent holds only the tank's spend key. It cannot transfer, withdraw or refund. `barrel_ask` needs the series' Pump to be running and reachable. `BARREL_PRIVATE=1` encrypts every question to the model.

An agent can also start with nothing but a key: leave out `BARREL_TANK`, and until someone funds the key, `barrel_balance` tells the agent how anyone can (below).

```bash
pnpm barrel key                                     # a new tank key → .barrel/keys/<public key>.json
pnpm barrel fund 1 1.0 --key <public key> --account you.near    # buy straight into the tank that key owns
pnpm barrel ask <public key> "hello" --private      # the key finds its tank; encrypted to the model
pnpm barrel assign <tank> you.near                  # hand the key's tank to a NEAR account
```

### Buy from another chain

The app and the CLI take USDC from the chains NEAR Intents' 1Click API offers it on (Base, Arbitrum, Ethereum, Solana, …). The quote names the Barrel contract as recipient with the buy message `{"series_id": N, "to": "<your NEAR account>"}`, or `{"series_id": N, "tank_key": "<key>"}` to fund a key's tank, so 1Click delivers the swapped USDC with `ft_transfer_call` and the contract mints the Barrels straight to your account or the tank. You send one deposit on the origin chain; you never hold USDC on NEAR. Unfinished swaps are refunded to your address on the origin chain.

```bash
pnpm barrel buy-from base 1 1.0 --refund-to 0xYourBaseAddress --account <your.near>
pnpm barrel fund-from base 1 1.0 --refund-to 0xYourBaseAddress                   # into a new key's tank
```

Quotes are kept under the series' room and the global escrow cap, because a delivery the contract refuses would go back to NEAR Intents rather than to the buyer. Without `ONECLICK_JWT` 1Click adds a 0.25% fee.

### HTTP 402 and x402

An agent sends its request with only `x-barrel-key: <public key>`. If the key owns no funded tank, the Pump answers `402 Payment Required` with an x402 body (`x402Version: 1`, `accepts: [{scheme: "exact", network: "near-mainnet", asset: <USDC>, payTo: <Barrel contract>, maxAmountRequired, extra: {method: "ft_transfer_call", msg: "{\"series_id\":1,\"tank_key\":\"…\"}"}}]`). Paying it puts the purchase into a tank only that key can spend, in the contract's escrow, never with the operator. On mainnet, `x-barrel-pay-from: <chain>` and `x-barrel-refund-to: <address>` add a 1Click deposit address on that chain for the same purchase. `GET /v1/tank?key=` then returns the tank, and `TankClient` with no tank id does all of this and throws `PaymentRequired` with the offers.

x402 funds a tank rather than paying per request on purpose: an x402 payment settles before the answer exists, and Barrel pays only after the model's signature over the finished answer checks out. There is no `X-PAYMENT` header or facilitator; payment is a NEAR transaction to the contract. Other 402 answers carry a plain JSON error (tank closed, accepted, unlocking, claim open, series expired).

### Resale *(mainnet, NEAR Intents)*

Barrels are NEP-245 tokens, so they trade inside `intents.near` with no exchange contract of Barrel's own. The seller deposits Barrels and signs one NEP-413 `token_diff` intent; the buyer signs the mirror image; anyone submits both, and both sides move in one transaction or nothing moves. `take` runs the free `simulate_intents` view first and leaves the Verifier's fee (1 pip today) out of what it asks for. The Pump's `/v1/offers` only relays signed offers; the buyer checks the signed terms. NEAR Intents does not run on testnet, so this is tested against mainnet's `simulate_intents` (signatures, nonces, fees) but no real trade has been made yet.

```bash
pnpm barrel sell 1 500000 0.25 --account seller.near   # 0.5 Barrels for 0.25 USDC
pnpm barrel offers 1
pnpm barrel take <offer id> --account buyer.near
```

### Firm series

```bash
pnpm barrel force <tank> "question"     # tank owner: a request the operator must answer on chain before its deadline
pnpm barrel canary 2                    # anyone: ask the operator to prove it is serving
pnpm barrel slash <id>                  # after a missed deadline: the bond pays the tank owner, and it counts as a miss
```

The Pump answers forced requests and canaries on its own. The contract hashes the posted answer, checks the model's signature and reads the token counts out of the signed bytes. Tested on testnet; the mainnet series were opened without a bond (`pnpm deploy:mainnet --firm-bond <USDC>` makes them firm).

## Mainnet deployment

| | |
| --- | --- |
| Contract | [`barrel-v2.promptbarrel.near`](https://nearblocks.io/address/barrel-v2.promptbarrel.near), owner `promptbarrel.near`, operator `op-v2.promptbarrel.near` |
| Attestor | [`attestor-v2.promptbarrel.near`](https://nearblocks.io/address/attestor-v2.promptbarrel.near): the only way a model key gets registered; the owner cannot |
| Stablecoin | Circle's USDC on NEAR (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) |
| Series 1–5 | GLM 5.3 Flash 0.60, Qwen3 VL 30B 0.66, Qwen3.6 35B 1.32, DeepSeek V4.1 Flash 1.44, Qwen3.8 27B 1.62 USDC per Barrel; open until 2026-12-31 00:00 UTC; Pump at `https://promptbarrel.com/pump` |
| Model keys | Registered on chain through the attestor, time to live 24 hours; a running Pump re-registers a rotated key, and anyone can with `barrel register` |
| Caps | 50 USDC of escrow in total, 100 Barrels per series, while this is new |
| Delays | unlock 10 minutes, claim window 5 minutes, settle grace 1 hour, changes 24 hours |
| Evidence | `deployments/evidence/`, one file per model named in `deployments/mainnet.json` (report, nonce, Intel collateral) |

Recorded in `deployments/mainnet.json`, including the WASM SHA-256. The operator moves its Pump with `set_series_endpoint`; payment rules do not change with the address. The first mainnet contract (`barrel-v1`, one model, keys registered by the owner) held no user money and was removed to pay for this one; its record is `deployments/mainnet-v1.json`.

## Testnet, for development

| | |
| --- | --- |
| Contract | [`barrel-v3.barrel-131c6dfe.testnet`](https://testnet.nearblocks.io/address/barrel-v3.barrel-131c6dfe.testnet), the current code |
| Attestor | `attestor-v3.barrel-131c6dfe.testnet`; every model key was registered through it |
| Test stablecoin | `usdc-v3.barrel-131c6dfe.testnet` (6 decimals, public `mint`, no value) |
| Series 1–5 | One firm series per model (GLM 5.3 Flash, Qwen3 VL 30B, Qwen3.6 35B, DeepSeek V4.1 Flash, Qwen3.8 27B), 0.60 to 1.62 tUSDC per Barrel, open until 2026-12-31, Pump endpoint `http://127.0.0.1:8787` |
| Timelock | 5 minutes (24 hours on mainnet) |

Recorded in `deployments/testnet.json`. It runs the end-to-end tests. Set `BARREL_NETWORK=testnet` and the Pump, CLI, MCP server and web pages read it instead of mainnet; `pnpm barrel account` makes a faucet-funded account there.

## How it is built

```
contracts/barrel        Rust, near-sdk 5.30. Registry, series + escrow, NEP-245 token, tanks, settle, claims,
                        firm series, price index, timelocked governance.
contracts/barrel-core   Pure rules shared by the contract and its unit tests (signed texts, units, rounding).
contracts/attestor      On-chain attestation: Intel DCAP, nonce binding, RTMR3 replay, reviewed compose hashes.
contracts/attest-core   The attestor's checks as pure Rust, tested against real NEAR AI Cloud reports.
contracts/test-usdc     NEP-141 test stablecoin with a public faucet (testnet only).
packages/verifier       Receipt checks and attestation checks (TDX quote, DCAP, RTMR3 replay). Node and browser.
packages/sdk            Chain client, TankClient (no proof, no ack; private mode; 402 handling), model list,
                        registrar, deploy helper, 1Click, NEAR Intents resale, `barrel` CLI.
apps/pump               Operator gateway: serves funded tanks for all its series, relays exact bytes, settles acks,
                        answers 402 with x402 offers, files claims, answers forced requests and canaries.
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

An answer that is never acknowledged can be claimed by the operator with the payer's request signature (which commits to a ceiling) and the model's signature; the payer's ack replaces the claim inside the claim window, and after it anyone can finalize the claim for the ceiling.

### What the tests prove

`tests/e2e/src/loop.test.ts` (15 tests) deploys fresh contracts on testnet and asserts exact balances through: buying with cap overflow refunded, filling, settling, a payout that bounces and is recovered with `claim`, batch settlement, key revocation and expiry, the unlock delay, NEP-245 transfers and a bounced `mt_transfer_call`, pause, refunds after expiry (including a bounced refund), the global escrow cap, a **real NEAR AI receipt settled on-chain**, a gateway receipt refused, and a job tank: the agent spends, the client accepts, a payout to an unregistered agent bounces and is retried, and the agent is paid exactly the leftover's USDC. It ends by checking that the contract's USDC equals its accounting to the last base unit.

`tests/e2e/src/pump.test.ts` (4 tests) plays a dishonest upstream and a dishonest Pump: gateway-signed, unsigned and usage-less answers are not billed; an altered answer or an inflated unit count gets no ack and the operator earns nothing; a tank that withholds an ack is not served again.

`tests/e2e/src/app.test.ts` (2 tests) runs the web app's write path on the testnet deployment. A fresh account signs the exact transactions the app hands a wallet (`apps/web/src/txs.ts`): mint, buy, fill. The browser's ask code (`apps/web/src/tank.ts`) then gets one real answer through the running Pump, and a second one with Private ticked, encrypted to the model and opened in the client, and the test checks both on-chain settlements and unlocks the tank. The second test funds a job tank for another account, gets a real answer on it, accepts the work and checks that the Pump stops serving it. Both are skipped when the testnet Pump is not running (`BARREL_NETWORK=testnet pnpm pump`).

`tests/e2e/src/market.test.ts` (9 tests) plays each newer mechanism with exact balances against fresh contracts and a simulated model key: a purchase that lands in a tank only its key controls, whoever paid, and its handover only with the key's signature; the price index built from proven deliveries; a claim paid at the authorized maximum unless the ack arrives; a firm series answering what is sent through the chain; a canary on a request the contract wrote; a default that slashes the bond and lets holders leave at once; a guardian that can only pause, and changes and upgrades that wait out the timelock; and the books: escrow plus bonds plus debts is exactly what the contract holds.

`tests/e2e/src/reach.test.ts` (6 tests) runs the Pump against real models: several series served at once, the 402 offer paid and spent by a key with no account, a private ask relayed as ciphertext, a claim with a late ack, the Pump answering a forced request and a canary on its own, and the offers relay.

## What a receipt does not prove

- It proves a TEE holding the model's signing key signed these exact bytes. It does not identify the serving machine.
- With an attestor, the chain checked Intel's quote before the key counted, against compose hashes someone reviewed. The compose hash names NEAR AI Cloud's serving software, which is shared by several models; what binds the model is the signed text, whose model id the contract takes from the grade. Anyone can repeat the checks off chain with `barrel attest` and `barrel audit`.
- NVIDIA GPU evidence is not checked yet. TEE guarantees rest on Intel TDX and NVIDIA confidential-computing assumptions. Intel's collateral comes from Intel's own Provisioning Certification Service.
- Asked privately, the Pump relays ciphertext but still sees token counts, timing and which tank asked. Otherwise it sees prompts and answers in plaintext.
- Streamed answers are signed by the gateway, not the model, so the Pump refuses streaming.
- An operator can refuse to serve: the money is safe. On a plain series the refund waits for expiry; on a firm series every unanswered forced request is paid from the bond and a default opens refunds at once.
- Mainnet runs with low caps (50 USDC of escrow). Code, owner and attestor changes go through a public 24-hour timelock in the contract (`propose`, then `apply` or `upgrade`). The deploy key still has full access to the contract account, which can bypass that, until it is removed.

## Roadmap

1. **Proof** (live on mainnet): the loop above, one operator, one model, job tanks, refunds.
2. **Reach** (live on mainnet): pay from any chain via NEAR Intents 1Click; key-owned tanks funded through HTTP 402 x402 offers; resale inside `intents.near`; claims for unacknowledged answers.
3. **Trustless** (live on mainnet): on-chain attestation so anyone can register a key; prompts encrypted to the model; timelocked changes and upgrades.
4. **Market** (live on mainnet, firm series tested on testnet): every NEAR-attested model as its own series; firm series with operator bonds, forced requests and canaries; a settlement price index. A second inference supplier is not in scope: it would need another provider's API.

Details in the docs, under [Roadmap](apps/web/docs/index.html#roadmap) (served at `/docs/#roadmap`).

## Running your own

```bash
cp .env.example .env                     # add NEARAI_API_KEY (needed for live inference)
pnpm build:contract                      # optional: rebuild res/*.wasm (stable Rust + wasm32-unknown-unknown)
pnpm deploy:mainnet --root <name>.near --funder <account> --endpoint https://<pump>   # prints the plan and its NEAR cost; add --yes to deploy
pnpm pump                                # the operator's Pump on 127.0.0.1:8787 (PUMP_HOST, PUMP_PORT, PUMP_PUBLIC_URL to expose it)
pnpm web --build                         # static pages in apps/web for mainnet: host the folder anywhere
pnpm deploy:testnet --tag v4             # a development deployment: contract, attestor, test stablecoin, one firm series per
                                         # attested model with its key registered on chain, sample paid answers
pnpm spike:s1 [model-id]                 # capture a fresh receipt and gateway sample for any model
```

## Prior work and libraries

`near-sdk` and `near-contract-standards` (contracts), `near-api-js` (chain client), NEAR Wallet Selector (browser wallets), esbuild (bundles the app's wallet code), `@noble/curves` and `@noble/hashes` (Ed25519, SHA-2), `@phala/dcap-qvl` (Intel DCAP quote verification, used as a library; collateral comes from Intel's PCS) and `dcap-qvl` (the same checks in the attestor contract), `tsx`. The web pages use the Geist, Geist Mono and Geist Pixel fonts (SIL Open Font License), self-hosted in `apps/web/assets/fonts/`. The NEAR, NEAR AI, Intel and NVIDIA logos in `apps/web/assets/img/logos.svg` are trademarks of their owners, shown only to name the technology Barrel runs on. The attestation and signature checks follow NEAR AI's reference verifier, [`nearai/nearai-cloud-verifier`](https://github.com/nearai/nearai-cloud-verifier); no code was copied from it. Everything else was written for this hackathon.

## License

MIT. See `LICENSE`.
