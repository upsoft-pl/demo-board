import { test, expect } from '@playwright/test';

/**
 * Smoke tests against the PRODUCTION BUILD, not the dev server.
 *
 * These exist because of a real escape: vite's CSS minifier rewrote
 * `--fly: 1050ms` as `1.05s`, the player read it with parseFloat, got 1.05,
 * treated it as "1ms — skip the animation", and every camera fly on the
 * deployed site was instant. The entire dev suite was green.
 */

const PLAYER = '/player.html?board=sample/board.json';

test('the built player boots and loads its board', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(PLAYER);
  await page.waitForFunction(() => window.__player);
  await page.waitForFunction(() => [...document.images].every(i => i.complete));
  expect(await page.locator('.plate').count()).toBeGreaterThan(3);
  expect(await page.locator('#fatal').evaluate(e => e.classList.contains('on'))).toBe(false);
  expect(errors).toEqual([]);
});

test('the camera actually animates in the built site', async ({ page }) => {
  await page.goto(PLAYER);
  await page.waitForFunction(() => window.__player);
  await page.waitForFunction(() => [...document.images].every(i => i.complete));
  await page.waitForTimeout(1600);                 // let the opening fly finish

  const frames = await page.evaluate(async () => {
    const g = window.__player.board.groups[0];
    const seen = [];
    const t = setInterval(() => {
      const c = window.__player.camera;
      seen.push(`${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(5)}`);
    }, 30);
    // sample position as well as zoom: two same-sized screens frame at the
    // same z, so zoom alone would look static even during a real fly
    window.__player.goto(g.id, g.steps[2].id);
    await new Promise(r => setTimeout(r, 900));
    clearInterval(t);
    return seen;
  });

  expect(new Set(frames).size,
    'the camera jumped instead of flying — a CSS time was misparsed').toBeGreaterThan(5);
});

test('CSS durations survive minification', async ({ page }) => {
  await page.goto(PLAYER);
  await page.waitForFunction(() => window.__player);
  const parsed = await page.evaluate(async () => {
    const { parseCssTime } = await import('./assets/' +
      [...document.querySelectorAll('script[type=module]')][0].src.split('/assets/')[1]);
    const cs = getComputedStyle(document.documentElement);
    return {
      flyRaw: cs.getPropertyValue('--fly').trim(),
      noteRaw: cs.getPropertyValue('--note-out').trim(),
      fly: parseCssTime(cs.getPropertyValue('--fly'), 0),
      note: parseCssTime(cs.getPropertyValue('--note-out'), 0),
    };
  }).catch(() => null);

  // the module import may be bundled away; fall back to asserting the raw values
  const raw = parsed ?? await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { flyRaw: cs.getPropertyValue('--fly').trim(), noteRaw: cs.getPropertyValue('--note-out').trim() };
  });
  const toMs = s => /ms$/i.test(s) ? parseFloat(s) : /s$/i.test(s) ? parseFloat(s) * 1000 : parseFloat(s);
  expect(toMs(raw.flyRaw), `--fly was ${raw.flyRaw}`).toBeGreaterThan(200);
  expect(toMs(raw.noteRaw), `--note-out was ${raw.noteRaw}`).toBeGreaterThan(20);
});

test('notes still land in the gutter in the built site', async ({ page }) => {
  await page.goto(PLAYER);
  await page.waitForFunction(() => window.__player);
  await page.waitForFunction(() => [...document.images].every(i => i.complete));
  await page.waitForFunction(() => document.querySelectorAll('.note').length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(1400);

  const overlap = await page.evaluate(() => {
    const R = e => e.getBoundingClientRect();
    const { groupId, stepId } = window.__player.ref;
    const g = window.__player.board.groups.find(x => x.id === groupId);
    const st = g.steps.find(x => x.id === stepId);
    const plate = R(document.querySelector(`.plate[data-screen="${st.screen}"]`));
    return [...document.querySelectorAll('.note')].reduce((s, n) => {
      const a = R(n);
      return s + Math.max(0, Math.min(a.right, plate.right) - Math.max(a.left, plate.left))
               * Math.max(0, Math.min(a.bottom, plate.bottom) - Math.max(a.top, plate.top));
    }, 0);
  });
  expect(Math.round(overlap)).toBe(0);
});

test('the built editor boots', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?memory=1');
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await expect(page.locator('#lib h1')).toHaveText('Demo boards');
  expect(errors).toEqual([]);
});
