# Architecture

Deeper tour of how `data-occultist` is put together. Read `CLAUDE.md` first for the
hard rules and conventions — this file is reference detail, not required reading for
every change.

The whole system is **backends behind ABCs, chosen by name** — nothing game- or
library-specific is hard-coded in calling code.

- **Contracts** live in `src/oc/interfaces.py` (one ABC per pluggable kind:
  `CaptureBackend`, `WindowProvider`, `ProcessDetector`, `OcrEngine`,
  `WindowClassifier`, `Corrector`, `Enricher`).
- **Implementations** self-register by name via decorators in `src/oc/registry.py`
  (e.g. `@register_ocr("rapidocr")`). `registry._IMPL_MODULES` lists the modules to
  import for discovery; a backend that fails to import (e.g. win32 off-Windows) is
  silently skipped, so its name just won't resolve.
- **`config/settings.yaml`** picks the backend name per kind, plus `tuning` knobs.
  `Settings.load()` parses it; `Engine.build()` (`src/oc/engine.py`) is the **only**
  place that turns names into live objects. Swapping a backend means changing one
  name (as long as the module registers it).

To add a backend: write the module, decorate the class with the matching
`register_*`, add its dotted path to `registry._IMPL_MODULES`, and reference the name
in `settings.yaml`. No edits to consumers.

## Profiles (per-game config, not code)

`config/games/<game>.yaml` is validated by the pydantic models in
`src/oc/profile/models.py`. `GameProfile` has process names + windows; each
`WindowDef` has `detect` (recognise the window), `states` (distinguishable modes),
`regions` (what to OCR and which field it feeds), and an optional `scroll` grid.

**Coordinate convention (important):** every box is a `FractionBox` — a fraction
(0..1) of the window's *client* area, so a profile authored at one resolution still
works at another. `FractionBox.to_pixels(w, h)` resolves it against a concrete frame.
`PixelBox`/`FractionBox`/`Frame`/`WindowInfo` in `src/oc/types.py` are the
backend-agnostic value types every backend speaks in.

**Datasets:** `WindowDef.dataset` (default = the window id) names the logical
collection its records join. Several windows can share a dataset when they show
overlapping data (e.g. arcanes appear in both the Equipment and Arcane windows) —
their records dedup and store together. Distinct data (e.g. mods) gets its own
dataset/window. Datasets just receive/store/serve rows; HOW a row is keyed is taught
where it's read: `KeyDef` (an ordered list of field ids + separator, case-insensitive
by default) lives on `ItemDef` (falling back to `WindowDef`, default `name`).
Composite keys distinguish e.g. "Arcane Aegis" level 5 from level 3 (`name`+`level`).
A record with any key part unread is dropped, never guessed — an occluded level must
never update another level's record. `GameProfile.key_map_for(dataset)` resolves the
dataset's `KeyMap` (`src/oc/store/keys.py`); the store re-keys the whole ledger on
replay whenever the key config changes. Every dataset producer (windows/items AND
file sources) must feed into `key_map_for` — a write-key/read-key mismatch silently
re-keys the ledger to null.

## Capture & window location (`src/oc/capture`, `window`, `locate.py`)

The active capture backend is picked in `config/settings.yaml` under `capture.name`
and changes over time — check that file rather than assuming a fixed default.
Registered backends:
- **`adaptive`** — picks per-grab by focus state (e.g. `mss` while the game is
  foreground, `printwindow` while it's backgrounded), so the more expensive backend's
  cost is only paid when needed.
- **`printwindow`** (`PrintWindow` + `PW_RENDERFULLCONTENT`) — grabs a specific
  window's surface even unfocused/backgrounded/occluded (needed for borderless
  games), but forces a fresh render each grab. Minimized windows can't be
  PrintWindow'd → empty frame → skipped.
- **`mss`** — screen-region capture; the window must be on top.
- **`wgc`** (Windows Graphics Capture) — reads the DWM-composited surface, so the
  game does not re-render per grab, at the cost of being GPU-stream-bound. Quirks
  handled in `src/oc/capture/wgc_backend.py`: Windows 10 doesn't support the
  border-toggle option (retries once without it), a grab right after session start
  has no frame yet (bounded `wait_first()` before the first real grab), and the
  native capture thread must be joined on exit or process finalization can crash
  (`atexit`-registered close).

`tuning.require_foreground` gates whether the collector needs window focus (default
false; only relevant for `mss`). `Engine.build()` calls
`window.dpi.set_process_dpi_aware()` once so win32 geometry and capture share true
physical pixels (no display-scaling skew — a 4K screen at 125% reads as 3840x2160,
not 3072x1728). Process enumeration is slow on Windows (first scan ~seconds);
`WindowLocator` finds the window once then revalidates the cached handle via
`WindowProvider.from_handle` (microseconds) — never rescan per frame. The web app
warms it at startup. Use `WindowLocator` in long-lived loops; `locate_window` for
one-shots.

## Collection pipeline (`src/oc/collect/`)

`Collector.tick()` runs a chain where **each stage can reject** — this is how
robustness and "don't save at the wrong moment" are enforced:

1. Is the process found, is the window located (`locate.py`), is it foreground (if
   required)?
