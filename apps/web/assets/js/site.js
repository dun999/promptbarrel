// Landing page: one dithered barrel on a sticky stage carries the hero and the
// four-step story. The hero's numbers are read from the contract; below come
// the comparison, the FAQ and the footer.

import { $, $$, EXPLORER, deployment, loadDeployment, loadSamples, readState, usdc, short, utc, tween, escapeHtml } from "./chain.js";
import { Barrel } from "./barrel.js";
import { paintField } from "./dither.js";
import { initVersus } from "./versus.js";
import { stackSVG, STACK } from "./hardware.js";

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// ── reveal on scroll ─────────────────────────────────────────────────────────
const revealer = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); revealer.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
$$("[data-reveal]").forEach((el) => revealer.observe(el));

// ── the stage ────────────────────────────────────────────────────────────────
const track = $("#track");
const stage = $("#stage");
const hero = $("#hero");
const heroCtas = $(".hero-ctas", hero);
const canvas = $("#barrel");
const scenes = $$(".scene", stage);
const steps = $$(".step", stage);
const stepsBar = $("#steps");
const stepsCap = $("#steps-cap");
const barrel = new Barrel(canvas, { level: 0.66 });

$("#stack-art").innerHTML = stackSVG();
const stackSvg = $(".stack", stage);
const stackBox = $("#stack-box");
const plates = $$(".plate", stage);
const leaders = $$(".leader", stage);
const layers = $$(".layer", stage);
const layerOf = (j) => layers.find((l) => Number(l.dataset.layer) === j);
const wide = matchMedia("(min-width: 1081px)");
let geo = null;             // where the stack drawing sits in its box, when notes hang off it
const segs = $$(".seg", stage);
const checks = $$(".settle-checks li", stage);
const pay = $(".settle-pay", stage);
let hexGroups = [];

const HERO = 0.12;          // share of the track spent moving from hero to story
const W = 0.1;              // width of each zoom transition, in story progress
let pos = null;             // barrel placement for the hero and for the story

function layout() {
  const H = stage.clientHeight, Wd = stage.clientWidth, m = Math.min(Wd, H);
  const navH = 64, stepsH = $("#steps").offsetHeight;
  // hero: the middle of the art cell (offsets, so a scrolled hero's transform does not count)
  const art = $("#hero-art"), cell = art.offsetParent;
  const ax = cell.offsetLeft + art.offsetLeft, ay = cell.offsetTop + art.offsetTop;
  const aw = art.offsetWidth, ah = art.offsetHeight;
  // story: the middle of the area above the steps
  const sTop = navH + 24, sBottom = H - stepsH - 24;
  pos = {
    hero: { cx: (ax + aw / 2) / Wd, cy: (ay + ah * 0.47) / H, size: Math.min(aw * 0.92, ah * 0.96) * 0.34 / m },
    story: { cx: 0.5, cy: (sTop + sBottom) / 2 / H, size: Math.min((sBottom - sTop) * 0.3, Wd * 0.27) / m },
  };
  stackLayout();
}

/** Wide screens hang a note off each plate; narrow ones list the notes beside the stack. */
function stackLayout() {
  const on = wide.matches;
  stackSvg.classList.toggle("compact", !on);
  stackSvg.setAttribute("viewBox", on ? `0 0 ${STACK.width} ${STACK.height}` : STACK.compact);
  geo = null;
  if (!on) {
    layers.forEach((l) => { l.classList.remove("l"); l.style.cssText = ""; });
    return;
  }
  const bw = stackBox.offsetWidth, bh = stackBox.offsetHeight;
  const s = Math.min(bw / STACK.width, bh / STACK.height);
  geo = { s, ox: (bw - STACK.width * s) / 2, oy: (bh - STACK.height * s) / 2 };
  layers.forEach((l) => {
    const left = STACK.side[Number(l.dataset.layer)] < 0;
    const edge = geo.ox + (left ? STACK.left : STACK.right) * s;
    const w = Math.min(340, left ? edge : bw - edge);
    l.classList.toggle("l", left);
    l.style.width = `${w.toFixed(1)}px`;
    l.style.left = `${(left ? edge - w : edge).toFixed(1)}px`;
  });
}

