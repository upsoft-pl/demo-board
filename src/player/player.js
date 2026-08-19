/**
 * The player: renders a board document onto a zoomable canvas.
 *
 * All geometry decisions are delegated to core/layout.js so they stay testable.
 * This file is the DOM half — it reads rects, writes styles, and routes input.
 */
import {
  safeBox, fitOf, camFor, camForBox, boundsOf, placeScreens,
  hotspotToViewport, computeNoteLayout, leaderPath, framingRatio, isCentred,
  NOTE_W, MARGIN, TOP_PAD,
} from '../core/layout.js';
import {
  validateBoard, normalizeBoard, migrateBoard, resolveStep, reconcileRef, findGroup,
  screenBackground, cropOf,
} from '../core/schema.js';

/**
 * Parse a CSS <time> into milliseconds.
 *
 * Must handle both units: the minifier rewrites `1050ms` as `1.05s` in a
 * production build, and reading that with a bare parseFloat yields 1.05 — which
 * looked like "1ms, skip the animation" and silently disabled every camera fly
 * on the deployed site while dev was fine.
 */
export function parseCssTime(raw, fallback) {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return fallback;
  if (/ms$/i.test(s)) return n;
  if (/s$/i.test(s)) return n * 1000;
  return n;                                   // unitless: already milliseconds
}

/**
 * Inline style that shows only a screen's cropped region.
 * The plate box is already the cropped size, so the image is scaled up by
 * 1/crop and shifted so the wanted area lands in it.
 */
export function cropStyle(screen) {
  const c = cropOf(screen);
  return `position:absolute;width:${(100 / c.w).toFixed(4)}%;height:${(100 / c.h).toFixed(4)}%;` +
         `left:${(-c.x / c.w * 100).toFixed(4)}%;top:${(-c.y / c.h * 100).toFixed(4)}%;` +
         `max-width:none;object-fit:fill`;
}
import { createHistory } from '../core/history.js';
import { buildCorpus, searchBoard, relatedScreens } from '../core/search.js';

const DOCK_MIN = 0.5;      // below this the camera isn't looking at anything
const DOCK_MAX = 1.35;     // above this the presenter is reading detail — leave them alone
const GRID_TILE = 170;     // period the backdrop tiles share (170 = 5×34); grid pan wraps on it
const GTITLE_PX = 118;     // .gtitle .nm font-size in player.css; keep the two in sync
const LABEL_AT = 26;       // show the centred locator once the in-world title shrinks below this (px on screen)
const THUMB_PX = 1024;     // longest side of the downscaled LOD copy; plates use it when smaller than this on screen
const PROMOTE_MAX_PX = 8192; // worlds wider/taller than one GPU texture aren't promoted while moving — see markMotion

