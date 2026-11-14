// Docs: the contents follow the reading position, code blocks copy, and the
// numbers the text quotes are re-read from the contract, so the page cannot
// drift from the deployment it describes.

import { $, $$, EXPLORER, deployment, loadDeployment, readState, liveKey, usdc, barrels, int, short, span, copyText, escapeHtml } from "./chain.js";

// ── footer: the name spans the sheet and lights up under the pointer ────────
const wordmark = $("#wordmark");
function fitWordmark() {
  const range = document.createRange();
  range.selectNodeContents(wordmark.firstElementChild);
  const w = range.getBoundingClientRect().width;
  const fs = parseFloat(getComputedStyle(wordmark).fontSize);
  if (w > 0 && fs > 0) wordmark.style.setProperty("--wm", `${((fs * wordmark.clientWidth * 0.95) / w).toFixed(1)}px`);
}
fitWordmark();
addEventListener("resize", fitWordmark);
document.fonts?.ready.then(fitWordmark);
$("#foot").addEventListener("pointermove", (e) => {
  const r = wordmark.getBoundingClientRect();
  wordmark.style.setProperty("--mx", `${(e.clientX - r.left).toFixed(0)}px`);
  wordmark.style.setProperty("--my", `${(e.clientY - r.top).toFixed(0)}px`);
}, { passive: true });

// ── contents ─────────────────────────────────────────────────────────────────
const toc = $("#toc");
const wide = matchMedia("(min-width: 961px)");
const syncToc = () => { toc.open = wide.matches; };
syncToc();
wide.addEventListener("change", syncToc);

