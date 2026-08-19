import { test, expect } from '@playwright/test';

/**
 * Editor flows, end to end.
 *
 * `?memory=1` swaps OPFS for the in-memory adapter so no test inherits another
 * run's library. `?test=1` collapses animations.
 */
const EDITOR = '/?test=1&memory=1';

/** A 1280×800 PNG, generated in-page so we exercise the real File → import path. */
const makeImage = async (page, name = 'shot.png') => page.evaluate(async n => {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 800;
  const x = c.getContext('2d');
  x.fillStyle = '#f7f8fa'; x.fillRect(0, 0, 1280, 800);
  x.fillStyle = '#101319'; x.fillRect(0, 0, 206, 800);
  x.fillStyle = '#232a38'; x.font = '28px sans-serif'; x.fillText('Inbox', 240, 90);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  window.__file = new File([blob], n, { type: 'image/png' });
  return blob.size;
}, name);

/**
 * Drop the generated file on the canvas exactly as a real drag would: enter,
 * over (which is what resolves the target group), then drop — at a point.
 */
const dropImage = async (page, expectCount = 1, at = null) => {
  await page.evaluate(p => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const pt = p || { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const dt = new DataTransfer();
    dt.items.add(window.__file);
    const mk = t => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true,
                                       clientX: pt.x, clientY: pt.y });
    c.dispatchEvent(mk('dragenter'));
    c.dispatchEvent(mk('dragover'));
    c.dispatchEvent(mk('drop'));
  }, at);
  await expect(page.locator('[data-testid="canvas-screen"]')).toHaveCount(expectCount, { timeout: 5000 });
};

const newBoard = async page => {
  await page.goto(EDITOR);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.getByTestId('new-board').click();
  await page.waitForFunction(() => !!window.__editor);
};

const doc = page => page.evaluate(() => window.__editor.board);

/** Add a group, drop a screenshot, and add a step pointing at it. */
async function boardWithScreen(page) {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page);
  await dropImage(page);
  await page.locator('[data-testid="canvas-screen"]').click();
  await page.getByTestId('add-step-for-screen').click();
  return doc(page);
}

test('creates a board and lists it in the library', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('board-title').fill('Client demo');
  await page.getByTestId('to-library').click();
  await expect(page.getByTestId('board-card')).toHaveCount(1);
  await expect(page.getByTestId('board-card')).toContainText('Client demo');
  await expect(page.getByTestId('board-card')).toContainText('never exported');
});

test('a board survives leaving and reopening', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('board-title').fill('Persisted');
  await page.getByTestId('add-group').click();
  await page.getByTestId('to-library').click();
  await page.getByTestId('open-board').click();
  await page.waitForFunction(() => !!window.__editor);
  const b = await doc(page);
  expect(b.title).toBe('Persisted');
  expect(b.groups).toHaveLength(1);
});

test('imports a screenshot and records its intrinsic size', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page);
  await dropImage(page);
  const b = await doc(page);
  const s = b.groups[0].screens[0];
  expect(s).toMatchObject({ w: 1280, h: 800 });
  expect(s.src).toMatch(/^images\//);
  expect(s.name).toBe('shot');
});

test('the drop overlay does not flicker when dragging across child elements', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page);
  await dropImage(page);                       // one screen on the canvas to cross over

  const states = await page.evaluate(() => {
    const dt = () => { const d = new DataTransfer(); d.items.add(window.__file); return d; };
    const fire = (node, type) => node.dispatchEvent(
      new DragEvent(type, { dataTransfer: dt(), bubbles: true, cancelable: true }));
    const on = () => document.getElementById('drop').classList.contains('on');
    const canvas = document.getElementById('canvas');
    const child = document.querySelector('[data-testid="canvas-screen"]');
    const seen = [];

    fire(canvas, 'dragenter');           seen.push(['enter canvas', on()]);
    fire(child, 'dragenter');            seen.push(['enter child', on()]);
    fire(child, 'dragleave');            seen.push(['leave child', on()]);
    fire(child, 'dragenter');            seen.push(['enter child again', on()]);
    fire(child, 'dragleave');            seen.push(['leave child again', on()]);
    fire(canvas, 'dragleave');           seen.push(['leave canvas', on()]);
    return seen;
  });

  // the overlay must stay up for the whole traversal, then go down once
  expect(states).toEqual([
    ['enter canvas', true],
    ['enter child', true],
    ['leave child', true],
    ['enter child again', true],
    ['leave child again', true],
    ['leave canvas', false],
  ]);
});

test('dragover is always defaulted-prevented, so the browser never opens the file', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page);

  const prevented = await page.evaluate(() => {
    const mk = () => { const d = new DataTransfer(); d.items.add(window.__file); return d; };
    const at = node => {
      const ev = new DragEvent('dragover', { dataTransfer: mk(), bubbles: true, cancelable: true });
      node.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return {
      canvas: at(document.getElementById('canvas')),
      overlay: at(document.getElementById('drop')),   // sits above the canvas while dragging
      elsewhere: at(document.getElementById('inspector')),
    };
  });
  // any of these returning false means the browser navigates to the dropped image
  expect(prevented).toEqual({ canvas: true, overlay: true, elsewhere: true });
});

