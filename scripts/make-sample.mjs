/**
 * Generates the sample board's screenshots as SVG.
 *
 * These are stand-ins until real PNGs are dropped in — but they are *real image
 * files* referenced by src, loaded through <img>, so the player exercises the
 * same path it will in production. Deterministic, no browser, no binary blobs
 * in the repo.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sample');
mkdirSync(join(OUT, 'images'), { recursive: true });

const W = 1280, H = 800;
const C = {
  chrome: '#EDEFF3', chromeLine: '#DDE1E8', nav: '#101319', navOn: '#1D2431',
  navText: '#8B94A6', doc: '#F7F8FA', card: '#FFFFFF', line: '#E4E8EE',
  ink: '#161B24', mid: '#6E7787', faint: '#9BA4B4', accent: '#4C8DFF',
  crit: '#FEE7E4', critT: '#B5341F', warn: '#FEF2D6', warnT: '#9A6206',
  good: '#DBF6E5', goodT: '#08704A', info: '#E0EBFF', infoT: '#1B54C4',
  mute: '#EEF1F5', muteT: '#79828F', vote: '#EDE7FB', voteT: '#5B32B8',
};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const F = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
const M = 'ui-monospace,SFMono-Regular,Menlo,monospace';

const t = (x, y, s, { size = 13, fill = C.ink, weight = 400, font = F, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const r = (x, y, w, h, { fill = C.card, stroke = null, rx = 0 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`;
const pill = (x, y, label, bg, fg) => {
  const w = label.length * 6.4 + 18;
  return r(x, y, w, 20, { fill: bg, rx: 5 }) + t(x + 9, y + 14, label.toUpperCase(), { size: 9.5, fill: fg, font: M, weight: 600 });
};

const chrome = url =>
  r(0, 0, W, 40, { fill: C.chrome }) +
  `<line x1="0" y1="40" x2="${W}" y2="40" stroke="${C.chromeLine}"/>` +
  ['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => `<circle cx="${20 + i * 19}" cy="20" r="5.5" fill="${c}"/>`).join('') +
  r(84, 9, W - 104, 22, { fill: '#fff', stroke: '#E3E7ED', rx: 6 }) +
  t(96, 24, url, { size: 11.5, fill: '#98A1B0', font: M });

const sidebar = active => {
  const items = [['Inbox', '1,284'], ['Reports', '218'], ['Requests', '96'], ['Sentiment', ''], ['Settings', '']];
  let s = r(0, 40, 206, H - 40, { fill: C.nav });
  s += r(16, 58, 18, 18, { fill: C.accent, rx: 5 }) + t(42, 72, 'Acme', { size: 15, weight: 700, fill: '#fff' });
  items.forEach(([n, c], i) => {
    const y = 100 + i * 34;
    if (n === active) s += r(12, y - 15, 182, 30, { fill: C.navOn, rx: 7 });
    s += r(22, y - 8, 15, 15, { fill: n === active ? C.accent : C.navText, rx: 4 });
    s += t(48, y + 5, n, { size: 13, weight: 500, fill: n === active ? '#fff' : C.navText });
    if (c) s += t(184, y + 4, c, { size: 10.5, fill: C.navText, font: M, anchor: 'end' });
  });
  return s;
};

const doc = (eyebrow, title, sub) =>
  r(206, 40, W - 206, H - 40, { fill: C.doc }) +
  t(236, 76, eyebrow.toUpperCase(), { size: 10.5, fill: C.faint, font: M }) +
  t(236, 106, title, { size: 25, weight: 700 }) +
  t(236, 130, sub, { size: 13.5, fill: C.mid });

const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#fff"/>${body}</svg>`;

/* ── the screens ─────────────────────────────────────────────────────────── */

const rows = (items, y0 = 152) => items.map(([label, meta, tag, bg, fg], i) => {
  const y = y0 + i * 56;
  return r(236, y, W - 272, 46, { fill: C.card, stroke: C.line, rx: 9 }) +
    `<circle cx="264" cy="${y + 23}" r="14" fill="#C3D0E4"/>` +
    t(290, y + 20, label, { size: 13.5, weight: 500 }) +
    t(290, y + 36, meta, { size: 11, fill: C.faint, font: M }) +
    pill(W - 60 - tag.length * 6.4 - 18, y + 13, tag, bg, fg);
}).join('');

