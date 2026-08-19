import { test, expect } from '@playwright/test';

/**
 * The geometry tier.
 *
 * Everything here needs a real layout engine — jsdom returns zeros from
 * getBoundingClientRect, so these assertions are impossible in the unit tier.
 * `?test=1` collapses every animation to 1ms, so no test waits on a camera fly.
 */

/** The player is its own entry point; `/` is the editor. */
const PLAYER = '/player.html?board=sample/board.json&test=1';

const open = async page => {
  await page.goto(PLAYER);
  await page.waitForFunction(() => window.__player && document.querySelector('.plate img'));
  await page.waitForFunction(() =>
    [...document.images].every(i => i.complete));
  await settle(page);
};

/** Give the (1ms) animations a frame to land. */
const settle = page => page.waitForTimeout(120);

const rects = page => page.evaluate(() => {
  const R = e => { const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  // ask the player which screen is focused rather than inferring it from
  // classes — on an overview step no single plate is focused
  const { groupId, stepId } = window.__player.ref;
  const grp = window.__player.board.groups.find(g => g.id === groupId);
  const step = grp?.steps.find(s => s.id === stepId);
  const focused = step?.screen ? document.querySelector(`.plate[data-screen="${step.screen}"]`) : null;
  return {
    plate: focused ? R(focused) : null,
    notes: [...document.querySelectorAll('.note')].map(R),
    targets: [...document.querySelectorAll('.target')].map(R),
    caption: R(document.getElementById('caption')),
    hud: R(document.getElementById('hud')),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    kicker: document.querySelector('#caption .k').textContent,
    group: document.querySelector('#gchip b').textContent,
    dots: document.querySelectorAll('#dots i').length,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  };
});

const overlap = (a, b) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Walk every step of every group. */
const eachStep = async (page, fn) => {
  const plan = await page.evaluate(() => window.__player.board.groups.map(
    g => ({ id: g.id, title: g.title, steps: g.steps.map(s => s.id) })));
  for (const g of plan) {
    for (const stepId of g.steps) {
      await page.evaluate(([gid, sid]) => window.__player.goto(gid, sid), [g.id, stepId]);
      await settle(page);
      await fn(g, stepId);
    }
  }
  return plan;
};

test('boots into the first step of the first group', async ({ page }) => {
  await open(page);
  const r = await rects(page);
  expect(r.group).toBe('Bug Reports');
  expect(r.kicker).toMatch(/^Step 01/);
  expect(r.notes.length).toBeGreaterThan(0);
});

test('no note ever overlaps the screenshot, in any step of any group', async ({ page }) => {
  await open(page);
  const seen = [];
  await eachStep(page, async (g, stepId) => {
    const r = await rects(page);
    if (!r.plate || !r.notes.length) return;
    const total = r.notes.reduce((s, n) => s + overlap(n, r.plate), 0);
    seen.push({ group: g.title, stepId, notes: r.notes.length, overlap: total });
    expect(total, `${g.title}/${stepId} — a note covered the screenshot`).toBe(0);
  });
  expect(seen.length, 'no annotated step was exercised').toBeGreaterThan(3);
});

test('above FHD the overlay scales up but still never covers the screenshot', async ({ page }) => {
  // The whole suite runs at 1440×900 (scale 1); this one case opens a 4K window
  // where uiScale ≈ 2, to prove the overlay grows *and* the no-overlap invariant
  // survives the larger gutter. See uiScale in core/layout.js.
  await page.setViewportSize({ width: 3840, height: 2160 });
  await open(page);
  const uiScale = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.note').closest('[style*="ui-scale"]'))
      .getPropertyValue('--ui-scale')));
  expect(uiScale, '4K window should scale the overlay ~2×').toBeGreaterThan(1.8);

  const noteW = await page.evaluate(() => document.querySelector('.note').getBoundingClientRect().width);
  expect(noteW, 'note box grew with the window').toBeGreaterThan(322 * 1.8);

  await eachStep(page, async (g, stepId) => {
    const r = await rects(page);
    if (!r.plate || !r.notes.length) return;
    const total = r.notes.reduce((s, n) => s + overlap(n, r.plate), 0);
    expect(total, `${g.title}/${stepId} — a scaled note covered the screenshot`).toBe(0);
  });
});

