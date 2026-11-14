// The upstream TEE cloud, as the Pump sees it: send exact bytes, get exact
// bytes back, then fetch the model's signature over both.

import { NEAR_AI_BASE_URL, type SignaturePayload } from "@barrel/verifier";
import { sleep } from "./chain.ts";

export interface UpstreamResponse {
  status: number;
  contentType: string;
  /** Raw response body exactly as received. Never re-serialized. */
  body: Uint8Array;
}

/**
 * The headers of an end-to-end encrypted request. The Pump passes them on
 * untouched: they name the keys, and the keys never leave the two ends.
 */
export const E2EE_HEADERS = ["x-signing-algo", "x-client-pub-key", "x-model-pub-key", "x-encryption-version", "x-encrypt-all-fields"] as const;

/**
 * Forwards a chat completion. The body is sent byte for byte, with the
 * canonical model ID and `x-no-aliasing: true`, so the model TEE (not the
 * gateway) signs the answer.
 */
export async function postCompletion(
  apiKey: string,
  body: Uint8Array,
  baseUrl: string = NEAR_AI_BASE_URL,
  extraHeaders: Record<string, string> = {},
): Promise<UpstreamResponse> {
  const res = await fetch(new URL("/v1/chat/completions", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "accept-encoding": "identity",
      "x-no-aliasing": "true",
      ...extraHeaders,
    },
    body: body as unknown as BodyInit,
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "application/json",
    body: new Uint8Array(await res.arrayBuffer()),
  };
}

/**
 * Fetches the signature for a completion. A 404, or a 2xx carrying
 * `error_code`, means "not available yet": retry for a short bounded
 * interval, then give up. An answer without a signature is never billed.
 */
export async function fetchSignature(
  apiKey: string,
  chatId: string,
  modelId: string,
  opts: { attempts?: number; delayMs?: number; baseUrl?: string } = {},
): Promise<SignaturePayload | null> {
  const url = new URL(`/v1/signature/${encodeURIComponent(chatId)}`, opts.baseUrl ?? NEAR_AI_BASE_URL);
  url.searchParams.set("model", modelId);
  url.searchParams.set("signing_algo", "ed25519");
  const attempts = opts.attempts ?? 8;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
    if (res.ok) {
      const payload = (await res.json()) as Partial<SignaturePayload> & { error_code?: string };
      if (!payload.error_code && payload.text && payload.signature && payload.signing_address) {
        return payload as SignaturePayload;
      }
    } else if (res.status !== 404) {
      throw new Error(`signature: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(opts.delayMs ?? 500);
  }
  return null;
}
