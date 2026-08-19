/**
 * Pure layout + camera maths.
 *
 * Nothing in here touches the DOM. That is deliberate: the interesting half of
 * the layout problem (does a note ever cover the screenshot?) is arithmetic, and
 * arithmetic can be tested in milliseconds. The DOM half is a dumb style write.
 */

import { effectiveSize } from './schema.js';

export const NOTE_W = 322;
export const MARGIN = 30;
export const TOP_PAD = 34;
export const BOT_PAD = 96;
export const NOTE_GAP = 13;
export const CAPTION_GAP = 26;

// The whole screen-space overlay (notes, leaders, targets, caption) is tuned at
// 1920×1080. Above that the camera fills the bigger window with the screenshot,
// so a fixed-px overlay reads as tiny. `uiScale` grows the overlay as a constant
// fraction of the window — a no-op at or below FHD, capped so it never runs away.
export const UI_REF_W = 1920;
export const UI_REF_H = 1080;
export const UI_SCALE_CAP = 2.2;
export function uiScale(viewport, cap = UI_SCALE_CAP) {
  const s = Math.min(viewport.w / UI_REF_W, viewport.h / UI_REF_H);
  return Math.min(Math.max(s, 1), cap);
}

/**
 * The rectangle of the viewport a screenshot is allowed to occupy.
 * When a step has notes, the gutter on `gutter` side is reserved for them —
 * this is what makes it structurally impossible for a note to cover the image.
 */
export function safeBox(viewport, gutter, hasNotes, scale = 1) {
  const m = MARGIN * scale;
  const g = hasNotes ? NOTE_W * scale + m * 2 : m;
  return {
    l: gutter === 'left' ? g : m,
    r: viewport.w - (gutter === 'right' ? g : m),
    t: TOP_PAD * scale,
    b: viewport.h - BOT_PAD * scale,
  };
}

/** Zoom at which `screen` exactly fits `box`. 1.0 of this === "framed". */
export function fitOf(screen, box) {
  return Math.min((box.r - box.l) / screen.w, (box.b - box.t) / screen.h) * 0.97;
}

/** Camera that frames `screen` inside `box`, given the viewport. */
export function camFor(screen, box, viewport) {
  const z = fitOf(screen, box);
  const bcx = (box.l + box.r) / 2;
  const bcy = (box.t + box.b) / 2;
  return {
    x: screen.x + screen.w / 2 - (bcx - viewport.w / 2) / z,
    y: screen.y + screen.h / 2 - (bcy - viewport.h / 2) / z,
    z,
  };
}

/** Camera that fits an arbitrary world-space box. */
export function camForBox(bb, viewport, pad = 420) {
  return {
    x: (bb.x0 + bb.x1) / 2,
    y: (bb.y0 + bb.y1) / 2,
    z: Math.min(viewport.w / (bb.x1 - bb.x0 + pad), viewport.h / (bb.y1 - bb.y0 + pad)),
  };
}

/** Union of positioned screens. Returns null for an empty set. */
export function boundsOf(placed) {
  if (!placed.length) return null;
  return {
    x0: Math.min(...placed.map(p => p.x)),
    y0: Math.min(...placed.map(p => p.y)),
    x1: Math.max(...placed.map(p => p.x + p.w)),
    y1: Math.max(...placed.map(p => p.y + p.h)),
  };
}

/**
 * "auto" group layout: row-major flow, rows sized by their tallest member,
 * columns by their widest. Deterministic — same input, same board, always.
 */
export function autoLayout(screens, { columns = 3, gap = 240 } = {}) {
  const cols = Math.max(1, Math.min(columns, screens.length || 1));
  const rows = [];
  for (let i = 0; i < screens.length; i += cols) rows.push(screens.slice(i, i + cols));

  // column widths are shared across rows so the grid reads as a grid
  const colW = [];
  rows.forEach(row => row.forEach((s, c) => { colW[c] = Math.max(colW[c] || 0, s.w); }));

  const out = [];
  let y = 0;
  for (const row of rows) {
    const rowH = Math.max(...row.map(s => s.h));
    let x = 0;
    row.forEach((s, c) => {
      // centre each screen in its cell so mixed aspect ratios still line up
      out.push({ id: s.id, x: x + (colW[c] - s.w) / 2, y: y + (rowH - s.h) / 2, w: s.w, h: s.h });
      x += colW[c] + gap;
    });
    y += rowH + gap;
  }
  return out;
}

/**
 * Resolve a screen's world rect, honouring the group's layout mode.
 * Sizes come from effectiveSize, so a cropped screen occupies the space it
 * actually shows rather than the size of its source file.
 */
