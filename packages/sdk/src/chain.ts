// Thin NEAR client: views, calls, contract deploys and account creation.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, type KeyPairString } from "near-api-js";

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  rpcUrl: string;
  /** Faucet that creates funded accounts. Testnet only. */
  helperUrl?: string;
  explorerTx: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    rpcUrl: process.env.BARREL_RPC_URL ?? "https://test.rpc.fastnear.com",
    helperUrl: "https://helper.testnet.near.org/account",
    explorerTx: "https://testnet.nearblocks.io/txns/",
  },
  mainnet: {
    name: "mainnet",
    rpcUrl: process.env.BARREL_RPC_URL ?? "https://free.rpc.fastnear.com",
    explorerTx: "https://nearblocks.io/txns/",
  },
};

export interface Wallet {
  accountId: string;
  publicKey: string;
  /** `ed25519:...` secret key. Never logged. */
  privateKey: string;
}

export interface CallOutcome<T = unknown> {
  value: T;
  txHash: string;
  logs: string[];
  /**
   * Panic messages from receipts that failed inside a transaction that still
   * succeeded overall (for example a buy the contract refused: the token
   * contract returns the USDC and the transaction reports success).
   */
  failures: string[];
  /** Gas burnt across the whole transaction, in gas units. */
  gasBurnt: bigint;
}

export interface BarrelEvent {
  standard: string;
  event: string;
  data: any;
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Local, git-ignored state: wallets and tank keys. */
export const STATE_DIR = process.env.BARREL_HOME ?? join(REPO_ROOT, ".barrel");

const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const RECORD_DEPOSIT = 10n ** 22n; // 0.01 NEAR

export function nearToYocto(near: string): bigint {
  const [whole, frac = ""] = near.split(".") as [string, string?];
  return BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, "0").slice(0, 24) || "0");
}

export class Chain {
  readonly provider: JsonRpcProvider;
  private readonly accounts = new Map<string, Account>();

  constructor(readonly net: NetworkConfig) {
    this.provider = new JsonRpcProvider({ url: net.rpcUrl });
  }

  account(wallet: Wallet): Account {
    let account = this.accounts.get(wallet.accountId);
    if (!account) {
      account = new Account(wallet.accountId, this.provider, wallet.privateKey as KeyPairString);
      this.accounts.set(wallet.accountId, account);
    }
    return account;
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    // "optimistic" reads the latest executed block, so a view right after a
    // call sees that call's effects.
    return withNetworkRetry(
      async () =>
        (await this.provider.callFunction({
          contractId,
          method,
          args,
          blockQuery: { finality: "optimistic" },
        })) as T,
    );
  }

