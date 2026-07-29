/**
 * The board library.
 *
 * Storage is OPFS in the browser, but every decision here is made against a
 * tiny filesystem interface so the logic can be tested in node against an
 * in-memory adapter. The OPFS adapter at the bottom is deliberately dumb.
 *
 * Layout inside the store:
 *   index.json                   { boards: [{id,title,updatedAt,lastExportedAt}] }
 *   boards/<id>/board.json
 *   boards/<id>/images/<file>
 *
 * IMPORTANT: this is a cache, not a vault. Browsers evict origin-private
 * storage under pressure, and "clear browsing data" wipes it. Callers should
 * surface `persisted` and nag on a stale `lastExportedAt`.
 */

import { validateBoard, normalizeBoard, migrateBoard } from './schema.js';

const INDEX = 'index.json';
const boardDir = id => `boards/${id}`;
const boardFile = id => `${boardDir(id)}/board.json`;
const imageFile = (id, name) => `${boardDir(id)}/images/${name}`;

/* ── in-memory adapter (tests, and a fallback when OPFS is unavailable) ──── */

export function createMemoryFS(seed = {}) {
  const files = new Map(Object.entries(seed));
  const urls = new Map();
  return {
    async read(path) {
      if (!files.has(path)) return null;
      const v = files.get(path);
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async readBinary(path) {
      const v = files.get(path);
      if (v == null) return null;
      return typeof v === 'string' ? new TextEncoder().encode(v) : v;
    },
    async write(path, data) {
      files.set(path, data);
      if (urls.has(path)) { URL.revokeObjectURL(urls.get(path)); urls.delete(path); }
    },
    async remove(prefix) {
      for (const k of [...files.keys()]) if (k === prefix || k.startsWith(prefix + '/')) files.delete(k);
    },
    async list(prefix) {
      return [...files.keys()].filter(k => k.startsWith(prefix + '/')).map(k => k.slice(prefix.length + 1));
    },
    /**
     * In a browser this must be a real, loadable URL — the memory adapter backs
     * the e2e runs, and an <img> cannot load a made-up scheme.
     */
    async url(path) {
      if (urls.has(path)) return urls.get(path);
      const v = files.get(path);
      if (v == null) return '';
      if (typeof URL === 'undefined' || !URL.createObjectURL) return `memory:${path}`;
      const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
      const u = URL.createObjectURL(new Blob([bytes]));
      urls.set(path, u);
      return u;
    },
    _files: files,
  };
}

/* ── OPFS adapter ────────────────────────────────────────────────────────── */

export function createOPFS() {
  const rootP = navigator.storage.getDirectory();
  const walk = async (path, { create = false } = {}) => {
    const parts = path.split('/').filter(Boolean);
    const file = parts.pop();
    let dir = await rootP;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return { dir, file };
  };
  const blobs = new Map();                       // path → object URL, revoked on overwrite

  return {
    async read(path) {
      try {
        const { dir, file } = await walk(path);
        return await (await (await dir.getFileHandle(file)).getFile()).text();
      } catch { return null; }
    },
    async readBinary(path) {
      try {
        const { dir, file } = await walk(path);
        const f = await (await dir.getFileHandle(file)).getFile();
        return new Uint8Array(await f.arrayBuffer());
      } catch { return null; }
    },
    async write(path, data) {
      const { dir, file } = await walk(path, { create: true });
      const h = await dir.getFileHandle(file, { create: true });
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
      if (blobs.has(path)) { URL.revokeObjectURL(blobs.get(path)); blobs.delete(path); }
    },
    async remove(prefix) {
      const parts = prefix.split('/').filter(Boolean);
      const name = parts.pop();
      let dir = await rootP;
      try {
        for (const p of parts) dir = await dir.getDirectoryHandle(p);
        await dir.removeEntry(name, { recursive: true });
      } catch { /* already gone */ }
    },
    async list(prefix) {
      const parts = prefix.split('/').filter(Boolean);
      let dir = await rootP;
      try {
        for (const p of parts) dir = await dir.getDirectoryHandle(p);
      } catch { return []; }
      const out = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'file') out.push(name);
      return out;
    },
    async url(path) {
      if (blobs.has(path)) return blobs.get(path);
      const { dir, file } = await walk(path);
      const f = await (await dir.getFileHandle(file)).getFile();
      const u = URL.createObjectURL(f);
      blobs.set(path, u);
      return u;
    },
  };
}

