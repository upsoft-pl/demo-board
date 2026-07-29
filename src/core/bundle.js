/**
 * Portability: zip in, zip out, and a static site you can drop on S3.
 *
 * Three shapes, one archive format:
 *   .demoboard.zip   manifest.json + board.json + images/     (share / backup)
 *   publish zip      index.html + assets/ + board.json + images/  (view-only)
 *
 * Importing never merges and never overwrites — it always mints a new board.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { validateBoard, normalizeBoard, migrateBoard, importBoard, createIdFactory } from './schema.js';

export const BUNDLE_VERSION = 1;
export const MANIFEST = 'manifest.json';
export const BOARD = 'board.json';

const RAND = prefix =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

/** Image filenames a board actually references, relative to images/. */
export function referencedImages(board) {
  const out = new Set();
  for (const g of board.groups) for (const s of g.screens) {
    out.add(String(s.src).replace(/^\.?\//, '').replace(/^images\//, ''));
  }
  return [...out];
}

/**
 * @param {object} board
 * @param {(name:string)=>Promise<Uint8Array|null>} readImage
 * @returns {Promise<Uint8Array>} zip bytes
 */
export async function exportBoard(board, readImage, { now = () => new Date().toISOString() } = {}) {
  const check = validateBoard(board);
  if (!check.ok) {
    const e = new Error('Refusing to export an invalid board');
    e.errors = check.errors;
    throw e;
  }
  const files = {
    [MANIFEST]: strToU8(JSON.stringify({
      bundleVersion: BUNDLE_VERSION,
      kind: 'demo-board',
      title: board.title,
      exportedAt: now(),
      images: referencedImages(board).length,
    }, null, 2)),
    [BOARD]: strToU8(JSON.stringify(board, null, 2)),
  };
  const missing = [];
  for (const name of referencedImages(board)) {
    const bytes = await readImage(name);
    if (!bytes) { missing.push(name); continue; }
    files[`images/${name}`] = bytes;
  }
  if (missing.length) {
    // a bundle whose images are absent looks fine until someone opens it
    const e = new Error(`Cannot export: ${missing.length} image(s) missing from storage`);
    e.missing = missing;
    throw e;
  }
  return zipSync(files, { level: 6 });
}

/**
 * Read a bundle. Returns the new board plus its images; the caller writes them.
 * Always a new board id — importing twice gives you two boards.
 */
export function readBundle(bytes, { idf = RAND, titleSuffix = ' (imported)' } = {}) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('That file is not a readable zip archive');
  }
  const raw = entries[BOARD];
  if (!raw) throw new Error(`Archive has no ${BOARD} — is this a demo board bundle?`);

  const manifest = entries[MANIFEST] ? safeJson(strFromU8(entries[MANIFEST])) : null;
  if (manifest?.bundleVersion > BUNDLE_VERSION) {
    throw new Error(`Bundle version ${manifest.bundleVersion} is newer than this app supports`);
  }

  let doc;
  try { doc = JSON.parse(strFromU8(raw)); }
  catch { throw new Error(`${BOARD} in the archive is not valid JSON`); }

  const board = importBoard(doc, { idf, titleSuffix });

  const images = [];
  for (const [path, data] of Object.entries(entries)) {
    if (path.startsWith('images/') && data.length) images.push({ name: path.slice(7), bytes: data });
  }
  const referenced = new Set(referencedImages(board));
  const missing = [...referenced].filter(n => !images.some(i => i.name === n));
  return { board, images, missing, manifest };
}

const safeJson = s => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Build the view-only static site.
 *
 * `playerFiles` is the built player bundle (path → bytes), fetched at runtime
 * from the app's own deployment. That is what lets a page in the browser emit a
 * deployable site without a build step.
 */
export async function publishBoard(board, readImage, playerFiles, opts = {}) {
  const check = validateBoard(board);
  if (!check.ok) {
    const e = new Error('Refusing to publish an invalid board');
    e.errors = check.errors;
    throw e;
  }
  if (!playerFiles || !Object.keys(playerFiles).some(p => p.endsWith('index.html'))) {
    throw new Error('Publish needs the player template (index.html was not found)');
  }
  const files = {};
  for (const [path, bytes] of Object.entries(playerFiles)) files[path] = bytes;
  files[BOARD] = strToU8(JSON.stringify(board, null, 2));

  const missing = [];
  for (const name of referencedImages(board)) {
    const bytes = await readImage(name);
    if (!bytes) { missing.push(name); continue; }
    files[`images/${name}`] = bytes;
  }
  if (missing.length) {
    const e = new Error(`Cannot publish: ${missing.length} image(s) missing from storage`);
    e.missing = missing;
    throw e;
  }
  const now = opts.now ? opts.now() : new Date().toISOString();
  files['README.txt'] = strToU8(
    `${board.title}\n\nStatic demo board, generated ${now}.\n\n` +
    `Upload the contents of this folder to any static host (S3, Netlify, GitHub Pages).\n` +
    `index.html reads board.json from the same directory, so keep them together.\n` +
    `Opening index.html directly from disk will NOT work — a file:// page cannot fetch board.json.\n`);
  return zipSync(files, { level: 6 });
}

/** Bundle → board + images, ready for the store. Kept separate so it is testable. */
export async function installBundle(store, bytes, { idf = RAND } = {}) {
  const { board, images, missing } = readBundle(bytes, { idf });
  for (const img of images) await store.putImage(board.id, img.name, img.bytes);
  await store.saveBoard(board);
  return { board, imported: images.length, missing };
}

export const filenameFor = (board, ext) =>
  `${String(board.title || 'board').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'board'}${ext}`;

export { createIdFactory, normalizeBoard, migrateBoard };
