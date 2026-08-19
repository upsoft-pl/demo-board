// Per-worktree port derivation. One base port fans out into the three servers
// the project runs — dev, the e2e dev server, and the e2e build-preview server
// — so every worktree gets its own non-colliding block and dev/e2e can run in
// parallel across worktrees. The base lives in a gitignored .worktree.json that
// `bin/worktree` writes; the main checkout has no such file and stays on 5173.

import { readFileSync } from 'node:fs';

export const BASE_PORT = 5173;

// dev, e2e, preview as three consecutive ports. Pure — the unit tests pin this.
export function trio(base) {
  return { dev: base, e2e: base + 1, preview: base + 2 };
}

// Base for the current worktree. Resolved relative to this file (not cwd) so it
// is correct however Vite or Playwright happen to be launched. The marker path
// is injectable so the fallback is testable from anywhere — including from
// inside a worktree, which really does have a .worktree.json.
export function readBase(marker = new URL('../.worktree.json', import.meta.url)) {
  try {
    const raw = readFileSync(marker);
    return JSON.parse(raw).port;
  } catch {
    return BASE_PORT; // no .worktree.json → main checkout
  }
}

export function ports() {
  return trio(readBase());
}
