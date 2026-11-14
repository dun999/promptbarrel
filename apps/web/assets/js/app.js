// The app. Reads the chain with free view calls; every write is a transaction
// the connected wallet signs (near.bundle.js). Tank spend keys are made and
// kept in this browser. No backend of ours sits between you and the contract.

import { $, $$, EXPLORER, deployment, loadDeployment, loadSamples, readState, fullAccessKeys, escrowParts, liveKey, view, usdc, int, barrels, short, utc, ago, span, pct, tween, checkReceipt, readReceipt, tamper, escapeHtml, copyText, icon } from "./chain.js";

const ROOT = "../";
const ic = (id, cls = "icon") => icon(id, cls, ROOT);
const POLL_MS = 15_000;
const UNITS = 1_000_000n;

let state = null; // network: readState()
let me = null; // the connected account: balances and tanks
let account = null;
// ?view=<account> shows any account's Barrels and tanks read-only, without a wallet.
// Everything shown is public chain state; nothing can be signed in this mode.
const watching = (() => {
  const v = new URLSearchParams(location.search).get("view")?.trim().toLowerCase();
  return v && /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v) ? v : null;
})();
const who = () => account ?? watching;
let near = null; // wallet + tank code, loaded after first paint
let selected = null; // series id to buy and fill from
let lastSync = 0;
let first = true;
/** Full-access keys on the contract account, read once per page load. */
let fullKeysRead = null;
const seen = new Set();
const shown = {};

const contracts = () => ({ barrel: deployment.contract, usdc: deployment.usdc });
const seriesById = (id) => state?.series.find((s) => s.id === id) ?? null;
const gradeOf = (s) => state?.grades.find((g) => g.id === s.grade_id) ?? null;
const now = () => Date.now() / 1000;
const isOpen = (s) => now() < s.window_end;
const testnet = () => deployment.network === "testnet";
/** The stablecoin's name: test USDC on testnet, USDC on mainnet. */
const unit = () => (testnet() ? "tUSDC" : "USDC");
const txLink = (hash) => `${EXPLORER}/txns/${hash}`;

/** "1.5" -> 1500000n (tUSDC and Barrels both have 6 decimals). null when not a positive amount. */
function amount(text) {
  const t = String(text).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  const v = BigInt(w) * UNITS + BigInt(f.padEnd(6, "0") || "0");
  return v > 0n ? v : null;
}
const status = (el, cls, text) => { el.innerHTML = `<i class="dot ${cls}"></i>${text}`; };

// ── toasts ───────────────────────────────────────────────────────────────────
function toast(kind, title, { hash, detail } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${ic(kind === "ok" ? "check" : kind === "bad" ? "x" : "clock")}<div>${escapeHtml(title)}${hash ? ` · <a href="${txLink(hash)}" target="_blank" rel="noopener">View transaction</a>` : ""}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, kind === "bad" ? 9000 : 6500);
}
function errText(e) {
  const m = e?.message ?? String(e);
  if (/reject|cancel|denied|closed the window|User declined/i.test(m)) return "Cancelled in the wallet.";
  return m.replace(/^Error:\s*/, "").slice(0, 240);
}

// ── tooltip ──────────────────────────────────────────────────────────────────
const tip = $("#tip");
function bindTip(el, html) {
  const at = (e) => {
    const r = el.getBoundingClientRect();
    const x = e?.clientX ?? r.left + r.width / 2;
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = `${Math.min(innerWidth - 90, Math.max(90, x))}px`;
    tip.style.top = `${r.top}px`;
  };
  const hide = () => { tip.hidden = true; };
  el.addEventListener("pointerenter", at);
  el.addEventListener("pointermove", at);
  el.addEventListener("pointerleave", hide);
  el.addEventListener("focus", () => at());
  el.addEventListener("blur", hide);
}

// ── dropdowns: the app's own list in place of the browser's ─────────────────
// The <select> stays, hidden: it holds the options and the value, so the code
// that fills and reads it is unchanged. A button and a list stand in for it.
function dropdown(select) {
  const id = select.id;
  const wrap = document.createElement("div");
  wrap.className = "dd";
  select.before(wrap);
  select.classList.add("dd-native");
  select.tabIndex = -1;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dd-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", `${id}-list`);
  btn.setAttribute("aria-label", select.getAttribute("aria-label") ?? "");
  btn.innerHTML = `<span class="dd-v"></span>${ic("chevron", "dd-chev")}`;
  const list = document.createElement("ul");
  list.className = "dd-list";
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.append(select, btn, list);
  let active = -1;

  // an option may carry a logo (data-icon); an empty one keeps the text aligned
  const face = (o) => {
    if (!o) return "";
    const pic = "icon" in o.dataset ? (o.dataset.icon ? `<img class="dd-ico" src="${escapeHtml(o.dataset.icon)}" alt="">` : `<span class="dd-ico"></span>`) : "";
    return `${pic}<span class="dd-t">${escapeHtml(o.textContent)}</span>`;
  };
  const items = () => [...list.children];
  const mark = () => {
    items().forEach((li, i) => li.classList.toggle("on", i === active));
    if (active >= 0) { btn.setAttribute("aria-activedescendant", `${id}-o${active}`); items()[active]?.scrollIntoView({ block: "nearest" }); }
  };
  const sync = () => {
    $(".dd-v", btn).innerHTML = face(select.selectedOptions[0]);
    // nothing to choose (e.g. "Connect a wallet first"): a disabled field, not a list
    btn.disabled = ![...select.options].some((o) => o.value !== "");
    if (btn.disabled) close();
  };
  const open = () => {
    if (btn.disabled || !list.hidden) return;
    list.innerHTML = [...select.options].map((o, i) => `<li role="option" id="${id}-o${i}" data-i="${i}" aria-selected="${o.selected}">${face(o)}${o.selected ? ic("check", "dd-tick") : ""}</li>`).join("");
    list.hidden = false;
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    active = Math.max(0, select.selectedIndex);
    mark();
  };
  function close() {
    if (list.hidden) return;
    list.hidden = true;
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-activedescendant");
  }
  const pick = (i) => {
    close();
    if (i < 0 || i === select.selectedIndex) return;
    select.selectedIndex = i;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  btn.addEventListener("click", () => (list.hidden ? open() : close()));
  btn.addEventListener("keydown", (e) => {
    const n = select.options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) return open();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      mark();
    } else if ((e.key === "Home" || e.key === "End") && !list.hidden) {
      e.preventDefault();
      active = e.key === "Home" ? 0 : n - 1;
      mark();
    } else if ((e.key === "Enter" || e.key === " ") && !list.hidden) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close();
    } else if (e.key.length === 1 && /\S/.test(e.key) && !list.hidden) {
      // jump to the next option starting with the typed letter
      const k = e.key.toLowerCase();
      const opts = [...select.options];
      const next = [...opts.keys()].map((d) => (active + 1 + d) % n).find((i) => opts[i].textContent.trim().toLowerCase().startsWith(k));
      if (next !== undefined) { active = next; mark(); }
    }
  });
  list.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus on the button
  list.addEventListener("pointermove", (e) => {
    const li = e.target.closest("li");
    if (li && Number(li.dataset.i) !== active) { active = Number(li.dataset.i); mark(); }
  });
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (li) { pick(Number(li.dataset.i)); btn.focus(); }
  });
  document.addEventListener("pointerdown", (e) => { if (!wrap.contains(e.target)) close(); });
  select.addEventListener("change", sync);
  // the app refills the options as the chain changes
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });
  sync();
}
$$("select[data-dd]").forEach(dropdown);

// ── transactions ─────────────────────────────────────────────────────────────
/**
 * Sends one transaction through the wallet, then re-reads the chain.
 * `refused(r)` can turn a transaction that succeeded on-chain but did not do
 * its job (a payout the token bounced) into an error message.
 */
