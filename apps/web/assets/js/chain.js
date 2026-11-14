// Shared by the site and the app: read the Barrel contract with free view calls
// and check a receipt. The browser talks to a public NEAR RPC and hashes the
// bytes itself. Writes go through the connected wallet (near.bundle.js).

/** Block explorer for the loaded deployment's network. Set by loadDeployment. */
export let EXPLORER = "https://testnet.nearblocks.io";

export const deployment = {
  network: "testnet",
  rpc: "https://test.rpc.fastnear.com",
  contract: "",
  usdc: "",
  operator: "",
  owner: "",
  wasm_sha256: "",
  series: [],
  grades: [],
  sample_receipts: [],
};

/** Load deployment.json from the site root. `root` is "" on / and "../" on /app/. */
export async function loadDeployment(root = "") {
  const dep = await fetch(`${root}deployment.json`).then((r) => r.json());
  Object.assign(deployment, dep);
  EXPLORER = deployment.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  return deployment;
}

export async function loadSamples(root = "") {
  const [sample, gateway] = await Promise.all([
    fetch(`${root}sample-receipt.json`).then((r) => r.json()),
    fetch(`${root}gateway-receipt.json`).then((r) => r.json()).catch(() => null),
  ]);
  return { sample, gateway };
}

/**
 * Public RPCs to read the chain through, in order. A free endpoint can throttle
 * a busy IP (fastnear answers -429); the next one then serves the reads.
 */
const FALLBACK_RPC = { mainnet: ["https://near.drpc.org", "https://rpc.shitzuapes.xyz"], testnet: ["https://rpc.testnet.near.org"] };
export const rpcUrls = () => [...new Set([deployment.rpc, ...(FALLBACK_RPC[deployment.network] ?? [])].filter(Boolean))];
let rpcIndex = 0;
const throttled = (json) => /rate limit|too many/i.test(String(json?.error?.message ?? json?.error?.cause?.name ?? "")) || json?.error?.code === -429;

/** One JSON-RPC query, moving to the next RPC (and staying there) if one throttles or fails. */
async function rpcQuery(params) {
  const urls = rpcUrls();
  const start = rpcIndex % urls.length;
  let last;
  for (let k = 0; k < urls.length; k++) {
    const i = (start + k) % urls.length;
    const url = urls[i];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "barrel", method: "query", params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`RPC ${res.status}`);
      const json = await res.json();
      if (!throttled(json)) return json;
      last = new Error(json.error.message);
    } catch (e) {
      last = e;
    }
    // Later reads start at the next RPC too (parallel reads agree on it).
    if (rpcIndex % urls.length === i) rpcIndex = (i + 1) % urls.length;
  }
  throw last;
}

/** Free view call on the Barrel contract, or on `contract` (e.g. the stablecoin). */
export async function view(method, args = {}, contract = deployment.contract) {
  const json = await rpcQuery({
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (json.error || json.result?.error) throw new Error(String(json.result?.error ?? json.error?.cause?.name ?? json.error?.message ?? "RPC error"));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result)));
}

/**
 * How many full-access keys an account holds. A contract account with none can
 * only change through its own methods, so its timelock really binds.
 */
export async function fullAccessKeys(accountId = deployment.contract) {
  const json = await rpcQuery({ request_type: "view_access_key_list", finality: "final", account_id: accountId });
  if (json.error || json.result?.error) throw new Error(String(json.result?.error ?? json.error?.message ?? "RPC error"));
  return json.result.keys.filter((k) => k.access_key.permission === "FullAccess").length;
}

/** Everything the pages show, in one round of parallel view calls. */
export async function readState() {
  const [escrow, count, recent, grades, series, config] = await Promise.all([
    view("get_total_escrow"),
    view("get_settlement_count"),
    view("get_recent_settlements", { limit: 12 }),
    view("get_grades"),
    view("get_series_list", {}),
    view("get_config"),
  ]);
  // Every model has its own keys; the pages show the ones of the series in view.
  const lists = await Promise.all(grades.map((g) => view("get_keys", { grade_id: g.id })));
  const keysByGrade = Object.fromEntries(grades.map((g, i) => [g.id, lists[i]]));
  const keys = grades[0] ? keysByGrade[grades[0].id] : [];
  return { escrow: BigInt(escrow), count: Number(count), recent, grades, series, config, keys, keysByGrade, at: Date.now() };
}

/** Split one series' escrow into where the money is now. Parts always sum to escrow_in. */
export function escrowParts(s) {
  const escrowIn = BigInt(s.escrow_in);
  const released = BigInt(s.released);
  const refunded = BigInt(s.refund_paid);
  const held = escrowIn - released - refunded;
  const unspent = BigInt(s.minted) - BigInt(s.burned) - BigInt(s.refunded);
  const tanks = unspent > 0n ? (held * BigInt(s.in_tanks)) / unspent : 0n;
  return { escrowIn, released, refunded, held, tanks, wallets: held - tanks, unspent };
}

export function liveKey(keys, now = Date.now() / 1000) {
  return keys.filter((k) => now < k.expires_at && !k.revoked).sort((a, b) => b.expires_at - a.expires_at)[0] ?? null;
}

// ── formatting ──────────────────────────────────────────────────────────────
const SCALE = 1_000_000n;

/** tUSDC base units (6 decimals) → "0.9995". Trailing zeros trimmed, at least `min` decimals. */
export function usdc(base, { min = 2, max = 6 } = {}) {
  const v = BigInt(base);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / SCALE).toLocaleString("en-US");
  let frac = (a % SCALE).toString().padStart(6, "0").slice(0, max).replace(/0+$/, "");
  if (frac.length < min) frac = frac.padEnd(min, "0");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export const int = (n) => Number(n).toLocaleString("en-US");
