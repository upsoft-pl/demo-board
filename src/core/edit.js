/**
 * Editor mutations, as pure functions.
 *
 * Every function takes a board and returns a new board. Nothing mutates its
 * input, nothing touches the DOM, nothing generates a random id unless you hand
 * it a factory. That makes the entire editing model testable in milliseconds,
 * and it makes undo a one-liner (keep the previous document).
 *
 * Invariant every mutation preserves: the board still passes validateBoard().
 */

import { createIdFactory, DEFAULT_SCREEN_BG, FULL_CROP } from './schema.js';

const clone = b => structuredClone(b);
const RAND = prefix =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

/** Move an array element, clamping the destination. Returns a new array. */
export function moveItem(list, from, to) {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const clamped = Math.max(0, Math.min(to, out.length - 1));
  out.splice(clamped, 0, out.splice(from, 1)[0]);
  return out;
}

const groupIdx = (b, id) => b.groups.findIndex(g => g.id === id);
const withGroup = (board, groupId, fn) => {
  const b = clone(board);
  const i = groupIdx(b, groupId);
  if (i < 0) return board;                     // unknown id is a no-op, not a crash
  const out = fn(b.groups[i], b);
  if (out === null) return board;
  return b;
};

/* ── groups ──────────────────────────────────────────────────────────────── */

export const DEFAULT_COLORS =
  ['#E9A23B', '#4FC1A0', '#7C8CF8', '#B183E8', '#E4796B', '#5BB8D4', '#C9B24A', '#D07FB0'];

/** Places a new group to the right of everything so it never lands on top. */
export function addGroup(board, { title = 'New group', color, layout = 'auto' } = {}, idf = RAND) {
  const b = clone(board);
  const used = new Set(b.groups.map(g => g.color));
  const pick = color || DEFAULT_COLORS.find(c => !used.has(c)) || DEFAULT_COLORS[b.groups.length % DEFAULT_COLORS.length];
  const rightmost = b.groups.reduce((max, g) => {
    const w = g.screens.reduce((s, x) => s + x.w + 260, 0);
    return Math.max(max, (g.origin?.x ?? 0) + w);
  }, 0);
  b.groups.push({
    id: idf('g'), title, color: pick, blurb: '', layout,
    origin: { x: b.groups.length ? rightmost + 1400 : 0, y: 0 },
    screens: [], steps: [],
  });
  return b;
}

export const updateGroup = (board, groupId, patch) =>
  withGroup(board, groupId, g => { Object.assign(g, patch); });

export function reorderGroups(board, from, to) {
  const b = clone(board);
  b.groups = moveItem(b.groups, from, to);
  return b;
}

export function deleteGroup(board, groupId) {
  const b = clone(board);
  b.groups = b.groups.filter(g => g.id !== groupId);
  return b;
}

/**
 * Switching to manual seeds each screen's pos from where auto had put it, so
 * the layout does not jump the instant you flip the toggle.
 */
export function setGroupLayout(board, groupId, layout, autoPositions) {
  return withGroup(board, groupId, g => {
    if (layout === 'manual') {
      // seed positions from wherever auto had already put things, so flipping
      // the toggle never makes the group jump. Fall back to a stagger rather
      // than stacking everything at the origin.
      let fallback = 0;
      for (const s of g.screens) {
        if (s.pos) continue;
        const p = autoPositions?.[s.id];
        s.pos = p
          ? { x: Math.round(p.x - (g.origin?.x ?? 0)), y: Math.round(p.y - (g.origin?.y ?? 0)) }
          : { x: fallback, y: 0 };
        fallback += s.w + 260;
      }
    }
    g.layout = layout;
  });
}

/* ── screens ─────────────────────────────────────────────────────────────── */

/**
 * @param {object} [spec.pos] group-relative position. Honoured only in manual
 *   layout — it lets a drag-and-drop land the screen where it was dropped.
 */
export function addScreen(board, groupId, { name = 'Untitled screen', src, w, h, keywords = [], pos }, idf = RAND) {
  if (!src || !(w > 0) || !(h > 0)) throw new Error('addScreen needs src and positive intrinsic w/h');
  return withGroup(board, groupId, g => {
    const s = { id: idf('s'), name, src, w, h, keywords };
    if (g.layout === 'manual') {
      if (pos) s.pos = { x: Math.round(pos.x), y: Math.round(pos.y) };
      else {
        // drop it to the right of the current content rather than on top of it
        const right = g.screens.reduce((m, x) => Math.max(m, (x.pos?.x ?? 0) + x.w), 0);
        s.pos = { x: g.screens.length ? right + 260 : 0, y: 0 };
      }
    }
    g.screens.push(s);
  });
}

export const updateScreen = (board, screenId, patch) => {
  const b = clone(board);
  for (const g of b.groups) {
    const s = g.screens.find(x => x.id === screenId);
    if (s) { Object.assign(s, patch); return b; }
  }
  return board;
};