async function send(btn, spec, { label, done, refused } = {}) {
  if (!near) return toast("bad", "The wallet code is still loading.");
  if (!account) return connectDialog();
  const text = btn?.textContent;
  if (btn) { btn.setAttribute("aria-busy", "true"); btn.textContent = "Confirm in your wallet…"; }
  try {
    const r = await near.send(spec);
    await refresh();
    if (r) {
      const problem = refused?.(r);
      if (problem) return toast("bad", problem.title, { detail: problem.detail, hash: r.hash });
      toast("ok", label, { hash: r.hash });
      await done?.(r);
    }
  } catch (e) {
    toast("bad", "Transaction failed", { detail: errText(e) });
  } finally {
    if (btn) { btn.removeAttribute("aria-busy"); btn.textContent = text; }
  }
}

// ── reads ────────────────────────────────────────────────────────────────────
async function readMe() {
  const account = who();
  if (!account || !state) { me = null; return; }
  const ids = state.series.map((s) => s.id);
  const [bal, tanks, held, refundAt] = await Promise.all([
    view("ft_balance_of", { account_id: account }, deployment.usdc).catch(() => "0"),
    view("get_tanks_for", { owner: account }),
    Promise.all(ids.map((id) => view("mt_balance_of", { account_id: account, token_id: String(id) }))),
    Promise.all(ids.map((id) => view("refund_opens_at", { series_id: id }).catch(() => null))),
  ]);
  // An agent can only be paid once it is registered with the stablecoin.
  const agents = [...new Set(tanks.filter((t) => t.accepted && !t.closed).map((t) => t.agent))];
  const registered = await Promise.all(agents.map((a) => view("storage_balance_of", { account_id: a }, deployment.usdc).then((r) => r !== null).catch(() => true)));
  me = {
    agentReady: new Map(agents.map((a, i) => [a, registered[i]])),
    usdc: BigInt(bal),
    tanks: [...tanks].sort((a, b) => Number(a.closed) - Number(b.closed) || b.id - a.id),
    held: new Map(ids.map((id, i) => [id, BigInt(held[i])])),
    refundAt: new Map(ids.map((id, i) => [id, refundAt[i]])),
  };
}

async function refresh(manual = false) {
  try {
    state = await readState();
    await readMe();
    lastSync = Date.now();
    $("#banner").hidden = true;
    if (selected === null || !seriesById(selected)) selected = (state.series.find(isOpen) ?? state.series[0])?.id ?? null;
    renderNetwork(state);
    renderUse();
    tick();
    if (manual) toast("ok", "Read the latest state from the chain.");
  } catch (e) {
    status($("#sync"), "bad", "Offline, retrying");
    const b = $("#banner");
    b.hidden = false;
    b.textContent = `Could not read the contract (${e.message}). ${lastSync ? "Showing the last values read." : ""}`;
  }
}
function tick() {
  if (!lastSync || !$("#banner").hidden) return;
  const s = Math.round((Date.now() - lastSync) / 1000);
  status($("#sync"), "live", s < 2 ? "Synced just now" : `Synced ${s}s ago`);
}
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);

// ── use: buy, fill, tanks, ask ───────────────────────────────────────────────
function renderUse() {
  renderAccount();
  renderCrossChain();
  renderSeriesPick();
  renderBuyCalc();
  renderMe();
  renderTanks();
  renderAskTanks();
}

function renderAccount() {
  $("#connect").hidden = Boolean(account);
  $("#acct").hidden = !account;
  $("#acct-id").textContent = account ?? "";
  $("#acct-name").textContent = account ?? (watching ? `${watching} (view only)` : "Not connected");
  $("#buy-btn").textContent = account ? "Buy Barrels" : "Connect wallet to buy";
  $("#fill-btn").textContent = account ? "Fill tank" : "Connect wallet";
  $("#mint").hidden = !testnet();
  $("#mint").disabled = !account;
}

function renderSeriesPick() {
  const box = $("#series-pick");
  if (!state) return;
  if (!state.series.length) { box.innerHTML = `<div class="empty"><p class="label">No series is open yet.</p></div>`; return; }
  box.innerHTML = state.series.map((s) => {
    const g = gradeOf(s);
    const open = isOpen(s);
    const blocked = near?.reachable(s.endpoint);
    const sub = !open
      ? `Closed ${utc(s.window_end)}. Holders can refund.`
      : blocked
        ? `<span class="warn">Not reachable from this page: ${escapeHtml(blocked)}.</span>`
        : `${s.firm ? `Firm, ${usdc(s.firm.bond)} ${unit()} bond · ` : ""}Closes ${new Date(s.window_end * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} · operator ${escapeHtml(s.operator)}`;
    return `<button type="button" class="series-opt" role="radio" aria-checked="${s.id === selected}" data-id="${s.id}" ${open ? "" : "disabled"}>
      <span class="radio"></span>
      <span><b>Series ${s.id} · ${escapeHtml(g?.model_id ?? s.grade_id)}</b><span class="label">${sub}</span></span>
      <span class="px"><b class="num">${usdc(s.price_per_barrel)}</b><span class="label">${unit()} / Barrel</span></span>
    </button>`;
  }).join("");
}
$("#series-pick").addEventListener("click", (e) => {
  const b = e.target.closest(".series-opt");
  if (!b || b.disabled) return;
  selected = Number(b.dataset.id);
  renderUse();
  // The escrow and key panels follow the series in view.
  if (state) renderNetwork(state);
});

function renderBuyCalc() {
  const s = seriesById(selected);
  const a = amount($("#buy-amount").value);
  $("#buy-units").textContent = s && a ? barrels((a * UNITS) / BigInt(s.price_per_barrel)) : "–";
}
$("#buy-amount").addEventListener("input", renderBuyCalc);

function renderMe() {
  const s = seriesById(selected);
  const held = me && s ? me.held.get(s.id) ?? 0n : null;
  $("#me-usdc").textContent = me ? usdc(me.usdc) : "–";
  $("#me-barrels").textContent = held === null ? "–" : barrels(held);
  $("#me-barrels-s").textContent = held === null ? "Connect a wallet" : `${int(held)} units of series ${s.id}`;
  $("#fill-held").textContent = held === null ? "–" : barrels(held);
  $("#fill-held-s").innerHTML = held === null ? "Connect a wallet" : held === 0n ? `None yet. <a class="link" href="#buy">Buy Barrels</a> first.` : `${int(held)} units of series ${s.id}`;
  $("#fill-series").textContent = s ? `Series ${s.id} · ${gradeOf(s)?.model_id ?? s.grade_id}` : " ";
  if (held !== null && !$("#fill-amount").value && held > 0n) $("#fill-amount").value = barrels(held).replace(/,/g, "");

  const box = $("#refund");
  const opens = me && s ? me.refundAt.get(s.id) : null;
  $("#next-fill").hidden = !held || !s || !isOpen(s);
  if (!me || !s || !held || held === 0n || opens === null || opens === undefined) { box.hidden = true; return; }
  box.hidden = false;
  const value = (held * BigInt(s.price_per_barrel)) / UNITS;
  if (now() >= opens) {
    box.innerHTML = `<div><b>Series ${s.id} has closed</b><p class="label">Refund your ${barrels(held)} Barrels for ${usdc(value)} ${unit()} from escrow.</p></div><button class="btn btn-primary btn-sm" id="refund-btn" type="button">Refund</button>`;
    $("#refund-btn").addEventListener("click", (e) => send(e.currentTarget, near.txs.refund(contracts(), s.id, held), { label: `Refunded ${barrels(held)} Barrels` }));
  } else {
    box.innerHTML = `<div><b>Unused Barrels are refundable</b><p class="label">From ${utc(opens)} UTC, ${barrels(held)} Barrels return ${usdc(value)} ${unit()}.</p></div>`;
  }
}

$("#buy-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!account) return connectDialog();
  const s = seriesById(selected);
  const a = amount($("#buy-amount").value);
  if (!s) return toast("bad", "Pick a series first.");
  if (!a) return toast("bad", `Enter an amount in ${unit()}.`);
  if (me && me.usdc < a) return toast("bad", `You hold ${usdc(me.usdc)} ${unit()}.`, { detail: testnet() ? "Mint test USDC first: it is the testnet stablecoin." : "" });
  const units = (a * UNITS) / BigInt(s.price_per_barrel);
  send($("#buy-btn"), near.txs.buy(contracts(), s.id, a), { label: `Bought ${barrels(units)} Barrels` });
});