export const barrels = (units) => (Number(BigInt(units)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const short = (hex, a = 6, b = 4) => (hex && hex.length > a + b + 1 ? `${hex.slice(0, a)}…${hex.slice(-b)}` : hex ?? "");
export const pct = (n, d, digits = 2) => (d > 0 ? `${((Number(n) / Number(d)) * 100).toFixed(digits)}%` : "0%");

export function utc(sec, withYear = false) {
  const d = new Date(sec * 1000);
  const iso = d.toISOString();
  return withYear ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}, ${iso.slice(11, 16)}`;
}

export function ago(sec, now = Date.now() / 1000) {
  const s = Math.max(0, Math.round(now - sec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function span(sec) {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── bytes ───────────────────────────────────────────────────────────────────
export const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── receipts ────────────────────────────────────────────────────────────────

/** The question and answer inside a receipt, for display. */
export function readReceipt(r) {
  const out = { q: "", a: "", usage: null, streamed: false };
  try {
    const req = JSON.parse(new TextDecoder().decode(fromB64(r.request_b64)));
    const last = req.messages?.at?.(-1)?.content;
    out.q = typeof last === "string" ? last : JSON.stringify(last ?? "");
  } catch { /* not JSON */ }
  try {
    const body = JSON.parse(new TextDecoder().decode(fromB64(r.response_b64)));
    out.a = body.choices?.[0]?.message?.content ?? "";
    out.usage = body.usage ?? null;
  } catch {
    out.streamed = true;
    out.a = "";
  }
  return out;
}

/** Swap the answer for a different one, keeping the signature: what a cheaper model would produce. */
export function tamper(r) {
  const copy = { ...r };
  const text = new TextDecoder().decode(fromB64(r.response_b64));
  let changed;
  try {
    const body = JSON.parse(text);
    body.choices[0].message.content = "A cheaper model wrote this answer instead.";
    changed = JSON.stringify(body);
  } catch {
    changed = `${text} `;
  }
  copy.response_b64 = toB64(new TextEncoder().encode(changed));
  return copy;
}

/**
 * Run every check a payer runs before acknowledging an answer. Hashes are
 * computed here; the signature and the key registry are checked by the
 * contract's free `verify_receipt` view.
 * Returns { ok, checks: [{ ok, html, note }], title, detail }.
 */
export async function checkReceipt(r) {
  const checks = [];
  const add = (ok, html, note = false) => (checks.push({ ok, html, note }), ok);
  let ok = true;
  let bytesChanged = false;

  ok &= add(r.signature_kind === "provider_tee", r.signature_kind === "provider_tee"
    ? "Signed by the model's TEE <code>provider_tee</code>"
    : `Signed by <code>${escapeHtml(r.signature_kind ?? "unknown")}</code>, not by the model`);

  const expected = `${r.model_id}:${r.request_hash}:${r.response_hash}`;
  const twoPart = typeof r.text === "string" && r.text.split(":").length === 2;
  ok &= add(r.text === expected, r.text === expected
    ? `Signed text names the model <code>${escapeHtml(r.model_id)}</code>`
    : twoPart ? "Signed text covers the bytes but names no model" : "Signed text does not match the model and hashes");

  if (r.request_b64) ok &= add((await sha256Hex(fromB64(r.request_b64))) === r.request_hash, "Request bytes hash to <code>request_hash</code>");
  if (r.response_b64) {
    const same = (await sha256Hex(fromB64(r.response_b64))) === r.response_hash;
    bytesChanged = !same;
    ok &= add(same, same ? "Answer bytes hash to <code>response_hash</code>" : "Answer bytes do not hash to <code>response_hash</code>: the answer was changed");
  }

  try {
    const chain = await view("verify_receipt", {
      grade_id: r.grade_id,
      request_hash: r.request_hash,
      response_hash: r.response_hash,
      tee_key: r.signing_address,
      tee_sig: r.signature,
    });
    ok &= add(chain.signature_ok, chain.signature_ok ? "Ed25519 signature verifies on-chain" : "Ed25519 signature does not verify over the model's text");
    ok &= add(chain.key_registered, chain.key_registered
      ? "Signing key was registered for this model after an attestation check"
      : "Signing key is not registered for this model (a gateway key never is)");
    if (chain.key_registered) add(true, chain.key_live ? "Key is live" : "Key has since expired. Old receipts stay checkable", true);
  } catch (e) {
    ok = false;
    add(false, `Contract check failed: ${escapeHtml(e.message)}`);
  }

  const verdict = ok
    ? { title: "Valid: this model produced this answer", detail: "The contract would pay the operator for it." }
    : r.signature_kind === "gateway"
      ? { title: "Rejected: not a model signature", detail: "The contract would not pay for this answer." }
      : bytesChanged
        ? { title: "Rejected: not the answer the model signed", detail: "The agent would not acknowledge it, so nothing is paid." }
        : { title: "Rejected", detail: "The contract would not pay for this answer." };
  return { ok: Boolean(ok), checks, ...verdict };
}

// ── small DOM helpers ───────────────────────────────────────────────────────
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const icon = (id, cls = "icon", root = "") => `<svg class="${cls}" aria-hidden="true"><use href="${root}assets/img/icons.svg#${id}"/></svg>`;

/** Count a number up into an element. `format` turns the tweened value into text. */
export function tween(el, to, { from = 0, duration = 1400, format = (v) => int(Math.round(v)) } = {}) {
  if (!el) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || duration <= 0) { el.textContent = format(to); return; }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(from + (to - from) * ease(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function copyText(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    if (!btn) return;
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1400);
  });
}