const kpis = items => items.map(([n, l], i) => {
  const x = 236 + i * 262;
  return r(x, 152, 246, 76, { fill: C.card, stroke: C.line, rx: 10 }) +
    t(x + 18, 190, n, { size: 29, weight: 700 }) +
    t(x + 18, 212, l.toUpperCase(), { size: 10, fill: C.faint, font: M });
}).join('');

const SCREENS = {
  inbox: svg(chrome('app.acme.io/inbox') + sidebar('Inbox') +
    doc('Unprocessed', 'Inbox', '1,284 reports this week · 0 triaged by a human') +
    rows([
      ['Game crashes when I save', 'discord · nightowl_42 · 6m', 'crash', C.crit, C.critT],
      ['controller keeps drifting left', 'discord · vex · 41m', 'input', C.warn, C.warnT],
      ['love the new map honestly', 'steam · 1h', 'praise', C.good, C.goodT],
      ['crash after saving in ch. 4', 'discord · pixelgrind · 2h', 'crash', C.crit, C.critT],
      ['stick drift again??', 'discord · morrow · 3h', 'input', C.warn, C.warnT],
      ['audio out of sync with my friend', 'discord · kesslr · 4h', 'audio', C.info, C.infoT],
      ['saving = instant crash', 'steam · 5h', 'crash', C.crit, C.critT],
    ])),

  issue: svg(chrome('app.acme.io/reports/218') + sidebar('Reports') +
    doc('Report #218', 'Crash on save', '218 individual reports merged automatically') +
    kpis([['218', 'players hit'], ['41%', 'of sessions'], ['4.2d', 'unresolved']]) +
    r(236, 248, W - 272, 150, { fill: C.card, stroke: C.line, rx: 10 }) +
    t(258, 276, 'Merged from', { size: 13, weight: 600 }) +
    ['Game crashes when I save', 'crash after saving in ch. 4', 'saving = instant crash', 'save → black screen']
      .map((x, i) => pill(258, 292 + i * 26, 'dup', C.mute, C.muteT) + t(300, 306 + i * 26, x, { size: 11.5, fill: C.muteT, font: M })).join('') +
    r(236, 414, W - 272, 116, { fill: C.card, stroke: C.line, rx: 10 }) +
    t(258, 442, 'Reproduction steps · extracted from the reports', { size: 13, weight: 600 }) +
    [94, 76, 52].map((w, i) => r(258, 458 + i * 18, (W - 316) * w / 100, 8, { fill: '#E9EDF3', rx: 4 })).join('')),

  sentiment: svg(chrome('app.acme.io/sentiment') + sidebar('Sentiment') +
    doc('Rolling 12 weeks', 'Player sentiment', 'Derived from report tone, not surveys') +
    r(236, 152, W - 272, 260, { fill: C.card, stroke: C.line, rx: 10 }) +
    [64, 71, 67, 75, 72, 79, 81, 57, 42, 37, 53, 69].map((h, i) => {
      const bw = (W - 320) / 12 - 9, x = 258 + i * ((W - 320) / 12);
      const hh = h * 1.9;
      return r(x, 380 - hh, bw, hh, { fill: (i === 8 || i === 9) ? '#D6412A' : '#3567D6', rx: 4 }) +
        t(x + bw / 2, 398, `w${i + 1}`, { size: 9.5, fill: '#A8B0BE', font: M, anchor: 'middle' });
    }).join('') +
    r(236, 428, W - 272, 56, { fill: C.card, stroke: C.line, rx: 9 }) +
    pill(258, 446, '−34%', C.crit, C.critT) +
    t(330, 452, 'Weeks 9–10 collapse', { size: 13.5, weight: 500 }) +
    t(330, 470, 'onset matches first "crash on save" report', { size: 11, fill: C.faint, font: M })),

  requests: svg(chrome('app.acme.io/requests') + sidebar('Requests') +
    doc('Open · sorted by reach', 'Requests', '96 open · deduplicated from 1,410 messages') +
    [[340, 'Ultrawide monitor support', 'planned'], [212, 'Rebindable controls', 'planned'],
     [188, 'Colourblind palette', 'under review'], [143, 'Offline co-op', ''],
     [97, 'Steam Deck preset', ''], [64, 'Photo mode', '']]
      .map(([v, label, st], i) => {
        const y = 152 + i * 62;
        return r(236, y, W - 272, 52, { fill: C.card, stroke: C.line, rx: 9 }) +
          r(252, y + 6, 46, 40, { fill: i === 0 ? '#F7F3FF' : '#fff', stroke: i === 0 ? '#8B5CF6' : '#DDE3EC', rx: 9 }) +
          t(275, y + 26, String(v), { size: 15, weight: 700, anchor: 'middle', fill: i === 0 ? C.voteT : C.ink }) +
          t(275, y + 38, 'VOTES', { size: 8, fill: C.faint, font: M, anchor: 'middle' }) +
          t(312, y + 31, label, { size: 13.5, weight: 500 }) +
          (st ? pill(W - 60 - st.length * 6.4 - 18, y + 16, st, st === 'planned' ? C.good : C.info, st === 'planned' ? C.goodT : C.infoT) : '');
      }).join('')),

  request: svg(chrome('app.acme.io/requests/41') + sidebar('Requests') +
    doc('Request #41', 'Ultrawide monitor support', '340 votes · merged from 27 differently-worded asks') +
    kpis([['340', 'asked'], ['61%', 'are paying'], ['2.4×', 'avg playtime']]) +
    r(236, 248, W - 272, 150, { fill: C.card, stroke: C.line, rx: 10 }) +
    t(258, 276, 'Merged phrasings', { size: 13, weight: 600 }) +
    ['21:9 support please', 'game is stretched on my ultrawide', 'black bars on 3440x1440', 'widescreen fov option']
      .map((x, i) => pill(258, 292 + i * 26, 'same', C.mute, C.muteT) + t(306, 306 + i * 26, x, { size: 11.5, fill: C.muteT, font: M })).join('') +
    r(236, 414, W - 272, 56, { fill: C.card, stroke: C.line, rx: 9 }) +
    pill(258, 432, 'segment', C.vote, C.voteT) +
    t(340, 438, 'Skews heavily to 40h+ players', { size: 13.5, weight: 500 }) +
    t(340, 456, 'the people least likely to churn quietly', { size: 11, fill: C.faint, font: M })),

  discord: svg((() => {
    let s = r(0, 0, W, H, { fill: '#313338' }) + r(0, 0, 200, H, { fill: '#2B2D31' });
    s += t(20, 34, '◆ Acme Playtest', { size: 13, weight: 600, fill: '#F2F3F5' });
    ['general', 'bugs', 'feedback', 'patch-notes'].forEach((c, i) => {
      const y = 62 + i * 30;
      if (c === 'bugs') s += r(10, y - 15, 180, 28, { fill: '#404249', rx: 5 });
      s += t(22, y + 4, `# ${c}`, { size: 13.5, fill: c === 'bugs' ? '#fff' : '#949BA4' });
    });
    const msg = (y, name, time, text, colour) =>
      `<circle cx="238" cy="${y}" r="17" fill="${colour}"/>` +
      t(268, y - 4, name, { size: 13.5, weight: 600, fill: '#F2F3F5' }) +
      (time ? t(268 + name.length * 8 + 12, y - 4, time, { size: 10, fill: '#7B828E', font: M }) : '') +
      t(268, y + 16, text, { size: 13.5, fill: '#DBDEE1' });
    s += msg(80, 'nightowl_42', '2:14 PM', 'game crashes every single time i save in chapter 4', '#8E2B44');
    s += msg(160, 'Acme', 'BOT', 'Logged, thanks.', '#188C51');
    s += r(268, 186, 440, 74, { fill: '#2B2D31', rx: 5 }) + r(268, 186, 3, 74, { fill: '#23A55A' });
    s += t(286, 210, '#218 · Crash on save', { size: 13, weight: 600, fill: '#fff' });
    s += t(286, 232, 'Matched to 217 existing reports', { size: 12.5, fill: '#3BC77A' });
    s += t(286, 250, "you'll be pinged when it ships", { size: 12.5, fill: '#B5BAC1' });
    s += msg(310, 'pixelgrind', '2:16 PM', 'same, thought it was just me', '#4B2E9E');
    return s;
  })()),

  branding: svg(chrome('app.acme.io/settings/branding') + sidebar('Settings') +
    doc('Appearance', 'Branding', 'Players should never see our name') +
    r(236, 152, W - 272, 150, { fill: C.card, stroke: C.line, rx: 10 }) +
    t(258, 180, 'Accent colour', { size: 13, weight: 600 }) +
    ['#8B5CF6', '#E9A23B', '#4FC1A0', '#F0596A', '#4C8DFF'].map((c, i) =>
      r(258 + i * 50, 196, 38, 38, { fill: c, rx: 9 }) +
      (i === 0 ? `<rect x="255" y="193" width="44" height="44" rx="11" fill="none" stroke="#8B5CF6" stroke-width="2"/>` : '')).join('') +
    t(258, 260, 'LOGO', { size: 10, fill: C.faint, font: M }) +
    r(258, 268, 300, 26, { fill: '#fff', stroke: '#DDE3EC', rx: 8 }) +
    t(270, 286, 'studio-mark.svg · 240×64', { size: 12, fill: '#3D4657' }) +
    r(236, 318, W - 272, 140, { fill: C.card, stroke: C.line, rx: 10 }) +
    t(258, 346, 'Custom domain', { size: 13, weight: 600 }) +
    t(258, 372, 'PORTAL ADDRESS', { size: 10, fill: C.faint, font: M }) +
    r(258, 380, 340, 30, { fill: '#fff', stroke: '#DDE3EC', rx: 8 }) +
    t(270, 400, 'feedback.yourstudio.com', { size: 13, fill: '#3D4657' }) +
    pill(258, 424, 'verified', C.good, C.goodT) +
    t(340, 438, 'SSL issued · 2h ago', { size: 11, fill: C.faint, font: M })),
};

