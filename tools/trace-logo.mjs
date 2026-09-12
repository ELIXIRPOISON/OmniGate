/**
 * Traces the supplied logo artwork (apps/dashboard/src/assets/logo.png) into SVG path data.
 *
 * The artwork is a raster with an alpha channel. Rebuilding the mark by hand from measurements was
 * tried first and drifts: the disc is not a true circle, and the door is not a true parallelogram.
 * Marching squares over the alpha coverage field gives a sub-pixel outline of the real shape, which
 * is then simplified so the result is small enough to inline.
 *
 * Output: apps/dashboard/src/components/brand/logo-paths.ts
 * Run with: node tools/trace-logo.mjs
 */
import fs from 'node:fs';
import { decodePng } from './png-decode.mjs';

const SRC = 'apps/dashboard/src/assets/logo.png';
const OUT = 'apps/dashboard/src/components/brand/logo-paths.ts';
const EPS = 0.12; // simplification tolerance, in units where the mark is 100 wide

const { w, h, ch, px } = decodePng(fs.readFileSync(SRC));
const alpha = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : ch === 4 ? px[(y * w + x) * ch + 3] / 255 : 1);
const rgb = (x, y) => { const i = (y * w + x) * ch; return [px[i], px[i + 1], px[i + 2]]; };

/* ---- marching squares over the coverage field ------------------------------------------------ */

const T = 0.5;
const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
const lerp = (x0, y0, v0, x1, y1, v1) => {
  const t = (T - v0) / (v1 - v0 || 1e-9);
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
};

const segs = [];
for (let y = -1; y < h; y++) {
  for (let x = -1; x < w; x++) {
    const a = alpha(x, y), b = alpha(x + 1, y), c = alpha(x + 1, y + 1), d = alpha(x, y + 1);
    const code = (a > T ? 8 : 0) | (b > T ? 4 : 0) | (c > T ? 2 : 0) | (d > T ? 1 : 0);
    if (code === 0 || code === 15) continue;
    const top = () => lerp(x, y, a, x + 1, y, b);
    const right = () => lerp(x + 1, y, b, x + 1, y + 1, c);
    const bottom = () => lerp(x + 1, y + 1, c, x, y + 1, d);
    const left = () => lerp(x, y + 1, d, x, y, a);
    const push = (p, q) => segs.push([p, q]);
    switch (code) {
      case 1: push(left(), bottom()); break;
      case 2: push(bottom(), right()); break;
      case 3: push(left(), right()); break;
      case 4: push(right(), top()); break;
      case 6: push(bottom(), top()); break;
      case 7: push(left(), top()); break;
      case 8: push(top(), left()); break;
      case 9: push(top(), bottom()); break;
      case 11: push(top(), right()); break;
      case 12: push(right(), left()); break;
      case 13: push(right(), bottom()); break;
      case 14: push(bottom(), left()); break;
      // Saddles: resolve with the cell average so the two strands never cross.
      case 5:
        if ((a + b + c + d) / 4 > T) { push(left(), top()); push(bottom(), right()); }
        else { push(left(), bottom()); push(right(), top()); }
        break;
      case 10:
        if ((a + b + c + d) / 4 > T) { push(top(), right()); push(bottom(), left()); }
        else { push(top(), left()); push(bottom(), right()); }
        break;
    }
  }
}

// Link segments into closed loops. Marching squares does not hand back a consistent winding, so
// the walk is undirected: every contour vertex has exactly two incident segments.
const inc = new Map();
const add = (p, s) => { const k = key(p); if (!inc.has(k)) inc.set(k, []); inc.get(k).push(s); };
for (const s of segs) { add(s[0], s); add(s[1], s); }

const used = new Set();
const loops = [];
for (const seed of segs) {
  if (used.has(seed)) continue;
  used.add(seed);
  const startK = key(seed[0]);
  const loop = [seed[0], seed[1]];
  let tip = seed[1];
  for (;;) {
    const next = (inc.get(key(tip)) ?? []).find((s) => !used.has(s));
    if (!next) break;
    used.add(next);
    tip = key(next[0]) === key(tip) ? next[1] : next[0];
    loop.push(tip);
    if (key(tip) === startK) break;
  }
  if (loop.length > 16) loops.push(loop);
}

/* ---- simplify ------------------------------------------------------------------------------- */

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bd = eps;
    const [x0, y0] = pts[i], [x1, y1] = pts[j];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1e-9;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k][0] - x0) * dy - (pts[k][1] - y0) * dx) / len;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/* ---- normalise and classify ------------------------------------------------------------------ */

