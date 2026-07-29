import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('https://upsoft-pl.github.io/demo-board/player.html?board=sample/board.json');
await p.waitForFunction(() => window.__player && [...document.images].every(i => i.complete));
await p.waitForTimeout(1500);
console.log('css vars:', await p.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return { fly: JSON.stringify(cs.getPropertyValue('--fly')),
           noteOut: JSON.stringify(cs.getPropertyValue('--note-out')),
           dataTest: document.documentElement.dataset.test ?? '(unset)',
           search: location.search };
}));
// sample the camera while changing step
const samples = await p.evaluate(async () => {
  const g = window.__player.board.groups[0];
  const out = [];
  const t0 = performance.now();
  const id = setInterval(() => out.push([Math.round(performance.now() - t0), +window.__player.camera.z.toFixed(4)]), 40);
  window.__player.goto(g.id, g.steps[2].id);
  await new Promise(r => setTimeout(r, 900));
  clearInterval(id);
  return out;
});
const zs = [...new Set(samples.map(s => s[1]))];
console.log('distinct camera z values during a step change:', zs.length);
console.log('first/last:', samples[0], samples.at(-1));
await b.close();
