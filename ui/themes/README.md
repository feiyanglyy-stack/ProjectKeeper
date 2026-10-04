# Themes

The workbench borrows WorkflowKeeper's four themes, by the owner's decision. The owner reviewed and hand-edited
each of them there; what was reviewed is frozen.

The themes are not covered by ProjectKeeper's MIT licence: see [LICENSE.md](LICENSE.md).

| id | name | character |
| --- | --- | --- |
| `a1` | Walnut Workshop | dark walnut, cast brass plates, parchment cards; the default (owner 2026-09-22) |
| `b1` | Peacock & Brass | four steps of green-black, brass only on edges and on what can be clicked |
| `d2` | Warm Clay | warm clay paper, terracotta accent; the one light theme |
| `i1` | Task Console | near-black machined panels, amber warning parts |

The workbench's own dark look stays as the factory theme and is what shows when no theme is chosen or a theme fails to
load.

## What is frozen

`<id>/board.css` is a **byte-for-byte copy** of WorkflowKeeper's `app/themes/<id>/board.css`. `manifest.json` records
where each came from, the WorkflowKeeper commit, the day it was copied, its size and its SHA-256.

- Never edit a `board.css` here, not even whitespace. Only the owner changes what is frozen, and they change it in
  WorkflowKeeper. `.gitattributes` marks these files `-text` so git never rewrites their line endings.
- `npm test` checks every copy against the manifest (`src/server/themes.test.ts`).
- When WorkflowKeeper's theme has changed, that is a decision for the owner: copy the new file over, update the
  manifest, and look at the workbench in that theme again.
- WorkflowKeeper's covers (`cover.html`) are not copied: the workbench has no start screen.

## What is ProjectKeeper's own

Everything the workbench adds for a theme goes in its own layer beside the frozen file, never into it: `<id>/pk.css`.
That layer uses only values the theme already has (its colours, radii, shadows and fonts) and can be removed as a
whole, leaving the factory look.

- `ui/styles.css` says every colour, shadow, radius and font as `var(--pk-…, <factory literal>)`; `pk.css` fills the
  tokens on `:root` and adds the parts the board never had. The tokens are the contract in [TOKENS.md](TOKENS.md).
- The page loads `styles.css` → `<id>/board.css` → `<id>/pk.css` → `guard.css` (always last: the shell's layout, no
  colour). The picker in the top bar swaps the two theme hrefs and nothing else; the choice is this browser's
  (`localStorage`, `pk.theme`), `a1` by default (`manifest.json`). The graph reads its colours from the `--pk-graph-*`
  tokens and repaints in place (`ui/graph-palette.js`).
- All four carry a complete layer (`pk.css`); `i1` was the first, the model for the other three.
- `scripts/ui-theme-check.mjs` measures a running fixture workbench: contrast, the graph's four colours through
  `palette-check.py`, what a switch leaves untouched, the fallback, the guard.
