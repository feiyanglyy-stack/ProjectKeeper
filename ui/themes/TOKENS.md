# The `--pk-*` tokens: what a theme's `pk.css` fills in

The contract between `ui/styles.css` and each theme's own layer (`ui/themes/<id>/pk.css`). Read this, look at
`i1/pk.css` (the finished example), and fill your theme without reading `styles.css`.

## How it works

- `styles.css` says every colour, shadow, radius and font as `var(--pk-…, <factory literal>)`. The factory skin defines no
  token, so with no theme every fallback applies and the factory look is exactly what it was (a test guards this:
  `src/ui/styles-tokens.test.ts`).
- A theme is two files, loaded after `styles.css` in this order: the owner's frozen `board.css` (never edited, checked
  byte for byte), then `pk.css`. `themes/guard.css` is always last.
- `pk.css` defines the tokens on `:root` **using only values the board already has**: its own custom properties
  (`var(--card)`), or literals that appear in its `board.css`. No new colour, shadow or radius. Then it adds
  the workbench parts the board never had (a segmented control, a conversation, a graph) in the same language.
- **Custom properties inherit.** A token may take another value on another surface: `a1` gives the parchment cards
  their own text and line tokens by redefining them on `.popover, .flyout, dialog, .note-card, .keeper-panel,
  .strip-row.open, .graph-tip, .keeper-entry`, so everything standing on a card takes the ink.
- **Names.** Only `--pk-*` custom properties exist in `styles.css` — the boards define `--bg`, `--line`, `--amber`,
  `--surface`, `--raise` with meanings of their own, so the workbench never reads an unprefixed one.
- **Chains.** Many tokens fall back to a more general one (`--pk-card-bg` → `--pk-surface` → the literal). A theme that
  sets only the general tokens gets a coherent whole and refines from there. The graph's palette is read the same way
  (`ui/graph-palette.js` `PALETTE_VARS`: the graph token first, then the general token, then the factory value).
- **Switching a theme swaps the two `<link>` hrefs and nothing else.** No data is fetched, nothing is rebuilt; the
  graph alone reads its palette again and repaints its pictures (`graph.js repaint`). So a theme must not depend on any
  script running: everything is CSS, and the graph's colours are CSS variables.
