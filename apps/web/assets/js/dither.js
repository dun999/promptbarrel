// 1-bit texture shared by the barrel and the footer band: an 8 × 8 ordered
// dither over a grid of square cells. A picture is a density from 0 to 1 per
// cell; a cell is inked when its density beats the matrix value at its place.

const B8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];
/** Thresholds in (0, 1), indexed by (y & 7) * 8 + (x & 7). */
export const BAYER = Float32Array.from(B8, (v) => (v + 0.5) / 64);

// ── value noise ──────────────────────────────────────────────────────────────
const PERM = new Uint8Array(512);
const VAL = new Float32Array(256);
{
  let seed = 20261113;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) VAL[i] = rand();
}
const hash = (i, j) => VAL[PERM[(PERM[i & 255] + j) & 255]];

export function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Three octaves, 0 to 1. */
export const fbm = (x, y) => noise(x, y) * 0.58 + noise(x * 2.07 + 5.2, y * 2.07 + 1.3) * 0.29 + noise(x * 4.3 + 9.1, y * 4.3 + 3.7) * 0.13;

// ── grid ─────────────────────────────────────────────────────────────────────
/** Size the canvas for its box and return the cell grid that covers it. */
export function grid(canvas, cell, gap = 0) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const px = Math.max(2, Math.round(cell * dpr));          // one cell, in device pixels
  return { w, h, dpr, px, gap: Math.round(gap * dpr), k: dpr / px, gw: Math.ceil(canvas.width / px), gh: Math.ceil(canvas.height / px) };
}

let maskKey = "", mask = null;
/** Scale a one-pixel-per-cell bitmap up to the canvas; with a gap, cut the cells apart into dots. */
export function blit(ctx, small, g) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "copy";
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, g.gw * g.px, g.gh * g.px);
  if (!g.gap) { ctx.globalCompositeOperation = "source-over"; return; }
  const key = `${g.px}:${g.gap}`;
  if (key !== maskKey) {
    const m = document.createElement("canvas");
    m.width = m.height = g.px;
    m.getContext("2d").fillRect(0, 0, g.px - g.gap, g.px - g.gap);
    mask = m;
    maskKey = key;
  }
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = ctx.createPattern(mask, "repeat");
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = "source-over";
}

/** Little-endian RGBA for a Uint32 view of ImageData. */
export const rgba = ([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/**
 * A still dithered field: `density(u, v, n)` gets the cell's position in the
 * box (0 to 1 each way) and a noise value, and returns how much ink it holds.
 * Repaints when the box changes size.
 */
export function paintField(canvas, { rgb = [10, 10, 10], cell = 4, gap = 0, scale = 0.045, density }) {
  const ctx = canvas.getContext("2d");
  const small = document.createElement("canvas");
  const draw = () => {
    const g = grid(canvas, cell, gap);
    small.width = g.gw;
    small.height = g.gh;
    const sctx = small.getContext("2d");
    const img = sctx.createImageData(g.gw, g.gh);
    const px = new Uint32Array(img.data.buffer);
    const on = rgba(rgb);
    const aspect = g.gw / g.gh;
    for (let y = 0; y < g.gh; y++) {
      for (let x = 0; x < g.gw; x++) {
        const d = density(x / g.gw, y / g.gh, fbm(x * scale, y * scale * 1.7), aspect);
        if (d > BAYER[(y & 7) * 8 + (x & 7)]) px[y * g.gw + x] = on;
      }
    }
    sctx.putImageData(img, 0, 0);
    blit(ctx, small, g);
  };
  new ResizeObserver(draw).observe(canvas);
  draw();
}

// ── halftone ─────────────────────────────────────────────────────────────────
/**
 * A moving halftone: round dots on a square grid, each as big as the density
 * under it. `density(u, v, t, aspect)` gets the dot's place in the box (0 to 1
 * each way), the time in seconds and the box's width over its height.
 * Runs only between start() and stop(); draws one still frame under reduced motion.
 */
export class Halftone {
  constructor(canvas, { rgb = [23, 23, 230], cell = 7, density }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.fill = `rgb(${rgb.join(",")})`;
    this.cell = cell;
    this.density = density;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.t = 0;
    this.running = false;
    new ResizeObserver(() => { this.#resize(); this.draw(); }).observe(canvas);
    this.#resize();
    this.draw();
  }

  #resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = Math.max(1, this.canvas.clientWidth);
    this.h = Math.max(1, this.canvas.clientHeight);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
  }

  draw() {
    const { ctx, cell, w, h, density, t } = this;
    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    const aspect = w / h, half = cell / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.fill;
    ctx.beginPath();
    for (let j = 0; j < rows; j++) {
      const y = (j + 0.5) * cell, v = y / h;
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * cell;
        const d = density(x / w, v, t, aspect);
        if (!(d > 0.012)) continue;
        const r = half * Math.sqrt(d < 1 ? d : 1);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, 6.2832);
      }
    }
    ctx.fill();
  }

  start() {
    if (this.running || this.reduced) return;
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.t += Math.min(0.05, (now - last) / 1000);
      last = now;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
