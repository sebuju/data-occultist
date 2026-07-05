# Node view — "blueprint" restyle notes

Source session `089b4c74` (05/07/26). Reference image: LLM-VRAM blueprint diagram
(`node-blueprint-reference.webp`). Mockup: `node-blueprint-preview.html` (standalone,
touches no repo code). This file = the design decisions, so implementation can start cold.

## Design language (pulled from reference)

- **Near-black bg + faint dot grid**, monospace everywhere.
- **Thin per-type accent borders** (amber / sky / coral / mint / violet / pink),
  near-transparent card fill (near-flat, slight glow).
- **Segmented meter bars** = the VRAM-bar motif. Reused for: OCR confidence
  (coral = low), dataset fill (mint), producer progress.
- **Boxed sub-label chips** (`0-9` `A-Z`, `on change -> emit`, `name + level`)
  = the `CPU / E1..En` motif.
- **Dashed dividers**; letter-spaced caps sub-headings.
- **Edge kinds** (color-coded): data = solid orange (animated flow blobs),
  view, owns = dotted amber, dict = dotted violet, trigger = pink,
  watch = dashed violet, disabled = faint.
- **States**: selected = accent ring; disabled = fade; collapsed; producer = spinner.

## Full board coverage (what the mockup proves out)

- Node types (authentic bodies): game, glyphs (collapsed), dictionary, window
  (grid tiles + detects list), region/field (rules + confidence meter), detect,
  scrollbar, item (+ child itemfield/itemtell), readout (live value), dataset,
  subset (selected), producer (fetch spinner), trigger, toast (token palette),
  sound (disabled), filesource. (~30 node types total.)
- Structure: nested groups SUPER `warframe` -> GROUP `capture`/`data`/`react`
  -> SUB `item.cell`. Watermark super-title.
- Satellite VTable under dataset (data/batches tabs, removed toggle, struck gone row).

## Implementation target (NOT done yet)

Node-view only. Map the look onto existing tokens/selectors, no other UI touched:
- `base.css` design tokens (accent hues per type -> `--ntint`).
- `graph.css` selectors: `.gnode`, `.gn-h`, `.gedge`, per-type tint.
- Edges: keep the real orthogonal A* router (`route.js`) — mockup edges are
  hand-routed / look-only, real ports land clean.

## Decisions (locked 05/07/26)

- **Per-type hues: KEEP** as-is.
- **Dot grid: REMOVE** (drop the `radial-gradient` board bg).
- **Meter bars: KEEP** (confidence / fill / progress).
- **Card fill: FLAT** (accent on border + faint header wash only; body stays
  neutral `--card`->`--card-2` gradient). Glow reserved for the *selected* node
  (which already gets the accent ring). Avoids noise across ~30 nodes. CONFIRMED.

## Decisions round 2 (locked 05/07/26)

- **Palette: ADOPT mockup** amber/sky/coral/mint/violet/pink. Retune `base.css`
  hue tokens to the blueprint hex.
- **Scope: NODES + PANELS** — push flat/blueprint look into floating panels
  (activity, toolbox, nodemap, minimap) + chrome too, full consistency.
- **Meters: BAR + NUMBER** — segmented meter shown alongside the numeric value
  (bar + `0.71`), everywhere a meter fits (confidence, dataset fill, progress).
- **Unify:** hoist meter/chip/divider/flat-card into SHARED classes driven off
  `--ntint`; kill per-node-type body CSS. `--ntint` extends header-only -> border.

## Implemented 05/07/26 (node view + panels)

- **base.css**: surfaces darkened to blueprint (`--bg #0b0d12`, `--panel #14171e`,
  `+--card-2`, `+--line-soft`, cooler `--line`, darker float-*). Added the per-type
  identity map `--nt-<type>` (mockup amber/sky/coral/mint/violet/pink).
- **graph.css**: ONE `--nt` per type on `.gnode` now drives card border tint, header
  accent wash, header icon, type tag AND the type's edge (repointed `.gedge.*` to the
  same `--nt-*` tokens) — a type's hue lives in exactly one place. Card = flat
  panel->card-2 gradient. Selection ring/glow = the node's own `--nt`.
- **Shared primitives** added (rule 7): `.meter/.segs/.seg/.pct`, `.chip`, `.bdivider`
  — colour rides `--mc` (default `--nt`). Reusable vocabulary, no per-type bars.
- **Meter wired**: producer fetch progress (`.enr-meter`, real `done/total`) — segmented
  bar + `%`, built once + reconciled in place, hidden at rest. This is the ONE node with
  a real 0..1 value; the mockup's field-confidence + dataset-"keyed fill" meters were
  invented (no backing metric) so were NOT fabricated. `.chip`/`.bdivider` are available
  for future reuse (e.g. dataset key parts, toast tokens) but not force-applied.
- **Not touched**: dot grid (mockup-only — real canvas never had one). Group title bands
  stay their user-set scheme colours (profile data, not CSS). Trigger/watch EDGES keep
  their semantic cyan/teal (edge-kind signal, distinct from the violet trigger node).
- Verified live (node view, floating panels, minimap, pretty view) — no console errors.

## Implemented round 2 — node internals (05/07/26)

- **De-inputted controls** (`graph.css`): `.gnode input/select/textarea` = transparent +
  borderless at rest; hover/focus reveals a faint type-tinted fill + border. Value carries
  `--text`, label stays muted -> "muted key -> bright value" like the preview.
- **`.flab` condensed**: grid `1fr 1fr` -> `auto 1fr` (label sizes to its text, not half the
  node), smaller margin + `min-height calc(1.4em + 8px)` -> rows sit close like the preview.
- **Editable segmented meter** (`js/graph/meter.js`, `confMeter()`): draggable 0..1 bar that
  REPLACES a number input. Drives a hidden `<input>` carrying the node's usual change-class +
  `dataset.k`, so the existing handler persists it (no new save path). Click/drag/arrow-keys.
  `stopPropagation` on press so the card doesn't drag. Accepts an optional `live` for a future
  read-confidence ghost-fill (not wired — live conf currently only renders on the canvas overlay).
  - Wired: field `conf` (region/itemfield/readout via `fieldConfigBody`), item `tell conf`,
    and sound `volume` (range+% -> bar; handler switched input->change, now 0.05-quantised).
- Verified: 23 conf meters render, correct segs/pct, drive fset/roset/ffset minconf handlers;
  sound volume bar full at 1.00. No console errors. All frontend files pass the lint hook.