/** Euclidean modulo — always in [0, m), unlike JS % which keeps the sign. */
const mod = (n, m) => ((n % m) + m) % m;

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
};
const shade = (hex, amt) => {
  const n = parseInt(hex.slice(1), 16);
  const f = c => Math.round(Math.max(0, Math.min(255, c + (amt < 0 ? c * amt : (255 - c) * amt))));
  return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`;
};
/** Minimal inline markup for note prose: **bold** only. Escapes everything else. */
const richText = s => String(s ?? '')
  .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

/**
 * @param {object}   o
 * @param {Function} [o.resolveSrc] maps a board-relative src to a loadable URL.
 *   Published sites resolve against baseUrl; the editor hands back blob URLs
 *   for images living in OPFS, which have no meaningful path.
 */
export function createPlayer({ mount, board: raw, baseUrl = '', resolveSrc, initialCam = null }) {
  const srcOf = resolveSrc || (s => `${baseUrl}${s}`);
  /* ── document ────────────────────────────────────────────────────────── */
  const migrated = migrateBoard(raw);
  const check = validateBoard(migrated);
  if (!check.ok) throw Object.assign(new Error('Invalid board document'), { errors: check.errors });
  const board = normalizeBoard(migrated);
  const corpus = buildCorpus(board);

  /* world placement — derived once, then cached */
  const placed = new Map();          // screenId → {x,y,w,h}
  const groupBB = new Map();         // groupId  → bounds
  for (const g of board.groups) {
    const ps = placeScreens(g);
    ps.forEach(p => placed.set(p.id, p));
    groupBB.set(g.id, boundsOf(ps) || { x0: g.origin.x, y0: g.origin.y, x1: g.origin.x + 1, y1: g.origin.y + 1 });
  }
  const boardBB = {
    x0: Math.min(...[...groupBB.values()].map(b => b.x0)),
    y0: Math.min(...[...groupBB.values()].map(b => b.y0)),
    x1: Math.max(...[...groupBB.values()].map(b => b.x1)),
    y1: Math.max(...[...groupBB.values()].map(b => b.y1)),
  };
  // A world that fits inside one GPU texture can be promoted to a single
  // compositor layer while moving; one larger than that can't, and forcing it
  // makes zoom-out blink (see markMotion). Decide once from the natural size.
  const promoteWorld =
    Math.max(boardBB.x1 - boardBB.x0, boardBB.y1 - boardBB.y0) <= PROMOTE_MAX_PX;

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  mount.innerHTML = `
    <div id="stage"><div id="grid"></div><div id="world"></div></div>
    <div id="grain"></div><div id="vignette"></div>
    <div id="glabels"></div>
    <div id="fps"></div>
    <svg id="leaders"></svg><div id="targets"></div><div id="notes"></div>
    <div id="mark"><s>◆</s> &nbsp;<span></span></div>
    <div id="caption"><span class="g"><em></em><span></span></span>
      <span class="k"></span><div class="t"></div><div class="r"></div></div>
    <div id="dock" class="chip">frame this screen <em>↵</em></div>
    <div id="nextg" class="chip"></div>
    <div id="hud">
      <div id="gchip" title="Switch group (⌘K)"><em></em><b></b><s></s></div>
      <div class="sep"></div>
      <button id="prev" title="Previous step (←)">←</button>
      <div id="dots"></div>
      <button id="next" title="Next step (→)">→</button>
      <div class="sep"></div>
      <button id="back" title="Back (⌘[)">↩</button>
      <button id="fwd" title="Forward (⌘])">↪</button>
      <div class="sep"></div>
      <button id="fitg" title="Fit group (G)">group</button>
      <button id="fit" title="Fit board (F)">all</button>
      <button id="find">⌘K</button>
    </div>
    <div id="help">
      <b>← →</b> step &nbsp;·&nbsp; <b>⌘1…9</b> group<br>
      <b>⌘K</b> find &nbsp;·&nbsp; <b>G</b> fit group &nbsp;·&nbsp; <b>F</b> fit board<br>
      <b>⌘[ ⌘]</b> back / forward
    </div>
    <div id="scrim"></div>
    <div id="pal">
      <div id="pal-in"><s>⌘K</s>
        <input id="pal-q" placeholder="Jump to a group or a screen…" spellcheck="false" autocomplete="off">
        <kbd>esc</kbd></div>
      <div id="pal-list"></div>
      <div id="pal-foot"><span><b>↑↓</b> browse</span><span><b>↵</b> fly there</span><span><b>esc</b> back</span></div>
    </div>`;

  const $ = s => mount.querySelector(s);
  const stage = $('#stage'), world = $('#world'), gridEl = $('#grid');
  const leaders = $('#leaders'), notesLayer = $('#notes'), caption = $('#caption');
  const targetLayer = $('#targets');
  const capG = $('#caption .g span'), capK = $('#caption .k'), capT = $('#caption .t');
  const dotsEl = $('#dots'), gchip = $('#gchip'), dockChip = $('#dock'), nextgChip = $('#nextg');
  const backBtn = $('#back'), fwdBtn = $('#fwd'), prevBtn = $('#prev'), nextBtn = $('#next');
  const scrim = $('#scrim'), pal = $('#pal'), palQ = $('#pal-q'), palList = $('#pal-list');
  $('#mark span').textContent = board.title;

  const GPAD = 190;
  const glabels = $('#glabels');
  const plateEl = new Map(), frameEl = new Map(), glabelEl = new Map();
  // LOD: full-res src, generated thumbnail url, and current level per screen.
  const fullSrc = new Map(), thumbURL = new Map(), lodIsThumb = new Map();
  for (const g of board.groups) {
    const bb = groupBB.get(g.id);
    // Screen-space locator label, centred on the group. The in-world .gtitle
    // scales with the camera and vanishes when zoomed out; this one stays a
    // fixed, readable size and fades in once the group gets small (see render).
    const lab = document.createElement('div');
    lab.className = 'glabel';
    lab.style.color = g.color;
    lab.textContent = g.title;
    glabels.appendChild(lab);
    glabelEl.set(g.id, lab);
    const f = document.createElement('div');
    f.className = 'gframe';
    f.dataset.group = g.id;
    f.style.cssText = `left:${bb.x0 - GPAD}px;top:${bb.y0 - GPAD}px;
      width:${bb.x1 - bb.x0 + GPAD * 2}px;height:${bb.y1 - bb.y0 + GPAD * 2}px;
      background:${hexA(g.color, .045)};box-shadow:inset 0 0 0 2px ${hexA(g.color, .22)}`;
    f.innerHTML = `<div class="gtitle" style="color:${g.color}">
      <span class="nm">${g.title}</span><span class="ct">${g.steps.length} steps</span></div>`;
    world.appendChild(f);
    frameEl.set(g.id, f);

    g.screens.forEach((s, i) => {
      const p = placed.get(s.id);
      const d = document.createElement('div');
      d.className = 'plate';
      d.dataset.screen = s.id;
      d.dataset.group = g.id;
      d.style.cssText = `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px`;
      // assigned as a property, never interpolated into cssText, so a colour
      // from the document can never break out into other declarations
      d.style.backgroundColor = screenBackground(board, s);
      d.innerHTML =
        `<div class="plate-tag"><span class="idx" style="color:${g.color}">${String(i + 1).padStart(2, '0')}</span>
          <span class="nm">${s.name}</span><span class="rule"></span></div>
         <img src="${srcOf(s.src)}" alt="${s.name}" draggable="false" loading="eager"
              style="${cropStyle(s)}">`;
      world.appendChild(d);
      plateEl.set(s.id, d);
      fullSrc.set(s.id, srcOf(s.src));
      d.addEventListener('click', () => {
        if (cam.z < fitOf(p, safeBox(vp(), 'right', false)) * DOCK_MIN) dock(s.id);
      });
    });
  }

  /* ── camera ──────────────────────────────────────────────────────────── */
  const vp = () => ({ w: window.innerWidth, h: window.innerHeight });
  let cam = { x: 0, y: 0, z: 0.1 }, anim = null;
  let ref = { groupId: board.groups[0]?.id, stepId: board.groups[0]?.steps[0]?.id };
  let activeGutter = 'right', live = [], liveKey = null, dockable = null;

  /** Durations come from CSS so JS and the stylesheet can never disagree. */
  const cssMs = (name, fallback) =>
    parseCssTime(getComputedStyle(document.documentElement).getPropertyValue(name), fallback);
  const flyMs = () => cssMs('--fly', 1050);
  const noteOutMs = () => cssMs('--note-out', 180);

  /**
   * Promote #world to its own layer only while the camera is moving.
   *
   * A permanent `will-change:transform` pins the layer's raster at scale 1, so
   * zooming out downsamples full-res screenshots with cheap bilinear filtering
   * and they alias ("show pixels"). Promoting only during motion — and dropping
   * it once renders go quiet — lets the browser re-rasterise the settled frame
   * at the true scale, which is sharp. Every motion path (drag, wheel, flyTo)
   * goes through render(), so kicking the timer here covers all of them.
   *
   * Removing will-change alone won't invalidate the cached raster, so the demote
   * nudges the transform into a 3D layer once to force a fresh, crisp raster.
   *
   * The `moving` flag also lets CSS drop the per-pixel full-screen effects
   * (grain's mix-blend, the grid mask) while the whole scene re-composites each
   * frame — a trace showed those saturating the GPU during pan. They come back
   * on settle, where a still frame can afford them.
   *
   * The promotion is skipped for worlds larger than one GPU texture
   * (`promoteWorld`): such a layer must be tiled, and re-rastering the tiles on
   * a scale change drops one blank frame — the whole board blinks black on
   * zoom-out. Measured pan cost is identical without the promotion at every
   * zoom, so a big board simply forgoes it; the `moving` effect-drop still runs.
   */
  let motionTimer = null;
  function markMotion() {
    if (promoteWorld) world.style.willChange = 'transform';
    document.body.classList.add('moving');
    clearTimeout(motionTimer);
    motionTimer = setTimeout(() => {
      if (promoteWorld) {
        world.style.willChange = 'auto';
        world.style.transform += ' translateZ(0)';
      }
      document.body.classList.remove('moving');
      applyLOD();                 // settled: pick the right resolution for each plate
    }, 200);
  }

  function render() {
    const v = vp();
    world.style.transform =
      `translate(${v.w / 2}px,${v.h / 2}px) scale(${cam.z}) translate(${-cam.x}px,${-cam.y}px)`;
    // Pan the grid with a compositor-only transform, never background-position:
    // shifting the background repaints the whole fixed multi-gradient surface
    // every frame, which drops frames and flickers when zoomed out. The tiles
    // share a 170px period (170 = 5×34), so wrapping the offset modulo 170 keeps
    // the pattern seamless while the element never travels more than one tile —
    // safely inside its inset:-200px slack.
    const gx = mod(-cam.x * cam.z, GRID_TILE), gy = mod(-cam.y * cam.z, GRID_TILE);
    gridEl.style.transform = `translate(${gx}px,${gy}px)`;
    gridEl.style.opacity = Math.min(1, .35 + cam.z * 1.4);
    document.body.classList.toggle('close', cam.z > 0.42);
    layoutNotes();
    layoutLabels();
    markMotion();
  }

  /**
   * Position and reveal the screen-space group locators. They fade in only once
   * the in-world title (GTITLE_PX at the current zoom) is too small to read, and
   * only for groups whose centre is on screen — so zoomed out you can still find
   * a group by its name, without cluttering the view when a title is legible.
   */
  function layoutLabels() {
    const v = vp();
    const show = GTITLE_PX * cam.z < LABEL_AT;
    for (const [id, lab] of glabelEl) {
      const bb = groupBB.get(id);
      const sx = ((bb.x0 + bb.x1) / 2 - cam.x) * cam.z + v.w / 2;
      const sy = ((bb.y0 + bb.y1) / 2 - cam.y) * cam.z + v.h / 2;
      const on = show && sx > 0 && sx < v.w && sy > 0 && sy < v.h;
      lab.classList.toggle('on', on);
      // Hand off: hide this group's in-world title while its locator is up, so
      // the two never stack. (body.close already hides it at the zoomed-in end.)
      frameEl.get(id).classList.toggle('labelled', on);
      if (on) {
        // Measure once, not every frame: reading offsetWidth mid-render forces a
        // synchronous layout. Text and font are fixed, so the size never changes.
        if (!lab._halfW) { lab._halfW = lab.offsetWidth / 2; lab._halfH = lab.offsetHeight / 2; }
        // Keep the whole label on screen — an edge group would otherwise clip.
        const x = Math.max(lab._halfW + 12, Math.min(sx, v.w - lab._halfW - 12));
        const y = Math.max(lab._halfH + 12, Math.min(sy, v.h - lab._halfH - 12));
        lab.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
      }
    }
  }

  /**
   * Level of detail. A trace showed the GPU saturated compositing ~25 full-res
   * (2560px) textures at 2× DPR while zoomed out. Generate a downscaled copy of
   * each screenshot once, then swap a plate to it whenever it is small on screen
   * — which is exactly the zoomed-out overview that janks. Full res returns when
   * you zoom back in. A hysteresis band avoids swapping back and forth at the
   * threshold, and swaps happen only on settle (applyLOD), never mid-motion.
   */
  async function buildThumbs() {
    for (const [id, plate] of plateEl) {
      const img = plate.querySelector('img');
      if (!img) continue;
      try {
        await img.decode();
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh || Math.max(nw, nh) <= THUMB_PX) continue;   // already small enough
        const scale = THUMB_PX / Math.max(nw, nh);
        const c = document.createElement('canvas');
        c.width = Math.round(nw * scale); c.height = Math.round(nh * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.85));
        if (blob) thumbURL.set(id, URL.createObjectURL(blob));
      } catch { /* cross-origin taint or decode failure: keep full res for this plate */ }
    }
    applyLOD();
  }
  function applyLOD() {
    const dpr = window.devicePixelRatio || 1;
    for (const [id, plate] of plateEl) {
      if (!thumbURL.has(id)) continue;                       // no thumb (small source)
      const p = placed.get(id);
      const onDev = Math.max(p.w, p.h) * cam.z * dpr;        // on-screen longest side, device px
      const cur = lodIsThumb.get(id);
      let want = cur;
      if (cur === undefined) want = onDev <= THUMB_PX;
      else if (cur && onDev > THUMB_PX * 1.1) want = false;
      else if (!cur && onDev < THUMB_PX * 0.9) want = true;
      if (want !== cur) {
        plate.querySelector('img').src = want ? thumbURL.get(id) : fullSrc.get(id);
        lodIsThumb.set(id, want);
      }
    }
  }

  function flyTo(t, dur = flyMs(), after) {
    cancelAnimationFrame(anim);
    if (dur <= 2) { cam = { ...t }; render(); after && after(); return; }
    const f = { ...cam }, t0 = performance.now();
    const ez = k => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    (function tick(now) {
      const k = Math.min(1, (now - t0) / dur), e = ez(k);
      cam.x = f.x + (t.x - f.x) * e;
      cam.y = f.y + (t.y - f.y) * e;
      cam.z = Math.exp(Math.log(f.z) + (Math.log(t.z) - Math.log(f.z)) * e);
      render();
      if (k < 1) anim = requestAnimationFrame(tick); else after && after();
    })(performance.now());
  }
  const camForScreen = (screenId, gutter, hasNotes) =>
    camFor(placed.get(screenId), safeBox(vp(), gutter, hasNotes), vp());
  const groupCam = gid => camForBox(groupBB.get(gid), vp(), 700);
  const boardCam = () => camForBox(boardBB, vp(), 900);

  /* ── annotations ─────────────────────────────────────────────────────── */
  function clearNotes() {
    const ms = noteOutMs();
    for (const n of live) {
      n.el.classList.add('out');
      const { el, path, dot, ring } = n;
      const drop = () => { el.remove(); path.remove(); dot.remove(); ring.remove(); };
      // leaders and rings point at the old screenshot, so they must go at once —
      // only the note itself gets to fade
      path.remove(); dot.remove(); ring.remove();
      ms <= 2 ? el.remove() : setTimeout(drop, ms);
    }
    live = []; liveKey = null;
  }
  function showNotes(step, key) {
    if (liveKey === key || !step.notes.length) return;
    clearNotes();
    liveKey = key;
    activeGutter = step.gutter;
    step.notes.forEach((n, i) => {
      const delay = `${i * 170}ms`;
      const el = document.createElement('div');
      el.className = 'note';
      el.dataset.note = n.id;
      el.style.setProperty('--d', delay);
      el.innerHTML = `<span class="n">Note ${String(i + 1).padStart(2, '0')}</span>
        <div class="x">${richText(n.text)}</div>`;
      notesLayer.appendChild(el);
      const ring = document.createElement('div');
      ring.className = 'target';
      ring.style.setProperty('--d', delay);
      // inside the mount, never on document.body: anything parked outside the
      // mount survives destroy() and haunts whatever replaces the player
      targetLayer.appendChild(ring);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.style.setProperty('--d', delay);
      leaders.appendChild(path);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '3.5');
      dot.style.setProperty('--d', delay);
      leaders.appendChild(dot);
      live.push({ id: n.id, rect: n.rect, screen: step.screen, el, ring, path, dot });
    });
    layoutNotes(true);
  }
  function layoutNotes(first) {
    if (!live.length) return;
    const plate = plateEl.get(live[0].screen);
    if (!plate) return;
    const pr = plate.getBoundingClientRect();
    const capBox = caption.classList.contains('centered') ? null : caption.getBoundingClientRect();

    const out = computeNoteLayout({
      notes: live.map(n => ({
        id: n.id,
        height: n.el.offsetHeight,
        hotspot: hotspotToViewport(n.rect, pr),
      })),
      viewport: vp(),
      gutter: activeGutter,
      captionBottom: capBox ? capBox.bottom : null,
    });

    for (const pos of out) {
      const n = live.find(x => x.id === pos.id);
      n.el.style.left = `${pos.x}px`;
      n.el.style.top = `${pos.y}px`;
      const hs = hotspotToViewport(n.rect, pr);
      // assign properties individually: `cssText +=` runs every frame and
      // concatenates declarations into each other, corrupting them
      n.ring.style.left = `${hs.left - 6}px`;
      n.ring.style.top = `${hs.top - 6}px`;
      n.ring.style.width = `${hs.width + 12}px`;
      n.ring.style.height = `${hs.height + 12}px`;
      n.path.setAttribute('d', leaderPath(pos.leader));
      n.dot.setAttribute('cx', pos.dot.x);
      n.dot.setAttribute('cy', pos.dot.y);
      if (first) n.path.style.setProperty('--len', n.path.getTotalLength());
    }
  }
  function depth(screenId, groupId) {
    for (const [id, el] of plateEl) {
      const g = el.dataset.group;
      el.classList.toggle('near', !!screenId && id !== screenId && g === groupId);
      el.classList.toggle('far', !!groupId && g !== groupId);
    }
    for (const [id, el] of frameEl) el.classList.toggle('away', !!groupId && id !== groupId);
  }

  /* ── history ─────────────────────────────────────────────────────────── */
  const history = createHistory();
  let histLock = false;
  const histUI = () => {
    backBtn.disabled = !history.canBack();
    fwdBtn.disabled = !history.canForward();
  };
  function histGo(d) {
    const e = d < 0 ? history.back() : history.forward();
    if (!e) return;
    histLock = true;
    if (e.kind === 'board') fitBoard();
    else goto(e.groupId, e.stepId);
    histLock = false;
    histUI();
  }

  /* ── steps ───────────────────────────────────────────────────────────── */
  function applyAccent(g) {
    const r = document.documentElement.style;
    r.setProperty('--accent', g.color);
    r.setProperty('--accent-dim', hexA(g.color, .42));
    r.setProperty('--accent-soft', hexA(g.color, .34));
    r.setProperty('--note-idx', shade(g.color, -.42));
  }
  function paintCaption(g, step, si) {
    capG.textContent = g.title;
    capK.textContent = step.screen == null
      ? `Overview · ${g.steps.length} steps`
      : `Step ${String(si + 1).padStart(2, '0')} — ${step.kicker}`;
    capT.innerHTML = richText(step.caption);
    caption.classList.toggle('centered', step.screen == null);
    if (step.screen != null) {
      caption.style.left = `${step.gutter === 'right' ? vp().w - NOTE_W - MARGIN : MARGIN}px`;
    }
    for (const n of [capG.parentNode, capK, capT]) {
      n.style.animation = 'none'; void n.offsetWidth; n.style.animation = '';
    }
  }
  function paintHud(g, si) {
    gchip.querySelector('b').textContent = g.title;
    gchip.querySelector('s').textContent = `${board.groups.indexOf(g) + 1}/${board.groups.length}`;
    dotsEl.innerHTML = '';
    g.steps.forEach((st, j) => {
      const b = document.createElement('i');
      b.className = j === si ? 'on' : (j < si ? 'past' : '');
      b.title = st.kicker || 'overview';
      b.onclick = () => goto(g.id, st.id);
      dotsEl.appendChild(b);
    });
    prevBtn.disabled = si <= 0;
    nextBtn.disabled = si >= g.steps.length - 1;
    const gi = board.groups.indexOf(g);
    const ng = board.groups[(gi + 1) % board.groups.length];
    if (si >= g.steps.length - 1 && board.groups.length > 1) {
      nextgChip.innerHTML =
        `<i style="background:${ng.color}"></i>next group · ${ng.title} <em>⇥</em>`;
      nextgChip.classList.add('on');
    } else nextgChip.classList.remove('on');
  }

  function goto(groupId, stepId) {
    const r = resolveStep(board, groupId, stepId) || (() => {
      const fixed = reconcileRef(board, { groupId, stepId });
      return fixed && resolveStep(board, fixed.groupId, fixed.stepId);
    })();
    if (!r) return;
    const { group, step, si } = r;
    ref = { groupId: group.id, stepId: step.id };
    if (!histLock) { history.push({ kind: 'step', ...ref }); histUI(); }

    applyAccent(group);
    paintCaption(group, step, si);
    paintHud(group, si);
    $('#help').classList.toggle('dim', history.size() > 1);
    clearNotes(); setDockable(null); caption.classList.remove('fade');

    if (step.screen == null) { depth(null, group.id); flyTo(groupCam(group.id)); return; }
    depth(step.screen, group.id);
    flyTo(camForScreen(step.screen, step.gutter, step.notes.length > 0), flyMs(),
      () => showNotes(step, `${group.id}:${step.id}`));
  }
  function gotoGroup(gi) {
    const g = board.groups[(gi + board.groups.length) % board.groups.length];
    if (g?.steps.length) goto(g.id, g.steps[0].id);
  }
  // Adopt a step as current WITHOUT moving the camera or revealing notes — used
  // when preview opens on the layout viewport (literal camera). Story state
  // (ref, accent, caption, HUD) tracks the screen you're already looking at, so
  // ←/→ continue from here and ↵ can frame it.
  function syncRef(groupId, stepId) {
    const r = resolveStep(board, groupId, stepId);
    if (!r) return;
    const { group, step, si } = r;
    ref = { groupId: group.id, stepId: step.id };
    applyAccent(group);
    paintCaption(group, step, si);
    paintHud(group, si);
  }
  function stepBy(d) {
    const r = resolveStep(board, ref.groupId, ref.stepId);
    if (!r) return;
    const next = r.si + d;
    if (next < 0 || next >= r.group.steps.length) return;   // never cross a group edge
    goto(r.group.id, r.group.steps[next].id);
  }
  function fitBoard() {
    if (!histLock) { history.push({ kind: 'board' }); histUI(); }
    clearNotes(); depth(null, null); setDockable(null);
    caption.classList.add('fade');
    flyTo(boardCam(), flyMs());
  }
  function fitGroup() {
    clearNotes(); depth(null, ref.groupId); setDockable(null);
    caption.classList.add('fade');
    flyTo(groupCam(ref.groupId), flyMs());
  }

  /* ── free flight ─────────────────────────────────────────────────────── */
  function nearest() {
    let best = null, bestR = 0;
    const v = vp();
    for (const [id, el] of plateEl) {
      const r = el.getBoundingClientRect();
      if (!isCentred(r, v)) continue;
      const ratio = framingRatio(cam.z, placed.get(id), v);
      if (ratio > bestR) { bestR = ratio; best = id; }
    }
    return bestR > DOCK_MIN ? { id: best, ratio: bestR } : null;
  }
  const setDockable = id => { dockable = id; dockChip.classList.toggle('on', !!id); };
  // The step to make current for a screen: the first step that frames it, or —
  // for a screen no step points at yet — the group's opening step, so docking
  // always lands somewhere playable.
  function stepForScreen(screenId) {
    for (const g of board.groups) {
      if (!g.screens.some(s => s.id === screenId)) continue;
      const st = g.steps.find(s => s.screen === screenId) || g.steps[0];
      return st ? { group: g, step: st } : null;
    }
    return null;
  }
  function dock(screenId) {
    setDockable(null);
    const hit = stepForScreen(screenId);
    if (hit) goto(hit.group.id, hit.step.id);
  }
  function settle() {
    if (drag) return;
    const n = nearest();
    if (!n) { clearNotes(); depth(null, null); setDockable(null); return; }
    if (n.ratio > DOCK_MAX) { clearNotes(); setDockable(n.id); return; }
    setDockable(null);
    const cur = resolveStep(board, ref.groupId, ref.stepId);
    if (cur && cur.step.screen === n.id && liveKey === `${ref.groupId}:${ref.stepId}`) return;
    dock(n.id);
  }

  /* ── ⌘K ──────────────────────────────────────────────────────────────── */
  let palOpen = false, palSel = 0, palRows = [];
  const groupOf = id => board.groups.find(g => g.id === id);
  const screenOf = id => { for (const g of board.groups) { const s = g.screens.find(x => x.id === id); if (s) return s; } };

  function miniMap(screenId, groupId) {
    const W = boardBB.x1 - boardBB.x0, H = boardBB.y1 - boardBB.y0;
    const body = groupId
      ? board.groups.map(g => {
          const bb = groupBB.get(g.id);
          return `<rect class="${g.id === groupId ? 'grp' : ''}" x="${bb.x0 - boardBB.x0}" y="${bb.y0 - boardBB.y0}"
            width="${bb.x1 - bb.x0}" height="${bb.y1 - bb.y0}" rx="60"
            ${g.id === groupId ? 'fill="currentColor" fill-opacity=".28"' : ''}/>`;
        }).join('')
      : [...placed.entries()].map(([id, p]) =>
          `<rect class="${id === screenId ? 'me' : ''}" x="${p.x - boardBB.x0}" y="${p.y - boardBB.y0}"
            width="${p.w}" height="${p.h}" rx="30"/>`).join('');
    return `<svg class="map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
  }
  function rowHtml(r, i) {
    const sel = i === palSel ? 'sel' : '';
    if (r.kind === 'group') {
      const g = groupOf(r.id);
      return `<div class="res ${sel}" data-i="${i}" style="color:${g.color}">${miniMap(null, g.id)}
        <div class="bd"><div class="nm">${g.title}</div><div class="cx">${r.why || ''}</div></div>
        <div class="gp"><em></em>${g.steps.length} steps</div></div>`;
    }
    const g = groupOf(r.groupId), s = screenOf(r.id);
    return `<div class="res ${sel}" data-i="${i}" style="color:${g.color}">${miniMap(r.id, null)}
      <div class="bd"><div class="nm">${s.name}</div><div class="cx">${r.why || ''}</div></div>
      <div class="gp"><em></em>${g.title}</div></div>`;
  }
  function palRender() {
    const q = palQ.value.trim();
    palRows = [];
    let html = '';
    if (!q) {
      html += `<div class="phead">Jump to group</div>`;
      board.groups.forEach(g => palRows.push({ kind: 'group', id: g.id, why: g.blurb }));
      html += palRows.map(rowHtml).join('');
      const cur = resolveStep(board, ref.groupId, ref.stepId);
      const rel = cur?.step.screen ? relatedScreens(board, cur.step.screen) : [];
      if (rel.length) {
        const g = groupOf(ref.groupId);
        html += `<div class="phead">Related to <b style="color:${g.color}">${screenOf(cur.step.screen).name}</b></div>`;
        const off = palRows.length;
        rel.forEach(r => palRows.push(r));
        html += rel.map((r, i) => rowHtml(r, off + i)).join('');
      }
    } else {
      const { groups, screens } = searchBoard(corpus, q);
      if (groups.length) {
        html += `<div class="phead">Groups</div>`;
        groups.forEach(r => palRows.push(r));
        html += groups.map((r, i) => rowHtml(r, i)).join('');
      }
      if (screens.length) {
        html += `<div class="phead">Screens</div>`;
        const off = palRows.length;
        screens.forEach(r => palRows.push(r));
        html += screens.map((r, i) => rowHtml(r, off + i)).join('');
      }
      if (!palRows.length) html = `<div id="pal-empty">Nothing on the board matches that.</div>`;
    }
    palList.innerHTML = html;
    palSel = Math.min(palSel, Math.max(0, palRows.length - 1));
    palList.querySelectorAll('.res').forEach(row => {
      row.onclick = () => { palSel = +row.dataset.i; palGo(); };
      row.onmouseenter = () => { palSel = +row.dataset.i; markSel(); };
    });
    markSel();
  }
  const markSel = () =>
    palList.querySelectorAll('.res').forEach(r => r.classList.toggle('sel', +r.dataset.i === palSel));
  function palShow() { palOpen = true; palQ.value = ''; palSel = 0; palRender(); scrim.classList.add('on'); pal.classList.add('on'); palQ.focus(); }
  function palHide() { palOpen = false; scrim.classList.remove('on'); pal.classList.remove('on'); palQ.blur(); }
  function palMove(d) {
    if (!palRows.length) return;
    palSel = (palSel + d + palRows.length) % palRows.length;
    markSel();
    palList.querySelector(`.res[data-i="${palSel}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function palGo() {
    const r = palRows[palSel];
    if (!r) return;
    palHide();
    if (r.kind === 'group') gotoGroup(board.groups.findIndex(g => g.id === r.id));
    else dock(r.id);
  }

  /* ── fps overlay (toggle: P, or ?fps=1) ─────────────────────────────────
   * A debug HUD for eyeballing pan/zoom cost on real boards. Frame time comes
   * from rAF deltas; under sustained GPU load Chrome throttles rAF to the real
   * presented rate, so this tracks it. "worst" is the slowest frame in the last
   * second — it exposes stutter that a smoothed average hides. */
  const fpsEl = $('#fps');
  let fpsRaf = 0, fpsLast = 0, fpsPaint = 0, fpsFrames = [];
  function fpsTick(now) {
    if (fpsLast) fpsFrames.push(now - fpsLast);
    fpsLast = now;
    let acc = 0, i = fpsFrames.length;
    while (i > 0 && acc < 1000) acc += fpsFrames[--i];   // keep ~1s of history
    if (i > 0) fpsFrames = fpsFrames.slice(i);
    if (now - fpsPaint > 250 && fpsFrames.length) {
      fpsPaint = now;
      const avg = fpsFrames.reduce((a, b) => a + b, 0) / fpsFrames.length;
      fpsEl.textContent = `${Math.round(1000 / avg)} fps · worst ${Math.max(...fpsFrames).toFixed(0)}ms`;
    }
    fpsRaf = requestAnimationFrame(fpsTick);
  }
  function fpsToggle(on) {
    const show = on ?? !fpsEl.classList.contains('on');
    fpsEl.classList.toggle('on', show);
    cancelAnimationFrame(fpsRaf);
    fpsFrames = []; fpsLast = 0; fpsPaint = 0;
    if (show) fpsRaf = requestAnimationFrame(fpsTick);
  }
  if (new URLSearchParams(location.search).has('fps')) fpsToggle(true);

  /* ── input ───────────────────────────────────────────────────────────── */
  let drag = null, freeTimer = null;
  function freeMode() {
    caption.classList.add('fade');
    if (live.length) clearNotes();
    clearTimeout(freeTimer);
    freeTimer = setTimeout(settle, 300);
  }
  stage.addEventListener('pointerdown', e => {
    if (e.button === 3) return histGo(-1);
    if (e.button === 4) return histGo(1);
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    stage.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch { /* stray pointer must not kill panning */ }
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    cancelAnimationFrame(anim);
    cam.x = drag.cx - (e.clientX - drag.x) / cam.z;
    cam.y = drag.cy - (e.clientY - drag.y) / cam.z;
    render(); freeMode();
  });
  window.addEventListener('pointerup', () => {
    const was = drag; drag = null;
    stage.classList.remove('dragging');
    if (was) freeMode();
  });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    cancelAnimationFrame(anim);
    const nz = Math.max(.03, Math.min(2.4, cam.z * Math.exp(-e.deltaY * .0016)));
    const v = vp();
    const mx = e.clientX - v.w / 2, my = e.clientY - v.h / 2;
    cam.x += mx / cam.z - mx / nz;
    cam.y += my / cam.z - my / nz;
    cam.z = nz;
    render(); freeMode();
  }, { passive: false });

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); palOpen ? palHide() : palShow(); return;
    }
    if (palOpen) {
      if (e.key === 'Escape') { e.preventDefault(); palHide(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
      if (e.key === 'Enter') { e.preventDefault(); palGo(); }
      return;                                   // the palette swallows everything else
    }
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const n = +e.key - 1;
      if (n < board.groups.length) { e.preventDefault(); gotoGroup(n); }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '[') { e.preventDefault(); return histGo(-1); }
    if ((e.metaKey || e.ctrlKey) && e.key === ']') { e.preventDefault(); return histGo(1); }
    if (e.key === 'Backspace') { e.preventDefault(); return histGo(e.shiftKey ? 1 : -1); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const gi = board.groups.findIndex(g => g.id === ref.groupId);
      return gotoGroup(gi + (e.shiftKey ? -1 : 1));
    }
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); return stepBy(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); return stepBy(-1); }
    if (e.key === 'Enter' && dockable) { e.preventDefault(); return dock(dockable); }
    if (e.key === 'g' || e.key === 'G') return fitGroup();
    if (e.key === 'f' || e.key === 'F' || e.key === '0') return fitBoard();
    if (e.key === 'p' || e.key === 'P') return fpsToggle();
  }
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => {
    const r = resolveStep(board, ref.groupId, ref.stepId);
    if (!r) return;
    paintCaption(r.group, r.step, r.si);
    cam = r.step.screen == null
      ? groupCam(r.group.id)
      : camForScreen(r.step.screen, r.step.gutter, r.step.notes.length > 0);
    render(); layoutNotes(true);
  });

  prevBtn.onclick = () => stepBy(-1);
  nextBtn.onclick = () => stepBy(1);
  backBtn.onclick = () => histGo(-1);
  fwdBtn.onclick = () => histGo(1);
  $('#fit').onclick = fitBoard;
  $('#fitg').onclick = fitGroup;
  $('#find').onclick = () => palOpen ? palHide() : palShow();
  gchip.onclick = () => palOpen ? palHide() : palShow();
  dockChip.onclick = () => dockable && dock(dockable);
  nextgChip.onclick = () => {
    const gi = board.groups.findIndex(g => g.id === ref.groupId);
    gotoGroup(gi + 1);
  };
  palQ.addEventListener('input', () => { palSel = 0; palRender(); });
  scrim.addEventListener('click', palHide);

  /* ── boot ────────────────────────────────────────────────────────────── */
  const first = board.groups[0];
  if (first) applyAccent(first);
  cam = boardCam(); cam.z *= .86; render(); histUI();

  return {
    board,
    start() {
      if (initialCam) {
        // Open on the layout viewport instead of the opening step: same region,
        // same zoom. Then, for whatever screen is centred — if it is already
        // reasonably framed (ratio within the dock band) fly the short distance
        // into that step so its notes reveal (auto-frame); if you are zoomed in
        // tighter than the frame, stay put and just adopt it as the current step
        // (↵ frames it); if nothing is centred (zoomed out over the board) leave
        // ref at the opening step so → still starts the story.
        cam = { ...initialCam };
        render();
        const n = nearest();
        const hit = n && stepForScreen(n.id);
        if (!hit) caption.classList.add('fade');
        else if (n.ratio <= DOCK_MAX) goto(hit.group.id, hit.step.id);
        else { syncRef(hit.group.id, hit.step.id); caption.classList.remove('fade'); setDockable(n.id); }
      } else if (first?.steps.length) {
        goto(first.id, first.steps[0].id);
      }
      buildThumbs();               // async: generate LOD copies, then applyLOD()
    },
    /* test + editor surface */
    goto, gotoGroup, stepBy, fitBoard, fitGroup, dock, histGo,
    get ref() { return ref; },
    get camera() { return { ...cam }; },
    destroy() {
      window.removeEventListener('keydown', onKey);
      clearNotes();                 // cancels the pending fade-out timers too
      cancelAnimationFrame(anim);
      clearTimeout(freeTimer);
      clearTimeout(motionTimer);
      cancelAnimationFrame(fpsRaf);
      document.body.classList.remove('moving');
      for (const u of thumbURL.values()) URL.revokeObjectURL(u);
      mount.innerHTML = '';
    },
  };
}
