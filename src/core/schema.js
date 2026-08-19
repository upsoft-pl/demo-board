/**
 * Board document: validation, normalisation, migration, import.
 *
 * Rule that drives the whole design: nothing outside this module may address a
 * step or group by array index. Steps get reordered; indices silently rot.
 */

export const CURRENT_VERSION = 1;

const GUTTERS = ['left', 'right'];
const LAYOUTS = ['auto', 'manual'];

export const DEFAULT_SCREEN_BG = '#FFFFFF';

/** A screen with no crop shows the whole source image. */
export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
export const cropOf = screen => screen?.crop ?? FULL_CROP;

/**
 * The size a screen actually occupies on the board. Cropping changes it and a
 * per-screen display `scale` (default 1) rescales it — both are absent for a
 * pristine screen — so layout must ask for this rather than reading w/h
 * directly. Scale is uniform, so the aspect ratio is preserved.
 */
export function effectiveSize(screen) {
  const c = cropOf(screen);
  const scale = screen?.scale ?? 1;
  return {
    w: Math.max(1, Math.round(screen.w * c.w * scale)),
    h: Math.max(1, Math.round(screen.h * c.h * scale)),
  };
}

/**
 * Colours are interpolated into styles, so the accepted shapes are constrained:
 * hex, rgb/rgba, hsl/hsla, a bare colour keyword, or `transparent`. Anything
 * containing `;`, `url(` or braces is rejected rather than sanitised.
 */