2. `WindowClassifier.classify()` → `(window_id, state_id)` via anchor matching
   (`src/oc/detect/`). No match → skip (whole-window occlusion, or the wrong screen
   is showing).
3. The state must be `valid_for_save` → else skip (e.g. wrong sort order active).
4. `RegionReader` (`reader.py`) OCRs each grid cell (`grid.py` tiles regions by
   stride), then runs each field's `rules` pipeline (`src/oc/collect/fields.py`
   `run_rules` — an ordered list of `FieldRule`s: dictionary correction, extraction,
   folding, min/max drop, etc., replacing what used to be scattered per-field
   scalars). A record's confidence is its **worst** field's, so one occluded region
   drops the whole record (`tuning.min_confidence` floor).
5. `Confirmer` (`stability.py`) requires `tuning.confirm_frames` consecutive
   **identical** reads (keyed by the dataset's dedup key) before a record is written
   — transient pop-ups/tooltips never stabilise, so never get saved. This step also
   dedups (a key is confirmed once).
6. Survivors go to the dataset's `DatasetStore` (see below). Confirmers/stores are
   keyed by **dataset**, so windows sharing a dataset dedup against each other.

## Stateful storage + history (`src/oc/store/`)

Each dataset is a `DatasetStore`, not an append-only log:
- `data/<game>/<dataset>.state.json` — current keyed records with first/last-seen.
- `data/<game>/<dataset>.history.jsonl` — one `ChangeEvent` per line, the durable
  source of truth (written immediately on `record_seen`; the state file is a
  fingerprint-validated cache replayed fresh if stale).

`record_seen(values)` logs an **add** (new key) or **update** (a field changed, e.g.
mod rank 5→6) live, merging fields into the snapshot. Bulk writes (a big file-source
read, an import) must go through `record_many(rows)` instead of looping
`record_seen` — each `record_seen` call is its own transaction *and* its own
change-bus announce, and looping it over tens of thousands of rows can starve the
web server's asyncio event loop. `record_many` shares the same dedup/merge decision
via `_plan_observation` so the two paths can't drift.

**Removals** are a separate `reconcile(present_keys)` step — only safe after a
*complete* pass, so it's gated behind `tuning.detect_removals` (default off) and run
on collector close. A partial/occluded view must never be mistaken for
"sold/deleted".

`store/factory.py::store_for(...)` is the one place a `DatasetStore` is opened; it
resolves key + aggregate from the profile so every producer (collector, precapture,
preview commit, pretty-studio record, price sweep, file-source read, inspector)
agrees on the same key spec.

## Correction: authored dictionary + fuzzy + taught glyph checks (`src/oc/learn/`)

OCR is noisy, so each field's `rules` pipeline can include a `dictionary` action
(`DictionaryDef` in `src/oc/profile/models.py`) that snaps a read to the closest
authored term via a `Corrector` (`rapidfuzz` by default, `difflib` as the stdlib
fallback) when similarity clears a threshold. There is **no self-learning /
runtime-taught vocabulary** — an earlier self-learning `Lexicon` + a hardcoded
glyph-confusion fold table were both deliberately ripped out (a previously-correct
read of "Lith Q3" was getting silently snapped to a wrong "Lith G3" via the learned
vocab). Correction is exact-dict-hit + word fuzzy match + an optional taught
`glyph_check` atlas (per-game, authored on the game node in the UI) that resolves
specific single-glyph confusions at the pixel level via sliding template-match — not
runtime-learned state. Don't reintroduce learned/self-updating correction state.

## Enrichment (`src/oc/enrich/`)

`Enricher` runs **after** capture (never in the collection loop, so network issues
can't hurt collection robustness). `enrich_file()` reads a `.jsonl`, writes a
`.enriched.jsonl`. `WarframeMarketEnricher` maps an item name to a warframe.market
`url_name` slug, fetches sell orders from online users, and reports min/median
platinum.

## Web UI (`src/oc/web/`)

FastAPI (`app.py`, startup lifespan warms the window locator) serving a single-page
ES-module front-end under `static/`. The whole UI is **one SPA**: `index.html` →
`static/js/graph/main.js` (the graph/pretty view). There is no separate teaching
page — window authoring (box-drawing, fields, states, grid, scroll, detect,
preprocess) happens inline on each window node's canvas via `graph/imaging.js` +
`graph/node_parts.js` + `graph/model.js` (`GraphModel`).

The capture endpoint returns a **JPEG** of the window client area (PNG was ~12MB at
4K; OCR uses the raw server-side frame, so the preview's compression never touches
the data actually read). Since the returned image *is* the client area, a box drawn
in the browser divided by the image size **is** the window-fraction coordinate the
profile stores.

All DOM in the front-end is built via the hyperscript primitives in
`static/js/dom.js` (`h()`/`svg()`/`frag()`) — there is no `innerHTML` string-building
anywhere in the app; see the poll/reconcile hard rule for how lists redrawn on a
timer must still avoid DOM churn.

Saving `PUT`s to `routes/profiles.py`, which **merges** by default
(`profile/merge.py`): an incoming single window upserts into the existing profile,
so a game's profile accumulates many windows authored one at a time.