test('the drop overlay cannot intercept the drag it is reporting', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page);
  await page.evaluate(() => {
    const d = new DataTransfer(); d.items.add(window.__file);
    document.getElementById('canvas').dispatchEvent(
      new DragEvent('dragenter', { dataTransfer: d, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#drop')).toHaveClass(/on/);
  expect(await page.locator('#drop').evaluate(e => getComputedStyle(e).pointerEvents)).toBe('none');
});

test('non-image files are refused instead of silently doing nothing', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    document.getElementById('canvas').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#toast')).toContainText(/not images/i);
  expect((await doc(page)).groups[0].screens).toHaveLength(0);
});

test('the drop names the group it will land in, and honours it', async ({ page }) => {
  // two groups, each with a screen, so both have a region on the canvas
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page, 'one.png');
  await dropImage(page);
  await page.getByTestId('add-group').click();
  const groups = (await doc(page)).groups;
  expect(groups).toHaveLength(2);

  await page.keyboard.press('f');                       // fit so both frames are on screen
  await page.waitForTimeout(150);

  const overFrame = async (i) => {
    const box = await page.locator(`.cframe[data-group="${groups[i].id}"]`).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  // the second group is still empty — it must be visible and droppable anyway
  await makeImage(page, 'two.png');
  await dropImage(page, 2, await overFrame(1));
  expect((await doc(page)).groups[1].screens, 'empty group could not receive a drop').toHaveLength(1);

  await page.keyboard.press('f');
  await page.waitForTimeout(150);
  const hover = async pt => {
    await makeImage(page, 'aim.png');
    return page.evaluate(p => {
      const dt = new DataTransfer(); dt.items.add(window.__file);
      const mk = t => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true,
                                         clientX: p.x, clientY: p.y });
      const c = document.getElementById('canvas');
      c.dispatchEvent(mk('dragenter'));
      c.dispatchEvent(mk('dragover'));
      const drop = document.getElementById('drop');
      return { label: drop.textContent.trim(), target: drop.dataset.target,
               highlighted: [...document.querySelectorAll('.cframe.droptarget')].map(f => f.dataset.group) };
    }, pt);
  };

  const first = await hover(await overFrame(0));
  expect(first.target).toBe(groups[0].id);
  expect(first.label.toLowerCase()).toContain(groups[0].title.toLowerCase());
  expect(first.highlighted).toEqual([groups[0].id]);

  const second = await hover(await overFrame(1));
  expect(second.target).toBe(groups[1].id);
  expect(second.highlighted).toEqual([groups[1].id]);

  // and the drop actually lands there, not in the selected group
  await page.evaluate(p => {
    const dt = new DataTransfer(); dt.items.add(window.__file);
    const mk = t => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true,
                                       clientX: p.x, clientY: p.y });
    const c = document.getElementById('canvas');
    c.dispatchEvent(mk('dragenter'));
    c.dispatchEvent(mk('dragover'));
    c.dispatchEvent(mk('drop'));
  }, await overFrame(0));
  await expect(page.locator('[data-testid="canvas-screen"]')).toHaveCount(3);

  const after = (await doc(page)).groups;
  expect(after[0].screens, 'the drop ignored the group under the cursor').toHaveLength(2);
  expect(after[1].screens).toHaveLength(1);
});

test('dropping on empty canvas starts a new group there', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page, 'first.png');
  await dropImage(page);
  await page.keyboard.press('f');
  await page.waitForTimeout(150);

  // aim well outside the existing group's region
  const state = await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(window.__file);
    const mk = t => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true,
                                       clientX: 12, clientY: 12 });
    const c = document.getElementById('canvas');
    c.dispatchEvent(mk('dragenter'));
    c.dispatchEvent(mk('dragover'));
    const drop = document.getElementById('drop');
    return { label: drop.textContent.trim(), target: drop.dataset.target };
  });
  expect(state.target).toBe('');
  expect(state.label.toLowerCase()).toContain('new group');
});

test('auto layout flows screens without overlapping them', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  for (let i = 0; i < 4; i++) {
    await makeImage(page, `s${i}.png`);
    await dropImage(page, i + 1);
  }
  expect((await doc(page)).groups, 'every drop should land in the one group').toHaveLength(1);
  const boxes = await page.locator('[data-testid="canvas-screen"]').evaluateAll(
    els => els.map(e => { const r = e.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j];
      const ov = Math.max(0, Math.min(a.r, c.r) - Math.max(a.l, c.l))
               * Math.max(0, Math.min(a.b, c.b) - Math.max(a.t, c.t));
      expect(ov, `screens ${i} and ${j} overlap`).toBe(0);
    }
});

test('switching a group to free hand seeds positions and allows dragging', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('group-header').first().click();
  await page.getByTestId('group-layout').selectOption('manual');

  const before = (await doc(page)).groups[0].screens[0].pos;
  expect(before).toBeTruthy();

  const box = await page.locator('[data-testid="canvas-screen"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 });
  await page.mouse.up();

  const after = (await doc(page)).groups[0].screens[0].pos;
  expect(after.x).not.toBe(before.x);
  expect((await doc(page)).groups[0].layout).toBe('manual');
});

test('dragging a group after reopening persists to the store and is undoable', async ({ page }) => {
  // A drag mutates the board live and coalesces into a single commit on
  // pointerup. When the undo stack is empty — exactly the state a freshly
  // reopened board is in — that coalescing used to no-op, so the move never
  // reached storage. Reproduce that path by round-tripping through the library.
  const id = (await boardWithScreen(page)).id;

  // Let the debounced autosave flush, so reopening loads the group we placed.
  await expect.poll(() => page.evaluate(bid =>
    window.__store.loadBoard(bid).then(b => b?.groups?.[0]?.screens?.length ?? 0), id)).toBe(1);

  // Back to the library and reopen: this rebuilds the editor with an empty
  // undo stack while the in-memory store keeps the board.
  await page.getByTestId('to-library').click();
  await page.getByTestId('board-card').click();
  await page.waitForFunction(() => !!window.__editor);
  const handle = page.getByTestId('group-handle').first();
  await expect(handle).toBeVisible();

  // Baseline origin, read from the store — the pre-drag truth.
  const before = await page.evaluate(bid =>
    window.__store.loadBoard(bid).then(b => b.groups[0].origin), id);

  // Drag the group by its title handle — the first action after load.
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 90, { steps: 10 });
  await page.mouse.up();

  // The move must land in the store, not just the live DOM.
  await expect.poll(() => page.evaluate(bid =>
    window.__store.loadBoard(bid).then(b => b.groups[0].origin.x), id)).not.toBe(before.x);

  // One undo returns the group to where it started.
  await page.locator('#undo').click();
  await expect.poll(() =>
    page.evaluate(() => window.__editor.board.groups[0].origin.x)).toBe(before.x);
});