export function placeScreens(group) {
  const origin = group.origin || { x: 0, y: 0 };
  const sized = group.screens.map(s => ({ id: s.id, pos: s.pos, ...effectiveSize(s) }));
  const base = group.layout === 'manual'
    ? sized.map(s => ({ id: s.id, x: (s.pos?.x ?? 0), y: (s.pos?.y ?? 0), w: s.w, h: s.h }))
    : autoLayout(sized, group.autoLayout);
  return base.map(p => ({ ...p, x: p.x + origin.x, y: p.y + origin.y }));
}

/** A normalised (0..1) hotspot, projected onto a screenshot's on-screen rect. */
export function hotspotToViewport(rect, plateRect) {
  return {
    left: plateRect.left + rect.x * plateRect.width,
    top: plateRect.top + rect.y * plateRect.height,
    width: rect.w * plateRect.width,
    height: rect.h * plateRect.height,
  };
}

/**
 * Stack notes down the reserved gutter.
 *
 * Each note wants to sit level with its hotspot; collisions push the next one
 * down. Everything is clamped inside the viewport, below the caption and above
 * the HUD. Inputs are plain numbers so this is directly unit-testable.
 *
 * @param {object}   a
 * @param {Array}    a.notes          [{ id, hotspot:{left,top,width,height}, height }]
 * @param {object}   a.viewport       { w, h }
 * @param {'left'|'right'} a.gutter
 * @param {number}   [a.captionBottom] y below which notes may start
 * @returns {Array} [{ id, x, y, leader:{ x1,y1,x2,y2,cx }, dot:{x,y} }]
 */
export function computeNoteLayout({ notes, viewport, gutter, captionBottom = null, scale = 1 }) {
  const right = gutter === 'right';
  const noteW = NOTE_W * scale;
  const margin = MARGIN * scale;
  const topPad = TOP_PAD * scale;
  const botPad = BOT_PAD * scale;
  const noteGap = NOTE_GAP * scale;
  const capGap = CAPTION_GAP * scale;
  const x = right ? viewport.w - noteW - margin : margin;
  const cursor0 = captionBottom == null ? topPad : captionBottom + capGap;

  // baseline order: down the gutter by hotspot position. `bi` records that order
  // so a crossing-driven reshuffle can still be tie-broken back towards it.
  const items = notes
    .map((n, i) => ({ ...n, ty: n.hotspot.top + n.hotspot.height / 2 }))
    .sort((a, b) => a.ty - b.ty)
    .map((n, bi) => ({ ...n, bi }));

  // Stack `order` down the gutter; each note wants to sit level with its hotspot,
  // collisions push the next one down. Order changes only the vertical sequence,
  // never lets notes overlap or leave the gutter.
  const stack = order => {
    let cursor = cursor0;
    return order.map(it => {
      let y = Math.max(cursor, it.ty - it.height / 2);
      y = Math.min(y, viewport.h - botPad - it.height + 34 * scale);
      y = Math.max(y, topPad);
      cursor = y + it.height + noteGap;
      const bx = right ? x : x + noteW;
      const hs = it.hotspot;
      // attach to the near edge of the hotspot, never past the note itself
      const tx = right ? Math.min(hs.left + hs.width + 8 * scale, bx - 16 * scale)
                       : Math.max(hs.left - 8 * scale, bx + 16 * scale);
      return { ...it, y, start: { x: tx, y: it.ty }, goal: { x: bx, y: y + it.height / 2 } };
    });
  };

  // route every leader for a candidate order — its own hotspot is the start, the
  // other hotspots are obstacles. Order only shifts each note's slot (goal.y).
  const cache = new Map();
  const evaluate = order => {
    const k = order.map(o => o.id).join('|');
    if (cache.has(k)) return cache.get(k);
    const placed = stack(order);
    const leaders = placed.map(p =>
      routeLeader({ start: p.start, goal: p.goal, obstacles: order.filter(o => o.id !== p.id).map(o => o.hotspot) }));
    const r = { order, placed, leaders, crossings: countLeaderCrossings(leaders), inv: inversions(order) };
    cache.set(k, r);
    return r;
  };
  // fewer crossings first, then closer to hotspot order, then a hair shorter
  const better = (a, b) => a.crossings !== b.crossings ? a.crossings < b.crossings
    : a.inv !== b.inv ? a.inv < b.inv
    : leadersLength(a.leaders) < leadersLength(b.leaders);

  let best = evaluate(items);
  // Only pay for the reshuffle search when the natural order actually crosses.
  // Bounded local search (adjacent swaps) from two seeds — enough to unpick the
  // common crossings without the cost of an all-permutations sweep.
  if (best.crossings > 0) {
    for (const seed of [items, [...items].reverse()]) {
      let cur = evaluate(seed), improved = true, guard = 0;
      while (improved && guard++ < items.length) {
        improved = false;
        for (let i = 0; i < cur.order.length - 1; i++) {
          const swapped = cur.order.slice();
          [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
          const cand = evaluate(swapped);
          if (better(cand, cur)) { cur = cand; improved = true; }
        }
      }
      if (better(cur, best)) best = cur;
    }
  }

  return best.placed.map((it, i) => ({
    id: it.id,
    x,
    y: it.y,
    width: noteW,
    height: it.height,
    leader: best.leaders[i],
    dot: it.start,
  }));
}

/** Inversions of an order versus the baseline hotspot order (its `bi` field). */
function inversions(order) {
  let n = 0;
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++) if (order[i].bi > order[j].bi) n++;
  return n;
}

