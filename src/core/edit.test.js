import { describe, it, expect } from 'vitest';
import {
  moveItem, addGroup, updateGroup, reorderGroups, deleteGroup, setGroupLayout,
  addScreen, updateScreen, moveScreen, reorderScreens, deleteScreen,
  addStep, updateStep, reorderSteps, deleteStep,
  addNote, updateNote, reorderNotes, deleteNote, normalizeRect,
  createBoard, setBoardTitle, setBoardBackground, setScreenBackground,
  applyHandle, moveRect, remapRect, normalizeCrop, setScreenCrop,
  replaceScreenImage, moveScreenToGroup, moveGroup, HANDLES,
  scaleScreen, SCALE_MIN, SCALE_MAX,
} from './edit.js';
import { validateBoard, createIdFactory, resolveStep, effectiveSize } from './schema.js';
import { placeScreens } from './layout.js';

const idf = () => createIdFactory();
const IMG = { src: 'images/a.png', w: 1280, h: 800 };

/** A board with one group, two screens and two steps (one annotated). */
function seed() {
  const f = idf();
  let b = createBoard({ title: 'T' }, f);
  b = addGroup(b, { title: 'G1' }, f);
  const g = b.groups[0].id;
  b = addScreen(b, g, { name: 'A', ...IMG }, f);
  b = addScreen(b, g, { name: 'B', ...IMG }, f);
  const [s1, s2] = b.groups[0].screens.map(s => s.id);
  b = addStep(b, g, { screen: s1, kicker: 'one' }, f);
  b = addStep(b, g, { screen: s2, kicker: 'two' }, f);
  const [t1, t2] = b.groups[0].steps.map(s => s.id);
  b = addNote(b, g, t1, { text: 'first', rect: { x: .1, y: .1, w: .2, h: .1 } }, f);
  b = addNote(b, g, t1, { text: 'second', rect: { x: .4, y: .4, w: .2, h: .1 } }, f);
  return { b, g, s1, s2, t1, t2, f };
}

const valid = b => expect(validateBoard(b), JSON.stringify(validateBoard(b).errors)).toMatchObject({ ok: true });

