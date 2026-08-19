import { test, expect } from '@playwright/test';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * Regression guard for the zoom-out "blink".
 *
 * A board wider than one GPU texture can't be a single promoted compositor
 * layer; forcing `will-change:transform` on #world while moving made the browser
 * re-raster the tiled layer on a scale change and present ONE blank frame — the
 * whole board flashed black on zoom-out. It is a compositor event: invisible to
 * requestAnimationFrame timing and to img.naturalWidth, so the only witness is
 * the rendered pixels. This test records the defocus and asserts no frame goes
 * abruptly dark relative to its neighbours.
 *
 * The fix (player.js `promoteWorld`) skips the promotion for oversized worlds.
 * Needs ffmpeg for per-frame luma; skips cleanly when it is absent.
 */
const hasFfmpeg = (() => {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const N_IMG = 10, GROUPS = 6, PER_GROUP = 5;   // 30 screens; world ≫ one texture
const DIR = 'public/_heavy', IMGDIR = `${DIR}/images`;

/** Build a heavy board (big raster textures) once, into public/ so vite serves it. */
async function buildHeavyAssets(page) {
  if (existsSync(`${DIR}/board.json`)) return;
  mkdirSync(IMGDIR, { recursive: true });
  await page.goto('about:blank');
  const b64 = await page.evaluate(async n => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas'); c.width = 2560; c.height = 1600;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 2560, 1600);
      g.addColorStop(0, `hsl(${i * 36},60%,18%)`); g.addColorStop(1, `hsl(${i * 36 + 70},55%,48%)`);
      x.fillStyle = g; x.fillRect(0, 0, 2560, 1600);
      for (let k = 0; k < 4000; k++) {
        x.fillStyle = `rgba(${Math.random() * 255 | 0},${Math.random() * 255 | 0},${Math.random() * 255 | 0},.12)`;
        x.fillRect(Math.random() * 2560, Math.random() * 1600, 48, 48);
      }
      x.fillStyle = '#fff'; x.font = 'bold 220px sans-serif'; x.fillText('SCREEN ' + i, 120, 320);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (const v of buf) s += String.fromCharCode(v);
      out.push(btoa(s));
    }
    return out;
  }, N_IMG);
  b64.forEach((d, i) => writeFileSync(`${IMGDIR}/s${i}.png`, Buffer.from(d, 'base64')));

  const groups = [];
  let n = 0;
  for (let gi = 0; gi < GROUPS; gi++) {
    const screens = [], steps = [];
    for (let si = 0; si < PER_GROUP; si++, n++) {
      const id = `s_${gi}_${si}`;
      screens.push({ id, name: `Screen ${n}`, src: `images/s${n % N_IMG}.png`, w: 2560, h: 1600, keywords: [] });
      steps.push({ id: `st_${gi}_${si}`, screen: id, kicker: `k${n}`, gutter: 'right',
        caption: `Step ${n}`, notes: [{ id: `nt_${gi}_${si}`, text: `note ${n}`, rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.05 } }] });
    }
    groups.push({ id: `g_${gi}`, title: `Group ${gi}`, color: `hsl(${gi * 60},70%,55%)`,
      blurb: `group ${gi}`, layout: 'auto', autoLayout: {}, origin: { x: gi * 3200, y: 0 }, screens, steps });
  }
  writeFileSync(`${DIR}/board.json`, JSON.stringify({ version: 1, id: 'heavy', title: 'Heavy', groups }));
}

/** Per-frame average luma of the last `tail` seconds, via ffmpeg signalstats. */
function frameLuma(videoPath, statsPath, tail = 2.5) {
  execSync(`ffmpeg -loglevel error -sseof -${tail} -i "${videoPath}" ` +
    `-vf "signalstats,metadata=print:file=${statsPath}" -f null -`, { stdio: 'ignore' });
  return readFileSync(statsPath, 'utf8').split('\n')
    .filter(l => l.includes('YAVG')).map(l => parseFloat(l.split('YAVG=')[1]));
}
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

test('the board does not blink black on zoom-out (heavy board)', async ({ page, browser }, testInfo) => {
  test.skip(!hasFfmpeg, 'ffmpeg not installed — luma analysis unavailable');
  test.setTimeout(120_000);
  await buildHeavyAssets(page);   // default page; separate from the recorded context below

  const dir = testInfo.outputPath('rec');
  const base = testInfo.project.use.baseURL;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir, size: { width: 1440, height: 900 } },
  });
  const p = await context.newPage();
  await p.goto(`${base}/player.html?board=_heavy/board.json`);
  await p.waitForFunction(() => !!window.__player);
  await p.waitForTimeout(6000);                     // decode 30 textures, build thumbs
  await p.evaluate(() => window.__player.goto(
    window.__player.board.groups[0].id, window.__player.board.groups[0].steps[0].id));
  await p.waitForTimeout(2000);
  await p.evaluate(() => window.__player.fitBoard());   // the defocus
  await p.waitForTimeout(1500);

  const videoPath = await p.video().path();
  await context.close();                            // finalises the video file

  const luma = frameLuma(videoPath, testInfo.outputPath('luma.txt'));
  expect(luma.length, 'no frames analysed').toBeGreaterThan(20);

  // The blink is a single frame far darker than its neighbourhood. Compare each
  // frame to a local rolling median; the pre-fix flash sat at ~0.83 of it.
  let worst = 1;
  for (let i = 4; i < luma.length - 4; i++) {
    const med = median(luma.slice(i - 4, i + 5));
    if (med > 0) worst = Math.min(worst, luma[i] / med);
  }
  expect(worst, 'a frame went abruptly dark — the zoom-out blink is back').toBeGreaterThan(0.9);
});