test('draws an annotation by dragging a box on the screenshot', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  const shot = page.locator('#shot');
  await expect(shot).toBeVisible();
  const box = await shot.boundingBox();

  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByTestId('hotspot')).toHaveCount(1);
  const note = (await doc(page)).groups[0].steps[0].notes[0];
  expect(note.rect.x).toBeGreaterThan(0.15);
  expect(note.rect.x).toBeLessThan(0.25);
  expect(note.rect.w).toBeGreaterThan(0.3);
  for (const k of ['x', 'y', 'w', 'h']) {
    expect(note.rect[k]).toBeGreaterThanOrEqual(0);
    expect(note.rect[k]).toBeLessThanOrEqual(1);
  }

  await page.getByTestId('note-text').fill('This is the pile.');
  await expect(page.locator('[data-testid="note-row"]')).toContainText('This is the pile.');
});

/** Draw N annotations on the current step. */
async function drawNotes(page, texts) {
  const shot = page.locator('#shot');
  for (let i = 0; i < texts.length; i++) {
    const box = await shot.boundingBox();   // re-read: never trust a stale box
    const y = 0.15 + i * 0.2;
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * (y + 0.1), { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId('hotspot')).toHaveCount(i + 1);
    await page.getByTestId('note-text').fill(texts[i]);
  }
}

test('the screenshot does not drift as notes are added', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  const at = async () => {
    const b = await page.locator('#shot').boundingBox();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const start = await at();
  await drawNotes(page, ['a', 'b', 'c']);
  expect(await at(), 'the image moved under the cursor while annotating').toEqual(start);
});

test('reorders notes — array order is reveal order', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['first', 'second', 'third']);

  expect((await doc(page)).groups[0].steps[0].notes.map(n => n.text))
    .toEqual(['first', 'second', 'third']);

  // move the third note to the top
  await page.locator('[data-testid="note-row"]').nth(2).locator('[data-testid="note-up"]').click();
  await page.locator('[data-testid="note-row"]').nth(1).locator('[data-testid="note-up"]').click();

  expect((await doc(page)).groups[0].steps[0].notes.map(n => n.text))
    .toEqual(['third', 'first', 'second']);
});

test('reorders steps without breaking their notes', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['on step one']);

  // a second step on the same screen
  await page.getByTestId('mode-layout').click();
  await page.locator('[data-testid="canvas-screen"]').click();
  await page.getByTestId('add-step-for-screen').click();
  await page.getByTestId('step-kicker').fill('second step');

  let b = await doc(page);
  expect(b.groups[0].steps).toHaveLength(2);
  const firstId = b.groups[0].steps[0].id;

  await page.locator('[data-testid="step"]').first().locator('[data-testid="step-down"]').click();

  b = await doc(page);
  expect(b.groups[0].steps[1].id).toBe(firstId);
  expect(b.groups[0].steps[1].notes.map(n => n.text)).toEqual(['on step one']);
});

test('a screenshot background is configurable, and reaches the player', async ({ page }) => {
  await boardWithScreen(page);
  const plate = () => page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-testid="canvas-screen"]')).backgroundColor);

  // default keeps today's behaviour
  expect(await plate()).toBe('rgb(255, 255, 255)');

  // per-screen override
  await page.locator('[data-testid="canvas-screen"]').click();
  await page.getByTestId('bg-transparent').click();
  expect(await plate()).toBe('rgba(0, 0, 0, 0)');
  expect((await doc(page)).groups[0].screens[0].background).toBe('transparent');
  // authoring aid: transparency is shown as transparency, not as the board
  await expect(page.locator('[data-testid="canvas-screen"]')).toHaveClass(/alpha/);

  // and the player honours it
  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => window.__player && document.querySelector('.plate'));
  expect(await page.evaluate(() =>
    getComputedStyle(document.querySelector('.plate')).backgroundColor)).toBe('rgba(0, 0, 0, 0)');

  // back to inheriting (the toolbar is covered in preview, so leave via Escape)
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mode-layout')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-testid="canvas-screen"]').click();
  await page.getByTestId('bg-inherit').click();
  expect((await doc(page)).groups[0].screens[0].background).toBeUndefined();
});

test('the board default backs every screen that has no override', async ({ page }) => {
  await boardWithScreen(page);
  await page.evaluate(() => window.__editor.selectBoard());
  await page.getByTestId('bg-0A0D12').click();
  expect((await doc(page)).screenBackground).toBe('#0A0D12');
  expect(await page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-testid="canvas-screen"]')).backgroundColor))
    .toBe('rgb(10, 13, 18)');
});

