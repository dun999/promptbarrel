// The Barrel, as a 1-bit picture: a shaded solid drawn small (one pixel per
// dither cell), then thresholded against an 8 × 8 ordered matrix and blown up
// into square dots. Lit staves thin out to paper, the shaded side fills in,
// and a dithered haze and a ground shadow sit under it. One colour.
//
//   const b = new Barrel(canvas, { level: 0.66 });
//   b.set({ cx: 0.5, cy: 0.5, size: 0.3 });   // place it
//   b.set({ zoom: 3, focus: 1 });             // push the camera into the front hoop

import { BAYER, fbm, grid, blit, rgba } from "./dither.js";

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

const R_MID = 0.76;   // radius at the belly
const R_END = 0.6;    // radius at the heads
const YT = 0.985;     // half height
const radius = (y) => R_MID - (R_MID - R_END) * y * y;
const D = 4.6;        // camera distance
const NA = 56;        // slices around (two per stave)
const NS = 12;        // bands up the side
const WALL = 0.85;    // inner radius of the rim, as a share of the outer

// light from the upper left, a little toward the viewer (view space)
const L = (() => { const v = [-0.58, 0.52, 0.63], m = Math.hypot(...v); return v.map((c) => c / m); })();

export class Barrel {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lo = document.createElement("canvas");
    this.lctx = this.lo.getContext("2d", { willReadFrequently: true });
    this.out = document.createElement("canvas");
    this.octx = this.out.getContext("2d");
    this.o = {
      rgb: [23, 23, 230],
      cell: 3,          // one dither cell, in CSS pixels
      gap: 0,           // space cut between cells, in CSS pixels
      level: 0.66,      // how full it is
      staves: NA / 2,
      hoops: [-0.6, 0.6],
      tilt: 0.5,
      spin: 0.12,
      size: 0.3,        // unit as a fraction of min(width, height)
      cx: 0.5,          // centre, as fractions of the canvas
      cy: 0.5,
      zoom: 1,
      focus: 0,
      focusY: 0.6,
      field: 1,         // strength of the haze and the shadow
      interactive: true,
      intro: true,
      ...options,
    };
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const intro = this.o.intro && !this.reduced;
    this.introNow = intro ? 0 : 1;
    this.level = this.o.level;
    this.zoomNow = this.o.zoom;
    this.cxNow = this.o.cx;
    this.cyNow = this.o.cy;
    this.sizeNow = this.o.size;
    this.fieldNow = this.o.field;
    this.focusNow = this.o.focus;
    this.yaw = 0.3;
    this.time = 0;
    this.ptr = { x: 0, y: 0, sx: 0, sy: 0 };
    this.running = false;
    this.visible = true;
    this.pts = Array.from({ length: NA + 1 }, () => new Array(NS + 1));