- **Every theme passes the same checks** (`scripts/ui-theme-check.mjs`): body text 4.5:1 or better on its surfaces,
  labels and counts readable, the graph's four colours checked with `scripts/palette-check.py`
  (`Plan` / `Work item` under protan and deutan not below the factory's 25.2 / 21.1), the readability mark unchanged by
  the theme, no new `/api/` request on a switch, zoom / pan / scroll unchanged.

## The tokens

Factory value = the literal `styles.css` falls back to. Where a token is read with more than one fallback, the theme's
one value replaces all of them (that is the point). "Chain" says what stands in when the token is not set.

### Surfaces and lines

| Token | What it is | Where | Factory |
| --- | --- | --- | --- |
| `--pk-ground` | the page behind everything; the ring around timeline dots | `body`, `.tl-event:before` | `#141413` |
| `--pk-rail` | the band surfaces: the rail, the bottom strip, the control row, the legend, the compare bar, the band under the pill | `.rail`, `.strip`, `.graph-tools`, `.legend`, `.compare-bar`, `.body::after` | `#191918` |
| `--pk-surface` | sections, cards and controls when their own tokens are not set; legend chips | chains; `.lg-mark`, `.lg-count` | `#1c1c1a` |
| `--pk-raised` | what lifts off a surface: hover, tags, chips, the toast, the Markdown table head, a note card inside the popover | `.btn:hover`, `.tag`, `.nav-item:hover`, `#toast`, `.md th`, … | `#242420` (toast `#303027`) |
| `--pk-line` | the stronger line: borders of tags of the strip's marks, blockquotes, table heads, keyboard hints, the timeline | 19 places | `#35352f` |
| `--pk-line-soft` | the quiet line: section borders, table rows, the rail's right edge, the top bar's bottom | 15 places | `#2b2b26` |
| `--pk-line-strong` | the line of what floats or is picked out: the scrollbar thumb, the toast's border, the legend count chip | `main` scrollbar, `#toast`, `.lg-count` | `#4b4b42` / `#505044` / `#4a4a43` |
| `--pk-scrim` | what dims the page under the popover and a dialog | `.popover-scrim`, `dialog::backdrop` | `#0009` |

### Text (four steps)

| Token | What it is | Where | Factory |
| --- | --- | --- | --- |
| `--pk-text-strong` | the highest-contrast text the theme has: the Keeper's answers and the owner's messages | `.msg.keeper`, `.msg.user`; the graph's node text by chain | `#e7e7df` |
| `--pk-text` | body text | `body`, 23 places | `#e7e7df` |
| `--pk-text-muted` | secondary text: `small`, `.muted`, tags, section subtitles, the object column of a strip row | 42 places | `#a5a59b` |
| `--pk-text-faint` | tertiary: rail section labels, `dt`, times, counts, hints, line numbers | 32 places | `#85857b` (`#75756c`) |

Body text must read 4.5:1 or better on `--pk-surface`, `--pk-rail` and `--pk-card-bg`; muted and faint are used at
10.5–12px, so keep them at 4.5:1 too where you can (i1: `--tx1` 9.8, `#a89a83` 6.4, `--tx2` 5.4 on the card).

### The accent and the families

| Token | What it is | Where | Factory |
| --- | --- | --- | --- |
| `--pk-accent` | the one signal colour: focus rings, the active state, the selected object, the pill's edge, the popover's top edge, the readability alert | 39 places | `#e3b76f` |
| `--pk-accent-bg` | the tinted face under accent text: `.tag.amber`, `.btn.active`, `.read-mark.alert`, the active nav on a narrow window | 7 places | `#322c20` |
| `--pk-accent-hi` | the accent lit further: the primary button's hover | `.btn.primary:hover` | `#edc98f` |
| `--pk-on-accent` | text on a solid accent face | `.btn.primary`, `.mk-decide` | `#211e16` / `#141413` |
| `--pk-accent-soft` | the quiet accent face of a selected row: the active view in the rail, a selected strip row | `.nav-item.active`, `.strip .item.sel` | `#302b22` |
| `--pk-flash` | where the List's flash starts when an object is arrived at | `@keyframes pk-flash` | `#4a3f25` |
| `--pk-star` | the ★ in the List and the legend | `.star`, `.star-legend` | `#ffd54a` |
| `--pk-green`, `--pk-green-bg`, `--pk-green-ln` | good / done: `.tag.green`, `.dot.green`, `.mk-good`, the diff's new side | | `#a3c5ac`, `#253129` (`#202820`), `#374237` |
| `--pk-blue`, `--pk-blue-bg` | what can be pressed: links, `.text-btn`, `.tag.blue`, `.mk-discuss` | | `#9fbdd5`, `#252e36` |
| `--pk-red`, `--pk-red-bg`, `--pk-red-ln` | wrong / removed: `.tag.red`, `.btn.danger`, `.mk-bad`, the diff's old side (`-ln` for struck text) | | `#dca6a0`, `#3a2a2a` (`#23201e`), `#b8a59d` |
| `--pk-purple`, `--pk-purple-bg` | `.tag.purple` | | `#c4b0dc`, `#2e2838` |

### Selection

| Token | What it is | Where | Factory |
| --- | --- | --- | --- |
| `--pk-sel-bg` | a selected table row | `table.list tr.sel td` | `#1f1f1b` |
| `--pk-control-on` | the segment that is on | `.segmented button.active` | `#34332d` |
| `--pk-control-on-text`, `--pk-control-on-shadow` | its text and its shadow (pressed, lit) | same | `--pk-text`, `none` |

### Fonts

| Token | What it is | Factory |
| --- | --- | --- |
| `--pk-font-body` | the whole `font` shorthand of `body`: give the board's own size and stack (i1 `12.5px/1.55 "Segoe UI",…`) | `13px/1.55 var(--pk-font-ui)` |
| `--pk-font-ui` | the interface family, where it is set apart from `body` (`kbd`, quoted sources, cite chips) | `'Segoe UI Variable Text','Segoe UI','Microsoft YaHei',sans-serif` |
| `--pk-font-mono` | identifiers, counts, paths, code | `'Cascadia Code',Consolas,monospace` |
| `--pk-font-display` | the π mark of the Keeper | `Georgia,serif` |

The heading sizes are the workbench's, pinned by the guard: `h1` 22px, `h2` 16px, `h3` 13px, `h4` 12px. A theme colours
them; it does not resize them (hierarchy by size difference, kept the same in every theme).

### Radii

| Token | Where | Factory |
| --- | --- | --- |
| `--pk-radius` | buttons, cards, the Markdown `pre`, the walkthrough boxes, the toast | `6px` (`7px`) |
| `--pk-radius-sm` | tags, inputs, rows, nav items, the strip's marks, folds, diff boxes | `4px` / `5px` |
| `--pk-radius-xs` | code, `kbd`, legend swatches, segment buttons | `3px` / `2px` |
| `--pk-radius-panel` | the dialog and the Keeper's window (the popover and flyout go through `--pk-card-radius`) | `9px` / `10px` |
| `--pk-radius-pill` | pills: the Keeper's dock, the graph's corner buttons, index chips, the agent chip, the legend count | `22px` … `8px` |

Circles (`.dot`, `.lg-mark`) stay `50%`; they are shapes, not radii.

### Shadows

| Token | Where | Factory |
| --- | --- | --- |
| `--pk-shadow-float` | the docked Keeper over the main view on a narrow window; the popover and flyout by chain | `0 14px 40px #0009` |
| `--pk-shadow-window` | the Keeper's popped-out window (and while it is dragged), the dialog | `0 28px 80px #000b, 0 1px 0 #ffffff0d inset` … |
| `--pk-shadow-raised` | the pill, the toast, the graph tooltip | `0 4px 16px #0006` … |

### The one card

The popover, the docked Keeper panel and its window, the dialog, note cards, the row of the bottom strip that opens,
the Keeper entry in the rail and the graph tooltip all read these, so one set of values makes them one card.

| Token | Chain | What it is | Factory |
| --- | --- | --- | --- |
| `--pk-card-bg` | `--pk-surface` | the face | `#1c1c1a` (`#191917`, `#1e1e1b`, `#10100f`, `#191918`) |
| `--pk-card-texture` | | `background-image` over the face (a chamfer, a brush, a grain); `none` for flat | `none` |
| `--pk-card-border` | `--pk-line` / `--pk-line-soft` | the frame | |
| `--pk-card-shadow` | `--pk-shadow-float` for the floating ones | the card's own shadow (i1: `--bezel-chunk`) | `none` |
| `--pk-card-radius` | `--pk-radius` / `--pk-radius-panel` | | `6px` / `8px` |
| `--pk-card-text` | `--pk-text` | text on the card (a1: the ink) | |
| `--pk-card-line` | `--pk-line-soft` / `--pk-line` | dividers inside a card: heads, feet, the composer's top | |
| `--pk-card-hover-border` | `--pk-line` | a note card pointed at | |
| `--pk-card-foot-bg` | `--pk-rail` | the popover's foot (i1: the card's port strip) | |
| `--pk-card-head-bg` | `--pk-raised` | the line of a strip row that is open | |