test('the screen inspector shows which steps use it', async ({ page }) => {
  await boardWithScreen(page);                  // already has one step on the screen
  await page.getByTestId('step-kicker').fill('the input');
  await page.locator('[data-testid="canvas-screen"]').click();

  await expect(page.locator('#inspector')).toContainText('Used by 1 step');
  const row = page.getByTestId('screen-step');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('the input');
  await expect(row).toContainText('no notes');

  // clicking it selects that step
  await row.click();
  await expect(page.getByTestId('step-kicker')).toHaveValue('the input');
});

test('a screen used by no step says so', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await makeImage(page);
  await dropImage(page);
  await page.locator('[data-testid="canvas-screen"]').click();
  await expect(page.locator('#inspector')).toContainText('Used by 0 steps');
  await expect(page.locator('#inspector')).toContainText(/will not appear in the demo/i);
});

test('preview hides the editor chrome instead of covering it', async ({ page }) => {
  await boardWithScreen(page);

  // Baseline: chrome is present in layout mode.
  await expect(page.locator('#top')).toBeVisible();
  await expect(page.locator('#outline')).toBeVisible();

  // In preview the toolbar and the left rail must be out of the render tree —
  // covering them with the position:fixed player is a paint-order gamble that
  // leaks the chrome through during zoom animations.
  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => !!window.__player);
  await expect(page.locator('#top')).toBeHidden();
  await expect(page.locator('#outline')).toBeHidden();

  // Leaving preview restores the chrome.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mode-layout')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#top')).toBeVisible();
  await expect(page.locator('#outline')).toBeVisible();
});

test('preview can always be exited — by button and by Escape', async ({ page }) => {
  await boardWithScreen(page);

  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => !!window.__player);
  // the player is position:fixed and covers the toolbar, so the way out must
  // sit above everything it draws
  const exit = page.getByTestId('exit-preview');
  await expect(exit).toBeVisible();
  const z = await exit.evaluate(e => +getComputedStyle(e).zIndex);
  const highest = await page.evaluate(() => Math.max(
    ...[...document.querySelectorAll('#pal,#scrim,#hud,#caption,#notes,#leaders')]
      .map(e => +getComputedStyle(e).zIndex || 0)));
  expect(z).toBeGreaterThan(highest);

  await exit.click();
  await expect(page.getByTestId('mode-layout')).toHaveAttribute('aria-pressed', 'true');

  // and Escape works too
  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => !!window.__player);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mode-layout')).toHaveAttribute('aria-pressed', 'true');
});

test('leaving preview removes every trace of the player', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['leaves a ring behind?']);

  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => !!window.__player);
  // Preview now opens on the layout viewport without revealing notes; frame the
  // step so there are targets/notes whose cleanup on exit we can then verify.
  await page.evaluate(() => {
    const g = window.__player.board.groups.find(x => x.steps.length);
    window.__player.goto(g.id, g.steps[0].id);
  });
  await page.waitForFunction(() => document.querySelectorAll('.target').length > 0, null, { timeout: 8000 });
  expect(await page.locator('.target').count()).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mode-layout')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);

  // rings used to be parked on document.body, so destroy() could not reach them
  const left = await page.evaluate(() => ({
    targets: document.querySelectorAll('.target').length,
    notes: document.querySelectorAll('.note').length,
    leaders: document.querySelectorAll('#leaders path').length,
    strayOnBody: [...document.body.children].filter(
      e => e.classList.contains('target') || e.classList.contains('note')).length,
  }));
  expect(left, 'the player left DOM behind in the editor').toEqual(
    { targets: 0, notes: 0, leaders: 0, strayOnBody: 0 });
});

test('the crop mask covers exactly the area outside the crop', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-crop').click();
  await expect(page.getByTestId('cropbox')).toBeVisible();

  // pull the left edge in, then the right edge in — the sequence that showed
  // a stray band on the right
  const img = await page.locator('#cropimg').boundingBox();
  const dragEdge = async (fromX, toX) => {
    const cb = await page.getByTestId('cropbox').boundingBox();
    await page.mouse.move(fromX(cb), cb.y + cb.height / 2);
    await page.mouse.down();
    await page.mouse.move(toX, cb.y + cb.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(80);
  };
  await dragEdge(cb => cb.x, img.x + img.width * 0.2);                 // west edge in
  await dragEdge(cb => cb.x + cb.width, img.x + img.width * 0.7);      // east edge in

  const geom = await page.evaluate(() => {
    const R = e => { const q = e.getBoundingClientRect();
      return { l: q.left, t: q.top, r: q.right, b: q.bottom, w: q.width, h: q.height }; };
    const box = R(document.getElementById('cropbox'));
    const host = R(document.getElementById('cropimg'));
    const bands = [...document.querySelectorAll('#cropmask i')].map(R);
    const overlap = (a, c) => Math.max(0, Math.min(a.r, c.r) - Math.max(a.l, c.l))
                            * Math.max(0, Math.min(a.b, c.b) - Math.max(a.t, c.t));
    return {
      bands: bands.length,
      overCrop: bands.reduce((s, b) => s + overlap(b, box), 0),
      covered: bands.reduce((s, b) => s + b.w * b.h, 0),
      expected: host.w * host.h - box.w * box.h,
      outside: bands.filter(b => b.r > host.r + 1 || b.l < host.l - 1).length,
    };
  });

  expect(geom.bands).toBe(4);
  expect(Math.round(geom.overCrop), 'the mask darkened part of the crop').toBeLessThan(50);
  expect(geom.outside, 'a mask band spilled outside the image').toBe(0);
  // the four bands should tile the complement of the crop box
  expect(geom.covered).toBeGreaterThan(geom.expected * 0.97);
  expect(geom.covered).toBeLessThan(geom.expected * 1.03);
});

