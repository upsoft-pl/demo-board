import './player.css';
import { createPlayer } from './player.js';

const params = new URLSearchParams(location.search);
if (params.has('test')) document.documentElement.dataset.test = '1';

/** A published site has board.json next to index.html. ?board= overrides it. */
const src = params.get('board') || 'board.json';
const baseUrl = src.replace(/[^/]+$/, '');

function fatal(title, detail) {
  const el = document.getElementById('fatal');
  el.innerHTML = `<div><h2>${title}</h2>${detail}</div>`;
  el.classList.add('on');
}

(async () => {
  let doc;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    doc = await res.json();
  } catch (e) {
    // fail loudly and specifically — a silent blank canvas is the worst outcome
    return fatal('Could not load the board', `<p>${src}</p><p>${e.message}</p>`);
  }
  try {
    const player = createPlayer({ mount: document.getElementById('app'), board: doc, baseUrl });
    window.__player = player;                 // e2e handle
    player.start();
  } catch (e) {
    return fatal('This board document is not valid',
      `<p>${e.message}</p><ul>${(e.errors || []).map(x => `<li>${x}</li>`).join('')}</ul>`);
  }
})();
