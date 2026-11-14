// End-to-end encryption to the model TEE, as NEAR AI Cloud defines it
// (X-Encryption-Version 2): X25519 ECDH with the model's Ed25519 key
// converted to X25519, HKDF-SHA256 (no salt, info "ed25519_encryption"),
// XChaCha20-Poly1305. Wire format, hex: ephemeral public key (32 bytes),
// nonce (24 bytes), ciphertext and tag.
//
// The model key is the same key that signs receipts and that the Barrel
// contract has registered for the grade, so a payer encrypts to a key the
// chain already vouches for. The operator's Pump relays ciphertext.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { utf8 } from "./crypto.ts";

const INFO = utf8("ed25519_encryption");
const decoder = new TextDecoder();

const deriveKey = (shared: Uint8Array) => hkdf(sha256, shared, undefined, INFO, 32);

/** Encrypts text to an Ed25519 public key (hex). Fresh ephemeral key per call. */
export function sealTo(ed25519PublicKeyHex: string, plaintext: string): string {
  const recipient = ed25519.utils.toMontgomery(hexToBytes(ed25519PublicKeyHex));
  const { secretKey, publicKey } = x25519.keygen();
  const key = deriveKey(x25519.getSharedSecret(secretKey, recipient));
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(key, nonce).encrypt(utf8(plaintext));
  return bytesToHex(publicKey) + bytesToHex(nonce) + bytesToHex(sealed);
}

/** Opens text that was encrypted to the Ed25519 key whose secret is given (hex). */
export function openWith(ed25519SecretKeyHex: string, sealedHex: string): string {
  const data = hexToBytes(sealedHex);
  if (data.length < 32 + 24 + 16) throw new Error("ciphertext too short");
  const secret = ed25519.utils.toMontgomerySecret(hexToBytes(ed25519SecretKeyHex));
  const key = deriveKey(x25519.getSharedSecret(secret, data.subarray(0, 32)));
  return decoder.decode(xchacha20poly1305(key, data.subarray(32, 56)).decrypt(data.subarray(56)));
}

/** True when a string has the shape of a sealed field. Used to refuse plaintext where ciphertext is promised. */
export function looksSealed(value: unknown): value is string {
  return typeof value === "string" && value.length >= (32 + 24 + 16) * 2 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
}

/** The response fields the model encrypts to the client key. */
export const SEALED_RESPONSE_FIELDS = ["content", "reasoning_content", "reasoning"] as const;