// ── buy from another chain (NEAR Intents 1Click, mainnet only) ─────────────
// EVM chains 1Click names, with their chain ids, for paying from a browser wallet.
const EVM = { eth: 1, base: 8453, arb: 42161, op: 10, pol: 137, avax: 43114, bsc: 56, gnosis: 100 };
let origins = null;
// 1Click's chain ids, by their proper names. Logos: assets/img/chains/<id>.svg.
const CHAINS = { aptos: "Aptos", arb: "Arbitrum", avax: "Avalanche", base: "Base", bsc: "BNB Chain", eth: "Ethereum", gnosis: "Gnosis", hypercore: "Hyperliquid", monad: "Monad", op: "Optimism", pol: "Polygon", sol: "Solana", stellar: "Stellar", sui: "Sui", xlayer: "X Layer" };
const chainName = (id) => CHAINS[id] ?? id;
let xcWatch = null;

async function renderCrossChain() {
  $("#xc").hidden = testnet() || !near;
  if (testnet() || !near || origins) return;
  try {
    // 1Click can list more than one USDC token on a chain. A deposit is quoted by
    // chain, so each chain is listed once, with its first token as before.
    origins = (await near.oneclick.usdcOrigins()).filter((t, i, all) => all.findIndex((x) => x.blockchain === t.blockchain) === i);
    $("#xc-chain").innerHTML = [...origins]
      .sort((a, b) => chainName(a.blockchain).localeCompare(chainName(b.blockchain)))
      .map((t) => `<option value="${escapeHtml(t.blockchain)}" data-icon="${CHAINS[t.blockchain] ? `${ROOT}assets/img/chains/${escapeHtml(t.blockchain)}.svg` : ""}" ${t.blockchain === "base" ? "selected" : ""}>${escapeHtml(chainName(t.blockchain))}</option>`)
      .join("");
  } catch (e) {
    origins = null;
    $("#xc").hidden = true;
  }
}

/** ERC-20 transfer(to, amount) calldata. */
function erc20Transfer(to, amount) {
  return `0xa9059cbb${to.toLowerCase().replace(/^0x/, "").padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`;
}

