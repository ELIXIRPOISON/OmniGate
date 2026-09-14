/**
 * Draws docs/assets/architecture-{light,dark}.svg.
 *
 * Two files from one source so the pair cannot drift, and two rather than one because GitHub renders
 * a README image inside <picture> and picks by colour scheme. A single light SVG is a white slab in
 * a dark README.
 *
 *   node tools/make-architecture-diagram.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const THEMES = {
  light: {
    bg: '#ffffff',
    surface: '#ffffff',
    surfaceMuted: '#fafafa',
    hairline: '#e4e4e7',
    ink: '#18181b',
    muted: '#71717a',
    brand: '#1a56f0',
    brandSoft: '#eef3ff',
    accent: '#eb6834',
    accentSoft: '#fef1eb',
    store: '#f4f4f5',
  },
  dark: {
    bg: '#18181b',
    surface: '#1f1f23',
    surfaceMuted: '#232327',
    hairline: '#3f3f46',
    ink: '#fafafa',
    muted: '#a1a1aa',
    brand: '#5c85ff',
    brandSoft: '#1e2a52',
    accent: '#eb6834',
    accentSoft: '#3a2318',
    store: '#27272a',
  },
};

const W = 1060;
const H = 528;
const FONT =
  "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function box(t, { x, y, w, h, fill, stroke, r = 8 }) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
}

function text(t, str, { x, y, size = 13, fill, weight = 400, anchor = 'start', mono = false }) {
  return `<text x="${x}" y="${y}" font-family="${mono ? MONO : FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(str)}</text>`;
}

/** A stage in the request pipeline: title plus one line of what it does. */
function stage(t, { x, y, w, h, title, sub, accent = false }) {
  return [
    box(t, {
      x,
      y,
      w,
      h,
      fill: accent ? t.brandSoft : t.surface,
      stroke: accent ? t.brand : t.hairline,
    }),
    text(t, title, {
      x: x + w / 2,
      y: y + 22,
      size: 13,
      weight: 600,
      fill: accent ? t.brand : t.ink,
      anchor: 'middle',
    }),
    ...(sub
      ? [
          text(t, sub, {
            x: x + w / 2,
            y: y + 39,
            size: 10.5,
            fill: t.muted,
            anchor: 'middle',
          }),
        ]
      : []),
  ].join('\n  ');
}

function arrow(t, { x1, y1, x2, y2, color, dashed = false, marker = 'arrow' }) {
  return `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${color}" stroke-width="1.5" fill="none"${dashed ? ' stroke-dasharray="4 3"' : ''} marker-end="url(#${marker})"/>`;
}

function elbow(t, { x1, y1, x2, y2, color, dashed = false, marker = 'arrow' }) {
  const midY = y1 + (y2 - y1) / 2;
  return `<path d="M${x1} ${y1} V${midY} H${x2} V${y2}" stroke="${color}" stroke-width="1.5" fill="none"${dashed ? ' stroke-dasharray="4 3"' : ''} marker-end="url(#${marker})" stroke-linejoin="round"/>`;
}

