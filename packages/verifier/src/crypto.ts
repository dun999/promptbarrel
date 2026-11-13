import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export { bytesToHex, hexToBytes };

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8(data) : data));
}

export function sha384Bytes(data: Uint8Array): Uint8Array {
  return sha384(data);
}

/** Strips an optional 0x prefix and lowercases. Returns null if it is not hex of the given byte length. */
export function normalizeHex(value: string, bytes: number): string | null {
  const s = (value.startsWith("0x") ? value.slice(2) : value).toLowerCase();
  return s.length === bytes * 2 && /^[0-9a-f]*$/.test(s) ? s : null;
}

export interface KeyPairHex {
  secretKey: string;
  publicKey: string;
}

export function newKeyPair(): KeyPairHex {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey: bytesToHex(secretKey), publicKey: bytesToHex(publicKey) };
}

export function publicKeyOf(secretKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secretKeyHex)));
}

export function signEd25519(message: string | Uint8Array, secretKeyHex: string): string {
  const msg = typeof message === "string" ? utf8(message) : message;
  return bytesToHex(ed25519.sign(msg, hexToBytes(secretKeyHex)));
}

/** RFC 8032 verification. Never throws: malformed input is simply not a valid signature. */
export function verifyEd25519(signatureHex: string, message: string | Uint8Array, publicKeyHex: string): boolean {
  const sig = normalizeHex(signatureHex, 64);
  const key = normalizeHex(publicKeyHex, 32);
  if (!sig || !key) return false;
  try {
    const msg = typeof message === "string" ? utf8(message) : message;
    return ed25519.verify(hexToBytes(sig), msg, hexToBytes(key), { zip215: false });
  } catch {
    return false;
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
