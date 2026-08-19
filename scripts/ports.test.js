import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trio, readBase, BASE_PORT } from './ports.js';

describe('trio', () => {
  it('derives dev / e2e / preview as three consecutive ports from a base', () => {
    expect(trio(5173)).toEqual({ dev: 5173, e2e: 5174, preview: 5175 });
  });

  it('shifts the whole block for a worktree base', () => {
    expect(trio(5183)).toEqual({ dev: 5183, e2e: 5184, preview: 5185 });
  });
});

describe('readBase', () => {
  // A real path, so the test is deterministic whether it runs at the repo root
  // or inside a worktree (which really does have its own .worktree.json).
  let dir;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ports-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('falls back to the main-checkout base when no marker file is present', () => {
    expect(readBase(join(dir, 'absent.json'))).toBe(BASE_PORT);
  });

  it('reads the base a worktree marker records', () => {
    const marker = join(dir, '.worktree.json');
    writeFileSync(marker, JSON.stringify({ port: 5183 }));
    expect(readBase(marker)).toBe(5183);
  });
});
