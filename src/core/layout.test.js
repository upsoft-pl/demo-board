import { describe, it, expect } from 'vitest';
import {
  safeBox, fitOf, camFor, camForBox, boundsOf, autoLayout, placeScreens,
  hotspotToViewport, computeNoteLayout, leaderPath, framingRatio, isCentred,
  NOTE_W, MARGIN, TOP_PAD, BOT_PAD,
} from './layout.js';

const VP = { w: 1440, h: 900 };
const landscape = { id: 'a', x: 0, y: 0, w: 2560, h: 1600 };
const portrait  = { id: 'b', x: 0, y: 0, w: 1200, h: 1700 };

/** Project a world-space screen through a camera into viewport coordinates. */
function project(screen, cam, vp) {
  const left = (screen.x - cam.x) * cam.z + vp.w / 2;
  const top  = (screen.y - cam.y) * cam.z + vp.h / 2;
  return { left, top, width: screen.w * cam.z, height: screen.h * cam.z,
           right: left + screen.w * cam.z, bottom: top + screen.h * cam.z };
}

describe('safeBox', () => {
  it('reserves a gutter only when the step has notes', () => {
    expect(safeBox(VP, 'right', false).r).toBe(VP.w - MARGIN);
    expect(safeBox(VP, 'right', true).r).toBe(VP.w - (NOTE_W + MARGIN * 2));
    expect(safeBox(VP, 'left', true).l).toBe(NOTE_W + MARGIN * 2);
  });

  it('reserves the gutter on the requested side and only that side', () => {
    const l = safeBox(VP, 'left', true);
    expect(l.l).toBeGreaterThan(MARGIN);
    expect(l.r).toBe(VP.w - MARGIN);
  });

  it('keeps clear of the caption above and the HUD below', () => {
    const b = safeBox(VP, 'right', true);
    expect(b.t).toBe(TOP_PAD);
    expect(b.b).toBe(VP.h - BOT_PAD);
  });
});

describe('camFor', () => {
  it('frames a screen inside the safe box, never into the gutter', () => {
    for (const screen of [landscape, portrait]) {
      for (const gutter of ['left', 'right']) {
        const box = safeBox(VP, gutter, true);
        const r = project(screen, camFor(screen, box, VP), VP);
        expect(r.left).toBeGreaterThanOrEqual(box.l - 1);
        expect(r.right).toBeLessThanOrEqual(box.r + 1);
        expect(r.top).toBeGreaterThanOrEqual(box.t - 1);
        expect(r.bottom).toBeLessThanOrEqual(box.b + 1);
      }
    }
  });

  it('centres the screen within the safe box', () => {
    const box = safeBox(VP, 'right', true);
    const r = project(landscape, camFor(landscape, box, VP), VP);
    expect((r.left + r.right) / 2).toBeCloseTo((box.l + box.r) / 2, 6);
    expect((r.top + r.bottom) / 2).toBeCloseTo((box.t + box.b) / 2, 6);
  });

  it('framing at 1.0 means fitOf, on any aspect ratio or viewport', () => {
    for (const vp of [{ w: 1280, h: 800 }, { w: 3840, h: 1600 }, { w: 900, h: 1200 }]) {
      for (const screen of [landscape, portrait]) {
        const cam = camFor(screen, safeBox(vp, 'right', true), vp);
        expect(framingRatio(cam.z, screen, vp)).toBeGreaterThan(0.5);
      }
    }
  });
});

describe('autoLayout', () => {
  const mk = (id, w, h) => ({ id, w, h });

  it('is deterministic', () => {
    const s = [mk('a', 100, 80), mk('b', 120, 90), mk('c', 90, 140)];
    expect(autoLayout(s)).toEqual(autoLayout(s));
  });

  it('never overlaps two screens', () => {
    const s = Array.from({ length: 9 }, (_, i) => mk(`s${i}`, 800 + i * 40, 500 + (i % 3) * 120));
    const placed = autoLayout(s, { columns: 3, gap: 100 });
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
                      * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        expect(overlap).toBe(0);
      }
    }
  });

  it('flows row-major in step order', () => {
    const s = Array.from({ length: 5 }, (_, i) => mk(`s${i}`, 100, 100));
    const p = autoLayout(s, { columns: 2, gap: 10 });
    expect(p[0].y).toBe(p[1].y);           // same row
    expect(p[2].y).toBeGreaterThan(p[0].y); // wrapped
    expect(p[0].x).toBeLessThan(p[1].x);
  });

  it('handles a single screen and an empty group', () => {
    expect(autoLayout([])).toEqual([]);
    expect(autoLayout([mk('only', 100, 100)])).toHaveLength(1);
  });
});