const links = $$("#toc nav a");
const sections = links.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
links.forEach((a) => a.addEventListener("click", () => { if (!wide.matches) toc.open = false; }));
let current = null;
function mark() {
  const line = 64 + 96;
  let at = sections[0];
  for (const s of sections) if (s.getBoundingClientRect().top <= line) at = s;
  // at the foot of the page the last short sections cannot reach the line
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) at = sections.at(-1);
  if (at === current) return;
  current = at;
  links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${at.id}`));
  // keep the current entry inside the contents' own scroll box, without moving the page
  const on = links.find((a) => a.classList.contains("on"));
  if (on && wide.matches && toc.scrollHeight > toc.clientHeight) {
    const top = on.getBoundingClientRect().top - toc.getBoundingClientRect().top + toc.scrollTop, pad = 48;
    if (top < toc.scrollTop + pad) toc.scrollTop = Math.max(0, top - pad);
    else if (top + on.offsetHeight > toc.scrollTop + toc.clientHeight - pad) toc.scrollTop = top + on.offsetHeight - toc.clientHeight + pad;
  }
}
let ticking = false;
addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; mark(); }); } }, { passive: true });
mark();

// ── code ─────────────────────────────────────────────────────────────────────
$$(".code .icon-btn").forEach((b) => b.addEventListener("click", () => copyText($("pre", b.parentElement).textContent, b)));

// ── live values ──────────────────────────────────────────────────────────────
const fill = (k, v) => $$(`[data-d="${k}"]`).forEach((el) => { el.textContent = v; });
const status = (id, cls, html) => { $(id).innerHTML = `<i class="dot ${cls}"></i><span>${html}</span>`; };
const hours = (sec) => { const h = Math.round(sec / 3600); return `${h} hour${h === 1 ? "" : "s"}`; };
const minutes = (sec) => { const m = Math.round(sec / 60); return `${m} minute${m === 1 ? "" : "s"}`; };
const duration = (sec) => (sec >= 3600 ? hours(sec) : minutes(sec));
const when = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
};

/** The models table: one row per series, from the chain or from the deployment record. */
function modelRows(series, grades, unit) {
  const rows = series.map((x) => {
    const g = grades.find((y) => y.id === x.grade_id);
    return `<tr><td>${x.id}</td><td class="mono">${escapeHtml(g?.model_id ?? x.model_id ?? x.grade_id)}</td><td>${usdc(x.price_per_barrel)} ${unit}</td><td>${g ? `${g.input_weight_bps / 100}%` : "–"}</td></tr>`;
  });
  $("#models-rows").innerHTML = rows.join("") || `<tr><td colspan="4">No series open</td></tr>`;
}

/** Where a series' Pump can be reached from a browser, and whether it answers. */
async function pumpState(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return ["bad", `Not a valid address: ${escapeHtml(endpoint)}`]; }
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return ["bad", `Local address (${escapeHtml(url.host)}). Only the operator's own machine can ask`];
  }
  if (url.protocol !== "https:") return ["bad", `Not HTTPS (${escapeHtml(url.host)}). Browsers cannot reach it`];
  try {
    const r = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/info`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    return ["ok", `Answering at ${escapeHtml(url.host)}`];
  } catch {
    return ["bad", `Not answering at ${escapeHtml(url.host)}`];
  }
}

(async () => {
  try {
    await loadDeployment("../");
  } catch {
    return;
  }
  const test = deployment.network === "testnet";
  fill("net", `NEAR ${deployment.network}`);
  fill("network", deployment.network);
  fill("contract", deployment.contract);
  if (deployment.wasm_sha256) fill("wasm", short(deployment.wasm_sha256, 8, 4));
  fill("unit", test ? "tUSDC" : "USDC");
  $$('[data-d-link="contract"]').forEach((a) => { a.href = `${EXPLORER}/address/${deployment.contract}`; });
  const unit = test ? "tUSDC" : "USDC";
  modelRows(deployment.series ?? [], deployment.grades ?? [], unit);
  if (test) {
    $("#dep-title").textContent = "Testnet (this build reads it)";
    $("#dep-coin").textContent = "A test stablecoin with no value";
    $("#foot-net").textContent = "Testnet development build. Test USDC has no value.";
  }

  let s;
  try {
    s = await readState();
  } catch (e) {
    $("#d-live").innerHTML = `<i class="dot bad"></i><span>Could not read the contract right now. The values below are the recorded ones.</span>`;
    ["#lv-contract", "#lv-key", "#lv-pump", "#lv-count"].forEach((id) => status(id, "bad", "Could not read"));
    return;
  }
  const c = s.config;
  // A contract from before claims and the timelock has no claim window in its config.
  $("#d-version").hidden = c.claim_window_sec !== undefined;
  const series = s.series[0];
  const gradeOf = (x) => s.grades.find((g) => g.id === x.grade_id);
  // The worked example uses the cheapest series on offer.
  const cheapest = [...s.series].sort((a, b) => Number(a.price_per_barrel) - Number(b.price_per_barrel))[0];
  const grade = cheapest ? gradeOf(cheapest) : s.grades[0];
  fill("escrow", usdc(s.escrow));
  fill("models", int(new Set(s.series.map((x) => x.grade_id)).size));
  if (c.attestor !== undefined) fill("attestor", c.attestor ?? "none: the owner registers keys");
  if (c.claim_window_sec !== undefined) fill("claim", minutes(c.claim_window_sec));
  if (c.timelock_sec !== undefined) fill("timelock", duration(c.timelock_sec));
  if (c.min_tank_buy_units !== undefined) fill("min-buy", int(c.min_tank_buy_units));
  modelRows(s.series, s.grades, unit);
  fill("owner", c.owner);
  fill("usdc-short", /^[0-9a-f]{64}$/.test(c.usdc) ? short(c.usdc, 8, 4) : c.usdc);
  fill("unlock", minutes(c.unlock_delay_sec));
  fill("grace", hours(c.settle_grace_sec));
  fill("cap-escrow", usdc(c.max_total_escrow, { min: 0 }));
  fill("cap-series", barrels(c.max_series_units));
  if (grade) {
    fill("model", grade.model_id);
    fill("weight", `${grade.input_weight_bps / 100}%`);
    fill("ttl", hours(grade.key_ttl_sec));
  }
  if (cheapest) {
    const price = BigInt(cheapest.price_per_barrel);
    fill("price-from", usdc(price));
    fill("price", usdc(price));
    fill("per-usdc", (Number((1_000_000n * 1_000_000n) / price) / 1e6).toFixed(6));
    if (grade) {
      const prompt = Math.ceil((420 * grade.input_weight_bps) / 10_000);
      const units = 180 + prompt;
      fill("ex-prompt", int(prompt));
      fill("ex-units", int(units));
      fill("ex-cost", (Number((BigInt(units) * price) / 1_000_000n) / 1e6).toPrecision(2));
    }
  }
  if (series) {
    fill("operator", series.operator);
    fill("window", when(series.window_end));
    fill("endpoint", series.endpoint);
  }

  status("#lv-contract", c.paused ? "bad" : "ok", c.paused ? "Paused" : "Active");
  // Every model on offer needs a live key, or its answers cannot settle.
  const offered = [...new Set(s.series.map((x) => x.grade_id))];
  const live = offered.filter((g) => liveKey(s.keysByGrade[g] ?? []));
  if (offered.length === 0) status("#lv-key", "", "No series open");
  else if (offered.length === 1) {
    const keys = s.keysByGrade[offered[0]] ?? [];
    const key = liveKey(keys);
    status("#lv-key", key ? "ok" : "bad", key
      ? `Live, ${span(key.expires_at - Date.now() / 1000)} left`
      : keys.length ? "Expired: nothing settles until a fresh key is registered" : "None registered");
  } else {
    status("#lv-key", live.length === offered.length ? "ok" : "bad", live.length === offered.length
      ? `Live for all ${offered.length} models`
      : `Live for ${live.length} of ${offered.length} models; the rest cannot settle until a fresh key is registered`);
  }
  status("#lv-count", s.count > 0 ? "ok" : "", s.count > 0 ? `${int(s.count)} paid on proof` : "None yet");
  if (series) {
    const [cls, html] = await pumpState(series.endpoint);
    status("#lv-pump", cls, html);
  } else {
    status("#lv-pump", "", "No series open");
  }
})();
