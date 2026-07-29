/**
 * Visit-order history — deliberately separate from story order.
 *
 * The board has two axes: the authored flow (←/→ inside a group) and where you
 * have actually been (⌘[ / ⌘]). A browser only has the second; conflating them
 * is what made the earlier prototype unable to return from a ⌘K excursion.
 *
 * Entries address steps by id, never by index, so reordering steps in the
 * editor cannot silently repoint history at the wrong slide.
 */

/** @typedef {{kind:'step', groupId:string, stepId:string}|{kind:'board'}|{kind:'group', groupId:string}} Entry */

const key = e =>
  e.kind === 'step' ? `s:${e.groupId}:${e.stepId}`
  : e.kind === 'group' ? `g:${e.groupId}`
  : 'board';

export function createHistory(limit = 200) {
  /** @type {Entry[]} */
  let entries = [];
  let i = -1;

  return {
    /** Push a destination. Consecutive duplicates collapse. Branching truncates. */
    push(entry) {
      const cur = entries[i];
      if (cur && key(cur) === key(entry)) return false;
      entries = entries.slice(0, i + 1);
      entries.push(entry);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      i = entries.length - 1;
      return true;
    },
    back() { if (i <= 0) return null; i--; return entries[i]; },
    forward() { if (i >= entries.length - 1) return null; i++; return entries[i]; },
    canBack() { return i > 0; },
    canForward() { return i < entries.length - 1; },
    current() { return entries[i] ?? null; },
    size() { return entries.length; },
    index() { return i; },
    all() { return entries.map(e => ({ ...e })); },
    /**
     * Drop entries that no longer resolve — after an edit deletes a step, or
     * after loading a different board. Keeps the cursor on the nearest survivor.
     */
    prune(isValid) {
      const before = entries[i];
      const kept = entries.filter(e => e.kind !== 'step' || isValid(e));
      const dedup = kept.filter((e, j) => j === 0 || key(e) !== key(kept[j - 1]));
      entries = dedup;
      const found = before ? dedup.findIndex(e => key(e) === key(before)) : -1;
      i = found >= 0 ? found : dedup.length - 1;
      return entries.length;
    },
    reset() { entries = []; i = -1; },
  };
}
