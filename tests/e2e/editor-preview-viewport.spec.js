import { test, expect } from '@playwright/test';

/**
 * Layout ↔ preview keep the same viewport.
 *
 * Entering preview opens on the layout camera (same region, same zoom) rather
 * than flying to the opening step. If the screen you were centred on is already
 * reasonably framed, preview flies the short distance into that step and reveals
 * its notes (auto-frame); either way ref adopts that step. Exiting preview
 * carries the preview camera back to layout.
 *
 * Geometry, so it lives in Playwright. `?test=1` collapses the fly animation to
 * 1ms, so every camera move here settles synchronously; `?memory=1` isolates the
 * library.
 */
const EDITOR = '/?test=1&memory=1';

const makeImage = async (page, name) => page.evaluate(async n => {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 800;
  const x = c.getContext('2d');
  x.fillStyle = '#f7f8fa'; x.fillRect(0, 0, 1280, 800);
  x.fillStyle = '#232a38'; x.font = '28px sans-serif'; x.fillText(n, 240, 90);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  window.__file = new File([blob], n, { type: 'image/png' });
}, name);

const dropImage = async (page, expectCount) => {
  await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const pt = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const dt = new DataTransfer();
    dt.items.add(window.__file);
    const mk = t => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true,
                                       clientX: pt.x, clientY: pt.y });
    c.dispatchEvent(mk('dragenter'));
    c.dispatchEvent(mk('dragover'));
    c.dispatchEvent(mk('drop'));
  });
  await expect(page.locator('[data-testid="canvas-screen"]')).toHaveCount(expectCount, { timeout: 5000 });
};

/** Draw one note on the currently selected step's screen (annotate mode). */
const drawNote = async (page, text) => {
  const box = await page.locator('#shot').boundingBox();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('hotspot')).toHaveCount(1);
  await page.getByTestId('note-text').fill(text);
};

/** One group, two screens, two steps; the second step carries a note. */
async function twoStepBoard(page) {
  await page.goto(EDITOR);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.getByTestId('new-board').click();
  await page.waitForFunction(() => !!window.__editor);
  await page.getByTestId('add-group').click();
  await makeImage(page, 'a.png'); await dropImage(page, 1);
  await makeImage(page, 'b.png'); await dropImage(page, 2);
  await page.locator('[data-testid="canvas-screen"]').nth(0).click();
  await page.getByTestId('add-step-for-screen').click();
  await page.locator('[data-testid="canvas-screen"]').nth(1).click();
  await page.getByTestId('add-step-for-screen').click();
  // annotate the second step so we can prove auto-frame reveals its notes
  await page.getByTestId('step').nth(1).click();
  await page.getByTestId('mode-annotate').click();
  await drawNote(page, 'on the second screen');
  await page.getByTestId('mode-layout').click();
}

const near = (a, b) => {
  expect(a.x).toBeCloseTo(b.x, 3);
  expect(a.y).toBeCloseTo(b.y, 3);
  expect(a.z).toBeCloseTo(b.z, 3);
};

const enterPreview = async page => {
  await page.evaluate(() => { window.__player = null; window.__editor.setMode('preview'); });
  await page.waitForFunction(() => !!window.__player);
};

test('preview keeps the viewport and auto-frames the centred step', async ({ page }) => {
  await twoStepBoard(page);
  const second = await page.evaluate(() => window.__editor.board.groups[0].steps[1].id);

  // In preview, frame the second step and remember where its camera sits.
  await enterPreview(page);
  const camB = await page.evaluate(sid => {
    const g = window.__player.board.groups[0];
    window.__player.goto(g.id, sid);
    return window.__player.camera;
  }, second);

  // Exit: layout must resume on that same camera.
  await page.evaluate(() => window.__editor.setMode('layout'));
  near(await page.evaluate(() => window.__editor.camera), camB);

  // Re-enter: the second screen is now centred and framed, so preview must open
  // on that camera, adopt the second step, and auto-frame it (its note reveals)
  // — never fly back to the opening step.
  await enterPreview(page);
  await page.waitForFunction(() => document.querySelectorAll('.note').length > 0, null, { timeout: 8000 });
  near(await page.evaluate(() => window.__player.camera), camB);
  expect(await page.evaluate(() => window.__player.ref.stepId)).toBe(second);
});
