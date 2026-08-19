import { test, expect } from '@playwright/test';

/**
 * Click-to-zoom on a screenshot.
 *
 * The "which step, or none" decision is pure logic (schema.stepForScreen, unit
 * tier). What only a real browser can prove lives here: the affordance is gated
 * on the camera zoom, a click navigates to the framed step, and the hover lift
 * is geometric. `?test=1` makes every transition instant, so hover scale lands
 * in the measured box with no wait.
 */
const PLAYER = '/player.html?board=sample/board.json&test=1';
const settle = page => page.waitForTimeout(120);

const open = async page => {
  await page.goto(PLAYER);
  await page.waitForFunction(() => window.__player && document.querySelector('.plate img'));
  await page.waitForFunction(() => [...document.images].every(i => i.complete));
  await settle(page);
};

/**
 * A navigable plate that is genuinely the top-most element at its own on-screen
 * centre — so a real pointer click/hover lands on it, not on a neighbour or off
 * the plate entirely. Its expected step is the first that frames it (dock order).
 */
const hittableNavigable = page => page.evaluate(() => {
  for (const g of window.__player.board.groups)
    for (const s of g.screens) {
      const st = g.steps.find(t => t.screen === s.id);
      if (!st) continue;
      const el = document.querySelector(`.plate[data-screen="${s.id}"]`);
      const r = el.getBoundingClientRect();
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      if (el.contains(document.elementFromPoint(cx, cy)))
        return { screen: s.id, groupId: g.id, stepId: st.id };
    }
  return null;
});

test('zoomed out, a framed screenshot is clickable and flies to its step', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__player.fitBoard());
  await settle(page);

  const target = await hittableNavigable(page);
  const plate = page.locator(`.plate[data-screen="${target.screen}"]`);
  await expect(plate).toHaveClass(/zoomable/);
  expect(await plate.evaluate(e => getComputedStyle(e).cursor)).toBe('pointer');

  await plate.click();
  await settle(page);
  expect(await page.evaluate(() => window.__player.ref))
    .toEqual({ groupId: target.groupId, stepId: target.stepId });
});

test('the screen you are reading offers no zoom affordance', async ({ page }) => {
  await open(page);                                   // boots into the first step, zoomed in
  const focused = await page.evaluate(() => {
    const { groupId, stepId } = window.__player.ref;
    const g = window.__player.board.groups.find(x => x.id === groupId);
    return g.steps.find(s => s.id === stepId).screen;
  });
  await expect(page.locator(`.plate[data-screen="${focused}"]`)).not.toHaveClass(/zoomable/);
});

test('hovering a clickable screenshot lifts it', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__player.fitBoard());
  await settle(page);

  const target = await hittableNavigable(page);
  const plate = page.locator(`.plate[data-screen="${target.screen}"]`);
  const before = await plate.boundingBox();
  await plate.hover();
  await settle(page);
  const after = await plate.boundingBox();
  expect(after.width).toBeGreaterThan(before.width);   // scale(1.025)
});