test('Escape closes the palette before it leaves preview', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => !!window.__player);

  await page.keyboard.press('Meta+k');
  await expect(page.locator('#pal')).toHaveClass(/on/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#pal')).not.toHaveClass(/on/);
  await expect(page.getByTestId('mode-preview')).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');          // second one leaves
  await expect(page.getByTestId('mode-layout')).toHaveAttribute('aria-pressed', 'true');
});

/* ── resize handles ──────────────────────────────────────────────────────── */

test('an annotation rect can be resized by any edge or corner', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['resize me']);

  const rectOf = async () => (await doc(page)).groups[0].steps[0].notes[0].rect;
  const before = await rectOf();
  await expect(page.getByTestId('handle-se')).toBeVisible();
  await expect(page.locator('.hd')).toHaveCount(8);   // 4 corners + 4 edges

  // drag the east edge right — only the width changes
  const shot = await page.locator('#shot').boundingBox();
  const box = await page.locator('[data-testid="hotspot"]').boundingBox();
  await page.mouse.move(box.x + box.width, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(shot.x + shot.width * 0.8, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const afterE = await rectOf();
  expect(afterE.w).toBeGreaterThan(before.w);
  expect(afterE.x).toBeCloseTo(before.x, 2);
  expect(afterE.y).toBeCloseTo(before.y, 2);
  expect(afterE.h).toBeCloseTo(before.h, 2);

  // drag the north edge up — the bottom edge stays put
  const box2 = await page.locator('[data-testid="hotspot"]').boundingBox();
  const bottom = afterE.y + afterE.h;
  await page.mouse.move(box2.x + box2.width / 2, box2.y);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, shot.y + shot.height * 0.05, { steps: 8 });
  await page.mouse.up();

  const afterN = await rectOf();
  expect(afterN.y).toBeLessThan(afterE.y);
  expect(afterN.y + afterN.h).toBeCloseTo(bottom, 2);
  for (const k of ['x', 'y', 'w', 'h']) {
    expect(afterN[k]).toBeGreaterThanOrEqual(0);
    expect(afterN[k]).toBeLessThanOrEqual(1);
  }
});

test('handles appear only on the selected rect', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['one', 'two']);
  await expect(page.getByTestId('hotspot')).toHaveCount(2);
  await expect(page.locator('.hd')).toHaveCount(8);        // only the last-selected
  await page.locator('[data-testid="hotspot"]').first().click();
  await expect(page.locator('[data-testid="hotspot"]').first().locator('.hd')).toHaveCount(8);
});

/* ── crop ────────────────────────────────────────────────────────────────── */

test('cropping changes the space a screen takes and keeps notes on target', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['stays put']);
  const rectBefore = (await doc(page)).groups[0].steps[0].notes[0].rect;

  await page.getByTestId('mode-crop').click();
  await expect(page.getByTestId('cropbox')).toBeVisible();

  // trim the east edge, well clear of the note (which sits at x≈0.15–0.5)
  const img = await page.locator('#cropimg').boundingBox();
  const cb = await page.getByTestId('cropbox').boundingBox();
  await page.mouse.move(cb.x + cb.width, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(img.x + img.width * 0.75, cb.y + cb.height / 2, { steps: 8 });
  await page.mouse.up();

  const s = (await doc(page)).groups[0].screens[0];
  expect(s.crop, 'no crop was recorded').toBeTruthy();
  expect(s.crop.w).toBeLessThan(0.85);
  expect(s.w, 'the source image must not be modified').toBe(1280);

  // the stored rect changed — it is expressed against the new crop
  const rectAfter = (await doc(page)).groups[0].steps[0].notes[0].rect;
  expect(rectAfter.x).not.toBeCloseTo(rectBefore.x, 3);

  // …but it still points at the same pixels of the source image
  const srcAfter = s.crop.x + rectAfter.x * s.crop.w;
  expect(srcAfter, 'the annotation drifted off its target').toBeCloseTo(rectBefore.x, 2);
});

test('an annotation cropped out of view is clamped, not lost', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['on the left edge']);

  // crop away the left half, where the note lives
  await page.evaluate(() => window.__editor.applyCrop(
    window.__editor.board.groups[0].screens[0].id, { x: 0.6, y: 0, w: 0.4, h: 1 }));

  const r = (await doc(page)).groups[0].steps[0].notes[0].rect;
  expect(r, 'the note was dropped instead of clamped').toBeTruthy();
  for (const k of ['x', 'y', 'w', 'h']) {
    expect(r[k]).toBeGreaterThanOrEqual(0);
    expect(r[k]).toBeLessThanOrEqual(1);
  }
  expect(r.w).toBeGreaterThan(0);
});

test('reset restores the whole image and removes the crop field', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-crop').click();
  const img = await page.locator('#cropimg').boundingBox();
  const cb = await page.getByTestId('cropbox').boundingBox();
  await page.mouse.move(cb.x, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(img.x + img.width * 0.3, cb.y + cb.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await doc(page)).groups[0].screens[0].crop).toBeTruthy();

  await page.getByTestId('crop-reset').click();
  expect('crop' in (await doc(page)).groups[0].screens[0]).toBe(false);
});

test('the player shows only the cropped region', async ({ page }) => {
  await boardWithScreen(page);
  await page.evaluate(() => {
    const b = window.__editor.board;
    window.__editor.applyCrop(b.groups[0].screens[0].id, { x: 0.25, y: 0, w: 0.5, h: 1 });
  });
  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => window.__player && document.querySelector('.plate img'));
  const g = await page.evaluate(() => {
    const plate = document.querySelector('.plate');
    const img = plate.querySelector('img');
    return {
      plate: [Math.round(plate.getBoundingClientRect().width), Math.round(plate.getBoundingClientRect().height)],
      img: [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)],
    };
  });
  // the image is scaled up 2x and clipped, so the plate is half its width
  expect(g.img[0] / g.plate[0]).toBeCloseTo(2, 1);
  expect(g.img[1] / g.plate[1]).toBeCloseTo(1, 1);
});

