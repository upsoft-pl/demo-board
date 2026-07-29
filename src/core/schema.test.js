import { describe, it, expect } from 'vitest';
import {
  CURRENT_VERSION, createIdFactory, validateBoard, normalizeBoard, migrateBoard,
  resolveStep, firstStepRef, reconcileRef, findGroup, screenById, importBoard,
  screenBackground, isColor,
} from './schema.js';

const good = () => ({
  version: 1, id: 'b_1', title: 'Demo',
  groups: [{
    id: 'g_bugs', title: 'Bug Reports', color: '#E9A23B', layout: 'auto',
    origin: { x: 0, y: 0 },
    screens: [
      { id: 's_inbox', name: 'The pile', src: 'images/inbox.png', w: 2560, h: 1600, keywords: ['triage'] },
      { id: 's_one',   name: 'One issue', src: 'images/one.png',  w: 2560, h: 1600, keywords: ['dedup'] },
    ],
    steps: [
      { id: 'st_a', screen: 's_inbox', kicker: 'the input', caption: 'It starts as noise.',
        gutter: 'right', notes: [{ id: 'n_1', text: 'x', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } }] },
      { id: 'st_b', screen: 's_one', kicker: 'the work', caption: 'Same bug.', gutter: 'left', notes: [] },
      { id: 'st_o', screen: null, kicker: 'the map', caption: 'Overview', notes: [] },
    ],
  }],
});

describe('validateBoard', () => {
  it('accepts a well-formed board', () => {
    expect(validateBoard(good())).toEqual({ ok: true, errors: [] });
  });

  it('reports every problem, not just the first', () => {
    const b = good();
    delete b.groups[0].screens[0].src;
    b.groups[0].screens[1].w = 0;
    const { ok, errors } = validateBoard(b);
    expect(ok).toBe(false);
    expect(errors).toHaveLength(2);
  });

  it('rejects a rect outside 0..1 — rects are normalised, not pixels', () => {
    const b = good();
    b.groups[0].steps[0].notes[0].rect = { x: 120, y: 40, w: 300, h: 20 };
    const { ok, errors } = validateBoard(b);
    expect(ok).toBe(false);
    expect(errors.join()).toMatch(/outside 0\.\.1/);
  });

  it('rejects a zero-area rect', () => {
    const b = good();
    b.groups[0].steps[0].notes[0].rect = { x: 0.1, y: 0.1, w: 0, h: 0.2 };
    expect(validateBoard(b).errors.join()).toMatch(/zero area/);
  });

  it('rejects a step pointing at a screen from another group', () => {
    const b = good();
    b.groups.push({ id: 'g2', title: 'Other', screens: [], steps: [
      { id: 'st_x', screen: 's_inbox', notes: [] },
    ] });
    expect(validateBoard(b).errors.join()).toMatch(/not in this group/);
  });

  it('rejects duplicate ids', () => {
    const b = good();
    b.groups[0].steps[1].id = 'st_a';
    expect(validateBoard(b).errors.join()).toMatch(/duplicate step id/);
  });

  it('rejects a note on an overview step — nothing to point at', () => {
    const b = good();
    b.groups[0].steps[2].notes = [{ id: 'n', text: 'x', rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }];
    expect(validateBoard(b).errors.join()).toMatch(/needs a screen/);
  });

  it('rejects a board from a future version', () => {
    expect(validateBoard({ ...good(), version: CURRENT_VERSION + 1 }).errors.join())
      .toMatch(/newer than supported/);
  });

  it('requires pos for manually laid out screens', () => {
    const b = good();
    b.groups[0].layout = 'manual';
    expect(validateBoard(b).errors.join()).toMatch(/manual layout requires pos/);
  });
});

describe('screen background', () => {
  it('defaults to white so existing boards keep their look', () => {
    const b = normalizeBoard({ groups: [] }, createIdFactory());
    expect(b.screenBackground).toBe('#FFFFFF');
    expect(screenBackground(b, { id: 's' })).toBe('#FFFFFF');
  });

  it('lets a screen override the board default', () => {
    const b = { screenBackground: '#0A0D12' };
    expect(screenBackground(b, { background: 'transparent' })).toBe('transparent');
    expect(screenBackground(b, {})).toBe('#0A0D12');
  });

  it('accepts the colour shapes a picker or a human would produce', () => {
    for (const c of ['transparent', '#fff', '#FFFFFF', '#0a0d12ff', 'rgb(1,2,3)',
                     'rgba(1,2,3,.5)', 'hsl(10 20% 30%)', 'white'])
      expect(isColor(c), c).toBe(true);
  });

  it('rejects anything that could break out of a style declaration', () => {
    for (const c of ['red;background:url(x)', '#ff', 'url(evil.png)', 'expression(1)',
                     '}body{display:none', '', null, 42])
      expect(isColor(c), String(c)).toBe(false);
  });

  it('validates board and screen colours', () => {
    const b = good();
    b.screenBackground = 'red;x:y';
    expect(validateBoard(b).errors.join()).toMatch(/screenBackground/);

    const c = good();
    c.groups[0].screens[0].background = 'nope;';
    expect(validateBoard(c).errors.join()).toMatch(/not an accepted colour/);
  });

  it('accepts a valid override', () => {
    const b = good();
    b.screenBackground = '#0A0D12';
    b.groups[0].screens[0].background = 'transparent';
    expect(validateBoard(b).ok).toBe(true);
  });
});

