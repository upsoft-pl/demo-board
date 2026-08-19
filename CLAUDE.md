# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An outcome-first demo tool: annotated screenshots on a zoomable canvas. `index.html`
is the **editor** (build boards); `player.html` is the view-only **player**
(`?board=<url>` selects the document). Publishing a board renames `player.html` to
`index.html` and drops it next to `board.json` + `images/` on any static host.

The README is the design document — read it for the document format and the
product rationale. This file covers what the README does not: how the code is
laid out and the invariants a change must not break.

## Commands

```bash
npm run dev          # editor at http://localhost:5173 (Playwright uses :5174/:5175)
npm test             # Vitest, pure logic, sub-second — the TDD loop
npm run test:watch   # Vitest in watch mode
npm run test:e2e     # Playwright, geometry in a real browser
npm run test:all     # both tiers
npm run build        # Vite → dist/ (two entries: index + player)
npm run sample       # regenerate public/sample/ (deterministic SVG screenshots)
```

Run a single unit test file: `npx vitest run src/core/layout.test.js`
Run one unit test by name: `npx vitest run -t "reserves a gutter"`
Run one e2e spec: `npx playwright test tests/e2e/board.spec.js`

## Architecture

The load-bearing split is **pure core vs. dumb DOM**:

```
src/core/     layout · schema · edit · history · search · store · bundle   (no DOM, node-tested)
src/player/   the viewer — reads rects from core, writes styles
src/editor/   library, canvas, inspector, annotate, preview
```

Everything with interesting logic lives in `src/core` and is tested in node. The
DOM layers (`player.js`, `editor.js`) only read geometry and write styles — keep
new logic in core so it stays testable in milliseconds.

Core modules:
- `schema.js` — validate / normalize / migrate / import a board document, plus
  the id-safe lookups (`resolveStep`, `reconcileRef`, `findGroup`).
- `edit.js` — every editor mutation as a pure `board → board` function. Nothing
  mutates its input; undo is just keeping the previous document.
- `layout.js` — camera maths and note placement. `safeBox()` reserves the gutter
  that makes it geometrically impossible for a note to cover the screenshot.
- `history.js` — visit-order history (⌘[ / ⌘]), deliberately separate from the
  authored story order (←/→).
- `search.js` — the ⌘K index, with a relevance cutoff that drops keywords bleeding
  from repeated app chrome.
- `store.js` — the board library over a tiny FS interface (OPFS in-browser,
  in-memory in tests). Treat it as an evictable cache, not a vault.
- `bundle.js` — zip in / zip out / static-site publish, via `fflate`.

Editor data flow: all document changes go through `core/edit.js`, and every
mutation in `editor.js` goes through a single `commit()` that gives undo and
autosave for free. The editor reuses the player (`createPlayer`) to render its
preview.

## Invariants — do not break these

- **Never address a step or group by array index.** Steps get reordered and
  indices rot silently. History, stored refs, and search all use `{groupId,
  stepId}`. `schema.test.js` shuffles `steps[]` and asserts every reference still
  resolves. Use `resolveStep` / `reconcileRef` / `findGroup`.
- **Note rects are normalised 0–1**, never pixels — re-exporting a screenshot at
  another resolution must not move annotations.
- **Notes can never overlap the screenshot.** Both test tiers assert 0 px² of
  overlap in every step of every group; the camera frames *from* `safeBox()`.
- **Every `edit.js` mutation must leave the board passing `validateBoard()`.**
- **Cropping changes a screen's size** — layout must call `effectiveSize()` /
  `cropOf()`, never read `w`/`h` directly.

## Testing — the two tiers are not stylistic

- **Vitest** runs in **node, not jsdom, on purpose**: jsdom has no layout engine,
  so `getBoundingClientRect` returns zeros and any geometry assertion there is a
  lie. This tier is pure arithmetic and stays sub-second.
- **Playwright** owns anything geometric, in a fixed 1440×900 viewport (every
  geometric assertion is in those coordinates).
- The Playwright suite has a separate **`build` project** (`build.spec.js`) that
  smoke-tests the production build, because it behaves differently from dev: the
  CSS minifier rewrites units (e.g. `1050ms` → `1.05s`), assets are hashed. A
  production-only bug once disabled every animation while the dev suite stayed
  green — hence the dedicated build pass. See `parseMs` in `player.js`.
- e2e runs against the in-memory store via `?memory=1` (and `?test=1`) so tests
  never inherit a previous run's OPFS.

## Conventions

- ES modules, `"type": "module"`, no framework — plain DOM. Vite is the only build
  step; `fflate` is the sole runtime dependency.
- Vite `base: './'` (relative) so the same build works on GitHub Pages, S3, and
  `vite preview`.
- Follow the existing style: pure functions in core, terse module-top doc
  comments that explain *why* a non-obvious decision was made.