test('the annotate plate clips the cropped screenshot', async ({ page }) => {
  await boardWithScreen(page);
  await page.evaluate(() => {
    const b = window.__editor.board;
    window.__editor.applyCrop(b.groups[0].screens[0].id, { x: 0.25, y: 0, w: 0.5, h: 1 });
  });
  await page.getByTestId('mode-annotate').click();
  await page.waitForFunction(() => {
    const img = document.querySelector('#shot img');
    return img && img.getAttribute('src');
  });
  // A 2x horizontal crop scales the image to 200% of the plate and shifts it
  // left by 50%, so it spills half a plate-width past each edge. The plate must
  // clip that: a point just outside #shot's right edge (still inside the padded
  // #annot stage) must not land on the screenshot. getBoundingClientRect ignores
  // overflow clipping, so the img/plate ratio alone can't catch the spill —
  // elementFromPoint respects both the clip and pointer-events, so we re-enable
  // pointer-events on the img (the app sets none for authoring) and hit-test the
  // spill point: a clipped plate suppresses the hit, an unclipped one doesn't.
  const probe = await page.evaluate(() => {
    const shot = document.getElementById('shot');
    const img = shot.querySelector('img');
    img.style.pointerEvents = 'auto';
    const r = shot.getBoundingClientRect();
    const hit = document.elementFromPoint(r.right + 8, r.top + r.height / 2);
    return {
      ratio: img.getBoundingClientRect().width / r.width,
      hitsImg: hit === img,
    };
  });
  expect(probe.ratio, 'the crop scale was not applied').toBeCloseTo(2, 1);
  expect(probe.hitsImg, 'the cropped image spills past the plate — #shot does not clip').toBe(false);
});

/* ── replace ─────────────────────────────────────────────────────────────── */

test('replacing an image keeps the screen, its steps and its notes', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['survives the swap']);
  const before = await doc(page);
  const screenId = before.groups[0].screens[0].id;
  const stepId = before.groups[0].steps[0].id;

  await page.getByTestId('mode-layout').click();
  await page.locator('[data-testid="canvas-screen"]').click();
  await makeImage(page, 'replacement.png');
  await page.evaluate(async () => {
    await window.__editor.replaceWith(
      window.__editor.board.groups[0].screens[0].id, window.__file);
  });

  const after = await doc(page);
  expect(after.groups[0].screens[0].id).toBe(screenId);
  expect(after.groups[0].screens[0].src).not.toBe(before.groups[0].screens[0].src);
  expect(after.groups[0].steps[0].id).toBe(stepId);
  expect(after.groups[0].steps[0].notes.map(n => n.text)).toEqual(['survives the swap']);
});

/* ── move between groups ─────────────────────────────────────────────────── */

test('a screen can be moved to another group, taking its steps', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['comes along']);
  await page.getByTestId('mode-layout').click();
  await page.getByTestId('add-group').click();

  const groups = (await doc(page)).groups;
  expect(groups[0].screens).toHaveLength(1);
  expect(groups[0].steps).toHaveLength(1);

  await page.locator('[data-testid="canvas-screen"]').click();
  await page.getByTestId('move-to-group').selectOption(groups[1].id);

  const after = (await doc(page)).groups;
  expect(after[0].screens).toHaveLength(0);
  expect(after[0].steps).toHaveLength(0);
  expect(after[1].screens).toHaveLength(1);
  expect(after[1].steps).toHaveLength(1);
  expect(after[1].steps[0].notes.map(n => n.text)).toEqual(['comes along']);
});

/* ── paste ───────────────────────────────────────────────────────────────── */

test('pasting an image asks where it should go', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('add-group').click();
  const groups = (await doc(page)).groups;

  await makeImage(page, 'pasted.png');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(window.__file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });

  const dialog = page.getByTestId('paste-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('paste-group')).toHaveCount(2);
  await expect(dialog.getByTestId('paste-new-group')).toBeVisible();

  await dialog.locator(`[data-testid="paste-group"][data-group-id="${groups[1].id}"]`).click();
  await expect(page.locator('[data-testid="canvas-screen"]')).toHaveCount(2);
  const after = (await doc(page)).groups;
  expect(after[1].screens, 'the paste ignored the chosen group').toHaveLength(1);
  expect(after[1].screens[0].src).toMatch(/\.png$/);
});

test('paste is ignored while typing so text paste still works', async ({ page }) => {
  await boardWithScreen(page);
  await makeImage(page);
  await page.getByTestId('step-caption').focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(window.__file);
    document.querySelector('[data-testid="step-caption"]').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('paste-dialog')).toHaveCount(0);
  expect((await doc(page)).groups[0].screens).toHaveLength(1);
});

test('a group can be dragged to a new position, taking its screens', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('add-group').click();
  await page.keyboard.press('f');
  await page.waitForTimeout(150);

  const originBefore = (await doc(page)).groups[0].origin;
  const otherBefore = (await doc(page)).groups[1].origin;
  const screenBefore = await page.locator('[data-testid="canvas-screen"]').boundingBox();

  const handle = page.getByTestId('group-handle').first();
  await expect(handle).toBeVisible();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 180, hb.y + hb.height / 2 + 90, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(120);

  const after = await doc(page);
  expect(after.groups[0].origin.x).not.toBe(originBefore.x);
  expect(after.groups[0].origin.y).not.toBe(originBefore.y);
  expect(after.groups[1].origin, 'the other group moved too').toEqual(otherBefore);

  // the screens inside moved with it
  const screenAfter = await page.locator('[data-testid="canvas-screen"]').boundingBox();
  expect(screenAfter.x).toBeGreaterThan(screenBefore.x);
  expect(screenAfter.y).toBeGreaterThan(screenBefore.y);
});