const polylineLength = pts => {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
};
const leadersLength = leaders => leaders.reduce((s, l) => s + polylineLength(l), 0);

/** Do segments a→b and c→d properly cross (not merely touch at a shared endpoint)? */
function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

/** Number of leader pairs whose polylines cross. */
function countLeaderCrossings(leaders) {
  let n = 0;
  for (let i = 0; i < leaders.length; i++)
    for (let j = i + 1; j < leaders.length; j++) {
      const A = leaders[i], B = leaders[j];
      let hit = false;
      for (let a = 1; a < A.length && !hit; a++)
        for (let b = 1; b < B.length && !hit; b++)
          if (segmentsCross(A[a - 1], A[a], B[b - 1], B[b])) hit = true;
      if (hit) n++;
    }
  return n;
}

export const LEADER_CELL = 10;    // routing grid resolution, px
export const LEADER_MARGIN = 14;  // clearance kept around each obstacle, px
export const LEADER_BIAS = 0.4;   // soft cost per step that moves vertically away from the note

const inflate = (r, m) => ({
  left: r.left - m, top: r.top - m, right: r.left + r.width + m, bottom: r.top + r.height + m,
});
const inside = (px, py, r) => px > r.left && px < r.right && py > r.top && py < r.bottom;

/**
 * Octilinear (H / V / 45° only) route from `start` (the rect) to `goal` (the
 * note edge) that steers around `obstacles` — the other annotation rects.
 *
 * Grid A* on a lattice anchored at `start`, so the rect end sits exactly on a
 * node and the common clear-and-level case collapses to one straight segment.
 * A turn penalty biases toward few bends / long runs; diagonals may not cut an
 * obstacle corner. Returns a simplified polyline [{x,y}, …]; if the goal is
 * unreachable it degrades to a straight [start, goal] rather than nothing.
 *
 * Pure geometry — the whole point of routing here rather than in the DOM is that
 * "does a leader plough through a rect?" is arithmetic, testable in milliseconds.
 */
