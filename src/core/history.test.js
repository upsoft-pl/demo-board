import { describe, it, expect } from 'vitest';
import { createHistory } from './history.js';

const step = (g, s) => ({ kind: 'step', groupId: g, stepId: s });

describe('history', () => {
  it('starts empty and refuses to move', () => {
    const h = createHistory();
    expect(h.current()).toBeNull();
    expect(h.canBack()).toBe(false);
    expect(h.back()).toBeNull();
    expect(h.forward()).toBeNull();
  });

  it('walks back and forward through visited steps', () => {
    const h = createHistory();
    h.push(step('g1', 'a'));
    h.push(step('g1', 'b'));
    h.push(step('g2', 'c'));
    expect(h.back()).toEqual(step('g1', 'b'));
    expect(h.back()).toEqual(step('g1', 'a'));
    expect(h.canBack()).toBe(false);
    expect(h.forward()).toEqual(step('g1', 'b'));
    expect(h.forward()).toEqual(step('g2', 'c'));
    expect(h.canForward()).toBe(false);
  });

  it('collapses consecutive duplicates', () => {
    const h = createHistory();
    h.push(step('g1', 'a'));
    expect(h.push(step('g1', 'a'))).toBe(false);
    expect(h.size()).toBe(1);
  });

  it('keeps a revisit that is not consecutive', () => {
    const h = createHistory();
    h.push(step('g1', 'a'));
    h.push(step('g1', 'b'));
    h.push(step('g1', 'a'));
    expect(h.size()).toBe(3);
  });

  it('truncates the forward branch when you navigate after going back', () => {
    const h = createHistory();
    h.push(step('g1', 'a'));
    h.push(step('g1', 'b'));
    h.push(step('g1', 'c'));
    h.back();
    h.push(step('g2', 'z'));
    expect(h.canForward()).toBe(false);
    expect(h.all().map(e => e.stepId)).toEqual(['a', 'b', 'z']);
  });

  it('distinguishes the same step id in different groups', () => {
    const h = createHistory();
    h.push(step('g1', 'a'));
    expect(h.push(step('g2', 'a'))).toBe(true);
    expect(h.size()).toBe(2);
  });

  it('mixes board and group entries with step entries', () => {
    const h = createHistory();
    h.push(step('g1', 'a'));
    h.push({ kind: 'board' });
    h.push(step('g1', 'a'));
    expect(h.size()).toBe(3);
    expect(h.back()).toEqual({ kind: 'board' });
  });

  it('honours its cap without corrupting the cursor', () => {
    const h = createHistory(5);
    for (let i = 0; i < 20; i++) h.push(step('g', `s${i}`));
    expect(h.size()).toBe(5);
    expect(h.current()).toEqual(step('g', 's19'));
    expect(h.back()).toEqual(step('g', 's18'));
  });

  it('prunes entries whose step no longer exists', () => {
    const h = createHistory();
    h.push(step('g', 'a'));
    h.push(step('g', 'gone'));
    h.push(step('g', 'b'));
    h.prune(e => e.stepId !== 'gone');
    expect(h.all().map(e => e.stepId)).toEqual(['a', 'b']);
    expect(h.current()).toEqual(step('g', 'b'));
  });

  it('collapses duplicates created by pruning', () => {
    const h = createHistory();
    h.push(step('g', 'a'));
    h.push(step('g', 'gone'));
    h.push(step('g', 'a'));
    h.prune(e => e.stepId !== 'gone');
    expect(h.all().map(e => e.stepId)).toEqual(['a']);
  });

  it('lands somewhere valid when the current entry is pruned away', () => {
    const h = createHistory();
    h.push(step('g', 'a'));
    h.push(step('g', 'gone'));
    h.prune(e => e.stepId !== 'gone');
    expect(h.current()).toEqual(step('g', 'a'));
  });

  it('hands out copies, so callers cannot mutate the stack', () => {
    const h = createHistory();
    h.push(step('g', 'a'));
    h.all()[0].stepId = 'hacked';
    expect(h.current().stepId).toBe('a');
  });
});
