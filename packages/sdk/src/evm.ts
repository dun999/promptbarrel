// A minimal EVM wallet for paying into NEAR Intents from Base (or any EVM
// chain): key generation, EIP-1559 signing and ERC-20 transfers over JSON-RPC.
// Built on the same noble libraries as the rest of the SDK, no extra deps.
//
// Keys live in .barrel/evm/<address>.json (git-ignored, mode 0600).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { STATE_DIR } from "./chain.ts";

export interface EvmChain {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerTx: string;
  /** Native USDC on this chain. */
  usdc: string;
}

export const EVM_CHAINS: Record<string, EvmChain> = {
  base: {
    name: "base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    explorerTx: "https://basescan.org/tx/",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

export interface EvmWallet {
  address: string;
  privateKey: string;
}

const EVM_DIR = join(STATE_DIR, "evm");
const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const strip = (h: string) => h.replace(/^0x/, "");

/** EIP-55 mixed-case checksum address. */
export function checksum(address: string): string {
  const a = strip(address).toLowerCase();
  const h = bytesToHex(keccak_256(new TextEncoder().encode(a)));
  return `0x${[...a].map((c, i) => (parseInt(h[i]!, 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

export function addressOf(privateKey: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(strip(privateKey)), false);
  return checksum(hex(keccak_256(pub.slice(1)).slice(-20)));
}

export function createEvmWallet(): EvmWallet {
  const sk = secp256k1.utils.randomSecretKey();
  const w = { address: addressOf(hex(sk)), privateKey: hex(sk) };
  mkdirSync(EVM_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(EVM_DIR, `${w.address}.json`), JSON.stringify(w, null, 2), { mode: 0o600 });
  return w;
}

export function loadEvmWallet(address?: string): EvmWallet {
  const files = existsSync(EVM_DIR) ? readdirSync(EVM_DIR).filter((f) => f.endsWith(".json")) : [];
  const file = address ? `${checksum(address)}.json` : files[0];
  if (!file || !files.includes(file)) throw new Error(`no EVM key${address ? ` for ${address}` : ""} in ${EVM_DIR}`);
  return JSON.parse(readFileSync(join(EVM_DIR, file), "utf8")) as EvmWallet;
}

// --- RLP ---------------------------------------------------------------------------
type Rlp = Uint8Array | Rlp[];
function rlp(item: Rlp): Uint8Array {
  const len = (n: number, off: number) => {
    if (n < 56) return Uint8Array.of(off + n);
    const b = hexToBytes(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), "0"));
    return Uint8Array.of(off + 55 + b.length, ...b);
  };
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    return Uint8Array.of(...len(item.length, 0x80), ...item);
  }
  const body = item.map(rlp);
  const total = body.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(len(total, 0xc0).length + total);
  out.set(len(total, 0xc0));
  let o = len(total, 0xc0).length;
  for (const b of body) { out.set(b, o); o += b.length; }
  return out;
}
const int = (n: bigint) => (n === 0n ? new Uint8Array() : hexToBytes(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), "0")));

// --- JSON-RPC ------------------------------------------------------------------------
async function rpc<T>(chain: EvmChain, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${chain.name} ${method}: ${body.error.message}`);
  return body.result as T;
}

export const ethBalance = async (chain: EvmChain, address: string) => BigInt(await rpc<string>(chain, "eth_getBalance", [address, "latest"]));

export async function erc20Balance(chain: EvmChain, token: string, address: string): Promise<bigint> {
  const data = `0x70a08231${strip(address).toLowerCase().padStart(64, "0")}`;
  return BigInt(await rpc<string>(chain, "eth_call", [{ to: token, data }, "latest"]));
}

export const erc20TransferData = (to: string, amount: bigint) =>
  `0xa9059cbb${strip(to).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

/** Signs and sends an EIP-1559 transaction; returns its hash once mined. */
export async function sendEvmTx(chain: EvmChain, w: EvmWallet, tx: { to: string; data?: string; value?: bigint }): Promise<string> {
  const from = w.address;
  const data = tx.data ?? "0x";
  const value = tx.value ?? 0n;
  const [nonce, gas, tip, block] = await Promise.all([
    rpc<string>(chain, "eth_getTransactionCount", [from, "pending"]),
    rpc<string>(chain, "eth_estimateGas", [{ from, to: tx.to, data, value: `0x${value.toString(16)}` }]),
    rpc<string>(chain, "eth_maxPriorityFeePerGas", []),
    rpc<{ baseFeePerGas: string }>(chain, "eth_getBlockByNumber", ["latest", false]),
  ]);
  const gasLimit = (BigInt(gas) * 12n) / 10n;
  const priority = BigInt(tip);
  const maxFee = BigInt(block.baseFeePerGas) * 2n + priority;
  const fields: Rlp[] = [
    int(BigInt(chain.chainId)), int(BigInt(nonce)), int(priority), int(maxFee), int(gasLimit),
    hexToBytes(strip(tx.to)), int(value), hexToBytes(strip(data)), [],
  ];
  const digest = keccak_256(Uint8Array.of(0x02, ...rlp(fields)));
  const sig = secp256k1.sign(digest, hexToBytes(strip(w.privateKey)), { prehash: false, format: "recovered" });
  // noble's "recovered" format is [recovery, r(32), s(32)].
  const recovery = sig[0]!;
  const r = sig.slice(1, 33);
  const s = sig.slice(33, 65);
  const strip0 = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.slice(i); };
  const signed = Uint8Array.of(0x02, ...rlp([...fields, int(BigInt(recovery)), strip0(r), strip0(s)]));
  const hash = await rpc<string>(chain, "eth_sendRawTransaction", [hex(signed)]);
  for (let i = 0; i < 60; i++) {
    const receipt = await rpc<{ status: string } | null>(chain, "eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`${chain.name} tx ${hash} reverted`);
      return hash;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${chain.name} tx ${hash} not mined after 2 minutes`);
}

/** Self-check of the signing layout: the recovered signer must be this wallet. */
export function checkSigning(w: EvmWallet): boolean {
  const digest = keccak_256(new TextEncoder().encode("barrel"));
  const sig = secp256k1.sign(digest, hexToBytes(strip(w.privateKey)), { prehash: false, format: "recovered" });
  const pub = secp256k1.recoverPublicKey(sig, digest, { prehash: false });
  const full = secp256k1.Point.fromBytes(pub).toBytes(false);
  return checksum(hex(keccak_256(full.slice(1)).slice(-20))) === w.address;
}