function frame() {
  if (!pos) layout();
  const r = track.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  const p = clamp(-r.top / (r.height - innerHeight));

  // hero → story
  const h = smooth(clamp(p / HERO));
  hero.style.opacity = clamp(1 - h * 1.6).toFixed(3);
  hero.style.transform = `translateY(${(-56 * h).toFixed(1)}px)`;
  hero.style.visibility = h > 0.7 ? "hidden" : "visible";
  stepsBar.style.opacity = clamp((h - 0.35) / 0.65).toFixed(3);

  // story: four scenes
  const q = clamp((p - HERO) / (1 - HERO));
  const SEG = 1 / scenes.length;
  let best = 0, bestVis = -1;
  scenes.forEach((el, i) => {
    const start = i * SEG, end = (i + 1) * SEG;
    // the outgoing scene finishes most of its exit before the next one arrives
    const e = i === 0 ? clamp((h - 0.5) / 0.5) : smooth(clamp((q - (start - W * 0.15)) / W));
    const x = i === scenes.length - 1 ? 0 : smooth(clamp((q - (end - W * 0.85)) / W));
    const local = clamp((q - start) / SEG);
    const vis = clamp(e * (1 - x * 1.15));
    if (vis > bestVis && h > 0.5) { bestVis = vis; best = i; }
    el.style.opacity = vis.toFixed(3);
    el.style.visibility = vis < 0.005 ? "hidden" : "visible";

    if (i === 0) {
      // move to the centre, then push the camera through the front hoop
      const cv = clamp(1 - smooth(clamp((x - 0.45) / 0.55)));
      canvas.style.opacity = cv.toFixed(3);
      cv < 0.01 ? barrel.stop() : barrel.start();
      barrel.set({
        cx: lerp(pos.hero.cx, pos.story.cx, h),
        cy: lerp(pos.hero.cy, pos.story.cy, h),
        size: lerp(pos.hero.size, pos.story.size, h),
        zoom: (1 + local * 0.08) * (1 + 3.6 * x * x),
        focus: clamp(x * 1.6),
        field: 1 - clamp(x * 2.5),
      });
      return;
    }
    const scale = (0.62 + 0.38 * easeOut(e)) * (1 + 1.6 * x * x);
    el.style.transform = `scale(${scale.toFixed(4)})`;

    if (i === 1) {
      // the stack separates from the bottom up; each layer lights as it arrives
      const ex = smooth(clamp(local / 0.55));
      const gap = lerp(20, 104, ex);
      const lit = Math.min(3, Math.floor(clamp((local - 0.06) / 0.66) * 4));
      plates.forEach((pl, j) => {
        const y = STACK.height / 2 + (1.5 - j) * gap + STACK.off;
        pl.setAttribute("transform", `translate(${STACK.cx} ${y.toFixed(1)})`);
        pl.classList.toggle("dim", j > lit);
        pl.classList.toggle("on", j === lit);
        // the leader runs from the plate's corner out to its note
        const side = STACK.side[j], ly = y + STACK.th / 2;
        const x0 = STACK.cx + side * (STACK.widths[j] / 2 + 8), x1 = side < 0 ? STACK.left : STACK.right;
        const [line, a, b] = leaders[j].children;
        line.setAttribute("x1", x0); line.setAttribute("x2", x1);
        line.setAttribute("y1", ly.toFixed(1)); line.setAttribute("y2", ly.toFixed(1));
        a.setAttribute("cx", x0); a.setAttribute("cy", ly.toFixed(1));
        b.setAttribute("cx", x1); b.setAttribute("cy", ly.toFixed(1));
        leaders[j].classList.toggle("dim", j > lit);
        leaders[j].classList.toggle("on", j === lit);
        if (geo) layerOf(j).style.top = `${(geo.oy + ly * geo.s).toFixed(1)}px`;
      });
      layers.forEach((l) => l.classList.toggle("on", Number(l.dataset.layer) === lit));
    }
    if (i === 2) {
      segs.forEach((s, j) => s.classList.toggle("on", local > 0.04 + j * 0.12));
      const n = Math.floor(clamp((local - 0.4) / 0.42) * hexGroups.length);
      hexGroups.forEach((g, j) => g.classList.toggle("on", j < n));
    }
    if (i === 3) {
      checks.forEach((li, j) => li.classList.toggle("on", local > 0.04 + j * 0.1));
      pay.classList.toggle("on", local > 0.6);
    }
  });

  steps.forEach((s, i) => {
    s.style.setProperty("--p", clamp((q - i * SEG) / SEG).toFixed(3));
    s.classList.toggle("on", i === best);
  });
  const cap = $("p", steps[best]).textContent;
  if (stepsCap.textContent !== cap) stepsCap.textContent = cap;
}

let ticking = false;
const schedule = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; frame(); }); } };
addEventListener("scroll", schedule, { passive: true });
addEventListener("resize", () => { pos = null; schedule(); });
document.fonts?.ready.then(() => { pos = null; schedule(); });
frame();