async function sendFromEvmWallet(origin, quote, btn) {
  const eth = window.ethereum;
  const chainId = `0x${EVM[origin.blockchain].toString(16)}`;
  btn.setAttribute("aria-busy", "true");
  try {
    const [from] = await eth.request({ method: "eth_requestAccounts" });
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    const hash = await eth.request({
      method: "eth_sendTransaction",
      params: [{ from, to: origin.contractAddress, data: erc20Transfer(quote.depositAddress, quote.amountIn), value: "0x0" }],
    });
    await near.oneclick.submitDeposit(hash, quote.depositAddress).catch(() => {});
    toast("ok", `Sent ${quote.amountInFormatted} USDC on ${origin.blockchain}`, { detail: "NEAR Intents is swapping it into Barrels." });
  } catch (e) {
    toast("bad", "The wallet did not send it", { detail: errText(e) });
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

function showDeposit(origin, quote, to) {
  const box = $("#xc-deposit");
  const evm = window.ethereum && EVM[origin.blockchain] && origin.contractAddress;
  box.hidden = false;
  box.innerHTML = `
    <span class="label">Send exactly <b>${escapeHtml(quote.amountInFormatted)} USDC on ${escapeHtml(origin.blockchain)}</b> to</span>
    <div class="xc-addr"><span class="mono" id="xc-addr">${escapeHtml(quote.depositAddress)}</span><button class="btn btn-secondary btn-sm" id="xc-copy" type="button">Copy</button></div>
    <span class="label">About ${usdc(quote.amountOut)} USDC reaches Barrel and buys Barrels for <b>${escapeHtml(to)}</b>. Not finished by ${utc(Date.parse(quote.deadline) / 1000)} UTC, the deposit goes back to your address. Usually ${quote.timeEstimate}s.</span>
    <div class="xc-actions">${evm ? `<button class="btn btn-primary btn-sm" id="xc-send" type="button">Send with my browser wallet</button>` : ""}</div>
    <div class="xc-steps" id="xc-steps"></div>`;
  $("#xc-copy").addEventListener("click", (e) => copyText(quote.depositAddress, e.currentTarget));
  if (evm) $("#xc-send").addEventListener("click", (e) => sendFromEvmWallet(origin, quote, e.currentTarget));
  watchDeposit(quote.depositAddress);
}

const XC_STEPS = [["PENDING_DEPOSIT", "Waiting for your deposit"], ["KNOWN_DEPOSIT_TX", "Deposit seen"], ["PROCESSING", "Swapping"], ["SUCCESS", "Barrels delivered"]];
function watchDeposit(depositAddress) {
  clearInterval(xcWatch);
  const draw = (status) => {
    const at = XC_STEPS.findIndex(([k]) => k === status);
    const bad = ["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(status);
    $("#xc-steps").innerHTML = bad
      ? `<span class="on warn">${status === "INCOMPLETE_DEPOSIT" ? "The deposit was short of the quote; it is being refunded" : `Swap ${status.toLowerCase()}; your deposit goes back to your address`}</span>`
      : XC_STEPS.map(([, label], i) => `<span class="${i <= at ? "on" : ""}">${i <= at ? "●" : "○"} ${label}</span>`).join("");
  };
  draw("PENDING_DEPOSIT");
  const tick = async () => {
    const st = await near.oneclick.swapStatus(depositAddress).catch(() => null);
    if (!st) return;
    draw(st.status);
    if (near.oneclick.finished(st.status)) {
      clearInterval(xcWatch);
      await refresh();
      if (st.status === "SUCCESS") toast("ok", "Barrels arrived from your cross-chain payment", { hash: st.nearTxs.at(-1) });
    }
  };
  xcWatch = setInterval(tick, 5000);
}

$("#xc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  // Barrels can be bought for any NEAR account, including one only being viewed.
  const to = who();
  if (!to) return connectDialog();
  const s = seriesById(selected);
  const a = amount($("#buy-amount").value);
  const origin = origins?.find((t) => t.blockchain === $("#xc-chain").value);
  const refundTo = $("#xc-refund").value.trim();
  if (!s || !a || !origin) return toast("bad", "Pick a series and enter the amount above.");
  if (!refundTo) return toast("bad", `Enter your address on ${origin.blockchain}.`, { detail: "If the swap cannot finish, the deposit is refunded there." });
  // A refused delivery returns the USDC to NEAR Intents rather than to you, so stay under the contract's caps.
  const room = near.oneclick.buyRoom(s, state.config, state.escrow);
  if (a > room) return toast("bad", `Series ${s.id} can take at most ${usdc(room)} USDC right now.`);
  const btn = $("#xc-btn");
  btn.setAttribute("aria-busy", "true");
  try {
    const amountIn = (a * 10n ** BigInt(origin.decimals)) / UNITS;
    const quote = await near.oneclick.quoteBuy({ originAsset: origin.assetId, amount: amountIn, refundTo, contract: deployment.contract, usdc: deployment.usdc, seriesId: s.id, to });
    showDeposit(origin, quote, to);
  } catch (err) {
    toast("bad", "Could not get a quote", { detail: errText(err) });
  } finally {
    btn.removeAttribute("aria-busy");
  }
});

$("#mint").addEventListener("click", (e) => {
  if (!account) return connectDialog();
  send(e.currentTarget, near.txs.mintTestUsdc(contracts(), account, 100n * UNITS), { label: "Minted 100 test USDC" });
});

$("#fill-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!account) return connectDialog();
  const s = seriesById(selected);
  const units = amount($("#fill-amount").value);
  const held = me?.held.get(s?.id) ?? 0n;
  if (!s) return toast("bad", "Pick a series first.");
  if (!units) return toast("bad", "Enter how many Barrels go into the tank.");
  if (units > held) return toast("bad", `You hold ${barrels(held)} Barrels of series ${s.id}.`, { detail: "Buy Barrels first." });
  const agent = $("#fill-agent").value.trim().toLowerCase();
  if (agent && !NEAR_ACCOUNT.test(agent)) return toast("bad", "That is not a NEAR account name.", { detail: "For example agent.near, or a 64-character implicit account." });
  if (agent && agent === account) return toast("bad", "The agent must be another account.", { detail: "Leave the field empty for a tank you use yourself." });
  let pub;
  try {
    pub = near.newTankKey(deployment.contract);
  } catch {
    return toast("bad", "This browser cannot store the tank key.", { detail: "Allow site storage, or use the CLI: pnpm barrel fill." });
  }
  send($("#fill-btn"), near.txs.fill(contracts(), s.id, units, pub, agent || undefined), {
    label: agent ? `Funded a job for ${agent} with ${barrels(units)} Barrels` : `Filled a tank with ${barrels(units)} Barrels`,
    done: (r) => {
      $("#fill-amount").value = "";
      $("#fill-agent").value = "";
      const t = me?.tanks.find((x) => x.key === pub);
      if (t) agentDialog(t);
    },
  });
});

/** NEAR account names: named (agent.near, a.b.testnet) or 64-hex implicit. */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** USDC the tank's leftover is worth at its series price (rounded down). */
function worthOf(t) {
  const s = seriesById(t.series_id);
  return s ? (BigInt(t.balance) * BigInt(s.price_per_barrel)) / 1_000_000n : 0n;
}

function tankStatus(t) {
  if (t.agent) {
    if (t.closed) return ["", t.accepted ? "Agent paid" : "Closed"];
    if (t.accepted) return now() >= t.unlock_at ? ["ok", "Ready to pay the agent"] : ["", `Accepted · pays out in ${span(t.unlock_at - now())}`];
    if (t.unlock_at !== null) return now() >= t.unlock_at ? ["bad", "Rejected · ready to withdraw"] : ["", `Rejected · ${span(t.unlock_at - now())}`];
    return ["ok", "Job · agent working"];
  }
  if (t.closed) return ["", "Closed"];
  if (t.unlock_at !== null) return now() >= t.unlock_at ? ["bad", "Ready to withdraw"] : ["", `Unlocking · ${span(t.unlock_at - now())}`];
  return ["ok", "Active"];
}

/** The tank's latest settled answers, from the contract's recent settlements. */
function tankAnswers(t) {
  const rows = (state?.recent ?? []).filter((r) => r.tank_id === t.id).slice(0, 3);
  if (!rows.length) return t.agent && !t.closed ? `<p class="label">No answers paid yet. Each one the agent asks for appears here once it settles.</p>` : "";
  return `<ul class="tank-answers">${rows.map((r) => `<li><span>#${int(r.seq)}</span><span class="num">${int(r.units)} units</span><span class="label">${ago(r.at)}</span></li>`).join("")}</ul>`;
}

function renderTanks() {
  const box = $("#tank-list");
  if (!who()) {
    box.innerHTML = `<div class="empty"><p class="label">Connect a NEAR wallet to see your tanks.</p><button class="btn btn-primary btn-sm" data-act="connect" type="button">Connect wallet</button></div>`;
    return;
  }
  if (!me?.tanks.length) {
    box.innerHTML = `<div class="empty"><p class="label">${account ? "No tanks yet. Buy Barrels, then fill a tank: it gets a spend key you can hand to an agent." : `${escapeHtml(watching)} has no tanks.`}</p></div>`;
    return;
  }
  box.innerHTML = me.tanks.map((t) => {
    const s = seriesById(t.series_id);
    const g = s ? gradeOf(s) : null;
    const key = near?.secretFor(deployment.contract, t.key);
    const [cls, text] = tankStatus(t);
    const bal = BigInt(t.balance), spent = BigInt(t.spent);
    const used = bal + spent > 0n ? Number((spent * 1000n) / (bal + spent)) / 10 : 0;
    const acts = [];
    if (t.agent && !t.closed && t.accepted) {
      if (now() >= t.unlock_at) {
        acts.push(me.agentReady.get(t.agent) === false
          ? `<button class="btn btn-primary btn-sm" data-act="register" data-id="${t.id}" type="button">Open the agent's ${unit()} account</button>`
          : `<button class="btn btn-primary btn-sm" data-act="withdraw" data-id="${t.id}" type="button">Pay the agent ${usdc(worthOf(t))} ${unit()}</button>`);
      }
    } else if (t.agent && !t.closed && t.unlock_at === null) {
      acts.push(`<button class="btn btn-primary btn-sm" data-act="accept" data-id="${t.id}" type="button">Accept the work</button>`);
      if (key) acts.push(`<button class="btn btn-secondary btn-sm" data-act="agent" data-id="${t.id}" type="button">Give to the agent</button>`);
      acts.push(`<button class="btn btn-secondary btn-sm" data-act="topup" data-id="${t.id}" type="button">Top up</button>`, `<button class="btn btn-secondary btn-sm" data-act="unlock" data-id="${t.id}" type="button">Reject</button>`);
    } else if (!t.closed && t.unlock_at === null) {
      if (key) acts.push(`<button class="btn btn-primary btn-sm" data-act="ask" data-id="${t.id}" type="button">Ask</button>`, `<button class="btn btn-secondary btn-sm" data-act="agent" data-id="${t.id}" type="button">Give to an agent</button>`);
      acts.push(`<button class="btn btn-secondary btn-sm" data-act="topup" data-id="${t.id}" type="button">Top up</button>`, `<button class="btn btn-secondary btn-sm" data-act="unlock" data-id="${t.id}" type="button">Unlock</button>`);
    } else if (!t.closed) {
      if (now() >= t.unlock_at) acts.push(`<button class="btn btn-primary btn-sm" data-act="withdraw" data-id="${t.id}" type="button">Withdraw ${barrels(bal)} Barrels</button>`);
      acts.push(`<button class="btn btn-secondary btn-sm" data-act="topup" data-id="${t.id}" type="button">Top up to keep using it</button>`);
    }
    const job = t.agent
      ? `<p class="label">${t.closed ? (t.accepted ? `The leftover was paid to ${escapeHtml(t.agent)}.` : "The leftover came back to you.") : t.accepted ? `Whatever is left, now ${usdc(worthOf(t))} ${unit()}, is paid to ${escapeHtml(t.agent)}.` : `If you accept the work, the leftover (${usdc(worthOf(t))} ${unit()} now) is paid to the agent. Each answer it asks for comes out of it.`}</p>`
      : "";
    return `<article class="tank ${t.closed ? "closed" : ""}">
      <div class="tank-head"><b>${t.agent ? "Job" : "Tank"} ${t.id}</b><span class="status"><i class="dot ${cls}"></i>${text}</span></div>
      <div class="tank-bal"><b class="num">${int(bal)}</b><span>units left</span></div>
      <div class="tank-meter" title="${used}% spent"><i style="width:${used}%"></i></div>
      <div class="tank-meta">
        <div><span class="label">Model</span><span class="v">${escapeHtml(g?.model_id ?? `series ${t.series_id}`)}</span></div>
        <div><span class="label">Answers paid</span><span class="v num">${int(t.next_seq)}</span></div>
        ${t.agent
          ? `<div><span class="label">Agent</span><span class="v mono" title="${escapeHtml(t.agent)}">${escapeHtml(short(t.agent, 14, 6))}</span></div>`
          : `<div><span class="label">Spend key</span><span class="v">${key ? "In this browser" : "Not here"}</span></div>`}
      </div>
      ${job}${tankAnswers(t)}
      <div class="tank-actions">${account ? acts.join("") : ""}</div>
    </article>`;
  }).join("");
}

$("#tank-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "connect") return connectDialog();
  const t = me?.tanks.find((x) => x.id === Number(b.dataset.id));
  if (!t) return;
  if (act === "ask") { $("#ask-tank").value = String(t.id); $("#ask-tank").dispatchEvent(new Event("change")); go("ask"); $("#ask-q").focus({ preventScroll: true }); }
  if (act === "agent") agentDialog(t);
  if (act === "topup") topUpDialog(t);
  if (act === "unlock") send(b, near.txs.requestUnlock(contracts(), t.id), { label: t.agent ? `Rejected job ${t.id}; the leftover comes back after the unlock delay` : `Tank ${t.id} is unlocking` });
  if (act === "accept") acceptDialog(t);
  if (act === "register") send(b, near.txs.registerUsdc(contracts(), t.agent), { label: `${t.agent} can now receive ${unit()}` });
  if (act === "withdraw") send(b, near.txs.withdraw(contracts(), t.id), {
    label: t.accepted ? `Paid the agent of job ${t.id}` : `Withdrew tank ${t.id}`,
    // A payout the token refused (agent not registered) returns 0 and restores the tank.
    refused: (r) => (t.accepted && String(r.value) === "0" && worthOf(t) > 0n
      ? { title: `The agent could not receive ${unit()}`, detail: `Nothing was lost: the tank is as it was. Open the agent's ${unit()} account, then pay again.` }
      : null),
  });
});