function render(name) {
  const t = THEMES[name];
  const parts = [];

  parts.push(`<defs>
    <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L8 4 L0 8 z" fill="${t.muted}"/>
    </marker>
    <marker id="arrowBrand" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L8 4 L0 8 z" fill="${t.brand}"/>
    </marker>
    <marker id="arrowAccent" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L8 4 L0 8 z" fill="${t.accent}"/>
    </marker>
  </defs>`);

  parts.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);

  // ---- header --------------------------------------------------------------------------------
  parts.push(text(t, 'OmniGate', { x: 32, y: 40, size: 19, weight: 700, fill: t.ink }));
  parts.push(
    text(t, 'one entry point in front of N services', {
      x: 146,
      y: 40,
      size: 13,
      fill: t.muted,
    }),
  );

  // ---- the data plane ------------------------------------------------------------------------
  const planeY = 72;
  const planeH = 132;
  parts.push(
    box(t, {
      x: 148,
      y: planeY,
      w: 764,
      h: planeH,
      fill: t.surfaceMuted,
      stroke: t.hairline,
      r: 12,
    }),
  );
  parts.push(
    text(t, 'DATA PLANE', {
      x: 164,
      y: planeY + 20,
      size: 9.5,
      weight: 700,
      fill: t.muted,
    }),
  );
  parts.push(
    text(t, 'every stage fails open except auth and rate limit', {
      x: 240,
      y: planeY + 20,
      size: 9.5,
      fill: t.muted,
    }),
  );

  const stages = [
    ['request id', 'X-Request-Id'],
    ['route', 'db + routes.yaml'],
    ['auth', 'JWT / API key'],
    ['rate limit', 'Redis Lua'],
    ['cache', 'GET, TTL'],
    ['screen', '9 signals'],
    ['proxy', 'streams body'],
  ];
  const sw = 100;
  const gap = 8;
  const sx0 = 164;
  const sy = planeY + 34;
  const sh = 54;
  stages.forEach(([title, sub], i) => {
    const x = sx0 + i * (sw + gap);
    parts.push(stage(t, { x, y: sy, w: sw, h: sh, title, sub, accent: title === 'screen' }));
    if (i > 0)
      parts.push(
        arrow(t, {
          x1: x - gap - 1,
          y1: sy + sh / 2,
          x2: x - 2,
          y2: sy + sh / 2,
          color: t.muted,
        }),
      );
  });

  parts.push(
    text(t, 'sub-millisecond inline; anything slower happens after the response', {
      x: 164,
      y: planeY + planeH - 12,
      size: 10,
      fill: t.muted,
    }),
  );

  // ---- client and upstream -------------------------------------------------------------------
  const midY = sy + sh / 2;
  parts.push(box(t, { x: 24, y: midY - 27, w: 104, h: 54, fill: t.surface, stroke: t.hairline }));
  parts.push(text(t, 'Client', { x: 76, y: midY - 4, size: 13, weight: 600, fill: t.ink, anchor: 'middle' }));
  parts.push(text(t, '/api/{service}', { x: 76, y: midY + 13, size: 10, fill: t.muted, anchor: 'middle', mono: true }));
  parts.push(arrow(t, { x1: 128, y1: midY, x2: 146, y2: midY, color: t.muted }));

  parts.push(box(t, { x: 932, y: midY - 27, w: 104, h: 54, fill: t.surface, stroke: t.hairline }));
  parts.push(text(t, 'Upstreams', { x: 984, y: midY - 4, size: 13, weight: 600, fill: t.ink, anchor: 'middle' }));
  parts.push(text(t, 'your services', { x: 984, y: midY + 13, size: 10, fill: t.muted, anchor: 'middle' }));
  parts.push(arrow(t, { x1: 914, y1: midY, x2: 930, y2: midY, color: t.muted }));

  // ---- state ---------------------------------------------------------------------------------
  // Drawn as one strip directly under the plane rather than with a line from every stage: the
  // honest statement is "the stages above share this state", and seven crossing elbows say it worse.
  const storeY = 236;
  parts.push(
    text(t, 'STATE', { x: 148, y: storeY - 8, size: 9.5, weight: 700, fill: t.muted }),
  );
  parts.push(
    text(t, 'shared by the stages above', { x: 196, y: storeY - 8, size: 9.5, fill: t.muted }),
  );
  const stores = [
    ['Redis', 'limits · cache · sender stats · learned route schema', 148, 380],
    ['PostgreSQL', 'routes · keys · anomaly events · partitioned audit log', 540, 372],
  ];
  for (const [title, sub, x, w] of stores) {
    parts.push(box(t, { x, y: storeY, w, h: 52, fill: t.store, stroke: t.hairline }));
    parts.push(text(t, title, { x: x + 14, y: storeY + 21, size: 12.5, weight: 600, fill: t.ink }));
    parts.push(text(t, sub, { x: x + 14, y: storeY + 38, size: 10, fill: t.muted }));
  }
  parts.push(arrow(t, { x1: 338, y1: planeY + planeH, x2: 338, y2: storeY - 2, color: t.hairline }));
  parts.push(arrow(t, { x1: 726, y1: planeY + planeH, x2: 726, y2: storeY - 2, color: t.hairline }));

  // ---- the async path --------------------------------------------------------------------------
  const asyncY = 336;
  parts.push(
    text(t, 'OFF THE HOT PATH', { x: 148, y: asyncY - 8, size: 9.5, weight: 700, fill: t.accent }),
  );
  parts.push(
    text(t, 'the response has already been sent', {
      x: 262,
      y: asyncY - 8,
      size: 9.5,
      fill: t.muted,
    }),
  );
  const asyncBoxes = [
    ['queue', 'BullMQ, gated + sampled', 148, 178],
    ['classify', 'any OpenAI-compatible model', 342, 200],
    ['escalate only', 'may raise a score, never lower it', 558, 222],
    ['audit writer', 'buffered, batched inserts', 796, 168],
  ];
  const ay = asyncY;
  const ah = 52;
  asyncBoxes.forEach(([title, sub, x, w], i) => {
    parts.push(box(t, { x, y: ay, w, h: ah, fill: t.accentSoft, stroke: t.accent, r: 8 }));
    parts.push(text(t, title, { x: x + w / 2, y: ay + 21, size: 12.5, weight: 600, fill: t.ink, anchor: 'middle' }));
    parts.push(text(t, sub, { x: x + w / 2, y: ay + 38, size: 10, fill: t.muted, anchor: 'middle' }));
    if (i > 0 && i < 3)
      parts.push(
        arrow(t, { x1: x - 16, y1: ay + ah / 2, x2: x - 2, y2: ay + ah / 2, color: t.accent, marker: 'arrowAccent' }),
      );
  });
  // Two dashed drops, routed down the outer margins so they cross nothing.
  parts.push(
    `<path d="M${sx0 + 5 * (sw + gap) + sw / 2} ${sy + sh} V${planeY + planeH + 8} H132 V${ay + ah / 2} H146" stroke="${t.accent}" stroke-width="1.5" fill="none" stroke-dasharray="4 3" marker-end="url(#arrowAccent)" stroke-linejoin="round"/>`,
  );
  parts.push(
    `<path d="M${sx0 + 6 * (sw + gap) + sw / 2} ${sy + sh} V${planeY + planeH + 8} H972 V${ay + ah / 2} H966" stroke="${t.accent}" stroke-width="1.5" fill="none" stroke-dasharray="4 3" marker-end="url(#arrowAccent)" stroke-linejoin="round"/>`,
  );
  parts.push(text(t, 'suspicious', { x: 136, y: planeY + planeH + 24, size: 9.5, fill: t.accent, anchor: 'end' }));
  parts.push(text(t, 'every request', { x: 1044, y: planeY + planeH + 24, size: 9.5, fill: t.accent, anchor: 'end' }));

  // ---- control plane ---------------------------------------------------------------------------
  const cpY = 436;
  parts.push(
    text(t, 'CONTROL PLANE', { x: 148, y: cpY - 8, size: 9.5, weight: 700, fill: t.brand }),
  );
  parts.push(box(t, { x: 148, y: cpY, w: 560, h: 58, fill: t.brandSoft, stroke: t.brand, r: 10 }));
  parts.push(text(t, 'Dashboard + Admin API', { x: 166, y: cpY + 23, size: 13, weight: 600, fill: t.brand }));
  parts.push(text(t, '/admin/v1', { x: 690, y: cpY + 23, size: 11, fill: t.brand, anchor: 'end', mono: true }));
  parts.push(
    text(t, 'routes · keys · policies · logs · anomaly review, served by the gateway itself', {
      x: 166,
      y: cpY + 42,
      size: 10.5,
      fill: t.muted,
    }),
  );

  parts.push(box(t, { x: 724, y: cpY, w: 188, h: 58, fill: t.surface, stroke: t.hairline, r: 10 }));
  parts.push(text(t, 'GET /metrics', { x: 742, y: cpY + 23, size: 12, weight: 600, fill: t.ink, mono: true }));
  parts.push(text(t, 'Prometheus, bounded labels', { x: 742, y: cpY + 42, size: 10, fill: t.muted }));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="OmniGate architecture">
  ${parts.join('\n  ')}
</svg>
`;
}

mkdirSync('docs/assets', { recursive: true });
for (const name of Object.keys(THEMES)) {
  const out = `docs/assets/architecture-${name}.svg`;
  writeFileSync(out, render(name));
  console.log('wrote', out);
}
