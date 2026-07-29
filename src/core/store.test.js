import { describe, it, expect } from 'vitest';
import { createStore, createMemoryFS, exportAge } from './store.js';
import { createBoard, addGroup, addScreen } from './edit.js';
import { createIdFactory } from './schema.js';

const clock = () => {
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  return () => new Date(t += 1000).toISOString();
};
const mk = () => {
  const fs = createMemoryFS();
  return { fs, store: createStore(fs, { now: clock() }) };
};
// distinct seeds per board: two boards sharing an id is a test artefact, not a
// scenario the store should ever have to handle
let seq = 0;
const sample = (title = 'B') => {
  const f = createIdFactory(seq += 1000);
  let b = createBoard({ title }, f);
  b = addGroup(b, { title: 'G' }, f);
  b = addScreen(b, b.groups[0].id, { name: 'A', src: 'images/a.png', w: 100, h: 80 }, f);
  return b;
};

describe('library', () => {
  it('starts empty', async () => {
    const { store } = mk();
    expect(await store.listBoards()).toEqual([]);
    expect(await store.loadBoard('nope')).toBeNull();
  });

  it('saves and loads a board round-trip', async () => {
    const { store } = mk();
    const b = sample();
    await store.saveBoard(b);
    expect(await store.loadBoard(b.id)).toEqual(b);
  });

  it('lists boards newest-updated first', async () => {
    const { store } = mk();
    const a = sample('A'), b = sample('B');
    await store.saveBoard(a);
    await store.saveBoard(b);
    await store.saveBoard(a);                   // touch A again
    expect((await store.listBoards()).map(x => x.title)).toEqual(['A', 'B']);
  });

  it('updates the index entry rather than duplicating it', async () => {
    const { store } = mk();
    const b = sample();
    await store.saveBoard(b);
    await store.saveBoard({ ...b, title: 'Renamed' });
    const list = await store.listBoards();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Renamed');
  });

  it('refuses to persist an invalid board', async () => {
    const { store, fs } = mk();
    const bad = sample();
    bad.groups[0].screens[0].w = 0;
    await expect(store.saveBoard(bad)).rejects.toThrow(/invalid board/);
    expect(await fs.read(`boards/${bad.id}/board.json`)).toBeNull();
  });

  it('deletes a board and its files', async () => {
    const { store, fs } = mk();
    const b = sample();
    await store.saveBoard(b);
    await store.putImage(b.id, 'a.png', new Uint8Array([1, 2, 3]));
    await store.deleteBoard(b.id);
    expect(await store.listBoards()).toEqual([]);
    expect(await store.loadBoard(b.id)).toBeNull();
    expect(await store.listImages(b.id)).toEqual([]);
  });

  it('keeps boards isolated from each other', async () => {
    const { store } = mk();
    const a = sample('A'), b = sample('B');
    await store.saveBoard(a);
    await store.saveBoard(b);
    await store.deleteBoard(a.id);
    expect(await store.loadBoard(b.id)).toEqual(b);
  });

  it('survives a corrupt index instead of bricking', async () => {
    const fs = createMemoryFS({ 'index.json': '{ not json' });
    const store = createStore(fs, { now: clock() });
    expect(await store.listBoards()).toEqual([]);
    const b = sample();
    await store.saveBoard(b);
    expect((await store.listBoards()).map(x => x.id)).toEqual([b.id]);
  });

  it('throws with detail when a stored board has gone bad on disk', async () => {
    const fs = createMemoryFS();
    const store = createStore(fs, { now: clock() });
    await fs.write('boards/b_x/board.json', JSON.stringify({
      version: 1, id: 'b_x', title: 'X',
      groups: [{ id: 'g', title: 'G', screens: [{ id: 's', src: 'a.png', w: 0, h: 0 }], steps: [] }],
    }));
    await expect(store.loadBoard('b_x')).rejects.toThrow(/invalid/);
  });
});

describe('images', () => {
  it('stores an image and returns a board-relative src', async () => {
    const { store } = mk();
    const b = sample();
    const src = await store.putImage(b.id, 'shot.png', new Uint8Array([1, 2, 3]));
    expect(src).toBe('images/shot.png');
    expect(await store.readImage(b.id, 'shot.png')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('sanitises hostile filenames', async () => {
    const { store } = mk();
    const src = await store.putImage('b1', '../../etc/passwd', new Uint8Array([0]));
    expect(src).toBe('images/.._.._etc_passwd');
    expect(src).not.toContain('/etc/');
  });

  it('finds images no screen references any more', async () => {
    const { store } = mk();
    const b = sample();
    await store.saveBoard(b);
    await store.putImage(b.id, 'a.png', new Uint8Array([1]));
    await store.putImage(b.id, 'stale.png', new Uint8Array([2]));
    expect(await store.orphanImages(b)).toEqual(['stale.png']);
  });
});

describe('export tracking', () => {
  it('records when a board was last exported', async () => {
    const { store } = mk();
    const b = sample();
    await store.saveBoard(b);
    expect((await store.listBoards())[0].lastExportedAt).toBeNull();
    await store.markExported(b.id);
    expect((await store.listBoards())[0].lastExportedAt).toBeTruthy();
  });

  it('leaves lastExportedAt alone on a later save', async () => {
    const { store } = mk();
    const b = sample();
    await store.saveBoard(b);
    const at = await store.markExported(b.id);
    await store.saveBoard({ ...b, title: 'edited' });
    expect((await store.listBoards())[0].lastExportedAt).toBe(at);
  });

  it('markExported on an unknown board is a no-op', async () => {
    const { store } = mk();
    expect(await store.markExported('nope')).toBeNull();
  });
});

describe('exportAge', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  it('flags a board that has never been exported', () => {
    expect(exportAge({ lastExportedAt: null }, now))
      .toMatchObject({ everExported: false, stale: true });
  });
  it('flags an export older than a week', () => {
    expect(exportAge({ lastExportedAt: '2026-01-01T00:00:00Z' }, now).stale).toBe(true);
  });
  it('accepts a recent export', () => {
    expect(exportAge({ lastExportedAt: '2026-01-09T00:00:00Z' }, now).stale).toBe(false);
  });
});