/* ── the library ─────────────────────────────────────────────────────────── */

export function createStore(fs, { now = () => new Date().toISOString() } = {}) {
  const readIndex = async () => {
    const raw = await fs.read(INDEX);
    if (!raw) return { boards: [] };
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.boards) ? parsed : { boards: [] };
    } catch {
      return { boards: [] };                     // a corrupt index must not brick the app
    }
  };
  const writeIndex = idx => fs.write(INDEX, JSON.stringify(idx, null, 2));

  const store = {
    async listBoards() {
      const { boards } = await readIndex();
      return [...boards].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },

    async loadBoard(id) {
      const raw = await fs.read(boardFile(id));
      if (!raw) return null;
      const doc = normalizeBoard(migrateBoard(JSON.parse(raw)));
      const check = validateBoard(doc);
      if (!check.ok) {
        const e = new Error(`Stored board ${id} is invalid`);
        e.errors = check.errors;
        throw e;
      }
      return doc;
    },

    /** Writes the document and refreshes its index entry. */
    async saveBoard(board) {
      const check = validateBoard(board);
      if (!check.ok) {
        const e = new Error('Refusing to save an invalid board');
        e.errors = check.errors;
        throw e;                                 // fail fast: never persist a broken document
      }
      const stamp = now();
      await fs.write(boardFile(board.id), JSON.stringify(board, null, 2));
      const idx = await readIndex();
      const entry = idx.boards.find(b => b.id === board.id);
      if (entry) { entry.title = board.title; entry.updatedAt = stamp; }
      else idx.boards.push({ id: board.id, title: board.title, updatedAt: stamp, lastExportedAt: null });
      await writeIndex(idx);
      return stamp;
    },

    async deleteBoard(id) {
      await fs.remove(boardDir(id));
      const idx = await readIndex();
      idx.boards = idx.boards.filter(b => b.id !== id);
      await writeIndex(idx);
    },

    async markExported(id) {
      const idx = await readIndex();
      const entry = idx.boards.find(b => b.id === id);
      if (!entry) return null;
      entry.lastExportedAt = now();
      await writeIndex(idx);
      return entry.lastExportedAt;
    },

    /** @returns {string} the `src` to store on the screen, relative to board.json */
    async putImage(boardId, name, bytes) {
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
      await fs.write(imageFile(boardId, safe), bytes);
      return `images/${safe}`;
    },

    listImages: boardId => fs.list(`${boardDir(boardId)}/images`),
    readImage: (boardId, name) => fs.readBinary(imageFile(boardId, name)),
    imageURL: (boardId, name) => fs.url(imageFile(boardId, name)),

    /** Images no longer referenced by any screen — safe to reclaim. */
    async orphanImages(board) {
      const used = new Set(board.groups.flatMap(g => g.screens.map(s => s.src.replace(/^images\//, ''))));
      const all = await store.listImages(board.id);
      return all.filter(f => !used.has(f));
    },
  };
  return store;
}

/**
 * Ask the browser to stop treating our data as disposable.
 * Chrome decides heuristically, so the answer is advisory — show it.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  const already = await navigator.storage.persisted?.();
  const persisted = already || await navigator.storage.persist();
  let quota = null;
  try { quota = await navigator.storage.estimate(); } catch { /* not fatal */ }
  return { supported: true, persisted, quota };
}

/** How stale is this board's last export? Drives the backup nag. */
export function exportAge(entry, now = Date.now()) {
  if (!entry?.lastExportedAt) return { everExported: false, days: Infinity, stale: true };
  const days = (now - Date.parse(entry.lastExportedAt)) / 86_400_000;
  return { everExported: true, days, stale: days > 7 };
}