test('dragging a group is one undo step, not one per pixel', async ({ page }) => {
  await boardWithScreen(page);
  await page.keyboard.press('f');
  await page.waitForTimeout(150);
  const before = (await doc(page)).groups[0].origin;

  const hb = await page.getByTestId('group-handle').first().boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 150, hb.y + hb.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  expect((await doc(page)).groups[0].origin.x).not.toBe(before.x);

  await page.locator('#undo').click();
  expect((await doc(page)).groups[0].origin).toEqual(before);
});

test('a cropped screenshot renders cropped in the layout view too', async ({ page }) => {
  await boardWithScreen(page);
  await page.evaluate(() => window.__editor.applyCrop(
    window.__editor.board.groups[0].screens[0].id, { x: 0.25, y: 0, w: 0.5, h: 1 }));
  await page.waitForTimeout(120);

  const g = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="canvas-screen"]');
    const img = box.querySelector('img');
    const b = box.getBoundingClientRect(), i = img.getBoundingClientRect();
    return { boxAspect: b.width / b.height, imgAspect: i.width / i.height,
             scale: i.width / b.width, clipped: getComputedStyle(box).overflow };
  });
  // 1280×800 cropped to half width => the plate is 640×800
  expect(g.boxAspect).toBeCloseTo(0.8, 1);
  // the image keeps its own 1.6 aspect and is scaled 2x, i.e. clipped not squashed
  expect(g.imgAspect, 'the image was squashed instead of cropped').toBeCloseTo(1.6, 1);
  expect(g.scale).toBeCloseTo(2, 1);
  expect(g.clipped).toBe('hidden');
});

test('undo reverses the last change', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('add-group').click();
  await page.getByTestId('add-group').click();
  expect((await doc(page)).groups).toHaveLength(2);
  await page.locator('#undo').click();
  expect((await doc(page)).groups).toHaveLength(1);
});

test('preview renders the edited board with no note over the screenshot', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('step-caption').fill('It starts as noise.');
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['1,284 reports.', 'Nobody triaged them.']);

  await page.getByTestId('mode-preview').click();
  await page.waitForFunction(() => !!window.__player);
  // Entry opens on the layout viewport (no notes yet); frame the step to reveal
  // them, then assert none overlaps the screenshot.
  await page.evaluate(() => {
    const g = window.__player.board.groups.find(x => x.steps.length);
    window.__player.goto(g.id, g.steps[0].id);
  });
  await page.waitForFunction(() => window.__player && document.querySelectorAll('.note').length > 0,
    null, { timeout: 8000 });
  await page.waitForTimeout(200);

  const r = await page.evaluate(() => {
    const R = e => { const q = e.getBoundingClientRect();
      return { left: q.left, top: q.top, right: q.right, bottom: q.bottom }; };
    const { groupId, stepId } = window.__player.ref;
    const g = window.__player.board.groups.find(x => x.id === groupId);
    const st = g.steps.find(x => x.id === stepId);
    const plate = document.querySelector(`.plate[data-screen="${st.screen}"]`);
    return {
      caption: document.querySelector('#caption .t').textContent,
      notes: [...document.querySelectorAll('.note')].map(R),
      noteText: [...document.querySelectorAll('.note .x')].map(n => n.textContent),
      plate: R(plate),
      imgLoaded: [...document.querySelectorAll('.plate img')].every(i => i.complete && i.naturalWidth > 0),
    };
  });

  expect(r.caption).toBe('It starts as noise.');
  expect(r.noteText).toEqual(['1,284 reports.', 'Nobody triaged them.']);
  expect(r.imgLoaded, 'preview must load images out of storage').toBe(true);
  const ov = r.notes.reduce((s, n) =>
    s + Math.max(0, Math.min(n.right, r.plate.right) - Math.max(n.left, r.plate.left))
      * Math.max(0, Math.min(n.bottom, r.plate.bottom) - Math.max(n.top, r.plate.top)), 0);
  expect(ov, 'a note covered the screenshot in preview').toBe(0);
});

test('exports a zip, and importing it creates a second independent board', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('board-title').fill('Exportable');
  await page.getByTestId('mode-annotate').click();
  await drawNotes(page, ['note one']);

  // export through the same code path the button uses, capturing the bytes
  const zip = await page.evaluate(async () => {
    const m = await import('/src/core/bundle.js');
    const b = window.__editor.board;
    const bytes = await m.exportBoard(b, name => window.__store.readImage(b.id, name));
    return [...bytes];
  });
  expect(zip.length).toBeGreaterThan(200);

  const result = await page.evaluate(async bytes => {
    const m = await import('/src/core/bundle.js');
    const { board, imported } = await m.installBundle(window.__store, new Uint8Array(bytes));
    const all = await window.__store.listBoards();
    return { newId: board.id, title: board.title, imported, count: all.length };
  }, zip);

  expect(result.count).toBe(2);
  expect(result.imported).toBe(1);
  expect(result.title).toBe('Exportable (imported)');

  await page.getByTestId('to-library').click();
  await expect(page.getByTestId('board-card')).toHaveCount(2);
});