export function routeLeader({ start, goal, obstacles = [], cell = LEADER_CELL, margin = LEADER_MARGIN, bias = LEADER_BIAS }) {
  const straight = [{ x: start.x, y: start.y }, { x: goal.x, y: goal.y }];
  const infl = obstacles.map(o => inflate(o, margin));

  const pad = cell * 3;
  const xs = [start.x, goal.x, ...infl.flatMap(o => [o.left, o.right])];
  const ys = [start.y, goal.y, ...infl.flatMap(o => [o.top, o.bottom])];
  const iMin = Math.floor((Math.min(...xs) - pad - start.x) / cell);
  const iMax = Math.ceil((Math.max(...xs) + pad - start.x) / cell);
  const jMin = Math.floor((Math.min(...ys) - pad - start.y) / cell);
  const jMax = Math.ceil((Math.max(...ys) + pad - start.y) / cell);
  const rows = jMax - jMin + 1;

  const wx = i => start.x + i * cell, wy = j => start.y + j * cell;
  const key = (i, j) => (i - iMin) * rows + (j - jMin);
  const S = { i: 0, j: 0 };
  const G = {
    i: Math.max(iMin, Math.min(iMax, Math.round((goal.x - start.x) / cell))),
    j: Math.max(jMin, Math.min(jMax, Math.round((goal.y - start.y) / cell))),
  };
  // endpoints are never treated as blocked, even if a rect overlaps them
  const free = (i, j) => {
    if ((i === S.i && j === S.j) || (i === G.i && j === G.j)) return true;
    const px = wx(i), py = wy(j);
    for (const o of infl) if (inside(px, py, o)) return false;
    return true;
  };

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const heur = (i, j) => {
    const dx = Math.abs(i - G.i), dy = Math.abs(j - G.j);
    return (dx + dy) - (2 - Math.SQRT2) * Math.min(dx, dy);   // octile distance
  };
  const TURN = 0.9;                       // bend cost, in straight-step units

  const startK = key(S.i, S.j);
  const gScore = new Map([[startK, 0]]);
  const came = new Map();
  const dir = new Map([[startK, null]]);
  const open = [{ i: S.i, j: S.j, f: heur(S.i, S.j) }];
  const closed = new Set();
  let found = false;
  while (open.length) {
    let b = 0;
    for (let k = 1; k < open.length; k++) if (open[k].f < open[b].f) b = k;
    const cur = open.splice(b, 1)[0];
    const ck = key(cur.i, cur.j);
    if (cur.i === G.i && cur.j === G.j) { found = true; break; }
    if (closed.has(ck)) continue;
    closed.add(ck);
    const cd = dir.get(ck);
    for (const [di, dj] of DIRS) {
      const ni = cur.i + di, nj = cur.j + dj;
      if (ni < iMin || ni > iMax || nj < jMin || nj > jMax) continue;
      if (!free(ni, nj)) continue;
      if (di && dj && (!free(cur.i + di, cur.j) || !free(cur.i, cur.j + dj))) continue; // no corner cut
      const step = di && dj ? Math.SQRT2 : 1;
      const turn = cd && (cd[0] !== di || cd[1] !== dj) ? TURN : 0;
      // steer detours toward the note's side: penalise vertical moves that
      // increase the gap to the goal row, so a leader for a note above a rect
      // goes over it and one for a note below goes under — leaders fan out
      // instead of crossing
      const away = Math.abs(nj - G.j) > Math.abs(cur.j - G.j) ? bias : 0;
      const ng = gScore.get(ck) + step + turn + away;
      const nk = key(ni, nj);
      if (!gScore.has(nk) || ng < gScore.get(nk)) {
        gScore.set(nk, ng); came.set(nk, ck); dir.set(nk, [di, dj]);
        open.push({ i: ni, j: nj, f: ng + heur(ni, nj) });
      }
    }
  }
  if (!found) return straight;

  const path = [];
  const unkey = k => ({ i: Math.floor(k / rows) + iMin, j: (k % rows) + jMin });
  for (let ck = key(G.i, G.j); ck !== undefined; ck = came.get(ck)) {
    const { i, j } = unkey(ck);
    path.push({ x: wx(i), y: wy(j) });
    if (ck === startK) break;
  }
  path.reverse();

  // pin the exact endpoints; the grid put us within half a cell of the note, so
  // close the gap with axis-aligned stubs that stay octilinear
  path[0] = { x: start.x, y: start.y };
  const last = path[path.length - 1];
  if (last.x !== goal.x || last.y !== goal.y) {
    if (last.x !== goal.x && last.y !== goal.y) path.push({ x: goal.x, y: last.y });
    path.push({ x: goal.x, y: goal.y });
  }
  return simplifyOctile(path);
}

/**
 * Collapse each straight/diagonal leg to a single segment: drop any interior
 * point collinear with its neighbours. Dropping on collinearity (not just
 * same-direction) also erases the ≤1-cell overshoot-and-back spike left when the
 * goal falls between grid nodes — a colinear out-and-back reduces to a→c.
 */
function simplifyOctile(pts) {
  const p = pts.filter((q, i) => i === 0 || q.x !== pts[i - 1].x || q.y !== pts[i - 1].y);
  if (p.length <= 2) return p;
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = out[out.length - 1], b = p[i], c = p[i + 1];
    const colinear = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-6;
    if (!colinear) out.push(b);
  }
  out.push(p[p.length - 1]);
  return out;
}

/** SVG path for a leader polyline. Separated so the shape is assertable. */
export function leaderPath(leader) {
  if (!leader || !leader.length) return '';
  return leader.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
}

/**
 * How hard is the camera "looking at" this screen? 1.0 === exactly framed.
 * Expressed as a ratio of the screen's own fit zoom so it behaves identically
 * on any monitor, aspect ratio or screenshot orientation.
 */
export function framingRatio(camZ, screen, viewport) {
  return camZ / fitOf(screen, safeBox(viewport, 'right', false));
}

/** Is this screen roughly centred in the viewport? */
export function isCentred(plateRect, viewport) {
  const cx = plateRect.left + plateRect.width / 2;
  const cy = plateRect.top + plateRect.height / 2;
  return Math.abs(cx - viewport.w / 2) <= viewport.w * 0.45
      && Math.abs(cy - viewport.h / 2) <= viewport.h * 0.48;
}