describe('placeScreens', () => {
  it('offsets by the group origin in both modes', () => {
    const screens = [{ id: 'a', w: 100, h: 100, pos: { x: 5, y: 7 } }];
    const auto = placeScreens({ layout: 'auto', origin: { x: 1000, y: 500 }, screens });
    const man  = placeScreens({ layout: 'manual', origin: { x: 1000, y: 500 }, screens });
    expect(auto[0].x).toBe(1000);
    expect(man[0]).toMatchObject({ x: 1005, y: 507 });
  });
});

describe('hotspotToViewport', () => {
  it('projects a normalised rect onto the on-screen image', () => {
    const plate = { left: 100, top: 50, width: 800, height: 400 };
    expect(hotspotToViewport({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, plate))
      .toEqual({ left: 500, top: 150, width: 200, height: 200 });
  });

  it('is resolution independent — same rect, same relative position', () => {
    const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const small = hotspotToViewport(r, { left: 0, top: 0, width: 400, height: 300 });
    const big   = hotspotToViewport(r, { left: 0, top: 0, width: 1600, height: 1200 });
    expect(big.left / small.left).toBeCloseTo(4);
    expect(big.width / small.width).toBeCloseTo(4);
  });
});

describe('computeNoteLayout', () => {
  const note = (id, top, height = 90) => ({
    id, height, hotspot: { left: 600, top, width: 300, height: 40 },
  });

  it('places every note inside the reserved gutter, never over the image', () => {
    for (const gutter of ['left', 'right']) {
      const box = safeBox(VP, gutter, true);
      const out = computeNoteLayout({ notes: [note('a', 120), note('b', 300)], viewport: VP, gutter });
      for (const n of out) {
        if (gutter === 'right') expect(n.x + n.width).toBeLessThanOrEqual(VP.w - MARGIN + 0.001);
        else expect(n.x).toBeGreaterThanOrEqual(MARGIN - 0.001);
        // the gutter is outside the image's safe box by construction
        if (gutter === 'right') expect(n.x).toBeGreaterThanOrEqual(box.r);
        else expect(n.x + n.width).toBeLessThanOrEqual(box.l);
      }
    }
  });

  it('never lets two notes overlap, however clustered the hotspots', () => {
    const notes = [note('a', 400), note('b', 405), note('c', 410), note('d', 402)];
    const out = computeNoteLayout({ notes, viewport: VP, gutter: 'right' })
      .sort((p, q) => p.y - q.y);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].y).toBeGreaterThanOrEqual(out[i - 1].y + out[i - 1].height);
    }
  });

  it('keeps notes on screen even when hotspots sit at the extremes', () => {
    const notes = [note('top', -200), note('bottom', VP.h + 300)];
    for (const n of computeNoteLayout({ notes, viewport: VP, gutter: 'right' })) {
      expect(n.y).toBeGreaterThanOrEqual(TOP_PAD);
      expect(n.y + n.height).toBeLessThanOrEqual(VP.h);
    }
  });

  it('starts below the caption when one shares the gutter', () => {
    const out = computeNoteLayout({
      notes: [note('a', 60)], viewport: VP, gutter: 'right', captionBottom: 300,
    });
    expect(out[0].y).toBeGreaterThanOrEqual(300);
  });

  it('orders notes down the gutter by hotspot position', () => {
    const out = computeNoteLayout({
      notes: [note('low', 600), note('high', 150)], viewport: VP, gutter: 'right',
    });
    expect(out.map(n => n.id)).toEqual(['high', 'low']);
  });

  it('degrades to nothing for an empty note list', () => {
    expect(computeNoteLayout({ notes: [], viewport: VP, gutter: 'right' })).toEqual([]);
  });

  it('points the leader at the hotspot and stops short of the note', () => {
    const [n] = computeNoteLayout({ notes: [note('a', 300)], viewport: VP, gutter: 'right' });
    expect(n.leader.x2).toBeLessThan(n.leader.x1);      // right gutter → leader runs leftward
    expect(n.dot.y).toBeCloseTo(320, 6);                 // hotspot vertical centre
    expect(leaderPath(n.leader)).toMatch(/^M [\d.-]+ [\d.-]+ C /);
  });
});

describe('camForBox / boundsOf', () => {
  it('fits the union of a set of screens', () => {
    const bb = boundsOf([{ x: 0, y: 0, w: 100, h: 100 }, { x: 400, y: 200, w: 100, h: 100 }]);
    expect(bb).toEqual({ x0: 0, y0: 0, x1: 500, y1: 300 });
    const cam = camForBox(bb, VP, 0);
    expect(cam.x).toBe(250);
    expect(cam.y).toBe(150);
  });

  it('returns null bounds for an empty group', () => {
    expect(boundsOf([])).toBeNull();
  });
});

describe('isCentred', () => {
  it('accepts a screen at the middle and rejects one at the edge', () => {
    expect(isCentred({ left: 620, top: 400, width: 200, height: 100 }, VP)).toBe(true);
    expect(isCentred({ left: -1400, top: 400, width: 200, height: 100 }, VP)).toBe(false);
  });
});