    this.#bind();
    this.#resize();
    this.render(0);
  }

  /** Update options. Level, zoom, size and position ease toward the new values. */
  set(patch, { snap = false } = {}) {
    Object.assign(this.o, patch);
    if (snap || this.reduced) {
      if ("level" in patch) this.level = this.o.level;
      if ("zoom" in patch) this.zoomNow = this.o.zoom;
      if ("cx" in patch) this.cxNow = this.o.cx;
      if ("cy" in patch) this.cyNow = this.o.cy;
      if ("size" in patch) this.sizeNow = this.o.size;
      if ("field" in patch) this.fieldNow = this.o.field;
      if ("focus" in patch) this.focusNow = this.o.focus;
    }
    if (!this.running) this.render(0);
  }

  destroy() {
    this.stop();
    this.ro?.disconnect();
    this.io?.disconnect();
    window.removeEventListener("pointermove", this.onPointer);
  }

  // ── setup ────────────────────────────────────────────────────────────────
  #bind() {
    this.ro = new ResizeObserver(() => { this.#resize(); if (!this.running) this.render(0); });
    this.ro.observe(this.canvas);
    this.io = new IntersectionObserver((entries) => {
      this.visible = entries[0].isIntersecting;
      this.visible ? this.start() : this.stop();
    }, { rootMargin: "100px" });
    this.io.observe(this.canvas);
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.visible && this.start()));
    if (this.o.interactive) {
      this.onPointer = (e) => {
        this.ptr.x = (e.clientX / innerWidth) * 2 - 1;
        this.ptr.y = (e.clientY / innerHeight) * 2 - 1;
      };
      window.addEventListener("pointermove", this.onPointer, { passive: true });
    }
  }

  #resize() {
    const g = grid(this.canvas, this.o.cell, this.o.gap);
    this.g = g;
    this.lo.width = this.out.width = g.gw;
    this.lo.height = this.out.height = g.gh;
    this.img = this.octx.createImageData(g.gw, g.gh);
    this.px = new Uint32Array(this.img.data.buffer);
    this.on = rgba(this.o.rgb);
  }

  start() {
    if (this.running || this.reduced) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.render(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Ink density as a grey level: 0 is paper, 255 is solid. */
  #ink(d) {
    const v = Math.round(clamp(d, 0, 1) * 255);
    this.lctx.fillStyle = this.lctx.strokeStyle = `rgb(${v},${v},${v})`;
  }

  // ── frame ────────────────────────────────────────────────────────────────
  render(dt) {
    const o = this.o;
    const g = this.g;
    const c = this.lctx;
    this.time += dt;
    const t = this.time;

    // dt = 0 is a static redraw: eased values hold, except under reduced motion where they snap
    const k = dt > 0 ? 1 - Math.pow(0.002, dt) : this.reduced ? 1 : 0;
    this.level = lerp(this.level, o.level, dt > 0 ? k * 0.5 : k);
    this.zoomNow = lerp(this.zoomNow, o.zoom, k);
    this.cxNow = lerp(this.cxNow, o.cx, k);
    this.cyNow = lerp(this.cyNow, o.cy, k);
    this.sizeNow = lerp(this.sizeNow, o.size, k);
    this.fieldNow = lerp(this.fieldNow, o.field, k);
    this.focusNow = lerp(this.focusNow, o.focus, k);
    this.introNow = Math.min(1, this.introNow + dt * 0.8);
    this.ptr.sx = lerp(this.ptr.sx, this.ptr.x, k * 0.3);
    this.ptr.sy = lerp(this.ptr.sy, this.ptr.y, k * 0.3);
    this.yaw += dt * o.spin;

    const yaw = this.yaw + this.ptr.sx * 0.25;
    const tilt = o.tilt + this.ptr.sy * 0.05;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    // everything below is in dither cells, not pixels
    const unit = Math.min(g.w, g.h) * this.sizeNow * this.zoomNow * g.k;
    const cx = g.w * this.cxNow * g.k;
    let cy = g.h * this.cyNow * g.k;

    const P = (x, y, z) => {
      const x1 = x * cyw + z * syw;
      const z1 = -x * syw + z * cyw;
      const y2 = y * ct - z1 * st;
      const z2 = y * st + z1 * ct;
      const p = D / (D - z2);
      return [cx + x1 * p * unit, cy - y2 * p * unit, z2];
    };
    /** Brightness of a surface with this (unnormalised) world normal; -1 when it faces away. */
    const lit = (nx, ny, nz) => {
      const m = Math.hypot(nx, ny, nz);
      const x1 = (nx * cyw + nz * syw) / m;
      const z1 = (-nx * syw + nz * cyw) / m;
      const y2 = (ny / m) * ct - z1 * st;
      const z2 = (ny / m) * st + z1 * ct;
      if (z2 < -0.14) return -1;
      return Math.max(0, x1 * L[0] + y2 * L[1] + z2 * L[2]);
    };
    if (this.focusNow > 0.0005) {
      const f = P(0, o.focusY, radius(o.focusY));
      cy += (g.h * this.cyNow * g.k - f[1]) * this.focusNow;
    }

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, g.gw, g.gh);
    c.lineJoin = "round";
    c.lineWidth = 0.8;
    const quad = (a, b, d, e) => {
      c.beginPath();
      c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(d[0], d[1]); c.lineTo(e[0], e[1]);
      c.closePath();
      c.fill();
      c.stroke();   // same tone: closes the hairline seams between neighbours
    };
    const loop = (pts) => { c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); };
    const ring = (y, r, n = 72) => {
      const pts = [];
      for (let j = 0; j < n; j++) { const a = (j / n) * TAU; pts.push(P(Math.cos(a) * r, y, Math.sin(a) * r)); }
      return pts;
    };

    // silhouette: left and right extremes per height. The barrel is round, so
    // its outline does not turn with it: sample angles relative to the view
    // and refine the extreme between samples.
    const sil = [];
    const SN = 28, N = 40;
    const xs = new Float64Array(N);
    for (let i = 0; i <= SN; i++) {
      const y = -YT + (2 * YT * i) / SN;
      const r = radius(y);
      const at = (b) => P(Math.cos(b + yaw) * r, y, Math.sin(b + yaw) * r);
      let lo = 0, hi = 0;
      for (let j = 0; j < N; j++) {
        xs[j] = at((j / N) * TAU)[0];
        if (xs[j] < xs[lo]) lo = j;
        if (xs[j] > xs[hi]) hi = j;
      }
      const edge = (j, sign) => {
        const a = sign * xs[(j + N - 1) % N], b = sign * xs[j], d = sign * xs[(j + 1) % N];
        const q = a - 2 * b + d;
        const off = q < 0 ? clamp((0.5 * (a - d)) / q, -0.5, 0.5) : 0;
        return at(((j + off) / N) * TAU);
      };
      sil.push({ l: edge(lo, -1), r: edge(hi, 1) });
    }
    const outline = () => {
      c.beginPath();
      sil.forEach((s, i) => (i ? c.lineTo(s.l[0], s.l[1]) : c.moveTo(s.l[0], s.l[1])));
      for (let i = sil.length - 1; i >= 0; i--) c.lineTo(sil[i].r[0], sil[i].r[1]);
      c.closePath();
    };

    // a mid tone under everything, so no seam can show paper
    this.#ink(0.6);
    outline();
    c.fill();

    // the side: one quad per slice and band, facing the viewer
    for (let i = 0; i <= NA; i++) {
      const a = (i / NA) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      for (let s = 0; s <= NS; s++) {
        const y = -YT + (2 * YT * s) / NS, r = radius(y);
        this.pts[i][s] = P(ca * r, y, sa * r);
      }
    }
    const tone = (b, stave = 0) => clamp(0.97 - b * 1.02 + stave, 0.06, 0.98);
    for (let i = 0; i < NA; i++) {
      const am = ((i + 0.5) / NA) * TAU, ca = Math.cos(am), sa = Math.sin(am);
      // neighbouring staves take the light a little differently
      const stave = ((((i >> 1) * 7) % 5) - 2) * 0.045;
      for (let s = 0; s < NS; s++) {
        const ym = -YT + (2 * YT * (s + 0.5)) / NS;
        const b = lit(ca, 0.32 * ym, sa);
        if (b < 0) continue;
        this.#ink(tone(b, stave));
        quad(this.pts[i][s], this.pts[i + 1][s], this.pts[i + 1][s + 1], this.pts[i][s + 1]);
      }
    }
    // the seams between staves, where the side faces the viewer
    c.lineWidth = 0.7;
    for (let i = 0; i < NA; i += 2) {
      const a = (i / NA) * TAU;
      const b = lit(Math.cos(a), 0, Math.sin(a));
      if (b < 0.12) continue;
      this.#ink(Math.min(1, tone(b) + 0.42));
      c.beginPath();
      for (let s = 0; s <= NS; s++) { const p = this.pts[i][s]; s ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); }
      c.stroke();
    }
    c.lineWidth = 0.8;

    // hoops: dark iron, with a line of paper along each edge so they still
    // read where the side is in shadow
    for (const hy of o.hoops) {
      const y0 = hy - 0.06, y1 = hy + 0.06, r0 = radius(y0) * 1.016, r1 = radius(y1) * 1.016;
      const lo = [], hi = [];
      for (let i = 0; i <= NA; i++) {
        const a = (i / NA) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        lo.push(P(ca * r0, y0, sa * r0));
        hi.push(P(ca * r1, y1, sa * r1));
      }
      const facing = [];
      for (let i = 0; i < NA; i++) {
        const am = ((i + 0.5) / NA) * TAU;
        const b = lit(Math.cos(am), 0.32 * hy, Math.sin(am));
        facing.push(b >= 0);
        if (b < 0) continue;
        this.#ink(clamp(1 - b * b * 0.3, 0.78, 1));
        quad(lo[i], lo[i + 1], hi[i + 1], hi[i]);
      }
      this.#ink(0.04);
      c.lineWidth = 0.9;
      for (const edge of [lo, hi]) {
        c.beginPath();
        let open = false;
        for (let i = 0; i < NA; i++) {
          if (!facing[i]) { open = false; continue; }
          if (!open) { c.moveTo(edge[i][0], edge[i][1]); open = true; }
          c.lineTo(edge[i + 1][0], edge[i + 1][1]);
        }
        c.stroke();
      }
      c.lineWidth = 0.8;
    }

    // the open top: inside wall and liquid, seen through the mouth
    const rt = radius(YT);
    const outer = ring(YT, rt), inner = ring(YT, rt * WALL);
    const lv = clamp(this.level, 0, 1);
    const yl = YT - 0.07 - (1 - lv) * 0.6;
    const rl = radius(yl) * WALL;
    c.save();
    c.beginPath();
    loop(inner);
    c.clip();
    this.#ink(0.96);
    c.fillRect(0, 0, g.gw, g.gh);
    for (let i = 0; i < NA; i++) {
      const a0 = (i / NA) * TAU, a1 = ((i + 1) / NA) * TAU, am = (a0 + a1) / 2;
      const b = lit(-Math.cos(am), 0, -Math.sin(am));
      if (b < 0) continue;
      this.#ink(clamp(0.94 - b * 0.6, 0.3, 0.96));
      quad(
        P(Math.cos(a0) * rl, yl, Math.sin(a0) * rl), P(Math.cos(a1) * rl, yl, Math.sin(a1) * rl),
        P(Math.cos(a1) * rt * WALL, YT, Math.sin(a1) * rt * WALL), P(Math.cos(a0) * rt * WALL, YT, Math.sin(a0) * rt * WALL),
      );
    }
    this.#ink(0.56);
    c.beginPath();
    loop(ring(yl, rl));
    c.fill();
    // slow rings widening across the surface
    for (let j = 0; j < 3; j++) {
      const f = (t * 0.05 + j / 3) % 1;
      this.#ink(0.56 - 0.42 * Math.sin(Math.PI * f));
      c.beginPath();
      loop(ring(yl, rl * Math.min(1, f + 0.11)));
      loop(ring(yl, rl * f).reverse());
      c.fill("evenodd");
    }
    c.restore();

    // the rim, lit from above
    this.#ink(0.05);
    c.beginPath();
    loop(outer);
    loop(inner.slice().reverse());
    c.fill("evenodd");

    // a drawn edge, so the lit side does not dissolve into the paper
    this.#ink(1);
    c.lineWidth = 1;
    outline();
    c.stroke();
    c.lineWidth = 0.75;
    c.beginPath();
    loop(outer);
    c.stroke();

    this.#threshold(P, unit, t);
  }

  /** Read the small picture back, add the haze and the shadow, and ink the cells. */
  #threshold(P, unit, t) {
    const g = this.g;
    const src = this.lctx.getImageData(0, 0, g.gw, g.gh).data;
    const px = this.px;
    const on = this.on;
    const F = clamp(this.fieldNow, 0, 1);
    const intro = easeOut(this.introNow);

    const mid = P(0, 0, 0), base = P(0, -YT, 0);
    const hx = mid[0], hy = mid[1], hrx = unit * 1.75, hry = unit * 1.7;
    const sx = base[0] + unit * 0.3, sy = base[1] + unit * 0.02, srx = unit * 1.45, sry = unit * 0.46;
    const x0 = Math.max(0, Math.floor(hx - hrx)), x1 = Math.min(g.gw, Math.ceil(hx + hrx));
    const y0 = Math.max(0, Math.floor(hy - hry)), y1 = Math.min(g.gh, Math.ceil(Math.max(hy + hry, sy + sry)));
    const fs = 0.034, dx = t * 0.022, dy = t * -0.012;

    px.fill(0);
    for (let y = 0; y < g.gh; y++) {
      const row = y * g.gw;
      const inY = y >= y0 && y < y1;
      for (let x = 0; x < g.gw; x++) {
        const a = src[(row + x) * 4 + 3];
        if (a === 0 && !(inY && x >= x0 && x < x1)) continue;
        let v = 0;
        if (a < 255 && F > 0.004) {
          const ux = (x - hx) / hrx, uy = (y - hy) / hry, d2 = ux * ux + uy * uy;
          if (d2 < 1) {
            const fall = (1 - d2) * (1 - d2);
            const n = fbm(x * fs + dx, y * fs + dy);
            v = F * fall * (0.05 + 0.6 * clamp((n - 0.36) * 2.4, 0, 1));
          }
          const vx = (x - sx) / srx, vy = (y - sy) / sry, s2 = vx * vx + vy * vy;
          if (s2 < 1) v = Math.max(v, F * 0.8 * Math.pow(1 - s2, 1.3));
        }
        if (a > 0) {
          const al = a / 255;
          v = (src[(row + x) * 4] / 255) * al + v * (1 - al);
        }
        if (v * intro > BAYER[(y & 7) * 8 + (x & 7)]) px[row + x] = on;
      }
    }
    this.octx.putImageData(this.img, 0, 0);
    blit(this.ctx, this.out, g);
  }
}
