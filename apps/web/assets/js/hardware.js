// The hardware under one answer, as an exploded isometric stack: NVIDIA GPU,
// Intel TDX CPU, the model's signing key, the NEAR contract. Plates are drawn at
// the origin and the page moves each one with a translate. Each plate has a
// dashed leader that runs out to its note, alternating right and left. Fills
// come from CSS, so the plate being read can turn blue.

const f = (n) => Math.round(n * 10) / 10;
const NS = 'vector-effect="non-scaling-stroke"';

const PLATES = [
  { id: "gpu", w: 400, face: gpuFace },
  { id: "cpu", w: 330, face: cpuFace },
  { id: "key", w: 260, face: keyFace },
  { id: "contract", w: 196, face: contractFace },
];

export const STACK = {
  width: 1120,
  height: 600,
  cx: 560,
  off: -36,                 // centres the exploded stack in the box
  th: 22,                   // plate thickness
  widths: PLATES.map((p) => p.w),
  side: [1, -1, 1, -1],     // which way each plate's leader runs
  left: 300,                // where left notes end and right notes begin
  right: 820,
  compact: "340 0 440 600", // the stack alone, for narrow screens
};

export function stackSVG() {
  const th = STACK.th;
  const groups = PLATES.map((p, i) => {
    const w = p.w, h = w / 2;
    const top = `0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`;
    const left = `${-w / 2},0 0,${h / 2} 0,${h / 2 + th} ${-w / 2},${th}`;
    const right = `0,${h / 2} ${w / 2},0 ${w / 2},${th} 0,${h / 2 + th}`;
    const m = `matrix(${f(w / 200)} ${f(h / 200)} ${f(-w / 200)} ${f(h / 200)} 0 ${f(-h / 2)})`;
    return `
    <g class="plate" data-i="${i}">
      <polygon class="pl-l" points="${left}"/>
      <polygon class="pl-r" points="${right}"/>
      <polygon class="pl-t" points="${top}"/>
      <g class="pl-face" transform="${m}">${p.face()}</g>
    </g>`;
  });
  const leaders = PLATES.map((_, i) => `<g class="leader" data-i="${i}"><line/><circle class="a" r="3.5"/><circle class="b" r="3.5"/></g>`);
  return `
<svg class="stack" viewBox="0 0 ${STACK.width} ${STACK.height}" role="img" aria-label="An exploded stack: NVIDIA GPU, Intel TDX CPU, the model signing key, and the NEAR contract">
  <line class="stack-axis" x1="${STACK.cx}" y1="16" x2="${STACK.cx}" y2="${STACK.height - 16}"/>
  ${leaders.join("")}
  ${groups.join("")}
</svg>`;
}

// Faces are drawn in a flat 100 × 100 square and mapped onto the iso top face.
// Each carries the logo of what the plate stands for, lying on the plate.
const logo = (id, x, y, w, h) => `<use class="logo" href="assets/img/logos.svg#${id}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;

// A plate's back corner sits under the plate above it, so the GPU's die and its
// logo are drawn toward the front.
function gpuFace() {
  let s = `<rect x="8" y="8" width="84" height="84" ${NS} opacity=".5"/>`;
  for (let i = 0; i < 4; i++) {
    s += `<rect x="13" y="${16 + i * 18}" width="12" height="14" ${NS}/>`;
    s += `<rect x="75" y="${16 + i * 18}" width="12" height="14" ${NS}/>`;
  }
  s += `<rect x="33" y="16" width="14" height="12" ${NS}/><rect x="53" y="16" width="14" height="12" ${NS}/>`;
  s += `<rect x="30" y="46" width="40" height="38" ${NS}/>`;
  return s + logo("nvidia", 35, 55.1, 30, 19.8);
}

function cpuFace() {
  let s = "";
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
    if (i > 1 && i < 7 && j > 1 && j < 7) continue;
    s += `<circle class="solid" cx="${14 + i * 9}" cy="${14 + j * 9}" r="1.3" opacity=".55"/>`;
  }
  s += `<rect x="28" y="28" width="44" height="44" ${NS}/>`;
  return s + logo("intel", 32, 50, 36, 14);
}

function keyFace() {
  let s = `<circle cx="50" cy="50" r="40" ${NS} opacity=".4"/>`;
  s += `<circle cx="50" cy="50" r="34" ${NS} stroke-dasharray="3 3"/>`;
  return s + logo("nearai", 21, 44.5, 58, 11);
}

function contractFace() {
  const s = `<rect x="14" y="14" width="72" height="72" ${NS}/>`;
  return s + logo("near", 31, 31, 38, 38);
}
