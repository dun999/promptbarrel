// The app's write side, bundled for the browser by build.ts into
// assets/js/near.bundle.js:
//   - a NEAR wallet connection (Wallet Selector: MyNearWallet, HOT, Intear).
//     The picker is the app's own dialog (app.js); this file lists the
//     wallets and signs in to the one picked.
//   - tank spend keys, made in this browser and kept in its storage
//   - ask(): one paid-on-proof answer (tank.ts)

import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { actionCreators } from "@near-js/transactions";
import { newKeyPair, publicKeyOf } from "@barrel/verifier/core";
import type { TxSpec } from "./txs.ts";

export * as txs from "./txs.ts";
export { ask, reachable, ProofError } from "./tank.ts";

const TGAS = 10n ** 12n;

let selector: WalletSelector | undefined;

const activeAccount = () => selector?.store.getState().accounts.find((a) => a.active)?.accountId ?? null;

export async function initWallet(opts: {
  network: "testnet" | "mainnet";
  onChange: (accountId: string | null) => void;
}): Promise<string | null> {
  selector = await setupWalletSelector({
    network: opts.network,
    modules: [setupMyNearWallet(), setupHotWallet(), setupIntearWallet()],
  });
  let last = activeAccount();
  selector.store.observable.subscribe(() => {
    const now = activeAccount();
    if (now !== last) {
      last = now;
      opts.onChange(now);
    }
  });
  // Opened inside a wallet's own browser (HOT in Telegram, say): that wallet
  // is already the user's choice, so sign in without asking.
  if (!last) {
    for (const m of selector.store.getState().modules) {
      if ((m.metadata as { topLevelInjected?: boolean }).topLevelInjected) {
        connectWith(m.id).catch(() => {});
        break;
      }
    }
  }
  return last;
}

export interface WalletOption {
  id: string;
  name: string;
  iconUrl: string;
}

/** The wallets the picker offers. */
export function wallets(): WalletOption[] {
  return (selector?.store.getState().modules ?? [])
    .filter((m) => m.metadata.available && !m.metadata.deprecated)
    .map((m) => ({ id: m.id, name: m.metadata.name, iconUrl: m.metadata.iconUrl }));
}

/**
 * Signs in with one wallet. Asks for no access key: every transaction
 * still goes to the wallet for approval. Resolves with the account id.
 */
export async function connectWith(id: string): Promise<string | null> {
  if (!selector) throw new Error("wallet not ready");
  const wallet = await selector.wallet(id);
  const accounts = await (wallet as { signIn(p: object): Promise<Array<{ accountId: string }>> }).signIn({});
  return accounts?.[0]?.accountId ?? activeAccount();
}

export async function disconnect(): Promise<void> {
  if (!selector?.isSignedIn()) return;
  const wallet = await selector.wallet();
  await wallet.signOut();
}

export interface TxResult {
  hash: string;
  value: unknown;
}

/**
 * Asks the connected wallet to sign and send one transaction. Redirect wallets
 * leave the page; their result arrives on return (see `returnedTx`).
 */
export async function send(tx: TxSpec): Promise<TxResult | null> {
  if (!selector) throw new Error("wallet not ready");
  const wallet = await selector.wallet();
  const outcome: any = await wallet.signAndSendTransaction({
    receiverId: tx.receiverId,
    actions: [actionCreators.functionCall(tx.methodName, tx.args, BigInt(tx.gasTgas) * TGAS, tx.deposit)],
  });
  if (!outcome) return null;
  return parseOutcome(outcome);
}

function parseOutcome(raw: any): TxResult {
  const hash: string = raw.transaction?.hash ?? raw.transaction_outcome?.id ?? "";
  if (raw.status?.Failure) throw new Error(panicMessage(raw.status.Failure));
  // A cross-contract call can fail in a later receipt while the transaction
  // reports success (for example a buy the contract refused: the USDC comes back).
  const failed = (raw.receipts_outcome ?? []).map((r: any) => r.outcome?.status?.Failure).find(Boolean);
  if (failed) throw new Error(panicMessage(failed));
  let value: unknown;
  const encoded = raw.status?.SuccessValue;
  if (typeof encoded === "string" && encoded.length > 0) {
    const text = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { hash, value };
}

function panicMessage(failure: unknown): string {
  const text = JSON.stringify(failure);
  return /Smart contract panicked: ([^"\\]+)/.exec(text)?.[1]?.trim() ?? /ExecutionError":\s*"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 300);
}

/** After a redirect wallet sends you back: the transaction hashes, or its error. */
export function returnedTx(): { hashes: string[]; error?: string } | null {
  const params = new URLSearchParams(location.search);
  const hashes = params.get("transactionHashes");
  const error = params.get("errorCode") ?? params.get("errorMessage");
  if (!hashes && !error) return null;
  for (const k of ["transactionHashes", "errorCode", "errorMessage", "account_id", "public_key", "all_keys"]) params.delete(k);
  const q = params.toString();
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
  return { hashes: hashes ? hashes.split(",") : [], error: error ? decodeURIComponent(error) : undefined };
}

// --- tank spend keys ----------------------------------------------------------
// A tank's key is made here and never leaves this browser unless you export it
// to give it to an agent. It can only spend that tank on answers.

interface StoredKey {
  secret: string;
  created: number;
}

const storeName = (contractId: string) => `barrel.tank-keys.${contractId}`;

function readKeys(contractId: string): Record<string, StoredKey> {
  try {
    return JSON.parse(localStorage.getItem(storeName(contractId)) ?? "{}");
  } catch {
    return {};
  }
}

function writeKeys(contractId: string, keys: Record<string, StoredKey>): void {
  localStorage.setItem(storeName(contractId), JSON.stringify(keys));
  // Read it back: a tank whose key was not kept could never be spent.
  if (!localStorage.getItem(storeName(contractId))) throw new Error("this browser did not keep the key");
}

/** Makes a key and stores it before any transaction, so a wallet redirect cannot lose it. */
export function newTankKey(contractId: string): string {
  const pair = newKeyPair();
  const keys = readKeys(contractId);
  keys[pair.publicKey] = { secret: pair.secretKey, created: Date.now() };
  writeKeys(contractId, keys);
  return pair.publicKey;
}

export function secretFor(contractId: string, publicKey: string): string | null {
  return readKeys(contractId)[publicKey]?.secret ?? null;
}

/** Adds a key exported from another browser or the CLI. Returns its public key. */
export function importTankKey(contractId: string, secretKey: string): string {
  const secret = secretKey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("a tank key is 64 hex characters");
  const publicKey = publicKeyOf(secret);
  const keys = readKeys(contractId);
  keys[publicKey] = { secret, created: Date.now() };
  writeKeys(contractId, keys);
  return publicKey;
}

export function forgetTankKey(contractId: string, publicKey: string): void {
  const keys = readKeys(contractId);
  delete keys[publicKey];
  writeKeys(contractId, keys);
}
export * as oneclick from "@barrel/sdk/oneclick";
