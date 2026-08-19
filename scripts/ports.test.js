import { describe, it, expect } from 'vitest';
import { trio, ports } from './ports.js';

describe('trio', () => {
  it('derives dev / e2e / preview as three consecutive ports from a base', () => {
    expect(trio(5173)).toEqual({ dev: 5173, e2e: 5174, preview: 5175 });
  });

  it('shifts the whole block for a worktree base', () => {
    expect(trio(5183)).toEqual({ dev: 5183, e2e: 5184, preview: 5185 });
  });
});

describe('ports', () => {
  it('defaults to the main-checkout trio when no .worktree.json is present', () => {
    // The repo root has no .worktree.json, so this exercises the fallback.
    expect(ports()).toEqual({ dev: 5173, e2e: 5174, preview: 5175 });
  });
});
