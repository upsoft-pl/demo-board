/**
 * ⌘K index: search across groups and screens, plus "what's related to here".
 *
 * The one non-obvious rule is the relevance cutoff. Real screenshots repeat
 * their app chrome — the same sidebar, the same nav badges, on every single
 * image. Any keyword drawn from that chrome therefore matches everything.
 * Measured on the prototype: "sentiment" and "218" each matched all six
 * screens. Weak body-text hits are dropped relative to the best match.
 */

export const CUTOFF = 0.45;
export const MAX_RESULTS = 6;

const WEIGHT = { keyword: 6, name: 5, group: 4, caption: 3, note: 2, body: 1 };

const strip = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\*\*/g, '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Flatten a board into searchable records.
 * `body` is optional OCR / authored transcript of what's visible in the image.
 */
export function buildCorpus(board) {
  const screens = [];
  for (const g of board.groups) {
    for (const s of g.screens) {
      const steps = g.steps.filter(st => st.screen === s.id);
      screens.push({
        id: s.id,
        groupId: g.id,
        name: s.name || '',
        group: g.title || '',
        keywords: (s.keywords || []).map(k => k.toLowerCase()),
        caption: steps.map(st => `${st.caption ?? ''} ${st.kicker ?? ''}`).map(strip).join(' '),
        notes: steps.flatMap(st => (st.notes || []).map(n => strip(n.text))).join(' '),
        body: strip(s.body || ''),
      });
    }
  }
  const groups = board.groups.map(g => ({
    id: g.id, title: g.title || '', blurb: g.blurb || '',
    screens: g.screens.length, steps: g.steps.length, color: g.color,
  }));
  return { groups, screens };
}

function scoreScreen(rec, terms) {
  let total = 0;
  let snippet = '';
  for (const t of terms) {
    let s = 0;
    if (rec.keywords.some(k => k.includes(t))) s += WEIGHT.keyword;
    if (rec.name.toLowerCase().includes(t)) s += WEIGHT.name;
    if (rec.group.toLowerCase().includes(t)) s += WEIGHT.group;
    if (rec.caption.toLowerCase().includes(t)) s += WEIGHT.caption;
    if (rec.notes.toLowerCase().includes(t)) s += WEIGHT.note;
    const bi = rec.body.toLowerCase().indexOf(t);
    if (bi >= 0) {
      s += WEIGHT.body;
      if (!snippet) snippet = rec.body.slice(Math.max(0, bi - 32), bi + 58);
    }
    if (!s) return null;                       // every term must land somewhere
    total += s;
  }
  return { score: total, snippet };
}

export function searchBoard(corpus, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { groups: [], screens: [] };

  const groups = corpus.groups.map(g => {
    let total = 0;
    for (const t of terms) {
      let s = 0;
      if (g.title.toLowerCase().includes(t)) s += 8;
      if (g.blurb.toLowerCase().includes(t)) s += 3;
      if (!s) return null;
      total += s;
    }
    return { kind: 'group', id: g.id, score: total, why: g.blurb };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  const scored = corpus.screens.map(rec => {
    const r = scoreScreen(rec, terms);
    if (!r) return null;
    return {
      kind: 'screen', id: rec.id, groupId: rec.groupId, score: r.score,
      why: r.snippet ? highlight(r.snippet, terms) : rec.caption.trim(),
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  const screens = scored.length
    ? scored.filter(r => r.score >= scored[0].score * CUTOFF).slice(0, MAX_RESULTS)
    : [];

  return { groups, screens };
}

export function highlight(text, terms) {
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map(esc).join('|')})`, 'ig');
  return `…${text.replace(re, '<mark>$1</mark>')}…`;
}

/**
 * Empty-query view: what would I plausibly jump to from here?
 * Shared keywords, explicit links, same group, and adjacency in the flow.
 */
export function relatedScreens(board, screenId, limit = 5) {
  let me = null, myGroup = null;
  for (const g of board.groups) {
    const s = g.screens.find(x => x.id === screenId);
    if (s) { me = s; myGroup = g; break; }
  }
  if (!me) return [];

  const mine = new Set((me.keywords || []).map(k => k.toLowerCase()));
  const myStep = myGroup.steps.findIndex(st => st.screen === screenId);

  const out = [];
  for (const g of board.groups) {
    for (const s of g.screens) {
      if (s.id === screenId) continue;
      let score = 0;
      const why = [];

      const shared = (s.keywords || []).filter(k => mine.has(k.toLowerCase()));
      if (shared.length) { score += shared.length * 3; why.push(`shares ${shared.join(', ')}`); }

      if ((me.related || []).includes(s.id)) { score += 5; if (!why.length) why.push('linked'); }
      if ((s.related || []).includes(screenId)) score += 3;

      if (g.id === myGroup.id) {
        score += 4;
        const theirStep = g.steps.findIndex(st => st.screen === s.id);
        if (myStep >= 0 && theirStep >= 0 && Math.abs(myStep - theirStep) === 1) {
          score += 2;
          why.push('next in this flow');
        }
      }
      if (score > 0) {
        out.push({ kind: 'screen', id: s.id, groupId: g.id, score, why: why.join(' · ') || 'same group' });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
