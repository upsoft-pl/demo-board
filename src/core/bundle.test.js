import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import {
  exportBoard, readBundle, publishBoard, installBundle, referencedImages,
  filenameFor, BOARD, MANIFEST,
} from './bundle.js';
import { createStore, createMemoryFS } from './store.js';
import { createBoard, addGroup, addScreen, addStep, addNote } from './edit.js';
import { createIdFactory, validateBoard } from './schema.js';

let seq = 0;
function sample(title = 'Demo') {
  const f = createIdFactory(seq += 1000);
  let b = createBoard({ title }, f);
  b = addGroup(b, { title: 'Bugs' }, f);
  const g = b.groups[0].id;
  b = addScreen(b, g, { name: 'Inbox', src: 'images/inbox.png', w: 1280, h: 800 }, f);
  b = addScreen(b, g, { name: 'Issue', src: 'images/issue.png', w: 1280, h: 800 }, f);
  const [s1] = b.groups[0].screens.map(s => s.id);
  b = addStep(b, g, { screen: s1, kicker: 'input', caption: 'Noise.' }, f);
  const t1 = b.groups[0].steps[0].id;
  b = addNote(b, g, t1, { text: 'look here', rect: { x: .1, y: .1, w: .3, h: .1 } }, f);
  return b;
}
const IMAGES = { 'inbox.png': new Uint8Array([1, 2, 3]), 'issue.png': new Uint8Array([4, 5, 6]) };
const reader = (bag = IMAGES) => async name => bag[name] ?? null;
const idf = () => createIdFactory(seq += 1000);

describe('referencedImages', () => {
  it('lists each image once, without the images/ prefix', () => {
    expect(referencedImages(sample()).sort()).toEqual(['inbox.png', 'issue.png']);
  });

  it('includes the brand logo so publishing carries it', () => {
    const b = { ...sample(), brand: { logo: 'images/logo.svg', opacity: 0.6 } };
    expect(referencedImages(b).sort()).toEqual(['inbox.png', 'issue.png', 'logo.svg']);
  });
});

describe('exportBoard', () => {
  it('writes a manifest, the board and every image', async () => {
    const b = sample();
    const files = unzipSync(await exportBoard(b, reader()));
    expect(Object.keys(files).sort())
      .toEqual([BOARD, 'images/inbox.png', 'images/issue.png', MANIFEST].sort());
    expect(JSON.parse(strFromU8(files[BOARD])).id).toBe(b.id);
    expect(files['images/inbox.png']).toEqual(IMAGES['inbox.png']);
  });

  it('refuses to export an invalid board', async () => {
    const b = sample();
    b.groups[0].screens[0].w = 0;
    await expect(exportBoard(b, reader())).rejects.toThrow(/invalid board/);
  });

  it('refuses rather than shipping a bundle with missing images', async () => {
    const b = sample();
    await expect(exportBoard(b, reader({ 'inbox.png': IMAGES['inbox.png'] })))
      .rejects.toThrow(/1 image\(s\) missing/);
  });

  it('packs the brand logo alongside the screenshots', async () => {
    const b = { ...sample(), brand: { logo: 'images/logo.svg' } };
    const bag = { ...IMAGES, 'logo.svg': new Uint8Array([7, 8, 9]) };
    const files = unzipSync(await exportBoard(b, reader(bag)));
    expect(files['images/logo.svg']).toEqual(bag['logo.svg']);
  });

  it('refuses to export when the brand logo is missing from storage', async () => {
    const b = { ...sample(), brand: { logo: 'images/logo.svg' } };
    await expect(exportBoard(b, reader())).rejects.toThrow(/1 image\(s\) missing/);
  });
});

describe('readBundle', () => {
  it('round-trips a board with no content drift', async () => {
    const b = sample();
    const { board, images } = readBundle(await exportBoard(b, reader()), { idf: idf() });
    expect(board.groups).toEqual(b.groups);
    expect(images.map(i => i.name).sort()).toEqual(['inbox.png', 'issue.png']);
    expect(validateBoard(board).ok).toBe(true);
  });

  it('always mints a new board id — import never overwrites', async () => {
    const b = sample();
    const zip = await exportBoard(b, reader());
    const f = idf();
    const one = readBundle(zip, { idf: f }).board;
    const two = readBundle(zip, { idf: f }).board;
    expect(one.id).not.toBe(b.id);
    expect(two.id).not.toBe(one.id);
  });

  it('marks the import in the title so two copies are tellable apart', async () => {
    const { board } = readBundle(await exportBoard(sample('Client demo'), reader()), { idf: idf() });
    expect(board.title).toBe('Client demo (imported)');
  });

  it('rejects a file that is not a zip', () => {
    expect(() => readBundle(strToU8('hello'), { idf: idf() })).toThrow(/not a readable zip/);
  });

  it('rejects a zip that is not a demo board', () => {
    const junk = zipSync({ 'notes.txt': strToU8('hi') });
    expect(() => readBundle(junk, { idf: idf() })).toThrow(/no board\.json/);
  });

  it('rejects a board.json that is not JSON', () => {
    const junk = zipSync({ [BOARD]: strToU8('{ nope') });
    expect(() => readBundle(junk, { idf: idf() })).toThrow(/not valid JSON/);
  });

  it('rejects a bundle from a newer version of the app', () => {
    const zip = zipSync({
      [MANIFEST]: strToU8(JSON.stringify({ bundleVersion: 99 })),
      [BOARD]: strToU8(JSON.stringify(sample())),
    });
    expect(() => readBundle(zip, { idf: idf() })).toThrow(/newer than this app supports/);
  });

  it('rejects a bundle whose board is structurally broken', () => {
    const b = sample();
    b.groups[0].steps[0].notes[0].rect = { x: 4, y: 4, w: 4, h: 4 };
    const zip = zipSync({ [BOARD]: strToU8(JSON.stringify(b)) });
    expect(() => readBundle(zip, { idf: idf() })).toThrow(/Cannot import board/);
  });

  it('reports images the archive is missing rather than failing silently', () => {
    const b = sample();
    const zip = zipSync({
      [BOARD]: strToU8(JSON.stringify(b)),
      'images/inbox.png': IMAGES['inbox.png'],
    });
    expect(readBundle(zip, { idf: idf() }).missing).toEqual(['issue.png']);
  });
});

