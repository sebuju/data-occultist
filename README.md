# data-occultist

Reads structured data off game screens via OCR. Captures the game window,
identifies which panel is on screen, OCRs the regions you marked, and writes
deduplicated records with change history. The pipeline drops frames it can't read
cleanly (pop-ups, tooltips, occlusion, mid-scroll), so it only records stable
reads.

No game-specific code: what to read and where is per-game config, authored in a
web UI and stored as YAML.

The example profile catalogues the Warframe equipment window and prices items
against [warframe.market](https://warframe.market).

![The node-graph teaching UI: a game node feeds a window, its fields, and a
dataset.](docs/img/node-graph.png)

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Run it](#run-it)
- [Desktop app](#desktop-app)
- [Tutorial: your first window](#tutorial-your-first-window)
- [CLI reference](#cli-reference)
- [How it works](#how-it-works)
- [Profiles: the per-game config](#profiles-the-per-game-config)
- [Where data lives](#where-data-lives)
- [GPU OCR](#gpu-ocr)
- [Development](#development)
- [Project layout](#project-layout)
- [Design notes](#design-notes)

---

## Requirements

- **Windows** — the window/capture backends use win32. (Pure-logic code and tests
  run anywhere.)
- **Python 3.11+**
- **NVIDIA GPU with CUDA** — effectively required. OCR on CPU works but is slow
  enough to be impractical for real collection; treat it as a fallback only.
  `install.ps1` sets up the CUDA OCR stack automatically when it finds a card.
- **Edge WebView2 Runtime** — only for the [desktop app](#desktop-app).
  Preinstalled on Windows 11; `install.ps1` sets it up on Windows 10. The browser
  UI needs nothing extra.

The default capture backend is **WGC** (Windows Graphics Capture), which needs the
`windows-capture` package (the `wgc` extra). `install.ps1` pulls it in; a manual
install adds `.[wgc]` (see below). If you'd rather not, switch `capture:` in
`config/settings.yaml` to `printwindow`, which has no extra dependency.

## Install

**Scripted.** Double-click **`#install.bat`**, or run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Cpu   # force CPU OCR (skip CUDA)
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Yes   # non-interactive (accept every prompt)
```

It checks for Python 3.11+ and the WebView2 runtime and offers to install anything
missing via winget; creates `.venv` and installs the package; downloads the GPU
OCR stack (onnxruntime-gpu + CUDA wheels) when an NVIDIA card is present; and drops
a `data-occultist` shortcut on the Desktop / Start menu. It skips anything already
present and prints a summary of what's still missing.

> `.ps1` files open in Notepad on double-click (Windows blocks run-on-click), so
> `#install.bat` is the double-click entry — it calls `scripts\install.ps1` with the
> execution policy bypassed. It runs as the **normal user** (so the venv and
> shortcuts are yours); only the winget system-installs (Python / WebView2) elevate,
> via their own UAC prompt.

**Manual.**

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev,desktop,wgc]"   # drop ",desktop" for browser-only; drop ",wgc" to use printwindow capture
pip uninstall -y onnxruntime; pip install -e ".[gpu]"   # NVIDIA CUDA OCR
```

The extras: `dev` (`pytest`, `ruff`, `httpx2`), `desktop` (`pywebview`), `wgc`
(`windows-capture`, the default capture backend), `gpu` (onnxruntime-gpu + the
`nvidia-*-cu12` CUDA wheels).

The package installs two console scripts, `data-occultist` and the short alias
`occ` — they're the same entry point.

## Run it

Start the dev server (auto-reloads on code change) and open the UI:

```powershell
.\scripts\start_server.ps1                 # http://127.0.0.1:8000, hot-reload on
.\scripts\start_server.ps1 -Port 8001
.\scripts\start_server.ps1 -Background     # detached
.\scripts\start_server.ps1 -NoReload       # single process (no reloader)
```

Or double-click `#serve.bat` for a supervised server that restarts on crash or
manual kill. Then open <http://127.0.0.1:8000>.

The UI opens on the **node** view (author the profile); the top bar's **pretty**
button switches to the dashboard surface — same page, no separate URL.

---

## Desktop app

The same UI can run in a native window instead of a browser tab, via
[`pywebview`](https://pywebview.flowlib.org/), which renders through the Edge
WebView2 runtime on Windows (no Electron, no bundled browser).

- **`data-occultist` shortcut** — the shortcut `install.ps1` puts on the Desktop /
  Start menu (and a `data-occultist.lnk` at the repo root). Runs
  `pythonw -m oc.desktop_main` from the venv (no console window, custom icon), so it
  uses the venv's GPU OCR stack. Starts the server, opens the window, and stops the
  server on close.
- **`scripts\app.ps1`** — launches `pythonw -m oc.desktop_main` detached; the
  shortcut is a thin wrapper over it.

The shortcut reuses the installed venv rather than bundling a packaged `.exe`,
which would have to ship the multi-GB CUDA OCR runtime.

The CLI launchers (`app`, `view`, `serve`) are in the [CLI reference](#cli-reference).

---

## Tutorial: your first window

This walks through configuring `data-occultist` to read a game panel from scratch. We'll
use Warframe's inventory, but the steps are identical for any game.

### 0. Start the game and the UI

Launch the game and open the panel you want to read (e.g. the Equipment /
Inventory screen). Then start the web UI:

```powershell
.\scripts\start_server.ps1
```

Open <http://127.0.0.1:8000>. The UI is a node graph: a `game` node on the left,
with windows, regions, detectors, datasets, and subsets branching off it.

### 1. Create a profile and a window

- Add a game profile (name it, e.g. `warframe`) — this becomes
  `config/games/warframe.yaml`.
- Add a **window** node. A window is one recognisable panel of the game.
- Open the window's **image** node and click **recapture** — `data-occultist` grabs the
  live game window and shows its client area. Because the picture *is* the client
  area, any box you draw ÷ image size **is** the fraction coordinate stored.

### 2. Draw a detector so `data-occultist` recognises the panel

`data-occultist` must know it's actually looking at this panel before it reads anything.

- Pick the **detect** tool and draw a box around a stable label that only appears
  on this screen — e.g. the `EQUIPMENT` / `INVENTORY` heading.
- A detector matches by **OCR text** (type the expected text, e.g. `INVENTORY`)
  or by **template image**. Set a `threshold` (default 0.8).
- A window matches only when **all** its enabled detectors match. The detector
  node shows a live ✓/✗ as you edit it; recapture to re-evaluate.

> A window with no detectors never matches. This is what stops `data-occultist` reading
> the wrong screen.

### 3. Mark the data area and an item template

- Draw a **data area** box to constrain OCR to the list region (stray UI text
  elsewhere is then never read).
- Draw an **item** box around a single list cell. `data-occultist` freezes that cutout and
  spawns an *item template* node. Inside it you define, **relative to the cell**:
  - **fields** — the regions to OCR (e.g. `name`, `count`), each mapped to a
    field with a type (`text`, `number`, `pips`, `diamonds`) and extraction rule.
  - **tells** — signals that a cell is a real item (has text / a colour / a
    template match), so empty slots and tooltips are rejected.
  - a **locator** tell/field that finds row positions, so one template reads
    every row regardless of scroll.

![A window node with its templates, detectors, and the recaptured inventory
grid with the live grid preview tiling every row.](docs/img/window-node.png)

### 4. Tune fields

For each field you can set:

- **type** — `text`, `number`, `pips` (count glowing dots, e.g. mod rank), or
  `diamonds` (count filled rank diamonds).
- **extract** — `whole`, `number`, `number_before/after`, `text_before/after`
  (with a `separator`, e.g. a mod rank `"7 / 10"`).
- **learn** — turn on for identity text (item names): confident reads feed the
  dictionary, uncertain reads are fuzzy-corrected against it.
- **fuzzy** — the similarity (0..1) an uncertain read must reach to snap to a
  known term.
- **dict mode** — how the dictionary participates, word per word: `off` (not
  consulted), `correct` (fix words, keep unmatched), `drop` (validate only — a
  read with an unknown word is dropped), `correct + drop` (fix what matches, drop
  a read with an unmatchable word).

### 5. Preview, then collect

- Hit **preview** to OCR the current layout against the captured image and see
  exactly what each field reads, with confidence.

![A preview node showing what each field OCRs, coloured by
confidence.](docs/img/preview.png)

- When it looks right, **save** (the UI writes the profile YAML) and start the
  collect loop from the UI. Scroll the in-game list while it runs — `data-occultist`
  stitches rows across scrolls, dedupes by key, and writes records once they
  stabilise. Inspect results under `data/warframe/` (see
  [Where data lives](#where-data-lives)) or switch to the **pretty** view for the
  dashboard.

> **Tip — precapture for fast lists.** Live OCR can't keep up with fast scrolling.
> The UI's *precapture* mode records frames as fast as the capture backend allows
> (no OCR), then batch-OCRs them afterward and stages the results for you to review
> and save. Recordings persist to disk, so they survive a server restart and can be
> re-processed.

> **Note on states.** A window can have *states* (distinguishable modes, usually a
> sort order) with a `valid_for_save` gate, so records are only written in a
> save-worthy state. States exist in the profile model and pipeline but are not yet
> exposed in the UI — set them in YAML if you need them.

---

## CLI reference

The UI is the primary interface. These subcommands exist for scripting and the
desktop launchers (`occ` is the short alias for `data-occultist`):

```text
data-occultist detect                                   list running known games
data-occultist serve [--host H] [--port N] [--reload]   launch the web UI (browser)
               [--verbose-access]
data-occultist view  [--host H] [--port N]              native window onto a RUNNING server
data-occultist app                                      release: server + native window, stop on close
data-occultist capture <game> [--out capture.png]       save one screenshot of the window
data-occultist collect <game> [--once] [--interval N]   run the capture -> OCR -> record loop
data-occultist bench   <game> [--seconds N] [--capture] capture/OCR throughput benchmark
               [--warmup N]
data-occultist price   <game> [--window equipment]      warframe.market enrichment (writes .enriched.jsonl)
               [--source warframe_market] [--name-field name]
data-occultist prices  <game> [--dataset master]        sweep market price history into a store
               [--throttle S] [--timeout S] [--limit N] [--workers N]
               [--mode M] [--name-field name] [--refresh-catalogue]
data-occultist profiles                                 list game profiles
```

## How it works

The collection pipeline is a chain of stages; any stage can reject the frame and
end the tick:

1. **Locate** — is the process running? Is the window found (and foreground, if
   required)? A cached window handle is revalidated each frame, never rescanned.
2. **Capture & gate** — grab the window surface, then skip cheaply if the frame is
   mid-scroll/animating or otherwise not worth OCRing (before any OCR runs).
3. **Classify** — `WindowClassifier` matches detectors → `(window_id, state_id)`.
   No match → skip (wrong screen / occluded). The state must also be
   `valid_for_save`, else skip (wrong sort order).
4. **Read** — `RegionReader` OCRs each grid cell. A record's confidence is its
   **worst** field, so one occluded region drops the record.
5. **Confirm** — a record must read identically for `confirm_frames` consecutive
   frames before it's written. Transient pop-ups never stabilise, so they're
   never saved. This also dedupes.
6. **Store** — survivors go to the dataset's store, keyed by dataset so windows
   that share a dataset dedupe against each other.

Enrichment runs after capture, not in the loop, so network failures can't stall
collection: it reads a `.jsonl` and writes a `.enriched.jsonl`.

Each pluggable kind is a backend behind an ABC, selected by name. Contracts live
in `src/oc/interfaces.py`; implementations self-register via decorators; and
`config/settings.yaml` picks the backend for each kind plus tuning knobs:

```yaml
capture: wgc           # Windows Graphics Capture (default); or printwindow / mss
window: win32          # locates the game window
process: psutil        # finds the running game
ocr: rapidocr          # reads text from regions
classifier: detect     # decides window + state from detectors
corrector: rapidfuzz   # fuzzy-corrects uncertain OCR (or difflib)

tuning:
  accept_confidence: 0.88   # >= this: trust + learn the term
  min_confidence: 0.50      # worst-field floor; below -> drop record
  confirm_frames: 2         # stable frames required before saving
  collect_interval: 1.0     # seconds between OCR ticks
  gate_interval: 0.25       # seconds between the cheap pre-OCR gate checks
  live_gate: true           # run the pre-OCR worthiness/settle gate
  require_foreground: false # true only for screen-region capture
  detect_removals: false    # reconcile deletions after a complete pass (off)
```

Swapping a backend means changing one name (and ensuring a module registers it).
Registered names today: capture `wgc` / `printwindow` / `mss`; corrector
`rapidfuzz` / `difflib`; the rest are single-implementation (`win32`, `psutil`,
`rapidocr`, `detect`).

## Profiles: the per-game config

`config/games/<game>.yaml` is validated by pydantic models in
`src/oc/profile/models.py`. A `GameProfile` has process names plus windows; each
`WindowDef` has:

- **`detect`** — detectors that recognise the window (text or template).
- **`states`** — distinguishable modes, each with its own detectors and a
  `valid_for_save` flag (config-level; not yet exposed in the UI).
- **`regions`** / **`items`** — what to OCR and which field each feeds. Item
  templates are matched across the data area and read cell-relative.
- **`dataset`** — the logical collection these records join. Set it per window;
  several windows can share one dataset to merge overlapping data. A window with
  no dataset set produces no records (there is no implicit window-id default).
- an optional **`scroll`** grid describing how rows tile and which field dedupes.

The UI writes this YAML; hand-editing isn't normally needed.

## Where data lives

```text
data/<game>/
  store.sqlite              live keyed records + change history (one DB per game)
  lexicon.json              the per-game dictionary
  prices.state.json         market price-history sweep (data-occultist prices)
  *.enriched.jsonl          one-shot enrichment output (data-occultist price)
```

The store is **not** an append-only log. `record_seen()` logs an add (new key) or
update (a field changed) and merges into the current snapshot, keeping first/last
seen and a per-key change history in the same SQLite DB. **Removals** are a
separate reconcile step, only run after a *complete* pass and gated behind
`tuning.detect_removals` (off by default) — a partial/occluded view must never be
mistaken for "sold/deleted".

## GPU OCR

OCR needs an NVIDIA GPU to be usable (CUDA 12 / cuDNN 9 on Windows); the installer
sets this up for you. To wire it up manually:

```powershell
pip uninstall -y onnxruntime
pip install -e ".[gpu]"
```

`onnxruntime-gpu` replaces `onnxruntime`; the bundled `nvidia-*-cu12` wheels ship
the CUDA DLLs (the OCR engine adds them to PATH at runtime). Then pick **GPU** in
the UI's top bar. CPU is available as a fallback but is too slow for real
collection.

## Development

```powershell
pip install -e ".[dev]"
pytest                      # pure-logic tests need no game or GPU
pytest tests/test_detect.py # one file
ruff check src tests        # lint
```

Tests set `pythonpath = ["src"]`, so they run without an editable install. The
OCR/capture/window backends are imported lazily, so logic tests don't require
RapidOCR models or Windows.

Dev server (auto-reload on by default):

```powershell
.\scripts\start_server.ps1            # -Port, -Background, -NoReload available
```

## Project layout

```text
src/oc/
  cli/            console subcommands (detect, capture, bench, collect, price, prices, serve, view, app, profiles)
  desktop_main.py release-mode entry: server + native window (PyInstaller targets this)
  interfaces.py   the ABCs (one per pluggable backend kind)
  registry.py     name -> implementation registry; lists modules to import
  settings.py     parses config/settings.yaml
  engine.py       the ONLY place that turns backend names into live objects
  types.py        backend-agnostic value types (FractionBox, PixelBox, Frame, …)
  locate.py       find the game window once, then revalidate the cached handle
  capture/        window/screen capture backends (wgc, printwindow, mss, fastcap)
  window/         win32 window provider + DPI awareness + input
  process/        process detection (psutil)
  ocr/            RapidOCR engine wrapper
  detect/         window/state classifier (matcher + classifier) + template match
  collect/        the tick pipeline: reader, grid, stability, precapture, store glue
  numbers/        on-screen number detection / tracking
  learn/          lexicon, fuzzy correctors, confusion map
  store/          stateful dataset store (SQLite) + change history + backups
  source/         producer sources: extract/read/run non-OCR data (parsers, locate)
  enrich/         post-capture enrichers + producers (warframe.market, relics, price sweep)
  profile/        pydantic profile models + YAML loader/merger + pretty view
  runtime/        transient runtime overrides
  jobs/           subprocess job runner
  backup.py       profile/db backup helpers
  eventlog.py     structured event log
  web/            FastAPI app + static ES-module front-end (node view + pretty dashboard)
  web/desktop.py  native-window helpers (open_window, serve_in_thread, free_port)
config/
  settings.yaml   backend choices + tuning
  games/*.yaml    per-game profiles (authored in the UI)
  dictionaries/   shared seed dictionaries
data/             collected records (store.sqlite), lexicon, price + enrichment output
packaging/        app icon generator (make_icon.py)
assets/data-occultist.ico  app icon for the desktop shortcut
#install.bat      double-click wrapper for scripts/install.ps1
#serve.bat        double-click wrapper for scripts/serve.ps1 (supervisor)
scripts/          install.ps1 (setup), start_server.ps1 (dev server), serve.ps1
                  (supervisor), app.ps1 (webview launcher), make_shortcut.ps1
```

## Design notes

- Game knowledge lives in per-game profile YAML, not Python: items, mods, ranks,
  sort orders, grids, and dedupe keys are all profile data.
- Each pluggable kind (capture, OCR, window provider, process detector,
  classifier, corrector, enricher) is a backend behind an ABC, selected in one
  settings file.
- Boxes are stored as fractions (0..1) of the window client area, so a profile
  authored at 1080p resolves correctly at 4K.
- Any pipeline stage can skip a frame, and a record is written only after it reads
  identically for N consecutive frames.