describe('moveItem', () => {
  it('moves forwards and backwards', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
  it('clamps an out-of-range destination and ignores a bad source', () => {
    expect(moveItem(['a', 'b'], 0, 99)).toEqual(['b', 'a']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
  it('does not mutate the input', () => {
    const src = ['a', 'b'];
    moveItem(src, 0, 1);
    expect(src).toEqual(['a', 'b']);
  });
});

describe('purity', () => {
  it('no mutation leaks into the previous document', () => {
    const { b, g, t1 } = seed();
    const snapshot = structuredClone(b);
    addGroup(b, { title: 'X' }, idf());
    updateGroup(b, g, { title: 'renamed' });
    addStep(b, g, { screen: null }, idf());
    addNote(b, g, t1, { text: 'x', rect: { x: 0, y: 0, w: .1, h: .1 } }, idf());
    deleteGroup(b, g);
    expect(b).toEqual(snapshot);
  });

  it('every mutation leaves the board valid', () => {
    const { b, g, s1, t1 } = seed();
    const f = idf();
    const boards = [
      addGroup(b, { title: 'X' }, f),
      updateGroup(b, g, { title: 'R', color: '#123456' }),
      addScreen(b, g, { name: 'C', ...IMG }, f),
      addStep(b, g, { screen: s1, kicker: 'k' }, f),
      addNote(b, g, t1, { text: 'n', rect: { x: 0, y: 0, w: .5, h: .5 } }, f),
      deleteScreen(b, s1),
      deleteStep(b, g, t1),
      reorderSteps(b, g, 0, 1),
      setGroupLayout(b, g, 'manual'),
    ];
    for (const x of boards) valid(x);
  });
});

describe('groups', () => {
  it('assigns each new group an unused colour', () => {
    const f = idf();
    let b = createBoard({}, f);
    b = addGroup(b, {}, f); b = addGroup(b, {}, f); b = addGroup(b, {}, f);
    const colors = b.groups.map(g => g.color);
    expect(new Set(colors).size).toBe(3);
  });

  it('places a new group clear of the existing ones', () => {
    const { b, g, f } = seed();
    const b2 = addGroup(b, { title: 'Second' }, f);
    expect(b2.groups[1].origin.x).toBeGreaterThan(b2.groups[0].origin.x);
  });

  it('renames, recolours and reorders', () => {
    const { b, g } = seed();
    expect(updateGroup(b, g, { title: 'New' }).groups[0].title).toBe('New');
    const two = addGroup(b, { title: 'Second' }, idf());
    expect(reorderGroups(two, 0, 1).groups.map(x => x.title)).toEqual(['Second', 'G1']);
  });

  it('ignores an unknown group id instead of throwing', () => {
    const { b } = seed();
    expect(updateGroup(b, 'nope', { title: 'x' })).toEqual(b);
    expect(deleteGroup(b, 'nope')).toEqual(b);
  });

  it('deletes a group and everything in it', () => {
    const { b, g } = seed();
    const out = deleteGroup(b, g);
    expect(out.groups).toHaveLength(0);
    valid(out);
  });
});

describe('moveGroup', () => {
  it('moves the group and everything placed inside it', () => {
    const { b, g } = seed();
    const before = placeScreens(b.groups[0]);
    const out = moveGroup(b, g, { x: 500, y: 300 });
    const after = placeScreens(out.groups[0]);
    expect(out.groups[0].origin).toEqual({ x: 500, y: 300 });
    after.forEach((p, i) => {
      expect(p.x - before[i].x).toBe(500);
      expect(p.y - before[i].y).toBe(300);
    });
    valid(out);
  });

  it('rounds to whole units', () => {
    const { b, g } = seed();
    expect(moveGroup(b, g, { x: 10.6, y: -3.2 }).groups[0].origin).toEqual({ x: 11, y: -3 });
  });

  it('leaves other groups where they are', () => {
    const { b, g, f } = seed();
    const two = addGroup(b, { title: 'Other' }, f);
    const other = two.groups[1].origin;
    expect(moveGroup(two, g, { x: 9, y: 9 }).groups[1].origin).toEqual(other);
  });

  it('ignores an unknown group', () => {
    const { b } = seed();
    expect(moveGroup(b, 'nope', { x: 1, y: 1 })).toEqual(b);
  });

  it('does not mutate the previous document', () => {
    const { b, g } = seed();
    const snapshot = structuredClone(b);
    moveGroup(b, g, { x: 700, y: 700 });
    expect(b).toEqual(snapshot);
  });
});

describe('screens', () => {
  it('refuses a screen with no intrinsic size — layout depends on it', () => {
    const { b, g } = seed();
    expect(() => addScreen(b, g, { src: 'a.png' }, idf())).toThrow(/positive intrinsic/);
    expect(() => addScreen(b, g, { src: 'a.png', w: 0, h: 10 }, idf())).toThrow();
  });

  it('gives a manual-layout screen a position clear of the others', () => {
    const { b, g } = seed();
    const man = setGroupLayout(b, g, 'manual');
    const out = addScreen(man, g, { name: 'C', ...IMG }, idf());
    const added = out.groups[0].screens.at(-1);
    expect(added.pos.x).toBeGreaterThan(0);
    valid(out);
  });

  it('moves a screen only in manual layout', () => {
    const { b, g, s1 } = seed();
    expect(moveScreen(b, s1, { x: 50, y: 50 })).toEqual(b);      // auto: refused
    const man = setGroupLayout(b, g, 'manual');
    const out = moveScreen(man, s1, { x: 50.6, y: 50.4 });
    expect(out.groups[0].screens[0].pos).toEqual({ x: 51, y: 50 });
  });

  it('deleting a screen drops the steps that pointed at it', () => {
    const { b, s1, t1 } = seed();
    const out = deleteScreen(b, s1);
    expect(out.groups[0].screens).toHaveLength(1);
    expect(out.groups[0].steps.map(s => s.id)).not.toContain(t1);
    valid(out);
  });

  it('deleting a screen clears related links pointing at it', () => {
    const { b, g, s1, s2 } = seed();
    const linked = updateScreen(b, s2, { related: [s1] });
    expect(deleteScreen(linked, s1).groups[0].screens[0].related).toEqual([]);
  });

  it('reorders screens', () => {
    const { b, g } = seed();
    expect(reorderScreens(b, g, 0, 1).groups[0].screens.map(s => s.name)).toEqual(['B', 'A']);
  });
});

describe('steps', () => {
  it('refuses a step pointing at a screen from another group', () => {
    const { b, g, s1, f } = seed();
    let two = addGroup(b, { title: 'Other' }, f);
    const g2 = two.groups[1].id;
    expect(addStep(two, g2, { screen: s1 }, f)).toEqual(two);    // no-op, board unchanged
  });

  it('allows an overview step with no screen', () => {
    const { b, g } = seed();
    const out = addStep(b, g, { screen: null, kicker: 'map' }, idf());
    expect(out.groups[0].steps.at(-1).screen).toBeNull();
    valid(out);
  });

  it('reordering steps keeps every id resolvable', () => {
    const { b, g, t1, t2 } = seed();
    const out = reorderSteps(b, g, 1, 0);
    expect(out.groups[0].steps.map(s => s.id)).toEqual([t2, t1]);
    expect(resolveStep(out, g, t1).si).toBe(1);
    expect(resolveStep(out, g, t2).si).toBe(0);
  });

  it('reordering steps does not disturb their notes', () => {
    const { b, g, t1 } = seed();
    const out = reorderSteps(b, g, 1, 0);
    expect(resolveStep(out, g, t1).step.notes.map(n => n.text)).toEqual(['first', 'second']);
  });

  it('repointing a step at a different screen clears its now-meaningless rects', () => {
    const { b, g, t1, s2 } = seed();
    const out = updateStep(b, g, t1, { screen: s2 });
    expect(resolveStep(out, g, t1).step.notes).toEqual([]);
    valid(out);
  });

  it('editing other fields keeps the notes', () => {
    const { b, g, t1 } = seed();
    const out = updateStep(b, g, t1, { caption: 'hello', gutter: 'left' });
    expect(resolveStep(out, g, t1).step.notes).toHaveLength(2);
  });

  it('deletes a step', () => {
    const { b, g, t1 } = seed();
    expect(deleteStep(b, g, t1).groups[0].steps.map(s => s.id)).not.toContain(t1);
  });
});

describe('normalizeRect', () => {
  it('normalises a rect drawn right-to-left / bottom-to-top', () => {
    expect(normalizeRect({ x: .8, y: .8, w: -.3, h: -.2 }))
      .toEqual({ x: .5, y: .6, w: .3, h: .2 });
  });
  it('clamps a drag that ran off the edge of the image', () => {
    const r = normalizeRect({ x: -.4, y: .9, w: .6, h: .5 });
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });
  it('gives a click-without-drag a minimum area rather than a zero-area rect', () => {
    const r = normalizeRect({ x: .5, y: .5, w: 0, h: 0 });
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });
  it('always produces a rect the schema accepts', () => {
    const cases = [
      { x: 2, y: 2, w: 2, h: 2 }, { x: -1, y: -1, w: -1, h: -1 },
      { x: 0, y: 0, w: 1, h: 1 }, { x: .999, y: .999, w: .5, h: .5 },
    ];
    for (const c of cases) {
      const r = normalizeRect(c);
      for (const k of ['x', 'y', 'w', 'h']) {
        expect(r[k]).toBeGreaterThanOrEqual(0);
        expect(r[k]).toBeLessThanOrEqual(1);
      }
      expect(r.x + r.w).toBeLessThanOrEqual(1.00001);
      expect(r.y + r.h).toBeLessThanOrEqual(1.00001);
    }
  });
});

describe('notes', () => {
  it('adds a note with a normalised rect', () => {
    const { b, g, t1 } = seed();
    const out = addNote(b, g, t1, { text: 'x', rect: { x: .6, y: .6, w: -.2, h: -.2 } }, idf());
    expect(resolveStep(out, g, t1).step.notes.at(-1).rect).toEqual({ x: .4, y: .4, w: .2, h: .2 });
    valid(out);
  });

  it('refuses a note on an overview step', () => {
    const { b, g, f } = seed();
    const withOverview = addStep(b, g, { screen: null }, f);
    const stId = withOverview.groups[0].steps.at(-1).id;
    expect(addNote(withOverview, g, stId, { text: 'x', rect: { x: 0, y: 0, w: .2, h: .2 } }, f))
      .toEqual(withOverview);
  });

  it('reorders notes — the array order is the reveal order', () => {
    const { b, g, t1 } = seed();
    const out = reorderNotes(b, g, t1, 1, 0);
    expect(resolveStep(out, g, t1).step.notes.map(n => n.text)).toEqual(['second', 'first']);
    valid(out);
  });

  it('edits text and rect independently', () => {
    const { b, g, t1 } = seed();
    const id = resolveStep(b, g, t1).step.notes[0].id;
    const a = updateNote(b, g, t1, id, { text: 'changed' });
    expect(resolveStep(a, g, t1).step.notes[0].text).toBe('changed');
    expect(resolveStep(a, g, t1).step.notes[0].rect).toEqual({ x: .1, y: .1, w: .2, h: .1 });
    const c = updateNote(b, g, t1, id, { rect: { x: 5, y: 5, w: 5, h: 5 } });
    expect(validateBoard(c).ok).toBe(true);          // clamped on the way in
  });

  it('deletes a note', () => {
    const { b, g, t1 } = seed();
    const id = resolveStep(b, g, t1).step.notes[0].id;
    const out = deleteNote(b, g, t1, id);
    expect(resolveStep(out, g, t1).step.notes.map(n => n.text)).toEqual(['second']);
  });

  it('is a no-op for unknown ids', () => {
    const { b, g, t1 } = seed();
    expect(deleteNote(b, g, t1, 'nope')).toEqual(b);
    expect(updateNote(b, g, 'nostep', 'nonote', { text: 'x' })).toEqual(b);
  });
});

describe('applyHandle', () => {
  const r = { x: .2, y: .2, w: .4, h: .4 };   // 0.2–0.6 in both axes

  it('drags each edge independently', () => {
    expect(applyHandle(r, 'e', .8, .5)).toMatchObject({ x: .2, w: .6 });
    expect(applyHandle(r, 'w', .1, .5)).toMatchObject({ x: .1, w: .5 });
    expect(applyHandle(r, 's', .5, .9)).toMatchObject({ y: .2, h: .7 });
    expect(applyHandle(r, 'n', .5, .05)).toMatchObject({ y: .05, h: .55 });
  });

  it('drags a corner in both axes at once', () => {
    expect(applyHandle(r, 'se', .9, .8)).toMatchObject({ x: .2, y: .2, w: .7, h: .6 });
    expect(applyHandle(r, 'nw', .1, .05)).toMatchObject({ x: .1, y: .05, w: .5, h: .55 });
  });

  it('leaves the opposite edge exactly where it was', () => {
    const out = applyHandle(r, 'w', .05, .5);
    expect(out.x + out.w).toBeCloseTo(r.x + r.w, 5);
  });

  it('flips rather than inverting when dragged past the far edge', () => {
    const out = applyHandle(r, 'w', .9, .5);
    expect(out.w).toBeGreaterThan(0);
    expect(out.x).toBeCloseTo(.6, 5);
  });

  it('clamps to the image', () => {
    for (const h of HANDLES) {
      const out = applyHandle(r, h, 5, -3);
      for (const k of ['x', 'y', 'w', 'h']) {
        expect(out[k], `${h}.${k}`).toBeGreaterThanOrEqual(0);
        expect(out[k], `${h}.${k}`).toBeLessThanOrEqual(1);
      }
      expect(out.x + out.w).toBeLessThanOrEqual(1.0001);
      expect(out.y + out.h).toBeLessThanOrEqual(1.0001);
    }
  });

  it('never collapses to zero area', () => {
    for (const h of HANDLES) {
      const out = applyHandle(r, h, .4, .4);
      expect(out.w, h).toBeGreaterThan(0);
      expect(out.h, h).toBeGreaterThan(0);
    }
  });

  it('ignores an unknown handle', () => {
    expect(applyHandle(r, 'middle', .9, .9)).toEqual(normalizeRect(r));
  });
});

describe('moveRect', () => {
  it('moves by a delta and keeps its size', () => {
    expect(moveRect({ x: .2, y: .2, w: .3, h: .3 }, .1, -.1))
      .toEqual({ x: .3, y: .1, w: .3, h: .3 });
  });
  it('stops at the edge instead of running off the image', () => {
    const out = moveRect({ x: .8, y: .8, w: .2, h: .2 }, .5, .5);
    expect(out).toEqual({ x: .8, y: .8, w: .2, h: .2 });
    expect(moveRect({ x: .1, y: .1, w: .2, h: .2 }, -.5, -.5)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('crop', () => {
  const seedCrop = () => {
    const { b, g, s1, t1 } = seed();
    return { b, g, s1, t1 };
  };

  it('changes the space a screen occupies', () => {
    const { b, s1 } = seedCrop();
    const out = setScreenCrop(b, s1, { x: .25, y: .25, w: .5, h: .5 });
    const s = out.groups[0].screens[0];
    expect(effectiveSize(s)).toEqual({ w: 640, h: 400 });   // half of 1280×800
    valid(out);
  });

  it('keeps annotations on the same pixels when the crop changes', () => {
    const { b, g, s1, t1 } = seedCrop();
    // a note at the centre of the full image
    const before = resolveStep(b, g, t1).step.notes[0].rect;
    const centreX = before.x + before.w / 2;

    const out = setScreenCrop(b, s1, { x: 0, y: 0, w: .5, h: .5 });
    const after = resolveStep(out, g, t1).step.notes[0].rect;
    // cropping to the left half doubles the relative x of anything inside it
    expect(after.x + after.w / 2).toBeCloseTo(centreX * 2, 4);
    valid(out);
  });

  it('is reversible — cropping and un-cropping restores the rects', () => {
    const { b, g, s1, t1 } = seedCrop();
    const before = resolveStep(b, g, t1).step.notes.map(n => ({ ...n.rect }));
    const cropped = setScreenCrop(b, s1, { x: .1, y: .1, w: .8, h: .8 });
    const restored = setScreenCrop(cropped, s1, { x: 0, y: 0, w: 1, h: 1 });
    const after = resolveStep(restored, g, t1).step.notes.map(n => n.rect);
    after.forEach((r, i) => {
      expect(r.x).toBeCloseTo(before[i].x, 3);
      expect(r.w).toBeCloseTo(before[i].w, 3);
    });
  });

  it('drops the field entirely when the crop is the whole image', () => {
    const { b, s1 } = seedCrop();
    const out = setScreenCrop(setScreenCrop(b, s1, { x: .2, y: .2, w: .5, h: .5 }),
      s1, { x: 0, y: 0, w: 1, h: 1 });
    expect('crop' in out.groups[0].screens[0]).toBe(false);
  });

  it('refuses to collapse the crop to nothing', () => {
    const { b, s1 } = seedCrop();
    const out = setScreenCrop(b, s1, { x: .5, y: .5, w: 0, h: 0 });
    const c = out.groups[0].screens[0].crop;
    expect(c.w).toBeGreaterThan(0.01);
    expect(c.h).toBeGreaterThan(0.01);
    valid(out);
  });

  it('only touches steps that show the cropped screen', () => {
    const { b, g, s1, t2 } = seed();
    const untouched = resolveStep(b, g, t2).step.notes;
    const out = setScreenCrop(b, s1, { x: .1, y: .1, w: .5, h: .5 });
    expect(resolveStep(out, g, t2).step.notes).toEqual(untouched);
  });
});

describe('scale', () => {
  it('effectiveSize honours a scale factor', () => {
    const { b, s1 } = seed();
    const out = scaleScreen(b, s1, 2);
    expect(effectiveSize(out.groups[0].screens[0])).toEqual({ w: 2560, h: 1600 });  // 2× of 1280×800
  });

  it('effectiveSize composes scale with crop', () => {
    const { b, s1 } = seed();
    const cropped = setScreenCrop(b, s1, { x: .25, y: .25, w: .5, h: .5 });   // 640×400
    const out = scaleScreen(cropped, s1, 0.5);
    expect(effectiveSize(out.groups[0].screens[0])).toEqual({ w: 320, h: 200 });
  });

  it('preserves the screenshot aspect ratio (uniform scale)', () => {
    const { b, s1 } = seed();
    const before = effectiveSize(b.groups[0].screens[0]);
    const after = effectiveSize(scaleScreen(b, s1, 1.7).groups[0].screens[0]);
    expect(after.w / after.h).toBeCloseTo(before.w / before.h, 6);
  });

  it('clamps below SCALE_MIN and above SCALE_MAX — fail fast, never collapse or explode', () => {
    const { b, s1 } = seed();
    expect(scaleScreen(b, s1, 0.001).groups[0].screens[0].scale).toBe(SCALE_MIN);
    expect(scaleScreen(b, s1, 999).groups[0].screens[0].scale).toBe(SCALE_MAX);
  });

  it('drops the field entirely when scale returns to 1 (identity)', () => {
    const { b, s1 } = seed();
    const scaled = scaleScreen(b, s1, 2);
    const reset = scaleScreen(scaled, s1, 1);
    expect('scale' in reset.groups[0].screens[0]).toBe(false);
  });

  it('leaves note rects untouched — annotations are normalised, so scaling must not move them', () => {
    const { b, g, s1, t1 } = seed();
    const before = resolveStep(b, g, t1).step.notes.map(n => ({ ...n.rect }));
    const out = scaleScreen(b, s1, 3);
    const after = resolveStep(out, g, t1).step.notes.map(n => n.rect);
    expect(after).toEqual(before);
  });

  it('repositions the anchor in manual layout when a pos is supplied', () => {
    const { b, g, s1 } = seed();
    const man = setGroupLayout(b, g, 'manual');
    const out = scaleScreen(man, s1, 2, { x: 40.6, y: 12.2 });
    expect(out.groups[0].screens[0].pos).toEqual({ x: 41, y: 12 });
  });

  it('ignores a pos in auto layout — position is derived there, not stored', () => {
    const { b, s1 } = seed();
    const out = scaleScreen(b, s1, 2, { x: 40, y: 12 });
    expect('pos' in out.groups[0].screens[0]).toBe(false);
  });

  it('is a no-op for an unknown screen id', () => {
    const { b } = seed();
    expect(scaleScreen(b, 'nope', 2)).toEqual(b);
  });

  it('leaves the board valid', () => {
    const { b, s1 } = seed();
    valid(scaleScreen(b, s1, 2.5));
    valid(scaleScreen(b, s1, SCALE_MIN));
  });
});

describe('replaceScreenImage', () => {
  it('keeps identity, steps and notes', () => {
    const { b, g, s1, t1 } = seed();
    const out = replaceScreenImage(b, s1, { src: 'images/new.png', w: 2560, h: 1600 });
    const s = out.groups[0].screens[0];
    expect(s.id).toBe(s1);
    expect(s.name).toBe('A');
    expect(s).toMatchObject({ src: 'images/new.png', w: 2560, h: 1600 });
    expect(resolveStep(out, g, t1).step.notes).toHaveLength(2);
    valid(out);
  });

  it('drops a crop that described the old image', () => {
    const { b, s1 } = seed();
    const cropped = setScreenCrop(b, s1, { x: .1, y: .1, w: .5, h: .5 });
    const out = replaceScreenImage(cropped, s1, { src: 'x.png', w: 100, h: 100 });
    expect('crop' in out.groups[0].screens[0]).toBe(false);
  });

  it('refuses an image with no intrinsic size', () => {
    const { b, s1 } = seed();
    expect(() => replaceScreenImage(b, s1, { src: 'x.png' })).toThrow(/positive w\/h/);
  });
});

describe('moveScreenToGroup', () => {
  const twoGroups = () => {
    const { b, g, s1, s2, t1, t2, f } = seed();
    const out = addGroup(b, { title: 'Target' }, f);
    return { b: out, g, g2: out.groups[1].id, s1, s2, t1, t2, f };
  };

  it('moves the screen and the steps that show it', () => {
    const { b, g, g2, s1, t1, t2 } = twoGroups();
    const out = moveScreenToGroup(b, s1, g2);

    expect(out.groups[0].screens.map(s => s.id)).not.toContain(s1);
    expect(out.groups[1].screens.map(s => s.id)).toEqual([s1]);
    expect(out.groups[0].steps.map(s => s.id)).toEqual([t2]);
    expect(out.groups[1].steps.map(s => s.id)).toEqual([t1]);
    valid(out);
  });

  it('carries the notes with the steps', () => {
    const { b, g2, s1, t1 } = twoGroups();
    const out = moveScreenToGroup(b, s1, g2);
    expect(resolveStep(out, g2, t1).step.notes.map(n => n.text)).toEqual(['first', 'second']);
  });

  it('leaves the other screens and steps untouched', () => {
    const { b, g, g2, s1, s2, t2 } = twoGroups();
    const out = moveScreenToGroup(b, s1, g2);
    expect(out.groups[0].screens.map(s => s.id)).toEqual([s2]);
    expect(resolveStep(out, g, t2).step.screen).toBe(s2);
  });

  it('gives it a position when the target lays out by hand', () => {
    const { b, g2, s1 } = twoGroups();
    const manual = setGroupLayout(b, g2, 'manual');
    const out = moveScreenToGroup(manual, s1, g2);
    expect(out.groups[1].screens[0].pos).toBeTruthy();
    valid(out);
  });

  it('drops a stale position when the target lays out automatically', () => {
    const { b, g, g2, s1 } = twoGroups();
    const manualSource = setGroupLayout(b, g, 'manual');
    const out = moveScreenToGroup(manualSource, s1, g2);
    expect('pos' in out.groups[1].screens[0]).toBe(false);
    valid(out);
  });

  it('is a no-op for the same group or an unknown id', () => {
    const { b, g, s1 } = twoGroups();
    expect(moveScreenToGroup(b, s1, g)).toEqual(b);
    expect(moveScreenToGroup(b, s1, 'nope')).toEqual(b);
    expect(moveScreenToGroup(b, 'nope', g)).toEqual(b);
  });

  it('does not mutate the previous document', () => {
    const { b, g2, s1 } = twoGroups();
    const snapshot = structuredClone(b);
    moveScreenToGroup(b, s1, g2);
    expect(b).toEqual(snapshot);
  });
});

describe('one screen, several steps', () => {
  it('lets two steps show the same screen with independent notes', () => {
    const { b, g, s1, t1, f } = seed();
    let out = addStep(b, g, { screen: s1, kicker: 'again' }, f);
    const t3 = out.groups[0].steps.at(-1).id;
    out = addNote(out, g, t3, { text: 'a different point', rect: { x: .5, y: .5, w: .2, h: .1 } }, f);

    expect(resolveStep(out, g, t1).step.notes.map(n => n.text)).toEqual(['first', 'second']);
    expect(resolveStep(out, g, t3).step.notes.map(n => n.text)).toEqual(['a different point']);
    expect(resolveStep(out, g, t3).step.screen).toBe(s1);
    valid(out);
  });

  it('editing one step leaves the other alone', () => {
    const { b, g, s1, t1, f } = seed();
    let out = addStep(b, g, { screen: s1, kicker: 'again' }, f);
    const t3 = out.groups[0].steps.at(-1).id;
    out = updateStep(out, g, t3, { caption: 'second half' });
    expect(resolveStep(out, g, t1).step.caption).toBe('');
    expect(resolveStep(out, g, t3).step.caption).toBe('second half');
  });

  it('deleting the screen removes every step that used it', () => {
    const { b, g, s1, f } = seed();
    const out = deleteScreen(addStep(b, g, { screen: s1 }, f), s1);
    expect(out.groups[0].steps.some(st => st.screen === s1)).toBe(false);
    valid(out);
  });
});

describe('backgrounds', () => {
  it('sets a board-wide default', () => {
    const { b } = seed();
    const out = setBoardBackground(b, 'transparent');
    expect(out.screenBackground).toBe('transparent');
    valid(out);
  });

  it('overrides one screen and leaves the rest inheriting', () => {
    const { b, s1, s2 } = seed();
    const out = setScreenBackground(b, s1, 'transparent');
    expect(out.groups[0].screens[0].background).toBe('transparent');
    expect(out.groups[0].screens[1].background).toBeUndefined();
    valid(out);
  });

  it('clears an override so the screen inherits again', () => {
    const { b, s1 } = seed();
    const set = setScreenBackground(b, s1, '#0A0D12');
    const cleared = setScreenBackground(set, s1, null);
    expect('background' in cleared.groups[0].screens[0]).toBe(false);
    valid(cleared);
  });

  it('does not mutate the previous document', () => {
    const { b, s1 } = seed();
    const snapshot = structuredClone(b);
    setBoardBackground(b, 'transparent');
    setScreenBackground(b, s1, '#000000');
    expect(b).toEqual(snapshot);
  });

  it('ignores an unknown screen', () => {
    const { b } = seed();
    expect(setScreenBackground(b, 'nope', 'transparent')).toEqual(b);
  });
});

describe('board', () => {
  it('creates an empty valid board', () => {
    const b = createBoard({ title: 'Fresh' }, idf());
    expect(validateBoard(b).ok).toBe(true);
    expect(b.groups).toEqual([]);
  });
  it('renames without touching anything else', () => {
    const { b } = seed();
    const out = setBoardTitle(b, 'Renamed');
    expect(out.title).toBe('Renamed');
    expect(out.groups).toEqual(b.groups);
  });
});
