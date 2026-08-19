/**
 * The editor.
 *
 * All document changes go through the pure functions in core/edit.js, so this
 * file only deals with input, rendering and persistence. Every mutation goes
 * through commit(), which gives undo and autosave for free.
 */
import {
  addGroup, updateGroup, reorderGroups, deleteGroup, setGroupLayout,
  addScreen, updateScreen, moveScreen, deleteScreen,
  addStep, updateStep, reorderSteps, deleteStep,
  addNote, updateNote, reorderNotes, deleteNote, normalizeRect,
  setBoardTitle, setBoardBackground, setScreenBackground, DEFAULT_COLORS,
  applyHandle, moveRect, setScreenCrop, replaceScreenImage, moveScreenToGroup, moveGroup, HANDLES,
  scaleScreen, SCALE_MIN, SCALE_MAX,
} from '../core/edit.js';
import { placeScreens, boundsOf, camForBox } from '../core/layout.js';
import {
  resolveStep, screenBackground, isColor, DEFAULT_SCREEN_BG, cropOf, effectiveSize, FULL_CROP,
} from '../core/schema.js';
import { createPlayer, cropStyle } from '../player/player.js';
import { exportBoard, publishBoard, filenameFor } from '../core/bundle.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
};

export function createEditor({ mount, store, board: initial, onExit, toast }) {
  let board = initial;
  let mode = 'layout';                          // layout | annotate | preview
  let sel = { kind: 'board' };                  // {kind:'group'|'screen'|'step'|'note', ...}
  const undo = [], redo = [];
  let player = null, saveTimer = null;
  const urlCache = new Map();                   // src → object URL

  mount.innerHTML = `
  <div id="ed">
    <div id="top">
      <span class="brand"><s>◆</s> board</span>
      <input class="title" id="btitle" value="${esc(board.title)}" data-testid="board-title">
      <div class="spacer"></div>
      <div class="seg" role="group">
        <button data-mode="layout" aria-pressed="true" data-testid="mode-layout">layout</button>
        <button data-mode="annotate" aria-pressed="false" data-testid="mode-annotate">annotate</button>
        <button data-mode="crop" aria-pressed="false" data-testid="mode-crop">crop</button>
        <button data-mode="preview" aria-pressed="false" data-testid="mode-preview">preview</button>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="undo" title="Undo (⌘Z)">undo</button>
      <button class="btn" id="export" data-testid="export">export zip</button>
      <button class="btn" id="publish" data-testid="publish">publish</button>
      <button class="btn" id="library" data-testid="to-library">library</button>
    </div>
    <div id="body">
      <div class="pane" id="outline"></div>
      <div id="stageWrap">
        <div id="canvas"><div id="cworld"></div></div>
        <div id="hint"></div>
        <div id="drop">drop images to add screens</div>
        <div id="annot"><div id="shot"><img alt=""><div id="rubber"></div></div></div>
        <div id="cropview"><div id="cropimg"><img alt="">
          <div id="cropmask"></div>
          <div id="cropbox" data-testid="cropbox"></div>
        </div><div id="croptools"></div></div>
      </div>
      <input type="file" id="replaceFile" accept="image/*" hidden>
      <div class="pane" id="inspector"></div>
    </div>
  </div>`;

  const $ = s => mount.querySelector(s);
  const outline = $('#outline'), inspector = $('#inspector'), canvas = $('#canvas');
  const cworld = $('#cworld'), annot = $('#annot'), shot = $('#shot');
  const shotImg = shot.querySelector('img'), rubber = $('#rubber'), hint = $('#hint');

  /* ── images ──────────────────────────────────────────────────────────── */
  async function warmImages() {
    for (const g of board.groups) for (const s of g.screens) {
      if (urlCache.has(s.src)) continue;
      try { urlCache.set(s.src, await store.imageURL(board.id, s.src.replace(/^images\//, ''))); }
      catch { urlCache.set(s.src, ''); }
    }
  }
  const srcOf = s => urlCache.get(s) || '';

  /* ── commit / undo / autosave ────────────────────────────────────────── */
  function commit(next, { silent = false } = {}) {
    if (!next || next === board) return;
    undo.push(board);
    if (undo.length > 100) undo.shift();
    redo.length = 0;
    board = next;
    scheduleSave();
    if (!silent) renderAll();
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await store.saveBoard(board); }
      catch (e) { toast(`Not saved: ${e.message}`, 'bad'); }
    }, 400);
  }
  function doUndo() {
    if (!undo.length) return;
    redo.push(board);
    board = undo.pop();
    scheduleSave();
    renderAll();
  }
  function doRedo() {
    if (!redo.length) return;
    undo.push(board);
    board = redo.pop();
    scheduleSave();
    renderAll();
  }

  /* ── selection helpers ───────────────────────────────────────────────── */
  const groupOf = id => board.groups.find(g => g.id === id);
  const selGroup = () => sel.groupId ? groupOf(sel.groupId) : null;
  const selStep = () => {
    if (!sel.groupId || !sel.stepId) return null;
    return resolveStep(board, sel.groupId, sel.stepId)?.step ?? null;
  };
  const screenOf = id => {
    for (const g of board.groups) {
      const s = g.screens.find(x => x.id === id);
      if (s) return { group: g, screen: s };
    }
    return null;
  };
  function select(next) { sel = next; renderAll(); }

  /* ── outline ─────────────────────────────────────────────────────────── */
  function renderOutline() {
    outline.innerHTML = '';
    const head = el('div', 'phead', `<span>Groups</span><span class="spacer"></span>
      <button class="icon" id="addGroup" title="Add group" data-testid="add-group">+</button>`);
    outline.appendChild(head);
    head.querySelector('#addGroup').onclick = () => {
      const next = addGroup(board, {});
      commit(next);
      select({ kind: 'group', groupId: next.groups.at(-1).id });
    };

    if (!board.groups.length) {
      outline.appendChild(el('div', 'empty', 'No groups yet. Add one, then drop screenshots on the canvas.'));
      return;
    }

    board.groups.forEach((g, gi) => {
      const box = el('div', `grp${sel.groupId === g.id && sel.kind === 'group' ? ' sel' : ''}`);
      box.dataset.testid = 'group';
      box.dataset.groupId = g.id;
      const h = el('div', 'grp-h', `
        <em style="background:${g.color}"></em>
        <b>${esc(g.title)}</b>
        <span class="n">${g.screens.length}s / ${g.steps.length}st</span>
        <span class="ord">
          <button data-up title="Move up">▲</button>
          <button data-down title="Move down">▼</button>
        </span>
        <button class="icon" data-addstep title="Add step">+</button>`);
      h.dataset.testid = 'group-header';
      h.onclick = e => {
        if (e.target.closest('button')) return;
        select({ kind: 'group', groupId: g.id });
      };
      h.querySelector('[data-up]').onclick = () => commit(reorderGroups(board, gi, gi - 1));
      h.querySelector('[data-down]').onclick = () => commit(reorderGroups(board, gi, gi + 1));
      h.querySelector('[data-addstep]').onclick = () => {
        const first = g.screens[0]?.id ?? null;
        const next = addStep(board, g.id, { screen: first, kicker: 'new step' });
        commit(next);
        const st = groupOfIn(next, g.id).steps.at(-1);
        select({ kind: 'step', groupId: g.id, stepId: st.id });
      };
      box.appendChild(h);

      g.steps.forEach((st, si) => {
        const scr = st.screen ? g.screens.find(s => s.id === st.screen) : null;
        const row = el('div', `stp${sel.kind === 'step' && sel.stepId === st.id ? ' sel' : ''}`, `
          <span class="i">${String(si + 1).padStart(2, '0')}</span>
          <span class="t">${esc(st.kicker || '(no kicker)')}<small>${esc(scr ? scr.name : 'overview')}</small></span>
          ${st.notes.length ? `<span class="nn">${st.notes.length}</span>` : ''}
          <span class="ord">
            <button data-up title="Move step up" data-testid="step-up">▲</button>
            <button data-down title="Move step down" data-testid="step-down">▼</button>
          </span>`);
        row.dataset.testid = 'step';
        row.dataset.stepId = st.id;
        row.onclick = e => {
          if (e.target.closest('button')) return;
          select({ kind: 'step', groupId: g.id, stepId: st.id });
        };
        row.querySelector('[data-up]').onclick = () => commit(reorderSteps(board, g.id, si, si - 1));
        row.querySelector('[data-down]').onclick = () => commit(reorderSteps(board, g.id, si, si + 1));
        box.appendChild(row);
      });
      outline.appendChild(box);
    });
  }
  const groupOfIn = (b, id) => b.groups.find(g => g.id === id);

  /* ── inspector ───────────────────────────────────────────────────────── */
  function renderInspector() {
    inspector.innerHTML = '';
    const add = n => inspector.appendChild(n);
    const field = (label, node, hintText) => {
      const f = el('div', 'fld');
      f.appendChild(el('label', null, label));
      f.appendChild(node);
      if (hintText) f.appendChild(el('div', 'hint', hintText));
      return f;
    };
    const text = (value, oninput, testid) => {
      const i = el('input');
      i.type = 'text'; i.value = value ?? '';
      if (testid) i.dataset.testid = testid;
      i.oninput = () => oninput(i.value);
      return i;
    };

    /** Swatches + colour picker for a screenshot backing. */
    const bgControl = (current, onPick, { inherit = null } = {}) => {
      const wrap = el('div');
      const sw = el('div', 'swatches');
      const opts = [
        ...(inherit ? [{ v: null, label: `board default`, css: inherit }] : []),
        { v: '#FFFFFF', label: 'white', css: '#FFFFFF' },
        { v: 'transparent', label: 'transparent', css: 'transparent' },
        { v: '#0A0D12', label: 'ink', css: '#0A0D12' },
        { v: '#F7F8FA', label: 'paper', css: '#F7F8FA' },
      ];
      for (const o of opts) {
        const b = el('button');
        b.title = o.label;
        b.dataset.testid = `bg-${o.v === null ? 'inherit' : o.v.replace('#', '')}`;
        b.style.background = o.css === 'transparent'
          ? 'repeating-conic-gradient(#8f97a8 0% 25%, #4a5162 0% 50%) 50%/10px 10px'
          : o.css;
        b.setAttribute('aria-pressed', String(current === o.v));
        b.onclick = () => onPick(o.v);
        sw.appendChild(b);
      }
      wrap.appendChild(sw);
      const pick = el('input');
      pick.type = 'color';
      pick.style.cssText = 'width:100%;height:30px;margin-top:8px;background:var(--panel-2);' +
        'border:1px solid var(--line);border-radius:7px;padding:2px';
      pick.value = isColor(current) && current.startsWith('#') ? current.slice(0, 7) : '#ffffff';
      pick.oninput = () => onPick(pick.value.toUpperCase());
      wrap.appendChild(pick);
      return wrap;
    };

    if (sel.kind === 'group' && selGroup()) {
      const g = selGroup();
      add(el('div', 'phead', '<span>Group</span>'));
      add(field('Title', text(g.title, v => commit(updateGroup(board, g.id, { title: v }), { silent: true }) || refreshSoon(), 'group-title')));
      add(field('Blurb', text(g.blurb, v => { commit(updateGroup(board, g.id, { blurb: v }), { silent: true }); }),
        'Shown in ⌘K when the group is offered as a jump target.'));

      const sw = el('div', 'swatches');
      DEFAULT_COLORS.forEach(c => {
        const b = el('button');
        b.style.background = c;
        b.setAttribute('aria-pressed', String(c === g.color));
        b.onclick = () => commit(updateGroup(board, g.id, { color: c }));
        sw.appendChild(b);
      });
      add(field('Colour', sw, 'Tints the notes, leader lines and step widget for this group.'));

      const layout = el('select');
      layout.dataset.testid = 'group-layout';
      layout.innerHTML = `<option value="auto">auto — flow in a grid</option>
                          <option value="manual">free hand — drag to place</option>`;
      layout.value = g.layout;
      layout.onchange = () => {
        const positions = Object.fromEntries(placeScreens(g).map(p => [p.id, p]));
        commit(setGroupLayout(board, g.id, layout.value, positions));
      };
      add(field('Layout', layout, g.layout === 'auto'
        ? 'Adding a screen reflows the others. Switch to free hand to pin them.'
        : 'Drag screens on the canvas. New screens land to the right.'));

      const del = el('button', 'btn danger', 'delete group');
      del.onclick = () => {
        if (!confirm(`Delete "${g.title}" and its ${g.screens.length} screens?`)) return;
        commit(deleteGroup(board, g.id));
        select({ kind: 'board' });
      };
      const r = el('div', 'row'); r.appendChild(del); add(r);
      return;
    }

    if (sel.kind === 'screen' && screenOf(sel.screenId)) {
      const { group: g, screen: s } = screenOf(sel.screenId);
      add(el('div', 'phead', '<span>Screen</span>'));
      add(field('Name', text(s.name, v => { commit(updateScreen(board, s.id, { name: v }), { silent: true }); refreshSoon(); }, 'screen-name')));
      add(field('Search keywords', text((s.keywords || []).join(', '),
        v => commit(updateScreen(board, s.id, { keywords: v.split(',').map(x => x.trim()).filter(Boolean) }), { silent: true })),
        'Comma separated. These outrank anything read from the image itself.'));
      add(field('Source', el('div', 'hint', `${esc(s.src)}<br>${s.w}×${s.h}px`)));
      add(field('Background', bgControl(s.background ?? null,
        v => commit(setScreenBackground(board, s.id, v)),
        { inherit: board.screenBackground ?? DEFAULT_SCREEN_BG }),
        s.background
          ? 'Overrides the board default for this screenshot.'
          : 'Following the board default. Shows through any transparency in the image.'));

      /* Which steps use this screen — the relationship was invisible before. */
      const users = g.steps.map((st, i) => ({ st, i })).filter(x => x.st.screen === s.id);
      add(el('div', 'phead', `<span>Used by ${users.length} step${users.length === 1 ? '' : 's'}</span>`));
      if (!users.length) {
        add(el('div', 'empty', 'No step shows this screen yet, so it will not appear in the demo.'));
      }
      for (const { st, i } of users) {
        const row = el('div', 'note-row', `
          <span class="i">${String(i + 1).padStart(2, '0')}</span>
          <span class="x">${esc(st.kicker || '(no kicker)')}${
            st.notes.length ? ` · ${st.notes.length} note${st.notes.length === 1 ? '' : 's'}` : ' · no notes'}</span>`);
        row.dataset.testid = 'screen-step';
        row.onclick = () => select({ kind: 'step', groupId: g.id, stepId: st.id });
        const w = el('div', 'fld'); w.appendChild(row); add(w);
      }

      if (board.groups.length > 1) {
        const move = el('select');
        move.dataset.testid = 'move-to-group';
        move.innerHTML = `<option value="">move to another group…</option>` +
          board.groups.filter(x => x.id !== g.id)
            .map(x => `<option value="${x.id}">${esc(x.title)}</option>`).join('');
        move.onchange = () => {
          if (!move.value) return;
          const users = g.steps.filter(st => st.screen === s.id).length;
          commit(moveScreenToGroup(board, s.id, move.value));
          toast(users ? `Moved with ${users} step${users > 1 ? 's' : ''}` : 'Moved', 'good');
          select({ kind: 'screen', screenId: s.id, groupId: move.value });
        };
        add(field('Group', move, 'Steps that show this screen move with it.'));
      }

      const replaceBtn = el('button', 'btn', 'replace image…');
      replaceBtn.dataset.testid = 'replace-image';
      replaceBtn.onclick = () => {
        replaceInput.onchange = async () => {
          const file = replaceInput.files?.[0];
          replaceInput.value = '';
          if (file) await replaceScreen(s.id, file);
        };
        replaceInput.click();
      };
      const r0 = el('div', 'row'); r0.appendChild(replaceBtn); add(r0);

      const addStepBtn = el('button', 'btn', 'add a step for this screen');
      addStepBtn.dataset.testid = 'add-step-for-screen';
      addStepBtn.onclick = () => {
        const next = addStep(board, g.id, { screen: s.id, kicker: s.name.toLowerCase() });
        commit(next);
        select({ kind: 'step', groupId: g.id, stepId: groupOfIn(next, g.id).steps.at(-1).id });
      };
      const del = el('button', 'btn danger', 'delete screen');
      del.onclick = () => {
        const used = g.steps.filter(st => st.screen === s.id).length;
        if (!confirm(`Delete "${s.name}"?${used ? ` ${used} step(s) use it and will be removed.` : ''}`)) return;
        commit(deleteScreen(board, s.id));
        select({ kind: 'group', groupId: g.id });
      };
      const r1 = el('div', 'row'); r1.appendChild(addStepBtn); add(r1);
      const r2 = el('div', 'row'); r2.appendChild(del); add(r2);
      return;
    }

    if (sel.kind === 'step' || sel.kind === 'note') {
      const st = selStep();
      if (!st) { add(el('div', 'empty', 'Select something on the left.')); return; }
      const g = selGroup();
      add(el('div', 'phead', '<span>Step</span>'));
      add(field('Kicker', text(st.kicker, v => { commit(updateStep(board, g.id, st.id, { kicker: v }), { silent: true }); refreshSoon(); }, 'step-kicker'),
        'The small line above the caption: “Step 03 — the input”.'));

      const cap = el('textarea');
      cap.dataset.testid = 'step-caption';
      cap.value = st.caption;
      cap.oninput = () => commit(updateStep(board, g.id, st.id, { caption: cap.value }), { silent: true });
      add(field('Caption', cap, 'One sentence. **bold** is supported.'));

      const scr = el('select');
      scr.dataset.testid = 'step-screen';
      scr.innerHTML = `<option value="">— overview (fits the whole group) —</option>` +
        g.screens.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      scr.value = st.screen ?? '';
      scr.onchange = () => {
        if (st.notes.length && scr.value !== (st.screen ?? '')
            && !confirm('Changing the screen discards this step’s notes — their rects belong to the old image. Continue?')) {
          scr.value = st.screen ?? ''; return;
        }
        commit(updateStep(board, g.id, st.id, { screen: scr.value || null }));
      };
      add(field('Screen', scr));

      const gut = el('select');
      gut.dataset.testid = 'step-gutter';
      gut.innerHTML = `<option value="right">right</option><option value="left">left</option>`;
      gut.value = st.gutter;
      gut.onchange = () => commit(updateStep(board, g.id, st.id, { gutter: gut.value }));
      add(field('Note margin', gut, 'The camera reserves this side, so a note can never cover the screenshot.'));

      add(el('div', 'phead', `<span>Notes — order is reveal order</span>`));
      if (!st.notes.length) {
        add(el('div', 'empty', st.screen
          ? 'Switch to Annotate and drag a box on the screenshot.'
          : 'An overview step has no screenshot to annotate.'));
      }
      st.notes.forEach((n, ni) => {
        const row = el('div', `note-row${sel.kind === 'note' && sel.noteId === n.id ? ' sel' : ''}`, `
          <span class="i">${String(ni + 1).padStart(2, '0')}</span>
          <span class="x">${esc(n.text)}</span>
          <span class="ord">
            <button data-up data-testid="note-up" title="Earlier">▲</button>
            <button data-down data-testid="note-down" title="Later">▼</button>
          </span>
          <button class="icon danger" data-del title="Delete">×</button>`);
        row.dataset.testid = 'note-row';
        row.onclick = e => {
          if (e.target.closest('button')) return;
          select({ kind: 'note', groupId: g.id, stepId: st.id, noteId: n.id });
        };
        row.querySelector('[data-up]').onclick = () => commit(reorderNotes(board, g.id, st.id, ni, ni - 1));
        row.querySelector('[data-down]').onclick = () => commit(reorderNotes(board, g.id, st.id, ni, ni + 1));
        row.querySelector('[data-del]').onclick = () => {
          commit(deleteNote(board, g.id, st.id, n.id));
          select({ kind: 'step', groupId: g.id, stepId: st.id });
        };
        const w = el('div', 'fld'); w.appendChild(row); add(w);
      });

      if (sel.kind === 'note') {
        const n = st.notes.find(x => x.id === sel.noteId);
        if (n) {
          add(el('div', 'phead', '<span>Selected note</span>'));
          const ta = el('textarea');
          ta.dataset.testid = 'note-text';
          ta.value = n.text;
          ta.oninput = () => {
            commit(updateNote(board, g.id, st.id, n.id, { text: ta.value }), { silent: true });
            // patch the list row in place: a full re-render here would steal focus
            const rows = inspector.querySelectorAll('[data-testid="note-row"] .x');
            const at = st.notes.findIndex(x => x.id === n.id);
            if (rows[at]) rows[at].textContent = ta.value;
            refreshSoon();
          };
          add(field('Text', ta, '**bold** is supported.'));
          add(field('Area', el('div', 'hint',
            `x ${n.rect.x} · y ${n.rect.y} · w ${n.rect.w} · h ${n.rect.h}<br>Normalised 0–1 — survives re-exporting the screenshot at another size.`)));
        }
      }

      const del = el('button', 'btn danger', 'delete step');
      del.onclick = () => {
        commit(deleteStep(board, g.id, st.id));
        select({ kind: 'group', groupId: g.id });
      };
      const r = el('div', 'row'); r.appendChild(del); add(r);
      return;
    }

    add(el('div', 'phead', '<span>Board</span>'));
    add(field('Title', text(board.title, v => {
      commit(setBoardTitle(board, v), { silent: true });
      $('#btitle').value = v;
    })));
    add(field('Screenshot background',
      bgControl(board.screenBackground ?? DEFAULT_SCREEN_BG,
        v => commit(setBoardBackground(board, v || DEFAULT_SCREEN_BG))),
      'Sits behind every screenshot. Only visible where an image is transparent — ' +
      'individual screens can override it.'));
    add(el('div', 'empty', 'Select a group, screen or step to edit it.'));
  }

  // input fields re-render lazily so typing does not lose focus
  let refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { renderOutline(); }, 350);
  }

  /* ── canvas ──────────────────────────────────────────────────────────── */
  let cam = { x: 0, y: 0, z: 0.1 };
  const vp = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });

  const GPAD = 150;
  function allPlaced() {
    const out = new Map();
    for (const g of board.groups) for (const p of placeScreens(g)) out.set(p.id, p);
    return out;
  }
  /**
   * A group's region in world space. Used for BOTH drawing the frame and
   * hit-testing a drop, so what you aim at is exactly what you see. An empty
   * group still gets a region — otherwise it would be invisible and unfillable.
   */
  function frameRect(g, placedAll) {
    const bb = boundsOf(g.screens.map(s => placedAll.get(s.id)).filter(Boolean));
    if (bb) return { x0: bb.x0 - GPAD, y0: bb.y0 - GPAD, x1: bb.x1 + GPAD, y1: bb.y1 + GPAD, empty: false };
    const o = g.origin || { x: 0, y: 0 };
    return { x0: o.x - GPAD, y0: o.y - GPAD, x1: o.x + 900, y1: o.y + 560, empty: true };
  }
  function renderCanvas() {
    cworld.innerHTML = '';
    const placed = allPlaced();
    for (const g of board.groups) {
      const fr = frameRect(g, placed);
      const f = el('div', `cframe${fr.empty ? ' empty' : ''}`);
      f.dataset.group = g.id;
      f.style.cssText = `left:${fr.x0}px;top:${fr.y0}px;width:${fr.x1 - fr.x0}px;
        height:${fr.y1 - fr.y0}px;background:${hexA(g.color, fr.empty ? .03 : .05)};
        box-shadow:inset 0 0 0 ${fr.empty ? '3px' : '2px'} ${hexA(g.color, sel.groupId === g.id ? .5 : .2)}`;
      f.style.color = g.color;                // drives currentColor on .droptarget
      const lbl = f.appendChild(el('div', 'lbl', esc(g.title)));
      lbl.style.color = g.color;
      // the title is the drag handle for the whole group — grabbing the frame
      // itself would steal panning over any large group
      lbl.dataset.groupHandle = g.id;
      lbl.dataset.testid = 'group-handle';
      lbl.title = 'Drag to move this group';
      if (fr.empty) f.appendChild(el('div', 'ghint', 'drop screenshots here'));
      cworld.appendChild(f);
      for (const s of g.screens) {
        const p = placed.get(s.id);
        const d = el('div', `cscr${sel.screenId === s.id ? ' sel' : ''}${g.layout === 'manual' ? ' manual' : ''}`);
        d.dataset.testid = 'canvas-screen';
        d.dataset.screenId = s.id;
        d.style.cssText = `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px`;
        const bg = screenBackground(board, s);
        d.style.backgroundColor = bg;          // property, not cssText: no injection
        // a checker makes "transparent" readable as transparent while authoring
        d.classList.toggle('alpha', bg === 'transparent');
        // the plate box is the cropped size, so the image needs the same
        // scale-and-offset the player applies — otherwise it just squashes
        d.innerHTML = `<img src="${srcOf(s.src)}" alt="" style="${cropStyle(s)}">
          <div class="cap">${esc(s.name)}</div>`;
        // corner handles resize (rescale) the selected screen — manual only, where
        // a position is stored to anchor the opposite corner against. They sit
        // *inside* the box because .cscr clips (it hides a cropped image's overflow).
        if (sel.screenId === s.id && g.layout === 'manual') {
          for (const hd of ['nw', 'ne', 'se', 'sw']) {
            const k = el('i', `rhd rhd-${hd}`);
            k.dataset.resize = hd;
            k.dataset.testid = `resize-${hd}`;
            k.title = 'Drag to resize · double-click to reset';
            d.appendChild(k);
          }
        }
        cworld.appendChild(d);
      }
    }
    paintCanvas();
    const g = selGroup();
    hint.textContent = board.groups.length === 0
      ? 'add a group, then drop screenshots here'
      : g?.layout === 'manual' ? 'drag screens to place them · drop images to add'
      : 'auto layout — screens flow in a grid · drop images to add';
  }
  function paintCanvas() {
    const v = vp();
    cworld.style.transform =
      `translate(${v.w / 2}px,${v.h / 2}px) scale(${cam.z}) translate(${-cam.x}px,${-cam.y}px)`;
  }
  function fitCanvas() {
    const v = vp();
    // fit the group regions, not just the screens, so an empty group you just
    // created is on screen and can be dropped into
    const placedAll = allPlaced();
    const rects = board.groups.map(g => frameRect(g, placedAll));
    if (!rects.length || !v.w) { cam = { x: 0, y: 0, z: 0.5 }; paintCanvas(); return; }
    cam = camForBox({
      x0: Math.min(...rects.map(r => r.x0)), y0: Math.min(...rects.map(r => r.y0)),
      x1: Math.max(...rects.map(r => r.x1)), y1: Math.max(...rects.map(r => r.y1)),
    }, v, 400);
    paintCanvas();
  }

  // reset a screen to 1×, anchoring the corner opposite the double-clicked handle
  // so it shrinks away from where you clicked, just as a resize drag would.
  function resetScreenScale(rh) {
    const id = rh.closest('.cscr').dataset.screenId, hd = rh.dataset.resize;
    const { screen: s } = screenOf(id);
    if ((s.scale ?? 1) === 1) return;
    const c = cropOf(s), size = effectiveSize(s);
    const w1 = Math.max(1, Math.round(s.w * c.w)), h1 = Math.max(1, Math.round(s.h * c.h));  // size at scale 1
    const nx = (s.pos?.x ?? 0) + (hd.includes('w') ? size.w - w1 : 0);
    const ny = (s.pos?.y ?? 0) + (hd.includes('n') ? size.h - h1 : 0);
    commit(scaleScreen(board, id, 1, { x: nx, y: ny }));
  }

  let cdrag = null, sdrag = null, gdrag = null, rdrag = null;
  canvas.addEventListener('pointerdown', e => {
    const handle = e.target.dataset?.groupHandle;
    if (handle) {
      const g = groupOf(handle);
      select({ kind: 'group', groupId: handle });
      gdrag = { id: handle, sx: e.clientX, sy: e.clientY,
                ox: g.origin?.x ?? 0, oy: g.origin?.y ?? 0, pre: board };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* stray pointer */ }
      return;
    }
    // a resize handle must be tested before the plate itself: it lives inside the
    // .cscr, so closest('.cscr') would otherwise start a move instead.
    const rh = e.target.closest('.rhd');
    if (rh) {
      const id = rh.closest('.cscr').dataset.screenId;
      const { group: g, screen: s } = screenOf(id);
      const hd = rh.dataset.resize, c = cropOf(s);
      const size = effectiveSize(s);
      rdrag = {
        id, handle: hd, sx: e.clientX, sy: e.clientY,
        gx: g.origin?.x ?? 0, gy: g.origin?.y ?? 0,
        ox: s.pos?.x ?? 0, oy: s.pos?.y ?? 0,
        bw: s.w * c.w, bh: s.h * c.h,          // intrinsic × crop — size at scale 1
        w0: size.w, h0: size.h, startScale: s.scale ?? 1, pre: board,
      };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* stray pointer */ }
      return;
    }
    const hitEl = e.target.closest('.cscr');
    if (hitEl) {
      const id = hitEl.dataset.screenId;
      const { group: g, screen: s } = screenOf(id);
      select({ kind: 'screen', screenId: id, groupId: g.id });
      if (g.layout === 'manual') {
        sdrag = { id, gx: g.origin?.x ?? 0, gy: g.origin?.y ?? 0,
                  sx: e.clientX, sy: e.clientY, ox: s.pos?.x ?? 0, oy: s.pos?.y ?? 0, pre: board };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* stray pointer */ }
        return;
      }
      return;
    }
    if (e.button !== 0) return;
    cdrag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    canvas.classList.add('dragging');
    try { canvas.setPointerCapture(e.pointerId); } catch { /* stray pointer */ }
  });
  canvas.addEventListener('pointermove', e => {
    if (gdrag) {
      const nx = gdrag.ox + (e.clientX - gdrag.sx) / cam.z;
      const ny = gdrag.oy + (e.clientY - gdrag.sy) / cam.z;
      const before = groupOf(gdrag.id).origin ?? { x: 0, y: 0 };
      board = moveGroup(board, gdrag.id, { x: nx, y: ny });   // live, uncommitted
      const dx = Math.round(nx) - before.x, dy = Math.round(ny) - before.y;
      // shift the frame and everything inside it without a full re-render
      const shift = node => {
        node.style.left = `${parseFloat(node.style.left) + dx}px`;
        node.style.top = `${parseFloat(node.style.top) + dy}px`;
      };
      const frame = cworld.querySelector(`.cframe[data-group="${gdrag.id}"]`);
      if (frame) shift(frame);
      for (const s of groupOf(gdrag.id).screens) {
        const node = cworld.querySelector(`[data-screen-id="${s.id}"]`);
        if (node) shift(node);
      }
      return;
    }
    if (rdrag) {
      const { handle: hd, w0, h0 } = rdrag;
      // the grabbed corner moves with the pointer; the opposite corner is the
      // anchor and stays put. Uniform scale: take the axis the pointer pulled
      // furthest so the box always reaches the cursor and the aspect is kept.
      const dx = (e.clientX - rdrag.sx) / cam.z * (hd.includes('w') ? -1 : 1);
      const dy = (e.clientY - rdrag.sy) / cam.z * (hd.includes('n') ? -1 : 1);
      const factor = Math.max((w0 + dx) / w0, (h0 + dy) / h0);
      const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, rdrag.startScale * factor));
      const w1 = Math.max(1, Math.round(rdrag.bw * scale));
      const h1 = Math.max(1, Math.round(rdrag.bh * scale));
      const nx = rdrag.ox + (hd.includes('w') ? w0 - w1 : 0);   // anchor opposite corner
      const ny = rdrag.oy + (hd.includes('n') ? h0 - h1 : 0);
      board = scaleScreen(board, rdrag.id, scale, { x: nx, y: ny });   // live, uncommitted
      const node = cworld.querySelector(`[data-screen-id="${rdrag.id}"]`);
      if (node) {
        node.style.left = `${Math.round(nx) + rdrag.gx}px`; node.style.top = `${Math.round(ny) + rdrag.gy}px`;
        node.style.width = `${w1}px`; node.style.height = `${h1}px`;
      }
      return;
    }
    if (sdrag) {
      const nx = sdrag.ox + (e.clientX - sdrag.sx) / cam.z;
      const ny = sdrag.oy + (e.clientY - sdrag.sy) / cam.z;
      board = moveScreen(board, sdrag.id, { x: nx, y: ny });   // live, uncommitted
      const node = cworld.querySelector(`[data-screen-id="${sdrag.id}"]`);
      if (node) { node.style.left = `${Math.round(nx) + sdrag.gx}px`; node.style.top = `${Math.round(ny) + sdrag.gy}px`; }
      return;
    }
    if (!cdrag) return;
    cam.x = cdrag.cx - (e.clientX - cdrag.x) / cam.z;
    cam.y = cdrag.cy - (e.clientY - cdrag.y) / cam.z;
    paintCanvas();
  });
  window.addEventListener('pointerup', () => {
    // one undo entry per drag, not one per pointermove. The live drag mutated
    // `board` in place without touching undo, so rewind to the snapshot taken at
    // pointerdown — not undo.at(-1), which is the state *before* the drag began.
    if (sdrag || gdrag || rdrag) { const moved = board; board = (sdrag ?? gdrag ?? rdrag).pre; commit(moved); }
    sdrag = null; cdrag = null; gdrag = null; rdrag = null;
    canvas.classList.remove('dragging');
  });
  // A resize drag captures the pointer to the canvas, so the browser retargets
  // the following dblclick to the canvas too — hence resolve the handle by point
  // rather than trusting e.target.
  canvas.addEventListener('dblclick', e => {
    const rh = document.elementFromPoint(e.clientX, e.clientY)?.closest('.rhd');
    if (rh) resetScreenScale(rh);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const v = vp();
    const nz = Math.max(.02, Math.min(3, cam.z * Math.exp(-e.deltaY * .0016)));
    const mx = e.clientX - v.w / 2, my = e.clientY - v.h / 2;
    cam.x += mx / cam.z - mx / nz;
    cam.y += my / cam.z - my / nz;
    cam.z = nz;
    paintCanvas();
  }, { passive: false });

  /* ── screenshot import ───────────────────────────────────────────────── */
  const drop = $('#drop');
  const carriesFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

  /** Screen coordinates → world coordinates, inverting the camera transform. */
  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: cam.x + (clientX - r.left - canvas.clientWidth / 2) / cam.z,
      y: cam.y + (clientY - r.top - canvas.clientHeight / 2) / cam.z,
    };
  }
  /** Group regions in world space — the same rects the canvas draws. */
  function groupFrames() {
    const placedAll = allPlaced();
    return board.groups.map(g => ({ id: g.id, ...frameRect(g, placedAll) }));
  }
  /** Which group is under the cursor? null means "nowhere — make a new one". */
  function groupAt(pt) {
    const hits = groupFrames().filter(f => pt.x >= f.x0 && pt.x <= f.x1 && pt.y >= f.y0 && pt.y <= f.y1);
    if (!hits.length) return null;
    // overlapping frames: prefer the one whose centre is nearest the cursor
    return hits.sort((a, b) => {
      const d = f => Math.hypot((f.x0 + f.x1) / 2 - pt.x, (f.y0 + f.y1) / 2 - pt.y);
      return d(a) - d(b);
    })[0].id;
  }

  /*
   * dragenter/dragleave bubble from descendants, so crossing a child fires
   * leave→enter and the overlay strobes. Count depth instead of toggling.
   */
  let dragDepth = 0, dropTarget = null, dropPoint = null;

  /** Name the destination while the file is still in the air. */
  function markTarget(pt) {
    dropPoint = pt;
    dropTarget = pt ? groupAt(pt) : null;
    const g = dropTarget && groupOf(dropTarget);
    drop.innerHTML = g
      ? `<span>add to <em style="color:${g.color}">${esc(g.title)}</em></span>`
      : `<span>drop here to start a <em>new group</em></span>`;
    drop.dataset.target = dropTarget || '';
    cworld.querySelectorAll('.cframe').forEach(f =>
      f.classList.toggle('droptarget', !!dropTarget && f.dataset.group === dropTarget));
  }
  function clearTarget() {
    dragDepth = 0;
    dropTarget = null;
    dropPoint = null;
    drop.classList.remove('on');
    drop.removeAttribute('data-target');
    cworld.querySelectorAll('.cframe').forEach(f => f.classList.remove('droptarget'));
  }

  canvas.addEventListener('dragenter', e => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    drop.classList.add('on');
    markTarget(toWorld(e.clientX, e.clientY));
  });
  canvas.addEventListener('dragover', e => {
    if (!carriesFiles(e)) return;
    e.preventDefault();                       // without this the browser opens the file
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    markTarget(toWorld(e.clientX, e.clientY));
  });
  canvas.addEventListener('dragleave', e => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) clearTarget();
  });
  canvas.addEventListener('drop', async e => {
    e.preventDefault();
    // recompute from the drop point rather than trusting the hover state: a drop
    // can arrive without a preceding dragover
    const at = dropPoint ?? toWorld(e.clientX, e.clientY);
    const target = dropTarget ?? groupAt(at);
    clearTarget();
    const all = [...(e.dataTransfer?.files || [])];
    const images = all.filter(f => /^image\//.test(f.type));
    if (!images.length) {
      return toast(all.length ? 'Those are not images' : 'Nothing to add', 'bad');
    }
    if (images.length < all.length) toast(`Ignored ${all.length - images.length} non-image file(s)`);
    await importImages(images, target, at);
  });

  /* ── clipboard ───────────────────────────────────────────────────────── */

  /**
   * Re-encode whatever the clipboard gave us as PNG. macOS hands over PNG
   * already, but other sources vary, and normalising means one decoder path.
   */
  async function toPng(blob) {
    if (blob.type === 'image/png') return new File([blob], 'pasted.png', { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = () => rej(new Error('clipboard image could not be decoded'));
        img.src = url;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const png = await new Promise(r => c.toBlob(r, 'image/png'));
      if (!png) throw new Error('could not convert the pasted image to PNG');
      return new File([png], 'pasted.png', { type: 'image/png' });
    } finally { URL.revokeObjectURL(url); }
  }

  function askDestination(file) {
    const scr = sel.kind === 'screen' ? screenOf(sel.screenId) : null;
    const back = el('div', 'modal-back');
    back.dataset.testid = 'paste-dialog';
    const box = el('div', 'modal');
    box.innerHTML = `<h3>Paste screenshot</h3>
      <p>Where should this go?</p>`;
    const close = () => back.remove();

    const list = el('div', 'modal-list');
    if (scr) {
      const b = el('button', 'btn', `replace “${esc(scr.screen.name)}”`);
      b.dataset.testid = 'paste-replace';
      b.onclick = async () => { close(); await replaceScreen(scr.screen.id, file); };
      list.appendChild(b);
    }
    for (const g of board.groups) {
      const b = el('button', 'btn', `add to ${esc(g.title)}`);
      b.dataset.testid = 'paste-group';
      b.dataset.groupId = g.id;
      b.onclick = async () => { close(); await importImages([file], g.id, null); };
      list.appendChild(b);
    }
    const nb = el('button', 'btn primary', 'new group');
    nb.dataset.testid = 'paste-new-group';
    nb.onclick = async () => { close(); await importImages([file], null, null); };
    list.appendChild(nb);
    const cancel = el('button', 'btn', 'cancel');
    cancel.dataset.testid = 'paste-cancel';
    cancel.onclick = close;
    list.appendChild(cancel);

    box.appendChild(list);
    back.appendChild(box);
    back.onclick = e => { if (e.target === back) close(); };
    mount.appendChild(back);
    list.querySelector('button')?.focus();
  }

  async function onPaste(e) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;   // let text paste work
    if (mode === 'preview') return;
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find(i => i.kind === 'file' && /^image\//.test(i.type));
    if (!img) return;
    e.preventDefault();
    const blob = img.getAsFile();
    if (!blob) return;
    try {
      const file = await toPng(blob);
      if (!board.groups.length) return importImages([file], null, null);
      askDestination(file);
    } catch (err) { toast(err.message, 'bad'); }
  }
  window.addEventListener('paste', onPaste);

  /* A file dropped anywhere else in the app must not navigate the editor away. */
  const swallowDrop = e => { if (carriesFiles(e)) e.preventDefault(); };
  window.addEventListener('dragover', swallowDrop);
  window.addEventListener('drop', swallowDrop);

  /** Reads intrinsic size before storing — the layout needs it before load. */
  async function intrinsicSize(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('not a readable image')); img.src = url; });
      return { w: img.naturalWidth, h: img.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  }
  const replaceInput = $('#replaceFile');

  /** Store an image file and return what a screen needs to reference it. */
  async function stashImage(file, label = file.name) {
    const { w, h } = await intrinsicSize(file);
    if (!w || !h) throw new Error('image has no intrinsic size');
    const src = await store.putImage(board.id,
      `${Date.now().toString(36)}-${label}`, new Uint8Array(await file.arrayBuffer()));
    urlCache.set(src, await store.imageURL(board.id, src.replace(/^images\//, '')));
    return { src, w, h };
  }

  async function replaceScreen(screenId, file) {
    const found = screenOf(screenId);
    if (!found) return;
    try {
      const img = await stashImage(file);
      const old = found.screen;
      const oldAspect = old.w / old.h, newAspect = img.w / img.h;
      const noteCount = found.group.steps
        .filter(st => st.screen === screenId)
        .reduce((n, st) => n + st.notes.length, 0);
      // rects are normalised, so a different shape moves them relative to content
      if (noteCount && Math.abs(oldAspect - newAspect) / oldAspect > 0.02 &&
          !confirm(`The new image has a different shape (${img.w}×${img.h} vs ${old.w}×${old.h}).\n` +
                   `${noteCount} annotation${noteCount > 1 ? 's' : ''} will keep their relative position, ` +
                   `so they may no longer line up. Replace anyway?`)) return;
      commit(replaceScreenImage(board, screenId, img));
      toast('Screenshot replaced', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  }

  /**
   * @param {string|null} targetId group the drop landed on; null starts a new one
   * @param {{x,y}|null}  at       world point of the drop, used to place both a
   *                               new group and (in manual layout) the screen
   */
  async function importImages(files, targetId = null, at = null) {
    let g = targetId ? groupOf(targetId) : null;
    let next = board;
    const wasEmpty = board.groups.every(x => x.screens.length === 0);
    if (!g) {
      next = addGroup(next, { title: 'New group' });
      g = next.groups.at(-1);
      if (at) g.origin = { x: Math.round(at.x), y: Math.round(at.y) };
    }
    let added = 0, firstNew = null;
    for (const file of files) {
      try {
        const { w, h } = await intrinsicSize(file);
        if (!w || !h) throw new Error('image has no intrinsic size');
        const src = await store.putImage(board.id,
          `${Date.now().toString(36)}-${added}-${file.name}`, new Uint8Array(await file.arrayBuffer()));
        urlCache.set(src, await store.imageURL(board.id, src.replace(/^images\//, '')));
        const cur = next.groups.find(x => x.id === g.id);
        // in free-hand layout, land the screen where it was actually dropped
        const pos = at && cur?.layout === 'manual'
          ? { x: at.x - (cur.origin?.x ?? 0) - w / 2 + added * 40,
              y: at.y - (cur.origin?.y ?? 0) - h / 2 + added * 40 }
          : undefined;
        next = addScreen(next, g.id, { name: file.name.replace(/\.[^.]+$/, ''), src, w, h, pos });
        firstNew ??= next.groups.find(x => x.id === g.id).screens.at(-1).id;
        added++;
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'bad');
      }
    }
    if (!added) return;
    commit(next);
    select({ kind: 'screen', screenId: firstNew, groupId: g.id });
    // only re-frame for the very first screen — re-fitting mid-session would
    // yank the canvas away while you are placing things
    if (wasEmpty) fitCanvas();
    const name = groupOf(g.id)?.title ?? 'the board';
    toast(`Added ${added} screen${added > 1 ? 's' : ''} to ${name}`, 'good');
  }

  /* ── annotate ────────────────────────────────────────────────────────── */
  let rub = null;
  function renderAnnotate() {
    const st = selStep();
    shot.querySelectorAll('.hot').forEach(n => n.remove());
    if (!st || !st.screen) {
      shotImg.removeAttribute('src');
      shot.style.width = shot.style.height = '0px';
      return;
    }
    const found = screenOf(st.screen);
    if (!found) return;
    const s = found.screen;
    const eff = effectiveSize(s);
    const maxW = annot.clientWidth - 60, maxH = annot.clientHeight - 60;
    const scale = Math.min(maxW / eff.w, maxH / eff.h, 1);
    const w = Math.max(100, Math.round(eff.w * scale)), h = Math.max(60, Math.round(eff.h * scale));
    shot.style.width = `${w}px`;
    shot.style.height = `${h}px`;
    shotImg.src = srcOf(s.src);
    shotImg.setAttribute('style', cropStyle(s));      // annotate what the demo shows
    st.notes.forEach((n, i) => {
      const selected = sel.kind === 'note' && sel.noteId === n.id;
      const b = el('div', `hot${selected ? ' sel' : ''}`, `<b>${String(i + 1).padStart(2, '0')}</b>`);
      b.dataset.testid = 'hotspot';
      b.dataset.noteId = n.id;
      b.style.cssText = `left:${n.rect.x * 100}%;top:${n.rect.y * 100}%;
        width:${n.rect.w * 100}%;height:${n.rect.h * 100}%`;
      // handles only on the selected rect, so the others stay grabbable to move
      if (selected) {
        for (const hd of HANDLES) {
          const k = el('i', `hd hd-${hd}`);
          k.dataset.handle = hd;
          k.dataset.testid = `handle-${hd}`;
          b.appendChild(k);
        }
      }
      shot.appendChild(b);
    });
  }

  /* ── crop ────────────────────────────────────────────────────────────── */
  const cropview = $('#cropview'), cropimg = $('#cropimg'), cropbox = $('#cropbox');
  const cropImgEl = cropimg.querySelector('img'), croptools = $('#croptools');
  let cropDraft = null;                       // live crop while dragging

  function cropTarget() {
    if (sel.kind === 'screen') return screenOf(sel.screenId);
    const st = selStep();
    return st?.screen ? screenOf(st.screen) : null;
  }
  function renderCrop() {
    const found = cropTarget();
    croptools.innerHTML = '';
    if (!found) {
      cropImgEl.removeAttribute('src');
      cropimg.style.width = cropimg.style.height = '0px';
      croptools.appendChild(el('div', 'empty', 'Select a screen to crop it.'));
      return;
    }
    const s = found.screen;
    const maxW = cropview.clientWidth - 80, maxH = cropview.clientHeight - 140;
    const scale = Math.min(maxW / s.w, maxH / s.h, 1);
    const w = Math.max(120, Math.round(s.w * scale)), h = Math.max(80, Math.round(s.h * scale));
    cropimg.style.width = `${w}px`;
    cropimg.style.height = `${h}px`;
    cropImgEl.src = srcOf(s.src);
    // the crop view always shows the WHOLE source, so you can give margin back
    cropImgEl.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill');

    const c = cropDraft || cropOf(s);
    cropbox.style.cssText = `left:${c.x * 100}%;top:${c.y * 100}%;width:${c.w * 100}%;height:${c.h * 100}%`;
    cropbox.innerHTML = HANDLES.map(hd =>
      `<i class="hd hd-${hd}" data-handle="${hd}" data-testid="crop-${hd}"></i>`).join('');
    // the complement of the crop box, as four exact bands
    const pct = v => `${(v * 100).toFixed(4)}%`;
    $('#cropmask').innerHTML = [
      { left: 0, top: 0, width: 1, height: c.y },                                  // above
      { left: 0, top: c.y + c.h, width: 1, height: 1 - (c.y + c.h) },              // below
      { left: 0, top: c.y, width: c.x, height: c.h },                              // left
      { left: c.x + c.w, top: c.y, width: 1 - (c.x + c.w), height: c.h },          // right
    ].map(b => `<i style="left:${pct(b.left)};top:${pct(b.top)};` +
               `width:${pct(Math.max(0, b.width))};height:${pct(Math.max(0, b.height))}"></i>`).join('');

    const eff = { w: Math.round(s.w * c.w), h: Math.round(s.h * c.h) };
    croptools.appendChild(el('div', 'croptip',
      `${esc(s.name)} — showing <b>${eff.w}×${eff.h}</b> of ${s.w}×${s.h}px`));
    const reset = el('button', 'btn', 'reset crop');
    reset.dataset.testid = 'crop-reset';
    reset.onclick = () => { cropDraft = null; commit(setScreenCrop(board, s.id, FULL_CROP)); renderCrop(); };
    croptools.appendChild(reset);
    const note = el('div', 'croptip dim',
      'Annotations move with the crop, so they stay on the same pixels.');
    croptools.appendChild(note);
  }

  let cropDrag = null;
  cropbox.addEventListener('pointerdown', e => {
    const found = cropTarget();
    if (!found) return;
    e.stopPropagation();
    const r = cropimg.getBoundingClientRect();
    const c = cropDraft || cropOf(found.screen);
    cropDrag = { id: found.screen.id, r, start: { ...c },
                 handle: e.target.dataset.handle || null, sx: e.clientX, sy: e.clientY };
    try { cropbox.setPointerCapture(e.pointerId); } catch { /* stray pointer */ }
  });
  cropbox.addEventListener('pointermove', e => {
    if (!cropDrag) return;
    const { r, start, handle } = cropDrag;
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    cropDraft = handle
      ? applyHandle(start, handle, px, py)
      : moveRect(start, (e.clientX - cropDrag.sx) / r.width, (e.clientY - cropDrag.sy) / r.height);
    renderCrop();
  });
  window.addEventListener('pointerup', () => {
    if (!cropDrag) return;
    const { id } = cropDrag;
    cropDrag = null;
    if (cropDraft) { const c = cropDraft; cropDraft = null; commit(setScreenCrop(board, id, c)); }
    renderCrop();
  });
  shot.addEventListener('pointerdown', e => {
    const st = selStep();
    if (!st || !st.screen) return;
    const handle = e.target.dataset?.handle;
    const hot = e.target.closest('.hot');
    const r = shot.getBoundingClientRect();
    if (handle && hot) {
      const n = st.notes.find(x => x.id === hot.dataset.noteId);
      rub = { mode: 'resize', handle, id: n.id, rect: { ...n.rect }, r };
    } else if (hot) {
      const n = st.notes.find(x => x.id === hot.dataset.noteId);
      select({ kind: 'note', groupId: sel.groupId, stepId: st.id, noteId: n.id });
      rub = { mode: 'move', id: n.id, sx: e.clientX, sy: e.clientY, rect: { ...n.rect }, r };
    } else {
      rub = { mode: 'draw', x0: (e.clientX - r.left) / r.width, y0: (e.clientY - r.top) / r.height, r };
      rubber.style.display = 'block';
    }
    try { shot.setPointerCapture(e.pointerId); } catch { /* stray pointer */ }
  });
  shot.addEventListener('pointermove', e => {
    if (!rub) return;
    if (rub.mode === 'draw') {
      const x1 = (e.clientX - rub.r.left) / rub.r.width, y1 = (e.clientY - rub.r.top) / rub.r.height;
      const q = normalizeRect({ x: rub.x0, y: rub.y0, w: x1 - rub.x0, h: y1 - rub.y0 });
      Object.assign(rubber.style, {
        left: `${q.x * 100}%`, top: `${q.y * 100}%`, width: `${q.w * 100}%`, height: `${q.h * 100}%`,
      });
      rub.rect = q;
    } else if (rub.mode === 'resize') {
      const px = (e.clientX - rub.r.left) / rub.r.width;
      const py = (e.clientY - rub.r.top) / rub.r.height;
      rub.moved = applyHandle(rub.rect, rub.handle, px, py);
      paintHot(rub.id, rub.moved);
    } else {
      const dx = (e.clientX - rub.sx) / rub.r.width, dy = (e.clientY - rub.sy) / rub.r.height;
      rub.moved = moveRect(rub.rect, dx, dy);
      paintHot(rub.id, rub.moved);
    }
  });
  /** Live feedback without a re-render, so the drag stays smooth. */
  function paintHot(id, q) {
    const node = shot.querySelector(`[data-note-id="${id}"]`);
    if (!node) return;
    node.style.left = `${q.x * 100}%`;
    node.style.top = `${q.y * 100}%`;
    node.style.width = `${q.w * 100}%`;
    node.style.height = `${q.h * 100}%`;
  }
  window.addEventListener('pointerup', () => {
    if (!rub) return;
    const st = selStep();
    rubber.style.display = 'none';
    if (rub.mode === 'draw' && rub.rect && st) {
      const next = addNote(board, sel.groupId, st.id, { text: '', rect: rub.rect });
      commit(next);
      const created = resolveStep(next, sel.groupId, st.id).step.notes.at(-1);
      select({ kind: 'note', groupId: sel.groupId, stepId: st.id, noteId: created.id });
      inspector.querySelector('[data-testid="note-text"]')?.focus();
    } else if ((rub.mode === 'move' || rub.mode === 'resize') && rub.moved && st) {
      commit(updateNote(board, sel.groupId, st.id, rub.id, { rect: rub.moved }));
    }
    rub = null;
  });

  /* ── preview ─────────────────────────────────────────────────────────── */
  async function renderPreview() {
    if (player) { player.destroy(); player = null; }
    const host = $('#stageWrap');
    let box = host.querySelector('#previewHost');
    if (!box) { box = el('div'); box.id = 'previewHost'; box.style.cssText = 'position:absolute;inset:0'; host.appendChild(box); }
    box.innerHTML = '';
    /*
     * The player is position:fixed throughout, so preview covers the whole
     * window — toolbar included. It therefore has to carry its own way out.
     */
    const exit = el('button', 'exit-preview', 'exit preview <em>esc</em>');
    exit.dataset.testid = 'exit-preview';
    exit.onclick = () => setMode('layout');
    box.appendChild(exit);
    if (!board.groups.some(g => g.steps.length)) {
      box.appendChild(el('div', 'empty', 'Nothing to preview yet — add a step to a group.'))
        .style.padding = '40px';
      return;
    }
    await warmImages();
    try {
      const stage = el('div');
      box.appendChild(stage);
      // Open preview on the layout viewport, not the opening step — see the
      // player's start() (initialCam). The reverse carry-back is in setMode.
      player = createPlayer({ mount: stage, board, resolveSrc: srcOf, initialCam: { ...cam } });
      player.start();
      window.__player = player;                // e2e handle, same as the standalone player
    } catch (e) {
      box.innerHTML = `<div class="empty" style="padding:40px;color:#F3B5AC">${esc(e.message)}<br>${(e.errors || []).map(esc).join('<br>')}</div>`;
    }
  }

  /* ── modes ───────────────────────────────────────────────────────────── */
  function setMode(m) {
    mode = m;
    mount.querySelectorAll('[data-mode]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    canvas.classList.toggle('hidden', m !== 'layout');
    hint.classList.toggle('hidden', m !== 'layout');
    annot.classList.toggle('on', m === 'annotate');
    cropview.classList.toggle('on', m === 'crop');
    $('#body').classList.toggle('wide', m === 'preview');
    // Preview hides the chrome rather than letting the position:fixed player
    // paint over it — a paint-order gamble that leaked the toolbar and rail
    // through during zoom animations. The exit button lives inside
    // #previewHost, so the way out survives.
    $('#top').classList.toggle('hidden', m === 'preview');
    $('#outline').classList.toggle('hidden', m === 'preview');
    const prev = $('#previewHost');
    if (prev) prev.classList.toggle('hidden', m !== 'preview');
    if (m === 'preview') renderPreview();
    else if (player) {
      // Symmetric with entry: carry the preview camera back so layout resumes
      // exactly where preview left off. Drags re-read cam at grab time, so a
      // repaint is all it takes.
      cam = player.camera;
      player.destroy(); player = null;
      paintCanvas();
    }
    if (m === 'annotate') renderAnnotate();
    if (m === 'crop') { cropDraft = null; renderCrop(); }
  }
  mount.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));

  /* ── export / publish ────────────────────────────────────────────────── */
  const download = (bytes, name) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = el('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const readImage = name => store.readImage(board.id, name);

  $('#export').onclick = async () => {
    try {
      const zip = await exportBoard(board, readImage);
      download(zip, filenameFor(board, '.demoboard.zip'));
      await store.markExported(board.id);
      toast('Exported. Keep it somewhere the browser cannot evict.', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  };

  /**
   * Publishing reads the app's own built player and repackages it. That is what
   * lets a page in the browser emit a deployable static site with no build step.
   */
  $('#publish').onclick = async () => {
    try {
      const files = await fetchPlayerTemplate();
      const zip = await publishBoard(board, readImage, files);
      download(zip, filenameFor(board, '-site.zip'));
      toast('Static site ready — unzip onto S3 and open index.html over http.', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  };

  async function fetchPlayerTemplate() {
    const base = new URL('.', location.href);
    const htmlRes = await fetch(new URL('player.html', base));
    if (!htmlRes.ok) throw new Error('Could not read the player template (player.html)');
    let html = await htmlRes.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(m => m[1]).filter(u => !/^https?:|^\/\/|^data:/.test(u));
    const files = {};
    for (const rel of assets) {
      const res = await fetch(new URL(rel, base));
      if (!res.ok) continue;
      files[rel.replace(/^\.?\//, '')] = new Uint8Array(await res.arrayBuffer());
    }
    files['index.html'] = new TextEncoder().encode(html);
    return files;
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */
  $('#btitle').oninput = e => commit(setBoardTitle(board, e.target.value), { silent: true });
  $('#undo').onclick = doUndo;
  $('#library').onclick = async () => {
    clearTimeout(saveTimer);
    try { await store.saveBoard(board); } catch { /* reported below */ }
    if (player) player.destroy();
    onExit();
  };

  function onKey(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    // Escape is the only key the editor keeps in preview — without it there is
    // no way back, because the player covers the toolbar
    if (e.key === 'Escape' && mode === 'preview') {
      if (mount.querySelector('#pal.on')) return;   // let ⌘K close first
      e.preventDefault();
      setMode('layout');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return;
    }
    if (typing || mode === 'preview') return;
    if (e.key === '1') setMode('layout');
    if (e.key === '2') setMode('annotate');
    if (e.key === '3') setMode('crop');
    if (e.key === '4') setMode('preview');
    if (e.key === 'f' || e.key === 'F') fitCanvas();
  }
  window.addEventListener('keydown', onKey);
  const onResize = () => { paintCanvas(); if (mode === 'annotate') renderAnnotate(); };
  window.addEventListener('resize', onResize);

  function renderAll() {
    renderOutline();
    renderInspector();
    if (mode === 'layout') renderCanvas();
    if (mode === 'annotate') renderAnnotate();
    if (mode === 'crop') renderCrop();
  }

  (async () => {
    await warmImages();
    renderAll();
    fitCanvas();
  })();

  return {
    get board() { return board; },
    get camera() { return { ...cam }; },   // test seam, mirrors the player's
    setMode,
    selectBoard: () => select({ kind: 'board' }),
    /* test seams for flows that start outside the page (file pickers, clipboard) */
    applyCrop: (screenId, crop) => commit(setScreenCrop(board, screenId, crop)),
    replaceWith: (screenId, file) => replaceScreen(screenId, file),
    destroy() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', swallowDrop);
      window.removeEventListener('drop', swallowDrop);
      if (player) player.destroy();
      mount.innerHTML = '';
    },
  };
}