/** Manual layout only — in auto mode positions are derived, not stored. */
export function moveScreen(board, screenId, pos) {
  const b = clone(board);
  for (const g of b.groups) {
    const s = g.screens.find(x => x.id === screenId);
    if (!s) continue;
    if (g.layout !== 'manual') return board;   // refuse rather than write a field nobody reads
    s.pos = { x: Math.round(pos.x), y: Math.round(pos.y) };
    return b;
  }
  return board;
}

export function reorderScreens(board, groupId, from, to) {
  return withGroup(board, groupId, g => { g.screens = moveItem(g.screens, from, to); });
}

/**
 * Deleting a screen must not leave steps pointing at nothing: any step that
 * used it becomes an overview step, and its notes go with the screen.
 */
export function deleteScreen(board, screenId) {
  const b = clone(board);
  for (const g of b.groups) {
    if (!g.screens.some(s => s.id === screenId)) continue;
    g.screens = g.screens.filter(s => s.id !== screenId);
    g.steps = g.steps.filter(st => st.screen !== screenId);
    for (const s of g.screens) {
      if (s.related) s.related = s.related.filter(r => r !== screenId);
    }
    return b;
  }
  return board;
}

/**
 * Relocate a screen into another group, taking every step that shows it — and
 * therefore every note on those steps. A step belongs to a group and points at
 * a screen in that group, so leaving the steps behind would break that rule.
 */
export function moveScreenToGroup(board, screenId, targetGroupId) {
  const b = clone(board);
  const to = b.groups.find(g => g.id === targetGroupId);
  const from = b.groups.find(g => g.screens.some(s => s.id === screenId));
  if (!to || !from || from.id === to.id) return board;

  const screen = from.screens.find(s => s.id === screenId);
  from.screens = from.screens.filter(s => s.id !== screenId);

  const moving = from.steps.filter(st => st.screen === screenId);
  from.steps = from.steps.filter(st => st.screen !== screenId);

  if (to.layout === 'manual') {
    // land it clear of whatever is already there
    const right = to.screens.reduce((m, x) => Math.max(m, (x.pos?.x ?? 0) + x.w), 0);
    screen.pos = { x: to.screens.length ? right + 260 : 0, y: 0 };
  } else {
    delete screen.pos;                       // auto layout derives position
  }
  to.screens.push(screen);
  to.steps.push(...moving);

  // links from screens left behind can no longer be resolved within the group
  for (const g of b.groups) for (const s of g.screens) {
    if (s.related) s.related = s.related.filter(r => r !== screenId || g.id === to.id);
  }
  return b;
}

/* ── steps ───────────────────────────────────────────────────────────────── */

export function addStep(board, groupId, { screen = null, kicker = '', caption = '', gutter = 'right' } = {}, idf = RAND) {
  return withGroup(board, groupId, g => {
    if (screen != null && !g.screens.some(s => s.id === screen)) return null;
    g.steps.push({ id: idf('st'), screen, kicker, caption, gutter, notes: [] });
  });
}

export function updateStep(board, groupId, stepId, patch) {
  return withGroup(board, groupId, g => {
    const st = g.steps.find(s => s.id === stepId);
    if (!st) return null;
    // moving a step to a different screen invalidates its rects
    if ('screen' in patch && patch.screen !== st.screen) st.notes = [];
    if (patch.screen != null && !g.screens.some(s => s.id === patch.screen)) return null;
    Object.assign(st, patch);
  });
}

export const reorderSteps = (board, groupId, from, to) =>
  withGroup(board, groupId, g => { g.steps = moveItem(g.steps, from, to); });

export const deleteStep = (board, groupId, stepId) =>
  withGroup(board, groupId, g => { g.steps = g.steps.filter(s => s.id !== stepId); });

/* ── notes ───────────────────────────────────────────────────────────────── */

/** Clamp a drawn rect into 0..1 and guarantee it has area. */
export function normalizeRect(rect) {
  const x0 = Math.min(rect.x, rect.x + rect.w);
  const y0 = Math.min(rect.y, rect.y + rect.h);
  const x1 = Math.max(rect.x, rect.x + rect.w);
  const y1 = Math.max(rect.y, rect.y + rect.h);
  const cx0 = Math.max(0, Math.min(1, x0));
  const cy0 = Math.max(0, Math.min(1, y0));
  const cx1 = Math.max(0, Math.min(1, x1));
  const cy1 = Math.max(0, Math.min(1, y1));
  const MIN = 0.004;                                   // a click should not make a zero-area rect
  const w = Math.max(MIN, cx1 - cx0);
  const h = Math.max(MIN, cy1 - cy0);
  return {
    x: +Math.min(cx0, 1 - w).toFixed(5),
    y: +Math.min(cy0, 1 - h).toFixed(5),
    w: +w.toFixed(5),
    h: +h.toFixed(5),
  };
}

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Drag one edge or corner of a rect to (px, py), in normalised coordinates.
 * Dragging an edge past its opposite flips the rect rather than inverting it,
 * which is what every drawing tool does and what a hand expects.
 */
export function applyHandle(rect, handle, px, py) {
  if (!HANDLES.includes(handle)) return normalizeRect(rect);
  let l = rect.x, t = rect.y, r = rect.x + rect.w, b = rect.y + rect.h;
  if (handle.includes('w')) l = px;
  if (handle.includes('e')) r = px;
  if (handle.includes('n')) t = py;
  if (handle.includes('s')) b = py;
  return normalizeRect({ x: l, y: t, w: r - l, h: b - t });
}