// ── dialogs ──────────────────────────────────────────────────────────────────
const dlg = $("#dlg");
function openDialog(title, html, cls = "") {
  $("#dlg-title").textContent = title;
  $("#dlg-body").innerHTML = html;
  dlg.className = `dlg ${cls}`.trim();
  if (!dlg.open) dlg.showModal();
}

// ── wallet picker ────────────────────────────────────────────────────────────
const WALLET_NOTES = {
  "my-near-wallet": "Web wallet. Opens in a pop-up window.",
  "intear-wallet": "Web wallet.",
  "hot-wallet": "Mobile app, Telegram or browser extension.",
};
let attempt = 0; // the latest sign-in; an older one that settles late is ignored

function connectDialog() {
  if (!near) return toast("bad", "The wallet code is still loading.");
  if (account) return;
  const list = near.wallets();
  const net = deployment.network;
  openDialog("Connect a wallet", `
    <p class="label">Barrel needs a NEAR ${escapeHtml(net)} account to hold Barrels and own tanks. Every transaction opens in your wallet for approval.</p>
    <div class="wallets" id="wallets" role="list">${list.map((w) => `
      <button type="button" class="wallet" role="listitem" data-id="${escapeHtml(w.id)}">
        <img src="${escapeHtml(w.iconUrl)}" alt="" width="32" height="32">
        <span class="wallet-txt"><b>${escapeHtml(w.name)}</b><span class="label" data-note>${escapeHtml(WALLET_NOTES[w.id] ?? "")}</span></span>
        <span class="wallet-go">${ic("arrow-right")}</span>
      </button>`).join("")}
    </div>
    ${net === "testnet" ? `<p class="label">No testnet account yet? <a class="link" href="https://testnet.mynearwallet.com" target="_blank" rel="noopener">Create one in MyNearWallet</a>. It is free.</p>` : ""}`, "dlg-wallets");
  $("#wallets").addEventListener("click", async (e) => {
    const b = e.target.closest(".wallet");
    if (!b) return;
    const w = list.find((x) => x.id === b.dataset.id);
    // Close the picker first. A modal dialog sits above everything else on the
    // page and makes the rest inert, and some wallets (Intear, HOT) draw their
    // own connect screen in the page: it has to be on top and clickable.
    dlg.close();
    const mine = ++attempt;
    const btn = $("#connect");
    btn.textContent = `Connecting ${w.name}…`;
    const done = () => { if (mine === attempt) btn.textContent = "Connect wallet"; };
    // Intear's Close button removes its screen without answering the sign-in.
    // When everything the wallet added to the page is gone again, stop waiting.
    const added = new Set();
    let saw = false;
    const watch = new MutationObserver((list) => {
      for (const m of list) {
        m.addedNodes.forEach((n) => { if (n.nodeType === 1) { added.add(n); saw = true; } });
        m.removedNodes.forEach((n) => added.delete(n));
      }
      if (saw && added.size === 0) { watch.disconnect(); done(); }
    });
    watch.observe(document.body, { childList: true });
    try {
      const id = await near.connectWith(w.id);
      if (mine === attempt && id && !account) { account = id; await readMe(); renderUse(); }
    } catch (err) {
      if (mine === attempt) toast("bad", `${w.name} did not connect`, { detail: errText(err) });
    } finally {
      watch.disconnect();
      done();
    }
  });
}