test('notes stay on screen and clear of the caption and HUD', async ({ page }) => {
  await open(page);
  await eachStep(page, async (g, stepId) => {
    const r = await rects(page);
    for (const n of r.notes) {
      expect(n.left, `${g.title}/${stepId}`).toBeGreaterThanOrEqual(0);
      expect(n.right).toBeLessThanOrEqual(r.viewport.w);
      expect(n.top).toBeGreaterThanOrEqual(0);
      expect(n.bottom).toBeLessThanOrEqual(r.viewport.h);
      expect(overlap(n, r.hud), 'note collided with the HUD').toBe(0);
      expect(overlap(n, r.caption), 'note collided with the caption').toBe(0);
    }
  });
});

test('notes never overlap each other', async ({ page }) => {
  await open(page);
  await eachStep(page, async (g, stepId) => {
    const { notes } = await rects(page);
    for (let i = 0; i < notes.length; i++)
      for (let j = i + 1; j < notes.length; j++)
        expect(overlap(notes[i], notes[j]), `${g.title}/${stepId}`).toBe(0);
  });
});

test('every target ring lands inside its screenshot', async ({ page }) => {
  await open(page);
  await eachStep(page, async (g, stepId) => {
    const r = await rects(page);
    if (!r.plate) return;
    for (const t of r.targets) {
      const where = `${g.title}/${stepId} ring=${JSON.stringify(t)} plate=${JSON.stringify(r.plate)}`;
      expect(t.left, where).toBeGreaterThanOrEqual(r.plate.left - 14);
      expect(t.right, where).toBeLessThanOrEqual(r.plate.right + 14);
      expect(t.top, where).toBeGreaterThanOrEqual(r.plate.top - 14);
      expect(t.bottom, where).toBeLessThanOrEqual(r.plate.bottom + 14);
    }
  });
});

test('two steps on one screen swap the notes without moving the camera', async ({ page }) => {
  await open(page);
  // the sample deliberately shows s_inbox twice: st_input and st_back
  const pair = await page.evaluate(() => {
    const g = window.__player.board.groups[0];
    const users = g.steps.filter(s => s.screen === 'stub');
    const byScreen = {};
    for (const s of g.steps) if (s.screen) (byScreen[s.screen] ||= []).push(s.id);
    const reused = Object.entries(byScreen).find(([, ids]) => ids.length > 1);
    return { groupId: g.id, screen: reused?.[0], steps: reused?.[1] };
  });
  expect(pair.steps, 'the sample board should demonstrate screen reuse').toHaveLength(2);

  const at = async stepId => {
    await page.evaluate(([g, s]) => window.__player.goto(g, s), [pair.groupId, stepId]);
    await settle(page);
    const r = await rects(page);
    return {
      cam: await page.evaluate(() => {
        const c = window.__player.camera;
        return [Math.round(c.x), Math.round(c.y), +c.z.toFixed(4)];
      }),
      caption: await page.locator('#caption .t').textContent(),
      notes: await page.locator('.note .x').allTextContents(),
      overlap: r.notes.reduce((s, n) => s + overlap(n, r.plate), 0),
    };
  };

  const a = await at(pair.steps[0]);
  const b = await at(pair.steps[1]);

  expect(b.cam, 'the camera moved — this should read as a reveal, not a jump').toEqual(a.cam);
  expect(b.caption).not.toBe(a.caption);
  expect(b.notes).not.toEqual(a.notes);
  expect(a.overlap).toBe(0);
  expect(b.overlap).toBe(0);
});

test('the step widget and accent follow the active group', async ({ page }) => {
  await open(page);
  const groups = await page.evaluate(() =>
    window.__player.board.groups.map(g => ({ id: g.id, title: g.title, color: g.color, steps: g.steps.length })));
  for (const g of groups) {
    await page.evaluate(gid => {
      const p = window.__player;
      const grp = p.board.groups.find(x => x.id === gid);
      p.goto(gid, grp.steps[0].id);
    }, g.id);
    await settle(page);
    const r = await rects(page);
    expect(r.group).toBe(g.title);
    expect(r.dots).toBe(g.steps);
    expect(r.accent.toLowerCase()).toBe(g.color.toLowerCase());
  }
});