for (const [name, content] of Object.entries(SCREENS)) {
  writeFileSync(join(OUT, 'images', `${name}.svg`), content);
}

/* ── the board document ──────────────────────────────────────────────────── */

const img = n => ({ src: `images/${n}.svg`, w: W, h: H });

const board = {
  version: 1,
  id: 'b_sample',
  title: 'Acme — client demo',
  groups: [
    {
      id: 'g_bugs', title: 'Bug Reports', color: '#E9A23B',
      blurb: 'raw reports → one ranked issue → the fix lands',
      layout: 'auto', autoLayout: { columns: 3, gap: 260 }, origin: { x: 0, y: 0 },
      screens: [
        { id: 's_inbox', name: 'The pile', ...img('inbox'), keywords: ['intake', 'triage', 'volume'],
          body: 'Inbox 1284 reports this week 0 triaged Game crashes when I save controller keeps drifting left audio out of sync' },
        { id: 's_issue', name: 'One issue', ...img('issue'), keywords: ['dedup', 'crash', 'priorities'],
          related: ['s_inbox'],
          body: 'Report 218 Crash on save 218 players hit 41% of sessions merged reproduction steps' },
        { id: 's_sent', name: 'The damage', ...img('sentiment'), keywords: ['sentiment', 'trend', 'analytics'],
          body: 'Player sentiment rolling 12 weeks weeks 9 10 collapse onset matches first crash on save report' },
      ],
      steps: [
        { id: 'st_input', screen: 's_inbox', kicker: 'the input', gutter: 'right',
          caption: 'It starts as noise.',
          notes: [{ id: 'n_pile', text: "1,284 reports. Today this is somebody's **entire job**, and they still miss things.",
                    rect: { x: 0.18, y: 0.145, w: 0.42, h: 0.035 } }] },
        { id: 'st_work', screen: 's_issue', kicker: 'the work', gutter: 'right',
          caption: '218 of those were the same bug.',
          notes: [
            { id: 'n_one', text: 'One issue, not 218 tickets. The merge happens at intake.',
              rect: { x: 0.18, y: 0.105, w: 0.28, h: 0.045 } },
            { id: 'n_kpi', text: "Now it's a number you can **prioritise against** — reach, not volume.",
              rect: { x: 0.18, y: 0.185, w: 0.60, h: 0.098 } },
            { id: 'n_repro', text: 'Repro steps assembled from what players actually wrote.',
              rect: { x: 0.18, y: 0.515, w: 0.60, h: 0.148 } },
          ] },
        { id: 'st_stakes', screen: 's_sent', kicker: 'the stakes', gutter: 'left',
          caption: 'And you can see what it cost you.',
          notes: [{ id: 'n_dip', text: 'The dip **is** the bug. Weeks before it reaches your reviews.',
                    rect: { x: 0.18, y: 0.185, w: 0.62, h: 0.335 } }] },
        { id: 'st_map', screen: null, kicker: 'the map', gutter: 'right',
          caption: 'Everything behind that email fits on one page.', notes: [] },
        // Deliberate reuse: the same screenshot as st_input, different commentary.
        // The camera does not move, so this reads as a reveal rather than a jump.
        { id: 'st_back', screen: 's_inbox', kicker: 'back where we started', gutter: 'right',
          caption: 'Same inbox. Nothing left for anyone to triage.',
          notes: [{ id: 'n_back', text: 'Every one of these is now attached to a ranked issue — **automatically**.',
                    rect: { x: 0.18, y: 0.145, w: 0.42, h: 0.035 } }] },
      ],
    },
    {
      id: 'g_requests', title: 'Feature Requests', color: '#4FC1A0',
      blurb: 'what players ask for, ranked by who actually plays',
      layout: 'auto', autoLayout: { columns: 2, gap: 260 }, origin: { x: 5200, y: 0 },
      screens: [
        { id: 's_wish', name: 'The wishlist', ...img('requests'), keywords: ['requests', 'votes', 'backlog'],
          body: 'Requests 96 open deduplicated from 1410 messages Ultrawide monitor support 340 votes rebindable controls colourblind palette' },
        { id: 's_req', name: '340 voices, one ask', ...img('request'), keywords: ['requests', 'votes', 'segments'],
          related: ['s_wish'],
          body: 'Request 41 Ultrawide monitor support 340 votes merged from 27 differently worded asks 61% are paying' },
      ],
      steps: [
        { id: 'st_wish', screen: 's_wish', kicker: 'the wishlist', gutter: 'right',
          caption: 'Players ask for a thousand things. These are the ones that matter.',
          notes: [{ id: 'n_dedup', text: '96 requests, from 1,410 messages. **The dedup is the product.**',
                    rect: { x: 0.18, y: 0.145, w: 0.44, h: 0.035 } }] },
        { id: 'st_one', screen: 's_req', kicker: 'one request', gutter: 'right',
          caption: 'Twenty-seven ways of asking the same thing.',
          notes: [
            { id: 'n_ask', text: 'Nobody typed the same words. It is still one request.',
              rect: { x: 0.18, y: 0.105, w: 0.40, h: 0.045 } },
            { id: 'n_who', text: 'Ranked by **who** asked, not how loudly. 61% of them pay you.',
              rect: { x: 0.18, y: 0.185, w: 0.60, h: 0.098 } },
          ] },
      ],
    },
    {
      id: 'g_discord', title: 'Discord Integration', color: '#7C8CF8',
      blurb: 'intake where the players already are',
      layout: 'manual', origin: { x: 0, y: 2400 },
      screens: [
        { id: 's_chat', name: 'In the channel', ...img('discord'), pos: { x: 0, y: 0 },
          keywords: ['discord', 'intake', 'dedup', 'bot'],
          body: 'Acme Playtest general bugs feedback patch-notes game crashes every single time i save matched to 217 existing reports' },
      ],
      steps: [
        { id: 'st_chat', screen: 's_chat', kicker: 'where they already are', gutter: 'right',
          caption: 'Your players never left Discord.',
          notes: [{ id: 'n_door', text: 'Dedup happens at the door. No form, no portal, no account to create.',
                    rect: { x: 0.20, y: 0.225, w: 0.36, h: 0.10 } }] },
      ],
    },
    {
      id: 'g_custom', title: 'Customization', color: '#B183E8',
      blurb: 'your brand on it, embedded wherever you want',
      layout: 'auto', origin: { x: 5200, y: 2400 },
      screens: [
        { id: 's_brand', name: 'Your brand', ...img('branding'), keywords: ['branding', 'theme', 'domain'],
          body: 'Appearance Branding players should never see our name accent colour logo custom domain feedback.yourstudio.com SSL issued' },
      ],
      steps: [
        { id: 'st_brand', screen: 's_brand', kicker: 'your brand', gutter: 'right',
          caption: 'Players should never see our name.',
          notes: [
            { id: 'n_accent', text: 'Accent, logo, typography. It reads as **your** studio.',
              rect: { x: 0.18, y: 0.185, w: 0.60, h: 0.19 } },
            { id: 'n_domain', text: 'On your own domain, with your own certificate.',
              rect: { x: 0.18, y: 0.395, w: 0.60, h: 0.175 } },
          ] },
      ],
    },
  ],
};

writeFileSync(join(OUT, 'board.json'), JSON.stringify(board, null, 2));
console.log(`wrote ${Object.keys(SCREENS).length} screens + board.json to public/sample/`);