### A section and its head (the bin header)

`.section` blocks (Project scope, Keeper, the Change log…) and `details.fold`; the head is `.section > header` and the
column head of the bottom strip (`.strip header`).

| Token | Chain | Factory |
| --- | --- | --- |
| `--pk-section-bg` | `--pk-surface` | |
| `--pk-section-border` | `--pk-line-soft` | |
| `--pk-section-radius` | `--pk-radius` / `--pk-radius-sm` | |
| `--pk-section-shadow` | | `none` |
| `--pk-head-bg` | | `transparent` |
| `--pk-head-texture` | | `none` |
| `--pk-head-border` | `--pk-line-soft` | the head's bottom line |
| `--pk-head-shadow` | | `none` — i1 draws its amber top edge here as `inset 0 2px 0 …`, so no rectangle changes |
| `--pk-head-text` | `--pk-text` / `--pk-text-muted` | |

### Controls (the toolbar's parts)

`.btn`, `.segmented`, the pill, the coverage pill, the search trigger, the theme picker, the graph's corner group,
`.popover-close`, `.outline-modes`, `.read-mark`.

| Token | Chain | Factory |
| --- | --- | --- |
| `--pk-control-bg` | `--pk-surface` / `--pk-rail` | |
| `--pk-control-texture` | | `none` |
| `--pk-control-border` | `--pk-line` | |
| `--pk-control-shadow` | | `none` |
| `--pk-control-radius` | `--pk-radius` / `--pk-radius-sm` | |
| `--pk-control-hover-bg` | `--pk-raised` | |
| `--pk-control-hover-border` | `--pk-control-border` | |