describe('normalizeBoard', () => {
  it('fills defaults without mutating the input', () => {
    const raw = { groups: [{ title: 'G', screens: [{ src: 'a.png', w: 10, h: 10 }], steps: [{}] }] };
    const snapshot = structuredClone(raw);
    const b = normalizeBoard(raw, createIdFactory());
    expect(raw).toEqual(snapshot);
    expect(b.version).toBe(CURRENT_VERSION);
    expect(b.groups[0].layout).toBe('auto');
    expect(b.groups[0].steps[0].gutter).toBe('right');
    expect(b.groups[0].screens[0].id).toBeTruthy();
  });

  it('produces a valid board from a minimal one', () => {
    const b = normalizeBoard(
      { groups: [{ title: 'G', screens: [{ src: 'a.png', w: 10, h: 10 }], steps: [] }] },
      createIdFactory());
    expect(validateBoard(b).ok).toBe(true);
  });
});

describe('migrateBoard', () => {
  it('stamps the current version on a versionless board', () => {
    expect(migrateBoard({ groups: [] }).version).toBe(CURRENT_VERSION);
  });
  it('leaves a current board untouched', () => {
    const b = good();
    expect(migrateBoard(b)).toEqual(b);
  });
});

describe('index-free addressing', () => {
  it('resolves a step by id and derives its current indices', () => {
    const b = good();
    expect(resolveStep(b, 'g_bugs', 'st_b')).toMatchObject({ gi: 0, si: 1 });
  });

  it('survives a step reorder — the reference still finds the same step', () => {
    const b = good();
    const ref = { groupId: 'g_bugs', stepId: 'st_b' };
    const before = resolveStep(b, ref.groupId, ref.stepId).step.caption;

    // drag step 'st_b' to the front
    const steps = b.groups[0].steps;
    steps.unshift(steps.splice(1, 1)[0]);

    const after = resolveStep(b, ref.groupId, ref.stepId);
    expect(after.si).toBe(0);                  // index moved
    expect(after.step.caption).toBe(before);   // still the same step
  });

  it('returns null for a step that no longer exists', () => {
    expect(resolveStep(good(), 'g_bugs', 'gone')).toBeNull();
    expect(resolveStep(good(), 'nope', 'st_a')).toBeNull();
  });

  it('reconciles a stale reference to the first step of its group', () => {
    const b = good();
    expect(reconcileRef(b, { groupId: 'g_bugs', stepId: 'deleted' }))
      .toEqual({ groupId: 'g_bugs', stepId: 'st_a' });
  });

  it('reconciles a reference into a vanished group', () => {
    expect(reconcileRef(good(), { groupId: 'gone', stepId: 'gone' }))
      .toEqual({ groupId: 'g_bugs', stepId: 'st_a' });
  });

  it('finds groups and screens by id', () => {
    expect(findGroup(good(), 'g_bugs').title).toBe('Bug Reports');
    expect(screenById(good(), 's_one').screen.name).toBe('One issue');
    expect(screenById(good(), 'nope')).toBeNull();
  });

  it('firstStepRef handles a group with no steps', () => {
    const b = good();
    b.groups[0].steps = [];
    expect(firstStepRef(b, 'g_bugs')).toBeNull();
  });
});

describe('importBoard', () => {
  it('mints a new board id and never reuses the source id', () => {
    const src = good();
    const out = importBoard(src, { idf: createIdFactory() });
    expect(out.id).not.toBe(src.id);
    expect(out.title).toBe('Demo (imported)');
  });

  it('leaves inner ids alone — they are scoped to their board', () => {
    const out = importBoard(good(), { idf: createIdFactory() });
    expect(out.groups[0].steps.map(s => s.id)).toEqual(['st_a', 'st_b', 'st_o']);
  });

  it('two imports of the same file produce two distinct boards', () => {
    const idf = createIdFactory();
    const a = importBoard(good(), { idf });
    const b = importBoard(good(), { idf });
    expect(a.id).not.toBe(b.id);
  });

  it('refuses a malformed board loudly rather than importing junk', () => {
    const bad = good();
    bad.groups[0].steps[0].notes[0].rect = { x: 5, y: 5, w: 5, h: 5 };
    expect(() => importBoard(bad, { idf: createIdFactory() })).toThrow(/Cannot import board/);
  });

  it('round-trips through JSON with no content drift', () => {
    // import normalises, so compare against the normalised source rather than
    // the hand-written fixture (which omits optional fields like `blurb`)
    const src = good();
    const out = importBoard(JSON.parse(JSON.stringify(src)), { idf: createIdFactory() });
    expect(out.groups).toEqual(normalizeBoard(src, createIdFactory()).groups);
  });

  it('is idempotent — exporting and re-importing changes nothing but identity', () => {
    const idf = createIdFactory();          // one factory, as a real caller would have
    const once = importBoard(good(), { idf, titleSuffix: '' });
    const twice = importBoard(JSON.parse(JSON.stringify(once)), { idf, titleSuffix: '' });
    expect(twice.groups).toEqual(once.groups);
    expect(twice.id).not.toBe(once.id);
  });
});