// ── live numbers ─────────────────────────────────────────────────────────────
let shown = { count: 0, units: 0 };
const setLive = (k, v) => $$(`[data-live="${k}"]`).forEach((el) => { el.textContent = v; });
const src = $("#st-src");
async function live() {
  try {
    const s = await readState();
    const burned = s.series.reduce((a, x) => a + Number(x.burned), 0);
    setLive("escrow", usdc(s.escrow));
    tween($('[data-live="count"]'), s.count, { from: shown.count, duration: 900 });
    tween($('[data-live="units"]'), burned, { from: shown.units, duration: 900 });
    shown = { count: s.count, units: burned };
    faq(s);
    $(".dot", src).className = "dot live";
    $("span", src).innerHTML = `Read from <a class="link mono" href="${EXPLORER}/address/${deployment.contract}" target="_blank" rel="noopener">${escapeHtml(deployment.contract)}</a> by your browser, ${utc(s.at / 1000).split(", ")[1]} UTC`;
  } catch (e) {
    $(".dot", src).className = "dot bad";
    $("span", src).textContent = `Could not read the contract right now (${e.message}). These numbers are not live.`;
  }
}

/** The FAQ quotes the contract's own numbers. */
function faq(s) {
  const fill = (k, v) => $$(`[data-faq="${k}"]`).forEach((el) => { el.textContent = v; });
  // Quote the cheapest series on offer.
  const series = [...s.series].sort((a, b) => Number(a.price_per_barrel) - Number(b.price_per_barrel))[0];
  const grade = series ? s.grades.find((g) => g.id === series.grade_id) : null;
  if (series) fill("price", usdc(series.price_per_barrel));
  if (grade) {
    fill("model", grade.model_id);
    fill("weight", `${grade.input_weight_bps / 100}%`);
  }
  const models = new Set(s.series.map((x) => x.grade_id)).size;
  fill("models-note", models > 1 ? `, the cheapest of ${models} models on offer, each in its own series` : "");
  const m = Math.round(Number(s.config.unlock_delay_sec) / 60);
  fill("unlock", `${m} minute${m === 1 ? "" : "s"}`);
  // A contract with an attestor registers keys only after checking Intel's quote on chain.
  if (s.config.attestor) {
    $("#faq-limits").innerHTML = `<p>It does not identify the machine that served the answer. NVIDIA GPU evidence is not checked yet. Model keys are registered by an attestor contract that checks Intel's quote on chain, and anyone can repeat the checks with <code>barrel audit</code>. Ask privately and the operator relays only ciphertext, though it still sees token counts and timing; otherwise it sees prompts and answers in plaintext.</p>`;
  }
}

// ── the comparison ─────────────────────────────────────────────────────────
initVersus($("#vsx"));

// ── footer: a dithered band behind the call to action, and the name ─────────
const mix = (v, a, b) => clamp((v - a) / (b - a));
paintField($("#foot-dither"), {
  rgb: [84, 84, 255],
  cell: 4,
  scale: 0.03,
  // clouds gather to the right and thin out downward, clear of the text; on a
  // narrow screen the text takes the full width, so they keep to the top edge
  density: (u, v, n, aspect) => (aspect < 1.6
    ? mix(n, 0.3, 0.74) * Math.pow(mix(u, 0.45, 1), 1.25) * Math.pow(mix(v, 0.16, 0), 1.2)
    : mix(n, 0.3, 0.74) * Math.pow(mix(u, 0.4, 1), 1.25) * Math.pow(1 - v, 1.1)),
});

const wordmark = $("#wordmark");
/** Set the name's size so six letters span the sheet. */
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

// ── boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await loadDeployment("");
    $("#foot-contract").href = `${EXPLORER}/address/${deployment.contract}`;
    $("#settle-contract").textContent = deployment.contract;
    // The page is written for mainnet; a development build on testnet says so.
    if (deployment.network === "testnet") {
      $$("[data-unit]").forEach((el) => { el.textContent = "tUSDC"; });
      $$("[data-net]").forEach((el) => { el.textContent = "NEAR testnet"; });
      $("#faq-money").innerHTML = `<p>Not on this build. It reads the testnet development deployment, whose test USDC anyone can mint in the app and has no value. The product runs on NEAR mainnet with Circle's USDC.</p>`;
      $("#foot-net").textContent = "Testnet development build. Test USDC has no value.";
    }
    const { sample } = await loadSamples("");
    // the signed text, the signature and the key all come from the same receipt
    $("#sig-model").textContent = sample.model_id;
    $("#sig-req").textContent = short(sample.request_hash, 8, 4);
    $("#sig-res").textContent = short(sample.response_hash, 8, 4);
    $("#sig-hex").innerHTML = sample.signature.match(/.{8}/g).map((g) => `<span>${g}</span>`).join("");
    hexGroups = $$("#sig-hex span");
    $("#sig-key").textContent = `key ${short(sample.signing_address, 8, 4)}`;
    schedule();
    live();
    setInterval(() => { if (!document.hidden) live(); }, 30_000);
  } catch (e) {
    $("span", src).textContent = `Could not load deployment data: ${e.message}`;
  }
})();