### The sunken well

Inputs, the composer, quoted sources, Markdown code and `pre`, the rule rows of Project scope.

| Token | Chain | Factory |
| --- | --- | --- |
| `--pk-well-bg` | `--pk-surface` / `--pk-ground` / `--pk-rail` | `#22221e`, `#171715` … |
| `--pk-well-border` | `--pk-line` / `--pk-line-soft` | |
| `--pk-well-shadow` | | `none` |
| `--pk-code-bg` | `--pk-raised` | bare `code` (the Markdown one is a well) |

### The conversation

| Token | Chain | What it is |
| --- | --- | --- |
| `--pk-msg-user-bg`, `--pk-msg-user-border` | `--pk-raised`, `--pk-line` | the owner's message bubble (WorkflowKeeper puts it on the accent face) |

### The graph

Read by `ui/graph-palette.js` into cytoscape and the objects' SVG pictures. Each entry reads the graph token first,
then the general token in the chain, then the factory value. The kinds' four colours **must** be checked with
`scripts/palette-check.py` on `--pk-graph-node-bg`.

**Write these as literal colours, not `var()` chains into the board.** The palette reads them with
`getComputedStyle(document.documentElement).getPropertyValue(...)`, which returns a custom property's value *unresolved*:
a chain that ends in one of `d2`'s `light-dark(light, dark)` tokens (or any `var()`) arrives as that text, is not a colour
the canvas can use, and falls back to the factory value without a word. `a1` and `d2` found this; their `pk.css` write
the board's light literals for every `--pk-graph-*` token. The CSS on the page is unaffected (the browser resolves the
chain there); only what JavaScript reads for the canvas is.

