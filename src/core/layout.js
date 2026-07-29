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

/**
 * The rectangle of the viewport a screenshot is allowed to occupy.
 * When a step has notes, the gutter on `gutter` side is reserved for them —
 * this is what makes it structurally impossible for a note to cover the image.
 */
export function safeBox(viewport, gutter, hasNotes) {
  const g = hasNotes ? NOTE_W + MARGIN * 2 : MARGIN;
  return {
    l: gutter === 'left' ? g : MARGIN,
    r: viewport.w - (gutter === 'right' ? g : MARGIN),
    t: TOP_PAD,
    b: viewport.h - BOT_PAD,
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
export function computeNoteLayout({ notes, viewport, gutter, captionBottom = null }) {
  const right = gutter === 'right';
  const x = right ? viewport.w - NOTE_W - MARGIN : MARGIN;

  const items = notes
    .map(n => ({ ...n, ty: n.hotspot.top + n.hotspot.height / 2 }))
    .sort((a, b) => a.ty - b.ty);

  let cursor = captionBottom == null ? TOP_PAD : captionBottom + CAPTION_GAP;
  const placed = [];
  for (const it of items) {
    let y = Math.max(cursor, it.ty - it.height / 2);
    y = Math.min(y, viewport.h - BOT_PAD - it.height + 34);
    y = Math.max(y, TOP_PAD);                       // never above the top edge
    placed.push({ ...it, y });
    cursor = y + it.height + NOTE_GAP;
  }

  return placed.map(it => {
    const by = it.y + it.height / 2;
    const bx = right ? x : x + NOTE_W;
    const hs = it.hotspot;
    // attach to the near edge of the hotspot, never past the note itself
    const tx = right
      ? Math.min(hs.left + hs.width + 8, bx - 16)
      : Math.max(hs.left - 8, bx + 16);
    const cx = (bx + tx) / 2;
    return {
      id: it.id,
      x,
      y: it.y,
      width: NOTE_W,
      height: it.height,
      leader: { x1: bx, y1: by, x2: tx, y2: it.ty, cx },
      dot: { x: tx, y: it.ty },
    };
  });
}

/** SVG path for a leader line. Separated so the shape is assertable. */
export function leaderPath(leader) {
  const { x1, y1, x2, y2, cx } = leader;
  return `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
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