test('arrow keys never cross a group boundary', async ({ page }) => {
  await open(page);
  const first = await page.evaluate(() => window.__player.board.groups[0]);
  // walk past the end
  for (let i = 0; i < first.steps.length + 3; i++) {
    await page.keyboard.press('ArrowRight');
    await settle(page);
  }
  expect((await rects(page)).group).toBe(first.title);
  // and past the start
  for (let i = 0; i < first.steps.length + 3; i++) {
    await page.keyboard.press('ArrowLeft');
    await settle(page);
  }
  const r = await rects(page);
  expect(r.group).toBe(first.title);
  expect(r.kicker).toMatch(/^Step 01|^Overview/);
});

test('⌘K finds a screen and flying there keeps the layout clean', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Meta+k');
  await expect(page.locator('#pal')).toHaveClass(/on/);
  await expect(page.locator('.phead').first()).toContainText('Jump to group');

  await page.locator('#pal-q').fill('drifting');
  await settle(page);
  const hits = await page.locator('.res .nm').allTextContents();
  expect(hits).toContain('The pile');
  await expect(page.locator('.res .cx mark').first()).toBeVisible();

  await page.keyboard.press('Enter');
  await settle(page);
  const r = await rects(page);
  expect(r.notes.reduce((s, n) => s + overlap(n, r.plate), 0)).toBe(0);
});

test('the palette swallows arrows, and Esc hands them back', async ({ page }) => {
  await open(page);
  const before = (await rects(page)).kicker;
  await page.keyboard.press('Meta+k');
  await page.keyboard.press('ArrowRight');
  await settle(page);
  expect((await rects(page)).kicker).toBe(before);        // step did not advance
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await settle(page);
  expect((await rects(page)).kicker).not.toBe(before);
});

test('history returns from a cross-group excursion', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowRight');
  await settle(page);
  const home = await rects(page);

  await page.keyboard.press('Meta+3');                     // jump to another group
  await settle(page);
  expect((await rects(page)).group).not.toBe(home.group);

  await page.keyboard.press('Meta+[');
  await settle(page);
  const back = await rects(page);
  expect(back.group).toBe(home.group);
  expect(back.kicker).toBe(home.kicker);

  await page.keyboard.press('Meta+]');
  await settle(page);
  expect((await rects(page)).group).not.toBe(home.group);
});

test('screenshots are not selectable, the search field is', async ({ page }) => {
  await open(page);
  const plateSelect = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.plate img')).userSelect);
  expect(plateSelect).toBe('none');

  await page.keyboard.press('Meta+k');
  await page.locator('#pal-q').fill('discord');
  expect(await page.evaluate(() => {
    const q = document.getElementById('pal-q');
    q.setSelectionRange(0, 7);
    return q.selectionEnd - q.selectionStart;
  })).toBe(7);
});

test('a malformed board fails loudly instead of rendering blank', async ({ page }) => {
  await page.route('**/sample/board.json', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      version: 1, groups: [{ id: 'g', title: 'G',
        screens: [{ id: 's', src: 'x.png', w: 10, h: 10 }],
        steps: [{ id: 't', screen: 's', notes: [{ id: 'n', text: 'x', rect: { x: 9, y: 9, w: 9, h: 9 } }] }] }],
    }),
  }));
  await page.goto(PLAYER);
  await expect(page.locator('#fatal')).toHaveClass(/on/);
  await expect(page.locator('#fatal')).toContainText('outside 0..1');
});

test('a missing board file reports the URL rather than hanging', async ({ page }) => {
  await page.route('**/sample/board.json', route => route.fulfill({ status: 404, body: 'nope' }));
  await page.goto(PLAYER);
  await expect(page.locator('#fatal')).toContainText('Could not load the board');
});

test('a brand logo takes the corner mark, keeping the title, at its set opacity', async ({ page }) => {
  await page.route('**/sample/board.json', async route => {
    const board = await (await route.fetch()).json();
    board.brand = { logo: 'images/branding.svg', opacity: 0.7 };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) });
  });
  await page.goto(PLAYER);
  const img = page.locator('#mark img');
  await expect(img).toBeVisible();
  expect(await img.evaluate(el => el.naturalWidth), 'the logo actually decoded').toBeGreaterThan(0);
  await expect(img).toHaveCSS('opacity', '0.7');
  await expect(page.locator('#mark s')).toHaveCount(0);              // the ◆ is gone
  await expect(page.locator('#mark span')).toHaveText('Acme — client demo');   // title stays
});