| Token | Chain | What it is | Factory |
| --- | --- | --- | --- |
| `--pk-graph-bg` | `--pk-ground` | the canvas (i1: `transparent`, the ground's grid shows) | `#141413` |
| `--pk-graph-intent` / `-plan` / `-work` / `-reality` | `--pk-blue` / `--pk-purple` / `--pk-green` / `--pk-accent` | the four kinds: the object's border, its top band, the legend icon | `#9fbdd5` `#c4b0dc` `#a3c5ac` `#e0a98e` |
| `--pk-graph-node-bg` | `--pk-card-bg` → `--pk-surface` | the object's face | `#232320` |
| `--pk-graph-node-text` | `--pk-text-strong` → `--pk-text` | the name | `#e7e7df` |
| `--pk-graph-node-kind` | (none) | the kind line; unset, it is written in the object's own colour (the factory way); set, in this colour (i1: `--tx1`, "the words in the body colour, the colour on the edges") | unset |
| `--pk-graph-node-muted` / `-faint` | `--pk-text-muted` / `--pk-text-faint` | progress, struck names, the folder's empty line | `#a5a59b` / `#85857b` |
| `--pk-graph-node-chamfer`, `-shade`, `-brush`, `-lip`, `-shadow` | (none) | the card's material lent to the objects: a highlight band under the top edge, a shade along the bottom, a hairline texture, a hard lip 3px below, a soft shadow (`dy 6, blur 5`). Any left unset is not drawn; all unset (the factory) means no material and the picture drawn as before. Use the theme's own shadow parts (i1: the parts of `--bezel-chunk` and `--card-brush`) | unset |
| `--pk-graph-edge` / `-edge-other` / `-edge-related` / `-edge-lit` / `-edge-selected` | `--pk-line-strong` / `--pk-text-faint` / `--pk-text-muted` / `--pk-text-strong` / `--pk-accent-hi` | the lines: structure; other links and dotted inferred; on the focused path; pointed at; selected | `#6e6e66` `#8c8c84` `#cfcfc6` `#e7e7df` `#f0d7a3` |
| `--pk-graph-questioned` | `--pk-accent` | a `Questioned` relation, always drawn, always loud | `#e3b76f` |
| `--pk-graph-label-bg`, `-chip-bg`, `-chip-border` | `--pk-ground`, `--pk-surface`, `--pk-line-strong` | the label on a lit line; the link-count chip | `#10100f` `#1c1c1a` `#4a4a43` |
| `--pk-graph-selection` | (none) | the selected object's border and halo — never one of the kinds (i1: `--tx0`) | `#ffffff` |
| `--pk-graph-focus` | `--pk-star` | the ring on the focused object | `#ffd54a` |
| `--pk-graph-diff-added` / `-changed` / `-removed` | `--pk-green` / `--pk-accent` / `--pk-red` | Compare | |
| `--pk-graph-replaced`, `--pk-graph-danger` | `--pk-line-strong`, `--pk-red` | a replaced object's border; `No established link` | `#5a5a50`, `#dca6a0` |
| `--pk-graph-group-bg`, `-border`, `-back`, `-back-border`, `-chip` | `--pk-raised`, `--pk-line-strong`, `--pk-surface`, `--pk-line`, `--pk-raised` | a folded group's stacked cards and its count chip | |
| `--pk-graph-mark-star` / `-flag` / `-note` / `-ask` / `-pending` | `--pk-text-strong` / `--pk-accent` / `--pk-text` / `--pk-accent` / `--pk-blue` | the corner marks ★ ⚑ ✎ ✎ ⟳ — on the objects, in the legend and in the List (`.mark-<key>`); keep them loud | `#f3ead2` `#e3b76f` `#e7e7df` `#e3b76f` `#9fbdd5` |

### The List's layers (owner 2026-09-30, from a design study of hers)

The List by module has three layers of its own (`ui/k-process.css`): the top — the owner's words, the product, the
goals — is WorkflowLens's **Sign in card** (a framed plate with an inlaid hairline and four rivets); a module's head is
its **lane card** (corner brackets, a small caps kicker, the title, the one sentence of its effect); a module's body is a
**panel** of its own (a1: the dark striped wood). Unset, every token falls back to the section, the raised face and the
accent, so a theme that sets none of them still gets the three layers in its own colours. `a1` sets all of them from
WorkflowKeeper's own recipes (cover.css `.loginplate`, `.signin`, `.flab`, `.paper`, `.strip`; board.css `.laneLabel`
r4/r5) — the one place its layer takes values from the cover rather than the board, at the owner's request.