/** Move a rect by a normalised delta, keeping it fully on the image. */
export function moveRect(rect, dx, dy) {
  const w = rect.w, h = rect.h;
  return {
    x: +Math.max(0, Math.min(1 - w, rect.x + dx)).toFixed(5),
    y: +Math.max(0, Math.min(1 - h, rect.y + dy)).toFixed(5),
    w, h,
  };
}

/**
 * Re-express a rect drawn on one crop of an image in terms of another crop, so
 * an annotation stays on the same pixels when the crop changes.
 */
export function remapRect(rect, from, to) {
  const sx = from.x + rect.x * from.w;
  const sy = from.y + rect.y * from.h;
  return normalizeRect({
    x: (sx - to.x) / to.w,
    y: (sy - to.y) / to.h,
    w: (rect.w * from.w) / to.w,
    h: (rect.h * from.h) / to.h,
  });
}

/** Clamp a crop to the image and stop it collapsing. */
export function normalizeCrop(crop) {
  const r = normalizeRect(crop);
  const MIN = 0.02;                                  // a crop smaller than this is a mis-drag
  return normalizeRect({ x: r.x, y: r.y, w: Math.max(MIN, r.w), h: Math.max(MIN, r.h) });
}

/**
 * Set a screen's crop and carry its annotations across, so the notes keep
 * pointing at the same thing they pointed at before.
 */
export function setScreenCrop(board, screenId, crop) {
  const b = clone(board);
  for (const g of b.groups) {
    const s = g.screens.find(x => x.id === screenId);
    if (!s) continue;
    const from = s.crop ?? FULL_CROP;
    const to = normalizeCrop(crop);
    s.crop = to;
    if (to.x === 0 && to.y === 0 && to.w === 1 && to.h === 1) delete s.crop;
    for (const st of g.steps) {
      if (st.screen !== screenId) continue;
      st.notes = st.notes.map(n => ({ ...n, rect: remapRect(n.rect, from, to) }));
    }
    return b;
  }
  return board;
}

/**
 * Swap the image behind a screen, keeping its identity and every step and note
 * that refers to it. The crop is dropped — it described the old image.
 */
export function replaceScreenImage(board, screenId, { src, w, h }) {
  if (!src || !(w > 0) || !(h > 0)) throw new Error('replaceScreenImage needs src and positive w/h');
  const b = clone(board);
  for (const g of b.groups) {
    const s = g.screens.find(x => x.id === screenId);
    if (!s) continue;
    s.src = src; s.w = w; s.h = h;
    delete s.crop;
    return b;
  }
  return board;
}

export function addNote(board, groupId, stepId, { text = '', rect }, idf = RAND) {
  if (!rect) throw new Error('addNote needs a rect');
  return withGroup(board, groupId, g => {
    const st = g.steps.find(s => s.id === stepId);
    if (!st) return null;
    if (st.screen == null) return null;               // nothing to point at
    st.notes.push({ id: idf('n'), text, rect: normalizeRect(rect) });
  });
}

export function updateNote(board, groupId, stepId, noteId, patch) {
  return withGroup(board, groupId, g => {
    const st = g.steps.find(s => s.id === stepId);
    const n = st?.notes.find(x => x.id === noteId);
    if (!n) return null;
    if (patch.rect) patch = { ...patch, rect: normalizeRect(patch.rect) };
    Object.assign(n, patch);
  });
}

export const reorderNotes = (board, groupId, stepId, from, to) =>
  withGroup(board, groupId, g => {
    const st = g.steps.find(s => s.id === stepId);
    if (!st) return null;
    st.notes = moveItem(st.notes, from, to);
  });

export const deleteNote = (board, groupId, stepId, noteId) =>
  withGroup(board, groupId, g => {
    const st = g.steps.find(s => s.id === stepId);
    if (!st) return null;
    st.notes = st.notes.filter(n => n.id !== noteId);
  });

/* ── board ───────────────────────────────────────────────────────────────── */

/** A new board is fully formed, so saving and loading it round-trips exactly. */
export function createBoard({ title = 'Untitled board', screenBackground = DEFAULT_SCREEN_BG } = {}, idf = RAND) {
  return { version: 1, id: idf('b'), title, screenBackground, groups: [] };
}

export const setBoardTitle = (board, title) => ({ ...clone(board), title });

/** Board-wide default backing for screenshots with transparency. */
export const setBoardBackground = (board, color) => ({ ...clone(board), screenBackground: color });

/** Per-screen override. Pass null to fall back to the board default. */
export function setScreenBackground(board, screenId, color) {
  const b = clone(board);
  for (const g of b.groups) {
    const s = g.screens.find(x => x.id === screenId);
    if (!s) continue;
    if (color == null) delete s.background; else s.background = color;
    return b;
  }
  return board;
}

/** Convenience for tests and for seeding a new board. */
export const withIds = seed => createIdFactory(seed);