describe('installBundle', () => {
  const mkStore = () => {
    let t = Date.parse('2026-01-01T00:00:00Z');
    return createStore(createMemoryFS(), { now: () => new Date(t += 1000).toISOString() });
  };

  it('lands a bundle in the library with its images', async () => {
    const store = mkStore();
    const zip = await exportBoard(sample(), reader());
    const { board, imported } = await installBundle(store, zip, { idf: idf() });
    expect(imported).toBe(2);
    expect((await store.listBoards()).map(x => x.id)).toEqual([board.id]);
    expect(await store.readImage(board.id, 'inbox.png')).toEqual(IMAGES['inbox.png']);
    expect(await store.loadBoard(board.id)).toEqual(board);
  });

  it('importing the same file twice creates two independent boards', async () => {
    const store = mkStore();
    const zip = await exportBoard(sample(), reader());
    const f = idf();
    const a = await installBundle(store, zip, { idf: f });
    const b = await installBundle(store, zip, { idf: f });
    expect(a.board.id).not.toBe(b.board.id);
    expect(await store.listBoards()).toHaveLength(2);

    // and they are genuinely independent
    await store.deleteBoard(a.board.id);
    expect(await store.loadBoard(b.board.id)).toBeTruthy();
    expect(await store.readImage(b.board.id, 'inbox.png')).toEqual(IMAGES['inbox.png']);
  });

  it('a full export → import → export cycle is stable', async () => {
    const store = mkStore();
    const first = await exportBoard(sample(), reader());
    const { board } = await installBundle(store, first, { idf: idf() });
    const second = await exportBoard(board, name => store.readImage(board.id, name));
    const reimported = readBundle(second, { idf: idf() }).board;
    expect(reimported.groups).toEqual(board.groups);
  });
});

describe('publishBoard', () => {
  const template = {
    'index.html': strToU8('<!doctype html><div id=app></div>'),
    'assets/index.js': strToU8('console.log(1)'),
    'assets/index.css': strToU8('body{}'),
  };

  it('emits a self-contained static site', async () => {
    const b = sample();
    const files = unzipSync(await publishBoard(b, reader(), template, { now: () => 'T' }));
    expect(Object.keys(files).sort()).toEqual([
      'README.txt', 'assets/index.css', 'assets/index.js', BOARD,
      'images/inbox.png', 'images/issue.png', 'index.html',
    ].sort());
    expect(JSON.parse(strFromU8(files[BOARD])).title).toBe('Demo');
  });

  it('ships no editor manifest — the published site is view-only', async () => {
    const files = unzipSync(await publishBoard(sample(), reader(), template, { now: () => 'T' }));
    expect(files[MANIFEST]).toBeUndefined();
  });

  it('warns in the README that file:// will not work', async () => {
    const files = unzipSync(await publishBoard(sample(), reader(), template, { now: () => 'T' }));
    expect(strFromU8(files['README.txt'])).toMatch(/file:\/\/ page cannot fetch/);
  });

  it('refuses without a player template rather than emitting a broken site', async () => {
    await expect(publishBoard(sample(), reader(), { 'assets/x.js': strToU8('') }))
      .rejects.toThrow(/player template/);
    await expect(publishBoard(sample(), reader(), null)).rejects.toThrow(/player template/);
  });

  it('refuses when an image is missing', async () => {
    await expect(publishBoard(sample(), reader({}), template)).rejects.toThrow(/missing/);
  });
});

describe('filenameFor', () => {
  it('makes a safe filename from the board title', () => {
    expect(filenameFor({ title: 'Acme — Client Demo!' }, '.zip')).toBe('acme-client-demo.zip');
  });
  it('falls back when the title has nothing usable', () => {
    expect(filenameFor({ title: '!!!' }, '.zip')).toBe('board.zip');
    expect(filenameFor({}, '.zip')).toBe('board.zip');
  });
});