// The mark occupies the left group; the wordmark starts after the first wide column gap.
const solid = (x, y) => alpha(x, y) > 0.5;
let ix0 = w, ix1 = 0, iy0 = h, iy1 = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (solid(x, y)) {
  if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
}
let markX1 = ix1, gap = 0;
for (let x = ix0; x <= ix1; x++) {
  let any = false;
  for (let y = iy0; y <= iy1 && !any; y++) if (solid(x, y)) any = true;
  if (!any) { gap++; if (gap > 20) { markX1 = x - gap; break; } } else gap = 0;
}
const markW = markX1 - ix0 + 1;
const K = 100 / markW;
const N = ([x, y]) => [(x - ix0) * K, (y - iy0) * K];

const isBlue = (loop) => {
  // Sample the ink around the loop's bounding box; a hole picks up its parent's colour.
  let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
  for (const [x, y] of loop) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  let blue = 0, dark = 0;
  for (let y = Math.max(0, Math.floor(by0) - 2); y <= Math.min(h - 1, Math.ceil(by1) + 2); y++) {
    for (let x = Math.max(0, Math.floor(bx0) - 2); x <= Math.min(w - 1, Math.ceil(bx1) + 2); x++) {
      if (alpha(x, y) < 0.9) continue;
      const [r, g, b] = rgb(x, y);
      if (b - r > 60 && b > 120) blue++; else if (r + g + b < 260) dark++;
    }
  }
  return blue >= dark;
};

const fmt = (v) => {
  const s = v.toFixed(2).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
/**
 * A closed loop cannot be fed to RDP directly: its first and last point coincide, so the baseline
 * has zero length and every perpendicular distance collapses to zero. Split it at the vertex
 * farthest from the start and simplify the two halves.
 */
const simplifyClosed = (pts, eps) => {
  const p = pts.slice();
  while (p.length > 1 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-9) p.pop();
  if (p.length < 4) return p;
  let far = 1, bd = -1;
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]);
    if (d > bd) { bd = d; far = i; }
  }
  const a = rdp(p.slice(0, far + 1), eps);
  const b = rdp(p.slice(far).concat([p[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
};

const toPath = (loop) => {
  const p = simplifyClosed(loop.map(N), EPS);
  return 'M' + p.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L') + 'Z';
};

const markLoops = [], blueTextLoops = [], inkTextLoops = [];
for (const loop of loops) {
  const cx = loop.reduce((s, p) => s + p[0], 0) / loop.length;
  if (cx <= markX1 + 2) markLoops.push(loop);
  else (isBlue(loop) ? blueTextLoops : inkTextLoops).push(loop);
}

const markPath = markLoops.map(toPath).join('');
const gatePath = blueTextLoops.map(toPath).join('');
const omniPath = inkTextLoops.map(toPath).join('');

const markVB = { w: 100, h: +((iy1 - iy0 + 1) * K).toFixed(2) };
const lockVB = { w: +((ix1 - ix0 + 1) * K).toFixed(2), h: markVB.h };

const banner = `// GENERATED by tools/trace-logo.mjs from apps/dashboard/src/assets/logo.png. Do not hand-edit.
// The supplied artwork is a raster; these are its outlines, traced at sub-pixel accuracy and
// simplified to ${EPS} units, so the mark and wordmark scale and take their fill from the theme.
`;

fs.writeFileSync(
  OUT,
  `${banner}
/** viewBox for the mark on its own. */
export const MARK_VIEWBOX = '0 0 ${markVB.w} ${markVB.h}';
/** viewBox for the full lockup: mark plus wordmark. */
export const LOCKUP_VIEWBOX = '0 0 ${lockVB.w} ${lockVB.h}';

export const MARK_PATH =
  '${markPath}';

export const OMNI_PATH =
  '${omniPath}';

export const GATE_PATH =
  '${gatePath}';
`,
);

// The favicon is generated from the same path so it can never drift from the app's mark.
const dy = -((100 - markVB.h) / 2).toFixed(3);
fs.writeFileSync(
  'apps/dashboard/public/favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${dy} 100 100">\n` +
    `  <path fill="#1a56f0" fill-rule="evenodd" d="${markPath}"/>\n` +
    `</svg>\n`,
);

console.log('loops', loops.length, '-> mark', markLoops.length, 'omni', inkTextLoops.length, 'gate', blueTextLoops.length);
console.log('mark viewBox', MARKVB(markVB), 'lockup viewBox', MARKVB(lockVB));
function MARKVB(v) { return `0 0 ${v.w} ${v.h}`; }
console.log('path bytes  mark', markPath.length, ' omni', omniPath.length, ' gate', gatePath.length);
