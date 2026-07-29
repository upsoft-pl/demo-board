/**
 * Editor entry: board library ⇄ editor.
 *
 * Storage is browser-owned (OPFS), which is convenient and evictable in equal
 * measure — so the library nags about backups and never hides that risk.
 */
import './editor.css';
import '../player/player.css';
import { createStore, createOPFS, createMemoryFS, requestPersistence, exportAge } from '../core/store.js';
import { createEditor } from './editor.js';
import { createBoard } from '../core/edit.js';
import { installBundle, exportBoard, filenameFor } from '../core/bundle.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
if (params.has('test')) document.documentElement.dataset.test = '1';

/* e2e runs against memory so tests never inherit a previous run's OPFS */
const fs = params.has('memory') || params.has('test') ? createMemoryFS() : createOPFS();
const store = createStore(fs);

let persistence = { supported: false, persisted: false };
let editor = null;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
let toastTimer = null;
function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `on ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = kind; }, 4200);
}

/* ── library ─────────────────────────────────────────────────────────────── */

async function showLibrary() {
  if (editor) { editor.destroy(); editor = null; }
  const boards = await store.listBoards();

  app.innerHTML = `
  <div id="lib"><div class="wrap">
    <h1>Demo boards</h1>
    <div class="sub">Outcome first: open on the result, then show what produced it.</div>
    <div id="persistNote"></div>
    <div class="acts">
      <button class="btn primary" id="new" data-testid="new-board">new board</button>
      <button class="btn" id="import" data-testid="import-board">import .zip</button>
      <input type="file" id="file" accept=".zip,application/zip" hidden>
    </div>
    <div class="cards" id="cards"></div>
  </div></div>`;

  /*
   * Ranked by how likely each is to actually lose someone's work. Changing
   * origin is near-certain and catches everybody (dev on localhost, then deploy
   * to Pages); disk-pressure eviction is real but rare. Saying so honestly beats
   * a scary banner that buries the thing that will actually happen.
   */
  const note = app.querySelector('#persistNote');
  const where = `${location.origin}`;
  const scope = `<b>Boards are stored in this browser, at ${esc(where)}.</b>
    A different origin, browser, profile or machine has its own separate library —
    nothing is synced. Clearing “cookies and other site data” deletes them.`;

  if (!persistence.supported) {
    note.innerHTML = `<div class="warn">${scope}
      This browser also cannot mark the data persistent, so treat it as scratch
      space and export a zip when you finish.</div>`;
  } else if (!persistence.persisted) {
    note.innerHTML = `<div class="warn">${scope}
      They are not yet marked <em>persistent</em>, so the browser may also reclaim
      them if the disk runs low — uncommon, but possible. Bookmarking this page or
      using it a few more times usually earns persistence automatically, and this
      notice will disappear.</div>`;
  } else {
    note.innerHTML = `<div class="warn" style="border-color:rgba(79,193,160,.35);
      background:rgba(79,193,160,.07);color:#A9DCC9">${scope}
      Storage <b>is</b> marked persistent, so it will not be evicted automatically.
      Export a zip anyway before anything you would hate to redo.</div>`;
  }

  const cards = app.querySelector('#cards');
  if (!boards.length) {
    cards.innerHTML = `<div class="empty">No boards yet. Create one, or import a .zip someone sent you.</div>`;
  }
  for (const b of boards) {
    const age = exportAge(b);
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.testid = 'board-card';
    card.innerHTML = `
      <h3>${esc(b.title)}</h3>
      <div class="meta">
        edited ${esc((b.updatedAt || '').slice(0, 16).replace('T', ' '))}<br>
        <span class="${age.stale ? 'stale' : ''}">${age.everExported
          ? `exported ${Math.floor(age.days)}d ago${age.stale ? ' — overdue' : ''}`
          : 'never exported — no backup'}</span>
      </div>
      <div class="foot">
        <button class="btn" data-open data-testid="open-board">open</button>
        <button class="btn" data-export>zip</button>
        <button class="btn danger" data-del>delete</button>
      </div>`;
    card.querySelector('[data-open]').onclick = () => openBoard(b.id);
    card.onclick = e => { if (!e.target.closest('button')) openBoard(b.id); };
    card.querySelector('[data-export]').onclick = async e => {
      e.stopPropagation();
      try {
        const doc = await store.loadBoard(b.id);
        const zip = await exportBoard(doc, name => store.readImage(b.id, name));
        const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = url; a.download = filenameFor(doc, '.demoboard.zip');
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        await store.markExported(b.id);
        showLibrary();
      } catch (err) { toast(err.message, 'bad'); }
    };
    card.querySelector('[data-del]').onclick = async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${b.title}"? This cannot be undone and there is no server copy.`)) return;
      await store.deleteBoard(b.id);
      showLibrary();
    };
    cards.appendChild(card);
  }

  app.querySelector('#new').onclick = async () => {
    const doc = createBoard({ title: 'Untitled board' });
    await store.saveBoard(doc);
    openBoard(doc.id);
  };
  const file = app.querySelector('#file');
  app.querySelector('#import').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const { board, imported, missing } = await installBundle(store, new Uint8Array(await f.arrayBuffer()));
      toast(missing.length
        ? `Imported "${board.title}" — ${missing.length} image(s) were missing from the archive`
        : `Imported "${board.title}" with ${imported} image(s)`, missing.length ? 'bad' : 'good');
      showLibrary();
    } catch (e) { toast(e.message, 'bad'); }
    file.value = '';
  };
}

async function openBoard(id) {
  let doc;
  try { doc = await store.loadBoard(id); }
  catch (e) { return toast(`${e.message}: ${(e.errors || []).join('; ')}`, 'bad'); }
  if (!doc) return toast('That board is gone', 'bad');
  app.innerHTML = '';
  editor = createEditor({ mount: app, store, board: doc, toast, onExit: showLibrary });
  window.__editor = editor;                    // e2e handle
}

(async () => {
  try { persistence = await requestPersistence(); } catch { /* advisory only */ }
  await showLibrary();
  window.__store = store;
  document.documentElement.dataset.ready = '1';
})();