test('publish produces a static site that boots from board.json', async ({ page }) => {
  await boardWithScreen(page);
  const files = await page.evaluate(async () => {
    const m = await import('/src/core/bundle.js');
    const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
    const b = window.__editor.board;

    // same template fetch the publish button performs
    const base = new URL('.', location.href);
    const html = await (await fetch(new URL('player.html', base))).text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(x => x[1]).filter(u => !/^https?:|^\/\/|^data:/.test(u));
    const tpl = {};
    for (const rel of assets) {
      const res = await fetch(new URL(rel, base));
      if (res.ok) tpl[rel.replace(/^\.?\//, '')] = new Uint8Array(await res.arrayBuffer());
    }
    tpl['index.html'] = new TextEncoder().encode(html);

    const zip = await m.publishBoard(b, name => window.__store.readImage(b.id, name), tpl);
    const out = unzipSync(zip);
    return {
      names: Object.keys(out),
      board: JSON.parse(strFromU8(out['board.json'])),
      readme: strFromU8(out['README.txt']),
    };
  });

  expect(files.names).toContain('index.html');
  expect(files.names).toContain('board.json');
  expect(files.names.some(n => n.startsWith('images/'))).toBe(true);
  expect(files.names).not.toContain('manifest.json');   // view-only, not a shareable bundle
  expect(files.board.groups[0].screens).toHaveLength(1);
  expect(files.readme).toMatch(/file:\/\//);
});

test('the library says where boards are stored and that nothing is synced', async ({ page }) => {
  await page.goto(EDITOR);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  const warn = page.locator('.warn');
  // the certain risks, named before the rare one
  await expect(warn).toContainText('stored in this browser');
  await expect(warn).toContainText(new URL(page.url()).origin);
  await expect(warn).toContainText(/nothing is synced/i);
  await expect(warn).toContainText(/cookies and other site data/i);
});

test('resize handles rescale a screen on the canvas, aspect-locked and undoable', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('group-header').first().click();
  await page.getByTestId('group-layout').selectOption('manual');

  // select the screen so its corner handles render
  const plate = page.locator('[data-testid="canvas-screen"]');
  await plate.click();

  const before = (await doc(page)).groups[0].screens[0];
  expect(before.scale ?? 1).toBe(1);
  const box0 = await plate.boundingBox();

  // drag the south-east handle outward — the top-left corner is the anchor
  const hd = page.getByTestId('resize-se');
  await expect(hd).toBeVisible();
  const hb = await hd.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 160, hb.y + 160, { steps: 10 });
  await page.mouse.up();

  const after = (await doc(page)).groups[0].screens[0];
  expect(after.scale).toBeGreaterThan(1);
  expect(after.w).toBe(before.w);            // intrinsic pixels untouched
  expect(after.h).toBe(before.h);

  const box1 = await plate.boundingBox();
  expect(box1.width).toBeGreaterThan(box0.width + 5);
  expect(box1.width / box1.height).toBeCloseTo(box0.width / box0.height, 1);  // aspect kept
  expect(Math.abs(box1.x - box0.x)).toBeLessThan(3);      // top-left corner stayed anchored
  expect(Math.abs(box1.y - box0.y)).toBeLessThan(3);

  await page.locator('#undo').click();
  const undone = (await doc(page)).groups[0].screens[0];
  expect(undone.scale ?? 1).toBe(1);         // one undo entry restores the size
});

test('double-clicking a resize handle resets the screen to 1×', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('group-header').first().click();
  await page.getByTestId('group-layout').selectOption('manual');
  await page.locator('[data-testid="canvas-screen"]').click();

  const hb = await page.getByTestId('resize-se').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 140, hb.y + 140, { steps: 8 });
  await page.mouse.up();
  expect((await doc(page)).groups[0].screens[0].scale).toBeGreaterThan(1);

  await page.getByTestId('resize-se').dblclick();
  expect('scale' in (await doc(page)).groups[0].screens[0]).toBe(false);
});

test('the inspector Size slider resizes a screen (works at any zoom) and is undoable', async ({ page }) => {
  // stays in auto layout on purpose: the slider is the resize path that does not
  // depend on the canvas corner-handles being on screen.
  await boardWithScreen(page);
  await page.locator('[data-testid="canvas-screen"]').click();
  const slider = page.getByTestId('screen-size');
  await expect(slider).toBeVisible();
  await slider.evaluate(el => {
    el.value = '250';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect((await doc(page)).groups[0].screens[0].scale).toBeCloseTo(2.5, 5);

  await page.locator('#undo').click();
  expect((await doc(page)).groups[0].screens[0].scale ?? 1).toBe(1);   // one undo entry
});

test('resize handles keep a constant screen size as the camera zooms out', async ({ page }) => {
  await boardWithScreen(page);
  await page.getByTestId('group-header').first().click();
  await page.getByTestId('group-layout').selectOption('manual');
  await page.locator('[data-testid="canvas-screen"]').click();

  const se = page.getByTestId('resize-se');
  const plate = page.locator('[data-testid="canvas-screen"]');
  const handleBefore = await se.boundingBox();
  const plateBefore = await plate.boundingBox();

  await page.locator('#canvas').evaluate(cv => {
    const r = cv.getBoundingClientRect();
    for (let i = 0; i < 3; i++) cv.dispatchEvent(new WheelEvent('wheel',
      { deltaY: 300, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  });

  const handleAfter = await se.boundingBox();
  const plateAfter = await plate.boundingBox();
  expect(plateAfter.width).toBeLessThan(plateBefore.width - 20);        // the screen shrank
  expect(Math.abs(handleAfter.width - handleBefore.width)).toBeLessThan(4);  // the handle did not
  expect(handleAfter.width).toBeGreaterThan(10);                        // still grabbable
});