| Token | Chain | What it is | Factory |
| --- | --- | --- | --- |
| `--pk-plate-bg`, `--pk-plate-texture` | `--pk-section-bg` → `--pk-surface`; none | the plate's face and its material | `#1c1c1a`, `none` |
| `--pk-plate-border`, `--pk-plate-border-width`, `--pk-plate-radius`, `--pk-plate-shadow` | `--pk-section-border`; `1px`; `--pk-radius`; `--pk-section-shadow` | its frame and drop | |
| `--pk-plate-inlay` | `--pk-line-soft` | the hairline inlaid 8px inside the frame | `#2b2b26` |
| `--pk-plate-rivet`, `--pk-plate-rivet-shadow` | `--pk-line-strong`; none | the four rivets (a colour or a gradient) | `#4b4b42` |
| `--pk-plate-kicker` | `--pk-accent` | the engraved title (the project's name) and the small caps labels | `#e3b76f` |
| `--pk-slot-bg`, `--pk-slot-text`, `--pk-slot-border`, `--pk-slot-shadow` | `--pk-well-*`, `--pk-text` | the product's slot on the plate (a1: the vellum `.paper`) | |
| `--pk-lane-bg`, `--pk-lane-texture` | `--pk-raised`; none | the lane card's face and material | `#242420` |
| `--pk-lane-border`, `--pk-lane-radius`, `--pk-lane-shadow` | `--pk-line`; `--pk-radius-sm`; none | its frame | `#35352f` |
| `--pk-lane-corner` | `--pk-accent` | the L corner brackets | `#e3b76f` |
| `--pk-lane-kicker`, `--pk-lane-title`, `--pk-lane-sub`, `--pk-lane-link` | `--pk-accent`, `--pk-text-strong`, `--pk-text-muted`, `--pk-blue` | the code and counts, the name, the effect, `Intent & basis` | |
| `--pk-module-bg`, `--pk-module-texture`, `--pk-module-border`, `--pk-module-shadow` | `--pk-section-bg`; none; `--pk-section-border`; none | a module's body | |

The sizes are the workbench's (the lane title 15px, the kicker and labels 10.5px): a theme colours and textures the
layers and may set their font family; it does not resize them.

## What the guard does, and what your `pk.css` must do because of it

`themes/guard.css` is last and says no colour. It restates the shell's layout (full-height grid, the main view scrolls,
the fixed layers) and puts the workbench's sizes back where a board's **element** or **class** rule would land on the
workbench's markup. What it puts back is layout only; the colours those rules carry are yours to restate in `pk.css`.

Rules every board has, and what happens to them:

| Board rule | Lands on | Guard | Your `pk.css` |
| --- | --- | --- | --- |
| `header { position: sticky; top: 0; z-index: 30–40; padding; margin }` | `.section > header`, `.strip header`, the heads of the popover, Keeper and dialog | `position: static; z-index: auto; margin: 0`, the workbench's paddings | the head's colours through `--pk-head-*`; a `border-top` (b1's brass line) would add height — draw it as `inset 0 2px 0` in `--pk-head-shadow` |
| `h1 { font-size: 14–18px; font-family; color; text-shadow }` | page titles (`.page-head h1`) | `h1` 22px / 600 / `-.4px`; `h2`–`h4` too | colour and text-shadow if you want them (i1: `--tx0`, `0 1px 0 rgba(0,0,0,.5)`) |
| `body { font; color; background; font-variant-numeric }` | everything | nothing (the guard leaves fonts and colours to the theme) | restate `body { color; font; background }` from your tokens so `pk.css` is the one source; `--pk-font-body` carries the board's size and stack |
| `code { font-size 10.5–11px; padding; border; background; box-shadow }` | bare `code` (rare; `.mono` is used instead) | nothing | a free look; `--pk-code-bg` if you care |
| `* { box-sizing }`, `[hidden] { display: none !important }` | the same as the workbench | nothing | nothing |
| `.legend { padding: 6px 20px; flex-wrap: wrap; gap: 16px; align-items: baseline; background; border-bottom }` | the graph's legend | `flex-wrap: nowrap; align-items: center; gap: 10px; white-space: nowrap; padding: 6px 12px; border-bottom: 0` | background through `--pk-rail` |
| `.mk { font-size: 12–13px; line-height }` | the marks of a strip row | `font-size: 10.5px; line-height: 1; 16×16` | colours through `--pk-line`, `--pk-text-muted` |
| `.empty { padding: 36–40px; color; font-style }` | empty states | `padding: 44px 20px; text-align: center; max-width: 64ch; margin: 0 auto` | **`.empty { color: var(--pk-text-muted) }`** — the board's colour is for its own page and may be unreadable on yours |
| `.fold > summary { margin: 0 -8px; padding; border-radius; display: block }` and `::before { margin-right; color }` | `details.fold` | `margin: 0`; `::before { margin-right: 0 }` (the workbench's `details.fold > summary` outranks the rest) | a free look: the open chevron's colour and the hover face are the board's |
| `.sub { font-size; color; font-style; opacity }` (a1: serif italic) | nothing — the workbench only has `.page-head .sub`, which outranks it | nothing | a free look |
| `.toolbar`, `.toolbar label` | nothing — no workbench element carries the class | nothing | nothing |
| `.mono { font-family }` (i1 only) | `.mono` text | nothing | the same stack as `--pk-font-mono` |
| `.amber`, `.red`, `.none`, `.open` | nothing — the boards only use them compounded (`.dc.amber`, `.slot.decl.open`) | nothing | nothing |
| `::-webkit-scrollbar*` (a1, b1), `::selection` (b1) | every scrollbar, the selection | nothing | a free look |

Per theme, what was seen (2026-09-21):

| Theme | Leaks that hit the workbench (before the guard) | Kept as a free look |
| --- | --- | --- |
| `i1` | sticky `header` with panel face and shadow; `h1` 14px; `body` 12.5px + grid; `.legend` wrapping and padded; `.mk` 12px; `.empty` in `--tx3` (3.3:1) | the grid ground (kept on purpose, also under the graph); `.fold` chevron amber when open, hover face `--well`; `.mono` in `ui-monospace` |
| `b1` | sticky `header` with a 2px brass `border-top` (adds height) and shadow; `h1` 15px; `.legend`; `.mk` 13px; `.empty` in `--fg-3` | `::selection` brass; scrollbars in the board's greens |
| `d2` | sticky `header`; `h1` 14px; `body` 12.5px; `.legend`; `.mk`; `.empty` in `--fg3`; `color-scheme: light` (wanted: the native controls follow) | `code` with `--elev-groove` |
| `a1` | sticky `header` with wood gradient, 2px brass `border-bottom`, z-index 40; `h1` 18px serif with text-shadow; `body` 12.5px with `background-attachment: fixed`; `.legend` with brass bottom line; `.mk`; `.empty` in `--ink-sepia` italic (unreadable on walnut) | `.sub` italic serif (only `.page-head .sub`, which outranks it); scrollbars in brass |

The class clashes (`amber empty fold legend mk none open red sub toolbar`, `mono` in i1) are the same in all four
boards; a board updated in WorkflowKeeper is checked again with the script in `themes.test.ts` and this table.

## Filling a theme: the order that worked for i1

1. Surfaces and text first (`--pk-ground` … `--pk-text-faint`), then measure the contrast of body, muted and faint on
   the card, the panel and the ground (`scripts/ui-theme-check.mjs` prints them).
2. The accent and the families, the card, the section head, the control, the well: every one from the board's own
   card / bin header / tray tile (as in WorkflowKeeper: each part after the theme's card).
3. `body`, `.empty`, and the segmented control (`.segmented button`, `.active`) as the board's tray tiles.
4. The graph: the four kinds from the numbers file, `--pk-graph-node-bg` the card, the material from the card's shadow
   parts, the marks loud, the selection never one of the kinds. Run `palette-check.py` on your four with `--bg` your
   node face, and the theme check for the readability mark.
5. Screenshots at 1280×800: default view, popover + docked Keeper, List, a dialog, Project scope.