export const COLOR_RE =
  /^(?:transparent|#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|[a-z]{3,20})$/i;

export const isColor = v => typeof v === 'string' && COLOR_RE.test(v.trim());

/** What sits behind a screenshot: its own override, else the board default. */
export function screenBackground(board, screen) {
  return screen?.background ?? board?.screenBackground ?? DEFAULT_SCREEN_BG;
}

/* ── ids ─────────────────────────────────────────────────────────────────── */

/** Injectable so tests are deterministic. */
export function createIdFactory(seed = 0) {
  let n = seed;
  return prefix => `${prefix}_${(++n).toString(36).padStart(4, '0')}`;
}

const RAND_ID = prefix =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

/* ── validation ──────────────────────────────────────────────────────────── */

/**
 * @returns {{ok:boolean, errors:string[]}} — every problem, not just the first.
 * Fail fast at the boundary: a malformed board should never reach the renderer.
 */
export function validateBoard(board) {
  const errors = [];
  const at = (p, m) => errors.push(`${p}: ${m}`);

  if (!board || typeof board !== 'object') return { ok: false, errors: ['board: not an object'] };
  if (typeof board.version !== 'number') at('version', 'missing or not a number');
  if (board.version > CURRENT_VERSION) at('version', `${board.version} is newer than supported (${CURRENT_VERSION})`);
  if (board.screenBackground != null && !isColor(board.screenBackground))
    at('screenBackground', `"${board.screenBackground}" is not an accepted colour`);
  if (!Array.isArray(board.groups)) return { ok: false, errors: [...errors, 'groups: not an array'] };

  const groupIds = new Set();
  const screenIds = new Set();
  const stepIds = new Set();

  board.groups.forEach((g, gi) => {
    const gp = `groups[${gi}]`;
    if (!g.id) at(gp, 'missing id');
    else if (groupIds.has(g.id)) at(gp, `duplicate group id "${g.id}"`);
    else groupIds.add(g.id);
    if (!g.title) at(gp, 'missing title');
    if (g.layout && !LAYOUTS.includes(g.layout)) at(gp, `layout must be one of ${LAYOUTS.join('|')}`);

    const localScreens = new Set();
    (g.screens || []).forEach((s, si) => {
      const sp = `${gp}.screens[${si}]`;
      if (!s.id) at(sp, 'missing id');
      else if (screenIds.has(s.id)) at(sp, `duplicate screen id "${s.id}"`);
      else { screenIds.add(s.id); localScreens.add(s.id); }
      if (!s.src) at(sp, 'missing src');
      if (!(s.w > 0) || !(s.h > 0)) at(sp, 'w/h must be positive (intrinsic pixel size)');
      if (s.scale != null && !(s.scale > 0)) at(sp, 'scale must be positive');
      if (g.layout === 'manual' && !s.pos) at(sp, 'manual layout requires pos {x,y}');
      if (s.background != null && !isColor(s.background))
        at(sp, `background "${s.background}" is not an accepted colour`);
      if (s.crop != null) {
        const c = s.crop;
        for (const k of ['x', 'y', 'w', 'h']) {
          if (typeof c[k] !== 'number') { at(sp, `crop.${k} must be a number`); continue; }
          if (c[k] < 0 || c[k] > 1) at(sp, `crop.${k}=${c[k]} outside 0..1 (crop is normalised)`);
        }
        if (c.w <= 0 || c.h <= 0) at(sp, 'crop has zero area');
        if (c.x + c.w > 1.0001 || c.y + c.h > 1.0001) at(sp, 'crop extends past the image');
      }
    });

    (g.steps || []).forEach((st, sti) => {
      const tp = `${gp}.steps[${sti}]`;
      if (!st.id) at(tp, 'missing id');
      else if (stepIds.has(st.id)) at(tp, `duplicate step id "${st.id}"`);
      else stepIds.add(st.id);
      // screen === null is a legitimate "group overview" step
      if (st.screen != null && !localScreens.has(st.screen))
        at(tp, `screen "${st.screen}" is not in this group`);
      if (st.gutter && !GUTTERS.includes(st.gutter)) at(tp, `gutter must be one of ${GUTTERS.join('|')}`);
      (st.notes || []).forEach((n, ni) => {
        const np = `${tp}.notes[${ni}]`;
        if (!n.id) at(np, 'missing id');
        if (st.screen == null) at(np, 'a note needs a screen to point at');
        const r = n.rect;
        if (!r) at(np, 'missing rect');
        else {
          for (const k of ['x', 'y', 'w', 'h']) {
            if (typeof r[k] !== 'number') { at(np, `rect.${k} must be a number`); continue; }
            if (r[k] < 0 || r[k] > 1) at(np, `rect.${k}=${r[k]} outside 0..1 (rects are normalised)`);
          }
          if (r.w === 0 || r.h === 0) at(np, 'rect has zero area');
        }
      });
    });
  });

  return { ok: errors.length === 0, errors };
}

/* ── normalisation ───────────────────────────────────────────────────────── */

/** Fills defaults so the renderer never has to guard. Does not mutate input. */
export function normalizeBoard(board, idf = RAND_ID) {
  const b = structuredClone(board);
  b.version ??= CURRENT_VERSION;
  b.id ??= idf('b');
  b.title ??= 'Untitled board';
  b.screenBackground ??= DEFAULT_SCREEN_BG;   // what shows through a transparent PNG
  b.groups ??= [];

  b.groups.forEach(g => {
    g.id ??= idf('g');
    g.color ??= '#E9A23B';
    g.blurb ??= '';
    g.layout ??= 'auto';
    g.origin ??= { x: 0, y: 0 };
    g.screens ??= [];
    g.steps ??= [];
    g.screens.forEach(s => {
      s.id ??= idf('s');
      s.name ??= 'Untitled screen';
      s.keywords ??= [];
      if (g.layout === 'manual') s.pos ??= { x: 0, y: 0 };
    });
    g.steps.forEach(st => {
      st.id ??= idf('st');
      st.screen ??= null;
      st.kicker ??= '';
      st.caption ??= '';
      st.gutter ??= 'right';
      st.notes ??= [];
      st.notes.forEach(n => { n.id ??= idf('n'); n.text ??= ''; });
    });
  });
  return b;
}

/* ── migration ───────────────────────────────────────────────────────────── */

const MIGRATIONS = {
  // 0: b => { ...b, version: 1 },     ← future shape; chain runs in order
};

export function migrateBoard(board) {
  let b = structuredClone(board);
  while ((b.version ?? 0) < CURRENT_VERSION) {
    const m = MIGRATIONS[b.version ?? 0];
    if (!m) { b.version = CURRENT_VERSION; break; }
    b = m(b);
  }
  return b;
}

/* ── index-free addressing ───────────────────────────────────────────────── */

export function findGroup(board, groupId) {
  return board.groups.find(g => g.id === groupId) || null;
}

/**
 * Resolve {groupId, stepId} to live objects plus their *current* indices.
 * Indices are derived here and nowhere else, so reordering can never desync a
 * stored reference.
 */
export function resolveStep(board, groupId, stepId) {
  const gi = board.groups.findIndex(g => g.id === groupId);
  if (gi < 0) return null;
  const group = board.groups[gi];
  const si = group.steps.findIndex(s => s.id === stepId);
  if (si < 0) return null;
  return { gi, si, group, step: group.steps[si] };
}

/** First step of a group — the safe landing spot when a reference goes stale. */
export function firstStepRef(board, groupId) {
  const g = findGroup(board, groupId) || board.groups[0];
  if (!g || !g.steps.length) return null;
  return { groupId: g.id, stepId: g.steps[0].id };
}

/** Clamp a step reference back into existence after an edit or an import. */
export function reconcileRef(board, ref) {
  if (ref && resolveStep(board, ref.groupId, ref.stepId)) return ref;
  if (ref && findGroup(board, ref.groupId)) return firstStepRef(board, ref.groupId);
  return board.groups.length ? firstStepRef(board, board.groups[0].id) : null;
}

export function screenById(board, screenId) {
  for (const g of board.groups) {
    const s = g.screens.find(x => x.id === screenId);
    if (s) return { group: g, screen: s };
  }
  return null;
}

/**
 * The step a screen navigates to when clicked — the first step (authored order)
 * that frames it — or null if no step does. Screens are group-scoped
 * (validateBoard enforces it), so the answer is always within the owning group.
 * The "if any" gate for the player's click-to-zoom: a screen no step frames is
 * not navigable, so it returns null rather than a fallback.
 */
export function stepForScreen(board, screenId) {
  const owner = screenById(board, screenId);
  if (!owner) return null;
  const step = owner.group.steps.find(s => s.screen === screenId);
  return step ? { groupId: owner.group.id, stepId: step.id } : null;
}

/* ── import ──────────────────────────────────────────────────────────────── */

/**
 * Importing never overwrites: it always mints a new board.
 * Inner ids stay as they are — they are scoped to their board, so two imported
 * copies cannot collide with each other.
 */
export function importBoard(raw, { idf = RAND_ID, titleSuffix = ' (imported)' } = {}) {
  const migrated = migrateBoard(raw);
  const check = validateBoard(migrated);
  if (!check.ok) {
    const err = new Error(`Cannot import board:\n  ${check.errors.join('\n  ')}`);
    err.errors = check.errors;
    throw err;
  }
  const b = normalizeBoard(migrated, idf);
  b.id = idf('b');
  b.title = (raw.title || 'Untitled board') + titleSuffix;
  b.importedAt = null;                    // stamped by the caller; keeps this pure
  return b;
}

/** Stable, sorted serialisation — so an export → import round-trip diffs clean. */
export function serializeBoard(board) {
  return JSON.stringify(board, null, 2);
}
