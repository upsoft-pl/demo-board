import { describe, it, expect } from 'vitest';
import { buildCorpus, searchBoard, relatedScreens, CUTOFF } from './search.js';

/**
 * The chrome in `body` is the point: every screenshot of an app repeats its
 * sidebar. This fixture reproduces the failure measured on the prototype, where
 * "sentiment" matched all six screens because the word sits in every sidebar.
 */
const CHROME = 'Inbox 1284 Reports 218 Requests 96 Sentiment Settings';
const board = {
  version: 1, id: 'b', title: 'T',
  groups: [
    {
      id: 'g_bugs', title: 'Bug Reports', blurb: 'raw reports to one ranked issue', color: '#E9A23B',
      screens: [
        { id: 's_inbox', name: 'The pile', keywords: ['intake', 'triage'], src: 'a.png', w: 1, h: 1,
          body: `${CHROME} Game crashes when I save controller keeps drifting left` },
        { id: 's_one', name: 'One issue', keywords: ['dedup', 'crash'], src: 'b.png', w: 1, h: 1,
          related: ['s_inbox'], body: `${CHROME} Crash on save 218 players hit` },
        { id: 's_sent', name: 'The damage', keywords: ['sentiment', 'trend'], src: 'c.png', w: 1, h: 1,
          body: `${CHROME} Player sentiment rolling 12 weeks` },
      ],
      steps: [
        { id: 't1', screen: 's_inbox', kicker: 'the input', caption: 'It starts as noise.', notes: [] },
        { id: 't2', screen: 's_one', kicker: 'the work', caption: '218 were the same bug.',
          notes: [{ id: 'n1', text: 'One issue, not 218 <b>tickets</b>.', rect: {} }] },
        { id: 't3', screen: 's_sent', kicker: 'the stakes', caption: 'What it cost you.', notes: [] },
      ],
    },
    {
      id: 'g_disc', title: 'Discord Integration', blurb: 'intake where the players already are',
      color: '#7C8CF8',
      screens: [
        { id: 's_chat', name: 'In the channel', keywords: ['discord', 'intake'], src: 'd.png', w: 1, h: 1,
          body: 'Acme Playtest bugs feedback game crashes every time i save' },
      ],
      steps: [{ id: 't4', screen: 's_chat', kicker: 'where they are', caption: 'Never left Discord.', notes: [] }],
    },
  ],
};
const corpus = buildCorpus(board);
const names = r => r.screens.map(s => s.id);

describe('buildCorpus', () => {
  it('indexes every screen and group', () => {
    expect(corpus.screens).toHaveLength(4);
    expect(corpus.groups).toHaveLength(2);
  });
  it('strips markup out of note text, keeping the words inside it', () => {
    const rec = corpus.screens.find(s => s.id === 's_one');
    expect(rec.notes).toContain('tickets');   // the emphasised word is searchable
    expect(rec.notes).not.toMatch(/<\/?b>/);  // the tag that emphasised it is not
    expect(names(searchBoard(corpus, 'tickets'))).toEqual(['s_one']);
  });
});

describe('searchBoard', () => {
  it('returns nothing for an empty query', () => {
    expect(searchBoard(corpus, '')).toEqual({ groups: [], screens: [] });
    expect(searchBoard(corpus, '   ')).toEqual({ groups: [], screens: [] });
  });

  it('matches a group by title and by blurb', () => {
    expect(searchBoard(corpus, 'discord').groups.map(g => g.id)).toContain('g_disc');
    expect(searchBoard(corpus, 'ranked').groups.map(g => g.id)).toContain('g_bugs');
  });

  it('ranks a keyword hit above a body-text hit', () => {
    const r = searchBoard(corpus, 'sentiment');
    expect(r.screens[0].id).toBe('s_sent');
  });

  it('suppresses matches that come only from repeated app chrome', () => {
    // "sentiment" is in every sidebar; only the real screen should survive
    expect(names(searchBoard(corpus, 'sentiment'))).toEqual(['s_sent']);
    expect(names(searchBoard(corpus, '218')).length).toBeLessThan(corpus.screens.length);
  });

  it('requires every term to land somewhere', () => {
    expect(names(searchBoard(corpus, 'crash zzzznope'))).toEqual([]);
  });

  it('finds words that only appear inside the screenshot body', () => {
    expect(names(searchBoard(corpus, 'drifting'))).toContain('s_inbox');
  });

  it('returns a highlighted snippet for a body hit', () => {
    const r = searchBoard(corpus, 'drifting');
    expect(r.screens[0].why).toMatch(/<mark>drifting<\/mark>/);
  });

  it('is case insensitive', () => {
    expect(names(searchBoard(corpus, 'DISCORD'))).toEqual(names(searchBoard(corpus, 'discord')));
  });

  it('caps results and applies the relevance cutoff', () => {
    const r = searchBoard(corpus, 'crash');
    const top = r.screens[0].score;
    for (const s of r.screens) expect(s.score).toBeGreaterThanOrEqual(top * CUTOFF);
  });

  it('escapes regex metacharacters in the query', () => {
    expect(() => searchBoard(corpus, 'a(b')).not.toThrow();
  });

  it('finds nothing for gibberish', () => {
    expect(searchBoard(corpus, 'qqxzzy')).toEqual({ groups: [], screens: [] });
  });
});

describe('relatedScreens', () => {
  it('prefers same-group screens', () => {
    const r = relatedScreens(board, 's_inbox');
    expect(r[0].groupId).toBe('g_bugs');
  });

  it('explains why each result is related', () => {
    for (const r of relatedScreens(board, 's_one')) expect(r.why).toBeTruthy();
  });

  it('scores shared keywords', () => {
    const r = relatedScreens(board, 's_chat');
    const inbox = r.find(x => x.id === 's_inbox');
    expect(inbox.why).toMatch(/shares intake/);
  });

  it('honours an explicit related link', () => {
    const r = relatedScreens(board, 's_inbox');
    expect(r.find(x => x.id === 's_one')).toBeTruthy();
  });

  it('never returns the screen you are standing on', () => {
    expect(relatedScreens(board, 's_inbox').map(r => r.id)).not.toContain('s_inbox');
  });

  it('returns nothing for an unknown screen', () => {
    expect(relatedScreens(board, 'nope')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(relatedScreens(board, 's_inbox', 1)).toHaveLength(1);
  });
});
