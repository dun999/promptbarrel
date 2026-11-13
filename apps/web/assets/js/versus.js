// The comparison, as five numbered columns. One is open at a time: it widens,
// shows what prepaid credits do and what Barrel does, and runs a small moving
// halftone drawn for that property. The others stay narrow, a number and a name.

import { Halftone, noise, fbm } from "./dither.js";

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (v, a, b) => clamp((v - a) / (b - a));
const smooth = (t) => t * t * (3 - 2 * t);

// Each drawing is a density from 0 to 1 at (u, v) and time t. x = u × aspect
// keeps shapes round whatever the box's proportions.
const ARTS = {
  // paid per answer: bands crossing in a stream, one after another
  stream(u, v, t, a) {
    const x = u * a;
    const band = 0.5 + 0.5 * Math.sin((x * 0.85 + v * 0.6 - t * 0.17) * TAU * 1.15);
    return Math.pow(band, 2.2) * mix(fbm(x * 1.5 - t * 0.1, v * 1.5 + 3), 0.2, 0.68);
  },
  // which model ran: rings spreading from one point, like a seal
  rings(u, v, t, a) {
    const r = Math.hypot(u * a - a * 0.5, v - 0.54);
    if (r < 0.07) return 1;
    const wave = 0.5 + 0.5 * Math.sin(r * 27 - t * 1.5);
    return Math.pow(wave, 1.7) * Math.pow(clamp(1 - r / (a * 0.56)), 0.85);
  },
  // a cheaper model swapped in: tiles that trade places
  tiles(u, v, t, a) {
    const cols = Math.max(2, Math.round(a * 4));       // four rows; as many columns as fit
    const gx = Math.floor(u * cols), gy = Math.floor(v * 4);
    const fx = u * cols - gx, fy = v * 4 - gy;
    if (fx < 0.1 || fx > 0.9 || fy < 0.1 || fy > 0.9) return 0;
    const phase = noise(gx * 13.7 + 0.5, gy * 7.3 + 0.5);
    return 0.05 + 0.9 * smooth(mix(Math.sin(t * 0.8 + phase * TAU + gx * 0.6), -0.25, 0.25));
  },
  // unused balance: a level that drains and comes back
  tide(u, v, t, a) {
    const x = u * a;
    const surface = 0.52 + 0.2 * Math.sin(t * 0.33) + 0.05 * Math.sin(x * 4.2 + t * 1.1) + 0.025 * Math.sin(x * 9.1 - t * 1.7);
    if (v < surface) return 0;
    const depth = (v - surface) / (1 - surface + 0.001);
    return v - surface < 0.035 ? 0.95 : 0.22 + 0.7 * depth;
  },
  // a budget for an agent: bars that rise to a ceiling and no further
  bars(u, v, t, a) {
    const cap = 0.7, y = 1 - v;
    if (Math.abs(y - cap - 0.05) < 0.016) return 0.85;
    const n = Math.max(8, Math.round(a * 7));
    const i = Math.floor(u * n), f = u * n - i;
    if (f < 0.2 || f > 0.8) return 0;
    const want = 0.12 + 0.95 * noise(i * 1.31 + 0.4, t * 0.32 + i * 0.37);
    return y < Math.min(want, cap) ? (want >= cap ? 1 : 0.5) : 0;
  },
};

export function initVersus(root) {
  if (!root) return;
  const items = [...root.querySelectorAll(".vsx-item")];
  const arts = items.map((it) => new Halftone(it.querySelector("canvas"), { density: ARTS[it.dataset.art] }));
  let active = Math.max(0, items.findIndex((it) => it.classList.contains("on")));
  let visible = false;
  const sync = () => arts.forEach((art, i) => (i === active && visible ? art.start() : art.stop()));
  const open = (i) => {
    active = i;
    items.forEach((it, j) => {
      it.classList.toggle("on", j === i);
      it.querySelector(".vsx-tab").setAttribute("aria-expanded", String(j === i));
    });
    sync();
  };
  items.forEach((it, i) => it.querySelector(".vsx-tab").addEventListener("click", () => open(i)));
  new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; sync(); }, { rootMargin: "80px" }).observe(root);
  open(active);
}