  /**
   * Signs a transaction once and submits it. A dropped connection resubmits
   * the same signed bytes, so a retry can never execute the action twice.
   * Throws with the contract's own panic message when execution fails.
   */
  private async send(wallet: Wallet, receiverId: string, list: unknown[], label: string): Promise<any> {
    let lastError: unknown;
    for (let nonceAttempt = 0; nonceAttempt < 3; nonceAttempt++) {
      const signed = await withNetworkRetry(() =>
        this.account(wallet).createSignedTransaction({ receiverId, actions: list as any }),
      );
      let raw: any;
      try {
        raw = await withNetworkRetry(() => this.provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC"));
      } catch (e) {
        lastError = e;
        if (/nonce/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e))) {
          this.accounts.delete(wallet.accountId);
          continue;
        }
        throw new Error(`${label} failed: ${panicMessage(e)}`);
      }
      const failure = raw?.status?.Failure;
      if (failure) throw new Error(`${label} failed: ${panicMessage(failure)}`);
      return raw;
    }
    throw new Error(`${label} failed: ${panicMessage(lastError)}`);
  }

  /** Signs and sends one function call. */
  async call<T = unknown>(
    wallet: Wallet,
    contractId: string,
    methodName: string,
    args: Record<string, unknown> = {},
    opts: { gasTgas?: number; deposit?: bigint } = {},
  ): Promise<CallOutcome<T>> {
    const raw = await this.send(
      wallet,
      contractId,
      [actions.functionCall(methodName, args, BigInt(opts.gasTgas ?? 30) * TGAS, opts.deposit ?? 0n)],
      methodName,
    );
    const outcomes: any[] = raw.receipts_outcome ?? [];
    const logs: string[] = outcomes.flatMap((r: any) => r.outcome?.logs ?? []);
    let value: unknown = undefined;
    const encoded = raw.status?.SuccessValue;
    if (typeof encoded === "string" && encoded.length > 0) {
      const text = Buffer.from(encoded, "base64").toString("utf8");
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    // A cross-contract call can fail in a later receipt while the transaction
    // itself reports success (for example a buy the contract refused).
    const failures: string[] = outcomes
      .map((r: any) => r.outcome?.status?.Failure)
      .filter(Boolean)
      .map((f: any) => panicMessage(f));
    const gasBurnt = outcomes.reduce(
      (sum: bigint, r: any) => sum + BigInt(r.outcome?.gas_burnt ?? 0),
      BigInt(raw.transaction_outcome?.outcome?.gas_burnt ?? 0),
    );
    return { value: value as T, txHash: raw.transaction?.hash ?? "", logs, failures, gasBurnt };
  }

  /** A function call whose arguments are raw bytes (a contract upgrade sends its code this way). */
  async callRaw(
    wallet: Wallet,
    contractId: string,
    methodName: string,
    args: Uint8Array,
    opts: { gasTgas?: number; deposit?: bigint } = {},
  ): Promise<{ txHash: string; logs: string[] }> {
    const raw = await this.send(
      wallet,
      contractId,
      [actions.functionCall(methodName, args, BigInt(opts.gasTgas ?? 30) * TGAS, opts.deposit ?? 0n)],
      methodName,
    );
    const logs: string[] = (raw.receipts_outcome ?? []).flatMap((r: any) => r.outcome?.logs ?? []);
    return { txHash: raw.transaction?.hash ?? "", logs };
  }

  async nearBalance(accountId: string): Promise<bigint> {
    const state: any = await withNetworkRetry(() => new Account(accountId, this.provider).getState());
    return BigInt(state.balance?.total ?? state.amount ?? 0);
  }

  async deploy(wallet: Wallet, wasm: Uint8Array): Promise<string> {
    const raw = await this.send(wallet, wallet.accountId, [actions.deployContract(wasm)], "deploy");
    return raw.transaction?.hash ?? "";
  }

  async transferNear(from: Wallet, to: string, near: string): Promise<string> {
    const raw = await this.send(from, to, [actions.transfer(nearToYocto(near))], "transfer");
    return raw.transaction?.hash ?? "";
  }

  /** Creates `<prefix>-<random>.testnet` with faucet funds. No human step. */
  async createFaucetAccount(prefix = "barrel"): Promise<Wallet> {
    if (!this.net.helperUrl) throw new Error(`${this.net.name} has no faucet`);
    const accountId = `${prefix}-${randomBytes(4).toString("hex")}.${this.net.name}`;
    const keyPair = KeyPair.fromRandom("ed25519");
    const wallet: Wallet = {
      accountId,
      publicKey: keyPair.getPublicKey().toString(),
      privateKey: keyPair.toString(),
    };
    const res = await fetch(this.net.helperUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: wallet.publicKey }),
    });
    if (!res.ok) throw new Error(`faucet: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    saveWallet(this.net.name, wallet);
    await this.waitForAccount(accountId);
    return wallet;
  }

  async createSubAccount(parent: Wallet, prefix: string, near: string): Promise<Wallet> {
    const keyPair = KeyPair.fromRandom("ed25519");
    const wallet: Wallet = {
      accountId: `${prefix}.${parent.accountId}`,
      publicKey: keyPair.getPublicKey().toString(),
      privateKey: keyPair.toString(),
    };
    saveWallet(this.net.name, wallet);
    await this.send(
      parent,
      wallet.accountId,
      [
        actions.createAccount(),
        actions.transfer(nearToYocto(near)),
        actions.addFullAccessKey(PublicKey.fromString(wallet.publicKey)),
      ],
      `create ${wallet.accountId}`,
    );
    return wallet;
  }

  /**
   * Creates a top-level name such as `promptbarrel.near` (or `x.testnet`)
   * through the network's registrar account, funded by `funder`.
   */
  async createTopLevelAccount(funder: Wallet, accountId: string, near: string): Promise<Wallet> {
    const registrar = this.net.name === "mainnet" ? "near" : "testnet";
    if (!accountId.endsWith(`.${registrar}`) || accountId.slice(0, -registrar.length - 1).includes(".")) {
      throw new Error(`${accountId} is not a top-level .${registrar} name`);
    }
    const keyPair = KeyPair.fromRandom("ed25519");
    const wallet: Wallet = {
      accountId,
      publicKey: keyPair.getPublicKey().toString(),
      privateKey: keyPair.toString(),
    };
    saveWallet(this.net.name, wallet);
    const out = await this.call<boolean>(
      funder,
      registrar,
      "create_account",
      { new_account_id: accountId, new_public_key: wallet.publicKey },
      { gasTgas: 100, deposit: nearToYocto(near) },
    );
    if (out.failures.length) throw new Error(`create ${accountId} failed: ${out.failures.join("; ")}`);
    await this.waitForAccount(accountId);
    return wallet;
  }

  private async waitForAccount(accountId: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        await new Account(accountId, this.provider).getState();
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error(`account ${accountId} did not appear`);
  }
}

/** Retries a request that failed in transit. Contract and protocol errors pass through. */
async function withNetworkRetry<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (e) {
      last = e;
      const text = e instanceof Error ? `${e.name} ${e.message} ${(e as any).cause?.code ?? ""}` : String(e);
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR|timeout|\b429\b|\b50[234]\b|Too Many Requests/i.test(text)) throw e;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pulls the contract's own panic text out of whatever near-api-js threw. */
export function panicMessage(error: unknown): string {
  const text = typeof error === "string" ? error : error instanceof Error ? `${error.message} ${safeJson(error)}` : safeJson(error);
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text);
  if (panic) return panic[1]!.trim();
  const exec = /ExecutionError":\s*"([^"]+)"/.exec(text);
  if (exec) return exec[1]!;
  if (error instanceof Error && error.message) return error.message;
  return text.slice(0, 400);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

export function parseEvents(logs: string[]): BarrelEvent[] {
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)) as BarrelEvent);
}

// --- local wallet files ------------------------------------------------------

export function walletDir(network: NetworkName): string {
  return join(STATE_DIR, network);
}

export function saveWallet(network: NetworkName, wallet: Wallet): void {
  const dir = walletDir(network);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${wallet.accountId}.json`);
  writeFileSync(file, JSON.stringify(wallet, null, 2));
  chmodSync(file, 0o600);
}

export function loadWallet(network: NetworkName, accountId: string): Wallet {
  const file = join(walletDir(network), `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`no local key for ${accountId} (${file})`);
  return JSON.parse(readFileSync(file, "utf8")) as Wallet;
}

export function listWallets(network: NetworkName): string[] {
  const dir = walletDir(network);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}