function agentDialog(t) {
  const secret = near.secretFor(deployment.contract, t.key);
  if (!secret) return toast("bad", `The key for tank ${t.id} is not in this browser.`);
  // BARREL_NETWORK picks the RPC the server reads the contract through, so it must match the contract's network.
  const cmd = `claude mcp add barrel \\\n  -e BARREL_NETWORK=${deployment.network} \\\n  -e BARREL_CONTRACT=${deployment.contract} \\\n  -e BARREL_TANK=${t.id} \\\n  -e BARREL_TANK_KEY=${secret} \\\n  -- node /path/to/barrel/apps/mcp/bin/barrel-mcp.mjs`;
  const shown = escapeHtml(cmd).replace(secret, `<span class="secret">${secret}</span>`);
  openDialog(t.agent ? `Give job ${t.id} to ${t.agent}` : `Give tank ${t.id} to an agent`, `
    <p class="label">This key can spend tank ${t.id} on answers that carry a valid model signature, and nothing else. It cannot transfer, withdraw or refund. ${t.agent ? `When you accept the work, whatever is left is paid to ${escapeHtml(t.agent)}. Reject it and the rest comes back to you.` : "Unlock the tank to take the rest back."}</p>
    <div class="code" id="agent-cmd">${shown}<button class="icon-btn" type="button" id="agent-copy" aria-label="Copy the command">${ic("copy")}</button></div>
    <div class="actions">
      <button class="btn btn-secondary btn-sm" type="button" id="agent-reveal">Show key</button>
      <button class="btn btn-secondary btn-sm" type="button" id="agent-download">Download key file</button>
    </div>
    <p class="label">The MCP server is <code>apps/mcp</code> in the Barrel repository. The key file works with <code>BARREL_TANK_KEY_FILE</code> and the <code>barrel ask</code> CLI.</p>`);
  $("#agent-copy").addEventListener("click", (e) => copyText(cmd.replace(/\\\n\s+/g, "\\\n  "), e.currentTarget));
  $("#agent-reveal").addEventListener("click", (e) => { $("#agent-cmd").classList.toggle("revealed"); e.currentTarget.textContent = $("#agent-cmd").classList.contains("revealed") ? "Hide key" : "Show key"; });
  $("#agent-download").addEventListener("click", () => {
    const body = JSON.stringify({ tank_id: t.id, contract: deployment.contract, network: deployment.network, secret_key: secret, public_key: t.key }, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    a.download = `barrel-tank-${t.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

function acceptDialog(t) {
  const delay = state?.config?.unlock_delay_sec ?? 0;
  openDialog(`Accept job ${t.id}`, `
    <p class="label">The agent stops being served, and after the unlock delay (${span(delay)}) whatever is left, now ${usdc(worthOf(t))} ${unit()}, is paid to <b>${escapeHtml(t.agent)}</b>. Answers it already received are still paid to the operator. This cannot be undone.</p>
    <div class="actions"><button class="btn btn-primary" type="button" id="accept-go">Accept and pay the agent</button></div>`);
  $("#accept-go").addEventListener("click", (e) => {
    send(e.currentTarget, near.txs.accept(contracts(), t.id), { label: `Accepted job ${t.id}`, done: () => dlg.close() });
  });
}

function topUpDialog(t) {
  const held = me?.held.get(t.series_id) ?? 0n;
  openDialog(`Top up tank ${t.id}`, `
    <p class="label">Move Barrels of series ${t.series_id} from your account into the tank. You hold ${barrels(held)}.${t.unlock_at !== null ? " Topping up also cancels the unlock." : ""}</p>
    <label class="field"><span class="label">Barrels</span><span class="input"><input id="top-amount" inputmode="decimal" autocomplete="off" value="${held > 0n ? barrels(held).replace(/,/g, "") : ""}"><span class="unit">Barrels</span></span></label>
    <div class="actions"><button class="btn btn-primary" type="button" id="top-go">Top up</button></div>`);
  $("#top-go").addEventListener("click", (e) => {
    const units = amount($("#top-amount").value);
    if (!units) return toast("bad", "Enter how many Barrels to add.");
    if (units > held) return toast("bad", `You hold ${barrels(held)} Barrels of series ${t.series_id}.`);
    send(e.currentTarget, near.txs.topUp(contracts(), t.id, units), { label: `Added ${barrels(units)} Barrels to tank ${t.id}`, done: () => dlg.close() });
  });
}

$("#import-key").addEventListener("click", () => {
  if (!near) return;
  openDialog("Import a tank key", `
    <p class="label">Paste a tank's spend key (64 hex characters), for example the <code>secret_key</code> from a key file or from <code>.barrel/tanks/</code>. It stays in this browser.</p>
    <textarea id="imp-key" rows="3" spellcheck="false" class="mono" placeholder="e.g. 3f9c…"></textarea>
    <div class="actions"><button class="btn btn-primary" type="button" id="imp-go">Import</button></div>`);
  $("#imp-go").addEventListener("click", () => {
    try {
      const pub = near.importTankKey(deployment.contract, $("#imp-key").value);
      const t = me?.tanks.find((x) => x.key === pub);
      toast("ok", t ? `Key for tank ${t.id} imported.` : "Key imported.", { detail: t ? "" : "No tank of the connected account uses it yet." });
      dlg.close();
      renderUse();
    } catch (e) {
      toast("bad", errText(e));
    }
  });
});

// ── ask ──────────────────────────────────────────────────────────────────────
function askable() {
  return (me?.tanks ?? []).filter((t) => !t.closed && t.unlock_at === null && near?.secretFor(deployment.contract, t.key));
}
function renderAskTanks() {
  const sel = $("#ask-tank");
  const list = askable();
  const keep = sel.value;
  sel.innerHTML = list.length
    ? list.map((t) => `<option value="${t.id}">Tank ${t.id} · ${int(t.balance)} units</option>`).join("")
    : `<option value="">${account ? "No tank with its key in this browser" : "Connect a wallet first"}</option>`;
  if (list.some((t) => String(t.id) === keep)) sel.value = keep;
  $("#ask-btn").disabled = !list.length;
  const hint = $("#ask-hint");
  hint.hidden = list.length > 0;
  hint.innerHTML = !account
    ? `<button class="link-btn" type="button" data-act="connect">Connect a wallet</button> to pay from one of your tanks.`
    : (me?.tanks ?? []).some((t) => !t.closed && t.unlock_at === null)
      ? `Your open tanks' keys are not in this browser. <a class="link" href="#tanks">Import a tank key</a>.`
      : `You need a tank first. <a class="link" href="#tanks">Fill a tank</a>.`;
  renderAskModel();
}
function renderAskModel() {
  const t = me?.tanks.find((x) => x.id === Number($("#ask-tank").value));
  const s = t ? seriesById(t.series_id) : seriesById(selected);
  const g = s ? gradeOf(s) : null;
  $("#ask-model").textContent = g ? `${g.model_id} · paid only on proof` : " ";
}
$("#ask-tank").addEventListener("change", renderAskModel);
$("#ask-hint").addEventListener("click", (e) => { if (e.target.closest("[data-act=connect]")) connectDialog(); });

function checkList(checks) {
  return `<div class="checks">${checks.map((c, i) => `<div class="check ${c.ok ? "ok" : "bad"}" style="--i:${i}"><span class="check-mark">${ic(c.ok ? "check" : "x")}</span><span>${escapeHtml(c.name)}${c.detail ? `<small class="label"> · ${escapeHtml(c.detail)}</small>` : ""}</span></div>`).join("")}</div>`;
}

let lastAsk = null;
$("#ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = me?.tanks.find((x) => x.id === Number($("#ask-tank").value));
  const q = $("#ask-q").value.trim() || $("#ask-q").placeholder;
  if (!t) return toast("bad", "Pick a tank whose key is in this browser.");
  const s = seriesById(t.series_id);
  const g = gradeOf(s);
  const secret = near.secretFor(deployment.contract, t.key);
  const out = $("#ask-out");
  const btn = $("#ask-btn");
  btn.setAttribute("aria-busy", "true");
  out.innerHTML = `<div class="thinking"><span class="dot live"></span>Asking ${escapeHtml(g.model_id)} through ${escapeHtml(new URL(s.endpoint).host)}. Nothing is paid until its signature checks out.</div>`;
  try {
    const priv = $("#ask-private").checked;
    const r = await near.ask({ view: (c, m, a) => view(m, a, c), contractId: deployment.contract, tank: t, grade: g, endpoint: s.endpoint, secretKey: secret, question: q, private: priv });
    lastAsk = r;
    const cost = (r.units * BigInt(s.price_per_barrel)) / UNITS;
    out.innerHTML = `<div class="answer">${escapeHtml(r.content.trim() || "(no visible answer: the token limit went to reasoning)")}</div>
      <div class="answer-meta"><span>Paid ${int(r.units)} units (${usdc(cost, { min: 2 })} ${unit()}) for ${r.usage.prompt_tokens} prompt + ${r.usage.completion_tokens} completion tokens</span>${r.settleTx ? `<a href="${txLink(r.settleTx)}" target="_blank" rel="noopener">Settlement transaction</a>` : "<span>Settlement queued by the operator</span>"}<button class="link-btn" type="button" id="ask-verify">Check this receipt</button></div>
      ${checkList(r.checks)}
      <div class="verdict ok">${ic("shield")}<div><b>Paid on proof</b><span>Your browser verified the model's signature before signing the ack.${r.sealedTo ? " The question and the answer crossed the Pump encrypted." : ""}</span></div></div>`;
    $("#ask-verify").addEventListener("click", () => { show(r.receipt, false, "Your answer"); verify(); go("verify"); });
    await refresh();
  } catch (err) {
    const checks = err?.checks ?? [];
    out.innerHTML = `${checks.length ? checkList(checks) : ""}<div class="verdict bad">${ic("x")}<div><b>Not paid</b><span>${escapeHtml(errText(err))}</span></div></div>`;
  } finally {
    btn.removeAttribute("aria-busy");
  }
});

// ── network panels ───────────────────────────────────────────────────────────
function renderNetwork(s) {
  const t = now();
  // The series in view: the one picked on the Buy page.
  const series = s.series.find((x) => x.id === selected) ?? s.series[0];
  const parts = series ? escrowParts(series) : null;
  const released = s.series.reduce((a, x) => a + BigInt(x.released), 0n);
  const burned = s.series.reduce((a, x) => a + Number(x.burned), 0);

  $("#k-escrow").textContent = usdc(s.escrow);
  $("#k-escrow-s").textContent = parts ? `${int(parts.unspent)} units unspent` : "No series yet";
  if (shown.count !== s.count) { tween($("#k-count"), s.count, { from: shown.count ?? 0, duration: 800 }); shown.count = s.count; }
  const lastAt = Math.max(0, ...s.recent.map((r) => r.at));
  $("#k-count-s").textContent = lastAt ? `Last one ${ago(lastAt, t)}` : "None yet";
  $("#k-released").textContent = usdc(released);
  $("#k-released-s").textContent = `For ${int(burned)} units delivered`;

  const grade = (series && s.grades.find((g) => g.id === series.grade_id)) ?? s.grades[0];
  const keys = (grade && s.keysByGrade?.[grade.id]) ?? s.keys;
  const key = liveKey(keys, t);
  const latest = key ?? [...keys].sort((a, b) => b.expires_at - a.expires_at)[0] ?? null;
  $("#k-key").innerHTML = latest ? `<i class="dot ${key ? "ok" : "bad"}"></i>${key ? "Live" : "Expired"}` : "None";
  $("#k-key-s").textContent = !latest ? "No key registered" : key ? `${span(key.expires_at - t)} left` : `Expired ${ago(latest.expires_at, t)}`;

  if (series) {
    const open = t < series.window_end;
    $("#series-title").textContent = `Series ${series.id}`;
    $("#series-sub").textContent = `${grade?.model_id ?? series.grade_id} · operator ${series.operator}`;
    status($("#series-state"), open ? "ok" : "", open ? "Open" : "Refunding");
    $("#m-price").textContent = `${usdc(series.price_per_barrel)} ${unit()}`;
    $("#m-window").textContent = new Date(series.window_end * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    $("#m-window-s").textContent = open ? `In ${span(series.window_end - t)}, then refunds open` : "Unused Barrels refund";
    $("#m-minted").textContent = barrels(series.minted);
    $("#m-minted-s").textContent = `${pct(series.minted, series.cap_units, 3)} of the ${barrels(series.cap_units)} cap`;
    $("#split-total").textContent = `${usdc(parts.escrowIn)} ${unit()} paid in`;
    renderSplit(parts);
  }

  $("#key-model").textContent = grade ? `Ed25519 key for ${grade.model_id}` : "Ed25519 key";
  status($("#key-state"), key ? "ok" : "bad", key ? "Live" : latest ? "Expired" : "None");
  if (latest) {
    $("#key-hex").textContent = latest.key;
    $("#key-hex").title = latest.key;
    const ttl = grade?.key_ttl_sec ?? latest.expires_at - latest.registered_at;
    const left = Math.max(0, latest.expires_at - t);
    $("#ttl-t").textContent = key ? `${span(left)} of ${span(ttl)} left` : `Expired ${ago(latest.expires_at, t)}`;
    $("#ttl-bar").style.width = `${Math.min(100, (left / ttl) * 100).toFixed(1)}%`;
    $("#ttl-bar").parentElement.classList.toggle("low", left / ttl < 0.15);
    $("#key-reg").textContent = utc(latest.registered_at, true);
    $("#key-exp").textContent = utc(latest.expires_at, true);
    $("#key-ev").textContent = short(latest.evidence_hash, 10, 6);
    $("#key-ev").title = latest.evidence_hash;
  }

  $("#set-count").textContent = `${int(s.count)} total`;
  renderChart(s.recent);
  renderRows(s.recent);

  const c = s.config;
  status($("#c-paused"), c.paused ? "bad" : "ok", c.paused ? "Paused" : "Active");
  const link = (acct) => `<a href="${EXPLORER}/address/${acct}" target="_blank" rel="noopener">${escapeHtml(acct)}</a>`;
  const kv = [
    ["Contract", link(deployment.contract)],
    ["Stablecoin", link(c.usdc)],
    ["Owner", link(c.owner)],
    ["Unlock delay", `${Math.round(c.unlock_delay_sec / 60)} min`],
    ["Settle grace", `${Math.round(c.settle_grace_sec / 3600)} h`],
    ["Escrow cap", `${usdc(c.max_total_escrow, { min: 0 })} ${unit()}`],
    ["Series cap", `${barrels(c.max_series_units)} Barrels`],
    ["Model key TTL", grade ? span(grade.key_ttl_sec) : "–"],
    ...(c.attestor ? [["Keys registered by", link(c.attestor)]] : []),
    ...(c.timelock_sec ? [["Change timelock", span(c.timelock_sec)]] : []),
    ...(c.claim_window_sec ? [["Claim window", span(c.claim_window_sec)]] : []),
    ...(c.guardian ? [["Guardian", link(c.guardian)]] : []),
    ["WASM sha256", `<span title="${escapeHtml(deployment.wasm_sha256 ?? "")}">${escapeHtml(short(deployment.wasm_sha256 ?? "", 10, 6))}</span>`],
  ];
  $("#c-kv").innerHTML = kv.map(([k, v]) => `<div><dt>${k}</dt><dd class="mono">${v}</dd></div>`).join("");
  // What the contract itself guarantees about who registers keys and who can change the code.
  $("#attest-label").textContent = c.attestor && !c.owner_registers_keys ? "Checked on chain before registration" : "Checked before registration";
  if (c.attestor && !c.owner_registers_keys) {
    $("#limit-key").innerHTML = `<h3 class="h4">Who registered the key</h3><p class="label">Only the attestor contract can: it checks Intel's quote, the nonce and the measured software on chain before any key counts. Anyone can run it; the owner cannot add keys.</p>`;
  }
  const money = (changes) => {
    $("#limit-money").innerHTML = testnet()
      ? `<h3 class="h4">Testnet money</h3><p class="label">This build reads the testnet development deployment. tUSDC is a test token with no value. ${changes}</p>`
      : `<h3 class="h4">Real money, low caps</h3><p class="label">This is mainnet USDC. The contract caps how much it holds. ${changes}</p>`;
  };
  if (!c.timelock_sec) money("The contract is upgradeable by its owner key.");
  else {
    const timelock = `Owner, attestor and code changes are announced on chain and wait ${span(c.timelock_sec)} before they apply`;
    money(`${timelock}.`);
    // The timelock binds only if no full-access key can replace the code directly.
    fullKeysRead ??= fullAccessKeys().catch(() => null);
    fullKeysRead.then((n) => {
      if (n === null) return;
      money(n === 0
        ? `${timelock}, and the contract account has no full-access key that could skip it.`
        : `${timelock}. The deploy key still has full access to the contract account and could skip that until it is removed.`);
    });
  }
  first = false;
}

const PARTS = [
  { key: "released", name: "Paid to the operator", color: "var(--d1)" },
  { key: "tanks", name: "Backing tanks", color: "var(--d2)" },
  { key: "wallets", name: "Backing wallets", color: "var(--d3)" },
  { key: "refunded", name: "Refunded or paid to agents", color: "var(--d4)" },
];
const share = (v, total) => {
  const p = (v / total) * 100;
  return v > 0 && p < 0.1 ? `${p.toFixed(3)}%` : `${p.toFixed(1)}%`;
};
function renderSplit(parts) {
  const total = Number(parts.escrowIn) || 1;
  const bar = $("#seg-bar");
  bar.innerHTML = "";
  PARTS.forEach((p, i) => {
    const v = Number(parts[p.key]);
    if (v <= 0) return;
    const el = document.createElement("div");
    el.className = "part";
    el.style.flex = `${v} 1 0`;
    el.style.background = p.color;
    el.style.animationDelay = `${i * 70}ms`;
    el.tabIndex = 0;
    el.setAttribute("aria-label", `${p.name}: ${usdc(parts[p.key])} ${unit()}, ${share(v, total)}`);
    bindTip(el, `<b>${p.name}</b><span class="v">${usdc(parts[p.key])}</span> ${unit()} · ${share(v, total)}`);
    bar.appendChild(el);
  });
  $("#legend").innerHTML = PARTS.map((p) => `<div><i class="sw" style="background:${p.color}"></i><span class="nm">${p.name}</span><span class="v">${usdc(parts[p.key])}<small>${share(Number(parts[p.key]), total)}</small></span></div>`).join("");
}

function niceStep(max, ticks = 5) {
  const raw = Math.max(1, max) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function renderChart(recent) {
  const box = $("#chart");
  const data = [...recent].sort((a, b) => a.at - b.at || a.seq - b.seq).slice(-12);
  if (!data.length) { box.innerHTML = `<div class="vempty"><p class="label">No settlements yet.</p></div>`; return; }
  const W = box.clientWidth || 600, H = box.clientHeight || 168;
  const padL = 40, padT = 20, padB = 24;
  const max = Math.max(...data.map((d) => Number(d.units)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const band = (W - padL) / Math.max(data.length, 4);
  const bw = Math.min(28, band * 0.5);
  let grid = "", axis = "";
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid += `<line x1="${padL}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    axis += `<text x="${padL - 10}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${int(v)}</text>`;
  }
  const maxI = data.findIndex((d) => Number(d.units) === max);
  const lastI = data.length - 1;
  const cols = data.map((d, i) => {
    const cx = padL + band * (i + 0.5);
    const x0 = cx - bw / 2, x1 = cx + bw / 2, yb = y(0), yt = Math.min(yb - 1, y(Number(d.units)));
    const r = Math.min(3, (yb - yt) / 2);
    const path = `M${x0} ${yb}V${yt + r}Q${x0} ${yt} ${x0 + r} ${yt}H${x1 - r}Q${x1} ${yt} ${x1} ${yt + r}V${yb}Z`;
    const cap = i === maxI || i === lastI ? `<text class="cap" x="${cx}" y="${yt - 7}">${int(d.units)}</text>` : "";
    return `<g class="col" tabindex="0" data-i="${i}" aria-label="Tank ${d.tank_id}, answer ${d.seq}: ${d.units} units"><rect class="hit" x="${cx - band / 2}" y="${padT}" width="${band}" height="${H - padT}"/><path class="bar" d="${path}" style="animation-delay:${i * 60}ms"/>${cap}<text x="${cx}" y="${H - 4}" text-anchor="middle">${utc(d.at, true).slice(11)}</text></g>`;
  }).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Units billed per settled answer"><g class="grid">${grid}</g>${axis}${cols}</svg>`;
  $$(".col", box).forEach((g) => {
    const d = data[Number(g.dataset.i)];
    bindTip(g, `<b>Tank ${d.tank_id}, answer ${d.seq}</b><span class="v">${int(d.units)}</span> units · ${utc(d.at, true)} UTC`);
  });
  $("#chart-note").textContent = `Last ${data.length} answers, by settlement time`;
}
function renderRows(recent) {
  const rows = [...recent].sort((a, b) => b.at - a.at || b.seq - a.seq);
  if (!rows.length) { $("#rows").innerHTML = `<tr><td colspan="6" class="muted">No settlements yet.</td></tr>`; return; }
  $("#rows").innerHTML = rows.map((r) => {
    const id = `${r.tank_id}:${r.seq}`;
    const fresh = !first && !seen.has(id);
    seen.add(id);
    return `<tr class="${fresh ? "fresh" : ""}">
      <td>Tank ${r.tank_id} <span class="muted">· ${r.seq}</span></td>
      <td class="r">${int(r.units)}</td>
      <td><span class="mono" title="${r.tee_key}">${short(r.tee_key, 8, 6)}</span></td>
      <td><span class="mono" title="${r.tee_sig}">${short(r.tee_sig, 8, 6)}</span></td>
      <td><span class="mono">${utc(r.at, true)}</span></td>
      <td><span class="status"><i class="dot ok"></i>Verified</span></td>
    </tr>`;
  }).join("");
}
let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => state && renderChart(state.recent), 120); });

// ── verifier ─────────────────────────────────────────────────────────────────
let sample = null, gatewaySample = null, current = null;
/** The bundled receipt was settled on this deployment, or captured from NEAR AI Cloud before anything settled here. */
const sampleLabel = () => (deployment.sample_receipts?.length ? "Receipt from a settled answer" : "Receipt captured from NEAR AI Cloud");
const ta = $("#receipt");
function show(r, changed = false, source = "Receipt") {
  current = r;
  $("#v-src").textContent = source;
  const qa = readReceipt(r);
  $("#v-q").textContent = qa.q || "(no question found)";
  const a = $("#v-a");
  a.textContent = qa.streamed ? "A streamed answer: the gateway, not the model, signed these bytes." : qa.a || "(empty answer: every token went to reasoning)";
  a.classList.toggle("changed", changed);
  fields(r);
  ta.value = JSON.stringify(r, null, 2);
}
function fields(r) {
  $("#v-model").textContent = r.model_id ?? "–";
  const kind = $("#v-kind");
  kind.textContent = r.signature_kind === "provider_tee" ? "The model's TEE" : `The ${r.signature_kind ?? "unknown"} key`;
  kind.classList.toggle("bad", r.signature_kind !== "provider_tee");
  $("#v-key").textContent = short(r.signing_address ?? "", 10, 6) || "–";
  $("#v-req").textContent = short(r.request_hash ?? "", 10, 6) || "–";
  $("#v-res").textContent = short(r.response_hash ?? "", 10, 6) || "–";
}
function idle() {
  status($("#v-state"), "", "Not checked");
  $("#v-result").innerHTML = `<div class="vempty"><p class="label">Press <b>Verify receipt</b>. Your browser hashes the bytes; the contract checks the signature and the key in a free view call.</p></div>`;
}
async function verify() {
  if (!current) return;
  const btn = $("#v-check");
  btn.setAttribute("aria-busy", "true");
  status($("#v-state"), "live", "Checking");
  const res = await checkReceipt(current);
  btn.removeAttribute("aria-busy");
  status($("#v-state"), res.ok ? "ok" : "bad", res.ok ? "Valid" : "Rejected");
  $("#v-result").innerHTML = `<div class="checks">${res.checks.map((c, i) => `<div class="check ${c.note ? "info" : c.ok ? "ok" : "bad"}" style="--i:${i}"><span class="check-mark">${ic(c.note ? "clock" : c.ok ? "check" : "x")}</span><span>${c.html}</span></div>`).join("")}</div>
    <div class="verdict ${res.ok ? "ok" : "bad"}" style="animation-delay:${res.checks.length * 90}ms">${ic(res.ok ? "shield" : "x")}<div><b>${escapeHtml(res.title)}</b><span>${escapeHtml(res.detail)}</span></div></div>`;
}
ta.addEventListener("input", () => {
  try {
    const r = JSON.parse(ta.value);
    current = r;
    const qa = readReceipt(r);
    $("#v-q").textContent = qa.q || "(no question found)";
    $("#v-a").textContent = qa.a || "";
    $("#v-a").classList.remove("changed");
    fields(r);
    idle();
  } catch {
    status($("#v-state"), "bad", "Not valid JSON");
  }
});
$("#v-check").addEventListener("click", verify);
$("#v-reset").addEventListener("click", () => { if (sample) { show(sample, false, sampleLabel()); idle(); } });
$("#v-gateway").addEventListener("click", () => { if (gatewaySample) { show(gatewaySample, false, "Gateway-signed receipt"); verify(); } });
$("#v-tamper").addEventListener("click", () => { if (current) { show(tamper(current), true, "Receipt with a changed answer"); verify(); } });

// ── navigation: one page per sidebar entry, addressed by the URL hash ───────
const links = $$(".side-nav a");
const PAGES = { buy: "Buy", tanks: "Tanks", ask: "Ask", escrow: "Escrow", settlements: "Settlements", verify: "Verify a receipt", contract: "Contract" };
let page = null;
function route() {
  const want = location.hash.slice(1);
  const next = Object.hasOwn(PAGES, want) ? want : "buy";
  closeNav();
  if (next === page) return;
  page = next;
  $$(".page").forEach((p) => { p.hidden = p.dataset.page !== next; });
  links.forEach((a) => {
    const on = a.getAttribute("href") === `#${next}`;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("#top-title").textContent = PAGES[next];
  document.title = `${PAGES[next]} · Barrel`;
  scrollTo(0, 0);
  // the chart measures its box, which has no width while its page is hidden
  if (next === "settlements" && state) renderChart(state.recent);
}
/** Opens a page. Same page: no history entry. */
function go(p) {
  if (location.hash === `#${p}`) route();
  else location.hash = p;
}
addEventListener("hashchange", route);
addEventListener("scroll", () => $("#top").classList.toggle("scrolled", scrollY > 4), { passive: true });
function closeNav() { document.body.classList.remove("nav-open"); }
$("#menu").addEventListener("click", () => document.body.classList.toggle("nav-open"));
$("#scrim").addEventListener("click", closeNav);
links.forEach((a) => a.addEventListener("click", closeNav));
route();

$("#connect").addEventListener("click", connectDialog);
$("#disconnect").addEventListener("click", async () => { await near?.disconnect(); });

// ── boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await loadDeployment(ROOT);
    $("#crumb-contract").textContent = deployment.contract;
    $("#crumb").href = `${EXPLORER}/address/${deployment.contract}`;
    $("#net-name").textContent = `NEAR ${deployment.network}`;
    $$("[data-unit]").forEach((el) => { el.textContent = unit(); });
    $("#key-copy").addEventListener("click", (e) => copyText($("#key-hex").textContent, e.currentTarget));
    ({ sample, gateway: gatewaySample } = await loadSamples(ROOT));
    show(sample, false, sampleLabel());
    idle();
    renderUse();
    await refresh();
  } catch (e) {
    $("#banner").hidden = false;
    $("#banner").textContent = `Could not load deployment data: ${e.message}`;
  }
  // The wallet code is large; it loads after the page can be read.
  try {
    near = await import("./near.bundle.js");
    account = await near.initWallet({
      network: deployment.network,
      onChange: async (id) => { account = id; await readMe(); renderUse(); if (id) toast("ok", `Connected ${id}`); },
    });
    const back = near.returnedTx();
    if (back?.error) toast("bad", "Transaction failed", { detail: back.error });
    else if (back?.hashes.length) toast("ok", "Transaction sent", { hash: back.hashes.at(-1) });
    await readMe();
    renderUse();
  } catch (e) {
    toast("bad", "Could not load the wallet connection.", { detail: errText(e) });
  }
})();
