# Demo Board

Annotated screenshots on a zoomable canvas, for outcome-first product demos:
open on the result, then show what produced it.

```bash
npm install
npm run dev          # editor at http://localhost:5173
npm test             # 157 unit tests, ~0.7s
npm run test:e2e     # 27 browser tests
npm run build
```

## Two entry points

| | |
|---|---|
| `index.html` | the **editor** — board library, groups, screenshots, annotations |
| `player.html` | the **player** — view only. `?board=<url>` picks the document |

A published board is `player.html` renamed to `index.html`, sitting next to its
`board.json` and `images/`. Upload that folder to any static host.

## Document format

```jsonc
{ "version": 1, "id": "b_…", "title": "Client demo",
  "groups": [{
    "id": "g_bugs", "title": "Bug Reports", "color": "#E9A23B",
    "blurb": "shown in ⌘K",
    "layout": "auto",                    // "auto" | "manual"
    "origin": { "x": 0, "y": 0 },
    "screens": [{
      "id": "s_inbox", "name": "The pile",
      "src": "images/inbox.png", "w": 2560, "h": 1600,   // intrinsic px
      "keywords": ["intake", "triage"],
      "pos": { "x": 0, "y": 0 },         // read only when layout = "manual"
      "scale": 1                         // optional display size, 0.25–4; absent = 1×
    }],
    "steps": [{
      "id": "st_input", "screen": "s_inbox",   // null = group overview step
      "kicker": "the input", "caption": "It starts as noise.",
      "gutter": "right",                        // margin the camera reserves
      "notes": [{ "id": "n_1", "text": "1,284 reports.",
                  "rect": { "x": 0.06, "y": 0.18, "w": 0.42, "h": 0.05 } }]
    }]
  }]}
```

Two rules the whole thing rests on:

- **Note rects are normalised 0–1**, so re-exporting a screenshot at another
  resolution does not move the annotations.
- **Nothing addresses a step or group by array index.** Steps get reordered;
  indices rot silently. History, the step widget and every stored reference use
  `{groupId, stepId}`. There is a test that shuffles `steps[]` and asserts every
  reference still resolves.

Note array order is simultaneously the gutter stacking order and the reveal
order, so reordering notes is one operation.

## Why notes can never cover the screenshot

Annotations are margin placards in a reserved gutter, joined to their target by
a leader line. The camera computes its framing **from** that gutter
(`safeBox()`), so a note has nowhere to go except beside the image. Both test
tiers assert `0 px²` of overlap in every step of every group.

## Storage

Boards live in **OPFS** — origin-private browser storage. That is convenient and
**evictable**: the browser may reclaim it under disk pressure and "clear
browsing data" wipes it. The app requests `navigator.storage.persist()`, shows
whether it was granted, and tracks `lastExportedAt` per board so the library can
nag. Treat the browser as a cache and the zip as the artefact.

`?memory=1` swaps in an in-memory adapter (used by the e2e suite).

## Layout

```
src/core/     layout · schema · edit · history · search · store · bundle   (pure, no DOM)
src/player/   the viewer
src/editor/   library, canvas, inspector, annotate, preview
public/sample/  a generated sample board — `npm run sample` rebuilds it
reference/    the original single-file mockup this grew out of
```

Everything with interesting logic lives in `src/core` and is tested in node.
The DOM layers read rects and write styles.

## Testing

Two tiers, deliberately:

- **Vitest** (`npm test`) — pure logic, sub-second, the TDD loop.
- **Playwright** (`npm run test:e2e`) — anything geometric.

The split is not stylistic. jsdom has no layout engine — `getBoundingClientRect`
returns zeros — so every "does this overlap that" assertion is meaningless
outside a real browser.

`?test=1` collapses animations so tests never race a camera fly. It uses
`transition: none`, **not** `transition-duration: 1ms`: `transition-property`
defaults to `all`, and a duration alone gives the world container a transform
transition, which makes `getBoundingClientRect()` return the pre-transition box.
That bug positioned every annotation against the previous step's camera.

The e2e suite runs two projects. `dev` covers behaviour against the dev server;
`build` is a short smoke pass against `vite preview` of a real production build.
The second exists because the CSS minifier rewrites `--fly: 1050ms` as `1.05s`,
`parseFloat` read that as `1.05`, the player took it for "1ms — skip the
animation", and every camera fly on the deployed site was instant while the
whole dev suite stayed green. Durations now go through `parseCssTime`.

## Deployment

`.github/workflows/pages.yml` runs both tiers and only deploys to GitHub Pages
if they pass.

One caveat: OPFS is scoped to the **origin**, not the path. Every project under
`https://<you>.github.io` shares one storage bucket. Use a custom domain if you
ever ship a second app there.
