# data-rig

> Collect clean, structured data from games by reading the screen — capture the
> game window, recognise which in-game panel is showing, OCR the labelled
> regions, and write deduplicated records. No game-specific code: everything is
> taught through a web UI and stored as per-game config.

`data-rig` watches a game window, figures out **which** window/state is on screen,
reads the data regions you taught it, fuzzy-corrects noisy OCR against a
self-learning per-game dictionary, and writes stable records with full change
history. It is robust to pop-ups, tooltips, occlusion, and scrolling.

**First target:** catalogue the **Warframe** equipment window, then price every
item against [warframe.market](https://warframe.market).

---

## Table of contents

- [Why](#why)
- [Highlights](#highlights)
- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Desktop app](#desktop-app)
- [Tutorial: teach your first window](#tutorial-teach-your-first-window)
- [CLI reference](#cli-reference)
- [How it works](#how-it-works)
- [Profiles: the per-game config](#profiles-the-per-game-config)
- [Where data lives](#where-data-lives)
- [GPU OCR (optional)](#gpu-ocr-optional)
- [Development](#development)
- [Project layout](#project-layout)
- [Design principles](#design-principles)

---

## Why

Games rarely expose their inventory/stats as data. Screen-scraping them usually
means brittle, hard-coded pixel math per game. `data-rig` flips that: the program
knows **nothing** about any game. You teach it — visually — what a window looks
like, where the data sits, and what each region means. That knowledge is saved
as plain config, so adding a game (or a new panel) never touches Python.

## Highlights

- **Teach, don't code.** A web UI lets you draw boxes on a live capture and
  label them. Items, ranks, counts, sort orders, scroll grids — all taught.
- **Resolution-independent.** Every box is stored as a fraction (0..1) of the
  window client area, so a profile authored at 1080p works at 4K.
- **Reads backgrounded windows.** Default capture uses `PrintWindow`, grabbing a
  specific window's surface even when it's unfocused, occluded, or borderless.
- **Robust by construction.** A record is only written after it reads identically
  for N consecutive frames, so transient tooltips and pop-ups never get saved.
- **Self-correcting OCR.** Confident reads teach a per-game dictionary;
  low-confidence reads snap to the nearest known term via fuzzy matching.
- **Stateful storage with history.** Each dataset keeps a current snapshot plus
  an append-only change log (item added, rank 5→6, …), grouped into revertible
  batches.
- **Pluggable everything.** Capture, OCR, window provider, process detector,
  classifier, corrector, enricher — all backends behind ABCs, chosen by name in
  one settings file.
- **Optional enrichment.** A Warframe-market enricher maps item names to market
  slugs and reports min/median platinum prices (run after capture, never in the
  hot loop).

## Requirements

- **Windows** (the window/capture backends use win32; pure-logic code and tests
  run anywhere).
- **Python 3.11+**
- **Edge WebView2 Runtime** — only for the [desktop app](#desktop-app). Preinstalled
  on Windows 11; `install.ps1` sets it up on Windows 10. The browser UI (`data-rig rig`)
  needs nothing extra.
- An **NVIDIA GPU** is recommended — `install.ps1` sets up CUDA OCR automatically when
  it finds one (CPU is a slow fallback; see [GPU OCR](#gpu-ocr-optional)).

## Install

**One-stop (recommended).** Double-click **`install.bat`**, or run:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1 -Cpu   # force CPU OCR (skip CUDA)
```

It checks for Python 3.11+ and the WebView2 runtime and offers to install anything
missing via winget; creates `.venv` and installs the package; **downloads the GPU OCR
stack** (onnxruntime-gpu + CUDA wheels) when an NVIDIA card is present; and drops an
**`data-rig` shortcut** on your Desktop / Start menu. It never reinstalls what you already
have, and exits with a summary if a prerequisite is still missing.

> `.ps1` files open in Notepad on double-click (Windows blocks run-on-click), so
> `install.bat` is the double-click entry — it calls `install.ps1` with the execution
> policy bypassed. It runs as the **normal user** (so the venv and shortcuts are yours);
> only the winget system-installs (Python / WebView2) elevate, via their own UAC prompt.

**Manual.** If you'd rather wire it up yourself:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev,desktop]"   # drop ",desktop" if you only want the browser UI
pip uninstall -y onnxruntime; pip install -e ".[gpu]"   # NVIDIA CUDA OCR (optional)
```

This installs `data-rig` as a console script plus the dev tools (`pytest`, `ruff`) and the
optional `desktop` extra (`pywebview`) for the native window.

## Quickstart

```powershell
data-rig detect                 # which known games are running right now
data-rig rig                  # open the web UI at http://127.0.0.1:8000
data-rig capture warframe --out shot.png   # save one screenshot of the game window
data-rig collect warframe       # run the capture -> OCR -> record loop
data-rig price warframe         # enrich collected records with warframe.market prices
```

For day-to-day UI work, use the dev server script (auto-reloads on code change):

```powershell
.\start_server.ps1                 # http://127.0.0.1:8000, hot-reload on
.\start_server.ps1 -Port 8001
.\start_server.ps1 -Background     # detached
.\start_server.ps1 -NoReload       # single process (no reloader)
```

---

## Desktop app

The same UI can run in a **native window** instead of a browser tab, via
[`pywebview`](https://pywebview.flowlib.org/) (it renders through the Edge WebView2
runtime on Windows — no Electron, no bundled browser). There are three launchers, and
which one you pick decides **who owns the server**:

| launcher | starts a server? | closing the window stops the server? | terminal window? |
| --- | --- | --- | --- |
| **`data-rig` shortcut** / `data-rig app` | yes | **yes** — one process owns both | none (shortcut) |
| `data-rig view` | no — attaches to a running one | no | n/a |
| `data-rig rig` | yes | n/a (no window — it's the browser UI) | yes |

- **`data-rig` shortcut** — the double-click app `install.ps1` puts on your Desktop / Start
  menu. It runs `pythonw -m oc.desktop_main` from the venv (no console window, custom
  icon), so it uses the GPU OCR stack the installer set up — no giant standalone bundle
  to ship. Starts the server, opens the window, and stops the server when you close it.
- **`data-rig app`** — the same release behaviour from a terminal (handy for testing).
- **`data-rig view [--host H] [--port N]`** — attach a window to a server you already
  started with `data-rig rig` (default `127.0.0.1:8000`). Closing it leaves that server
  running.

> Why a shortcut and not a packaged `.exe`? A standalone exe would have to bundle the
> CUDA OCR runtime (multiple GB). The shortcut reuses the installed venv instead, so
> GPU OCR works and there's nothing huge to commit or download twice.

---

## Tutorial: teach your first window

This walks through teaching `data-rig` to read a game panel from scratch. We'll use
Warframe's inventory, but the steps are identical for any game.

### 0. Start the game and the UI

Launch the game and open the panel you want to read (e.g. the Equipment /
Inventory screen). Then start the web UI:

```powershell
.\start_server.ps1
```

Open <http://127.0.0.1:8000>. The UI is a node graph: a `game` node on the left,
with windows, regions, detectors, datasets, and subsets branching off it.

### 1. Create a profile and a window

- Add a game profile (name it, e.g. `warframe`) — this becomes
  `config/games/warframe.yaml`.
- Add a **window** node. A window is one recognisable panel of the game.
- Open the window's **image** node and click **recapture** — `data-rig` grabs the live
  game window and shows its client area. Because the picture *is* the client
  area, any box you draw ÷ image size **is** the fraction coordinate stored.

### 2. Draw a detector so `data-rig` recognises the panel

`data-rig` must know it's actually looking at this panel before it reads anything.

- Pick the **detect** tool and draw a box around a stable label that only appears
  on this screen — e.g. the `EQUIPMENT` / `INVENTORY` heading.
- A detector matches by **OCR text** (type the expected text, e.g. `INVENTORY`)
  or by **template image**. Set a `threshold` (default 0.8).
- A window matches only when **all** its enabled detectors match. The detector
  node shows a live ✓/✗ as you tweak it — recapture and watch it light up.

> A window with no detectors never matches — by design. That's how `data-rig` avoids
> reading the wrong screen.

### 3. (Optional) Teach states

A **state** is a distinguishable mode of the window — usually a sort order. Draw
a state detector over the "sorted by name ▼" indicator, and mark which states are
`valid_for_save`. Records are only written while the window is in a save-worthy
state, so you never catalogue data in the wrong order.

### 4. Mark the data area and an item template

- Draw a **data area** box to constrain OCR to the list region (stray UI text
  elsewhere is then never read).
- Draw an **item** box around a single list cell. `data-rig` freezes that cutout and
  spawns an *item template* node. Inside it you define, **relative to the cell**:
  - **fields** — the regions to OCR (e.g. `name`, `count`), each mapped to a
    field with a type (`text`, `number`, `pips`, `diamonds`) and extraction rule.
  - **tells** — signals that a cell is a real item (has text / a colour / a
    template match), so empty slots and tooltips are rejected.
  - a **locator** tell/field that finds row positions, so one template reads
    every row regardless of scroll.

### 5. Tune fields

For each field you can set:

- **type** — `text`, `number`, `pips` (count glowing dots, e.g. mod rank), or
  `diamonds` (count filled rank diamonds).
- **extract** — `whole`, `number`, `number_before/after`, `text_before/after`
  (with a `separator`, e.g. a mod rank `"7 / 10"`).
- **learn** — turn on for identity text (item names): confident reads teach the
  dictionary, uncertain reads are fuzzy-corrected against it.
- **fuzzy** — the similarity (0..1) an uncertain read must reach to snap to a
  known term.
- **dict mode** — how the authored dictionary participates, word per word:
  `off` (not consulted), `correct` (fix words, keep unmatched), `drop`
  (validate only — a read with an unknown word is dropped), `correct + drop`
  (fix what matches, drop a read with an unmatchable word).

### 6. Preview, then collect

- Hit **preview** to OCR the current layout against the captured image and see
  exactly what each field reads, with confidence.
- When it looks right, **save** (the UI writes the profile YAML), then run the
  live loop:

```powershell
data-rig collect warframe
```

Scroll the in-game list while it runs — `data-rig` stitches rows across scrolls,
dedupes by key, and writes records once they stabilise. Inspect results under
`data/warframe/` (see [Where data lives](#where-data-lives)) or on the dashboard
at <http://127.0.0.1:8000/dash.html>.

### 7. Price it (Warframe)

```powershell
data-rig price warframe --window equipment
```

This reads the collected records, maps each item name to its warframe.market
slug, fetches live sell orders, and writes a `*.enriched.jsonl` with min/median
platinum.

> **Tip — precapture for fast lists.** Live OCR can't keep up with fast
> scrolling. The UI's *precapture* mode records frames as fast as the capture
> backend allows (no OCR), then batch-OCRs them afterward and stages the results
> for you to review and save. Recordings persist to disk, so they survive a
> server restart and can be re-processed.

---

## CLI reference

```text
data-rig detect                                   list running known games
data-rig rig [--host H] [--port N] [--reload]   launch the web UI (browser)
data-rig view  [--host H] [--port N]              native window onto a RUNNING server
data-rig app                                      release: server + native window, stop on close
data-rig capture <game> [--out capture.png]       save one screenshot of the window
data-rig collect <game> [--once] [--interval 1.0] run the capture -> OCR -> record loop
data-rig price   <game> [--window equipment]      warframe.market enrichment
           [--source warframe_market] [--name-field name]
data-rig prices  <game> [--dataset master]        sweep market price history into a store
data-rig profiles                                 list game profiles
```

## How it works

The collection pipeline is a chain where **every stage can reject** — that's how
robustness is enforced:

1. **Locate** — is the process running? Is the window found (and foreground, if
   required)? A cached window handle is revalidated each frame, never rescanned.
2. **Classify** — `WindowClassifier` matches detectors → `(window_id, state_id)`.
   No match → skip (wrong screen / occluded).
3. **Gate** — the state must be `valid_for_save`, else skip (wrong sort order).
4. **Read** — `RegionReader` OCRs each grid cell. A record's confidence is its
   **worst** field, so one occluded region drops the record.
5. **Confirm** — a record must read identically for `confirm_frames` consecutive
   frames before it's written. Transient pop-ups never stabilise, so they're
   never saved. This also dedupes.
6. **Store** — survivors go to the dataset's store, keyed by dataset so windows
   that share a dataset dedupe against each other.

**Enrichment** runs *after* capture (never in the loop, so network issues can't
hurt robustness): it reads a `.jsonl` and writes a `.enriched.jsonl`.

The whole system is **backends behind ABCs, chosen by name**. Contracts live in
`src/oc/interfaces.py`; implementations self-register via decorators; and
`config/settings.yaml` picks the backend for each kind plus tuning knobs:

```yaml
capture: printwindow   # window-targeted; works backgrounded/occluded
window: win32          # locates the game window
process: psutil        # finds the running game
ocr: rapidocr          # reads text from regions
classifier: detect     # decides window + state from detectors
corrector: rapidfuzz   # fuzzy-corrects uncertain OCR

tuning:
  accept_confidence: 0.88   # >= this: trust + learn the term
  min_confidence: 0.50      # worst-field floor; below -> drop record
  confirm_frames: 2         # stable frames required before saving
  require_foreground: false # true only for screen-region capture
```

Swapping a backend = change one name (and make sure a module registers it).

## Profiles: the per-game config

`config/games/<game>.yaml` is validated by pydantic models in
`src/oc/profile/models.py`. A `GameProfile` has process names plus windows; each
`WindowDef` has:

- **`detect`** — detectors that recognise the window (text or template).
- **`states`** — distinguishable modes, each with its own detectors and a
  `valid_for_save` flag.
- **`regions`** / **`items`** — what to OCR and which field each feeds. Item
  templates are matched across the data area and read cell-relative.
- **`dataset`** — the logical collection these records join (defaults to the
  window id). Several windows can share a dataset to merge overlapping data.
- an optional **`scroll`** grid describing how rows tile and which field dedupes.

You should never need to hand-edit this YAML — author it all in the UI.

## Where data lives

```text
data/<game>/
  <dataset>.state.json      current keyed records (first/last seen)
  <dataset>.history.jsonl   one change event per line (add / update / remove)
  lexicon.json              the self-learned per-game dictionary
  *.enriched.jsonl          enrichment output (e.g. market prices)
```

A dataset is **not** an append-only log: `record_seen()` logs an add (new key) or
update (a field changed) and merges into the snapshot. **Removals** are a
separate reconcile step, only run after a *complete* pass and gated behind
`tuning.detect_removals` (off by default) — a partial/occluded view must never be
mistaken for "sold/deleted".

## GPU OCR (optional)

OCR runs on CPU by default. For NVIDIA GPUs (CUDA 12 / cuDNN 9 on Windows):

```powershell
pip uninstall -y onnxruntime
pip install -e ".[gpu]"
```

`onnxruntime-gpu` replaces `onnxruntime`; the bundled `nvidia-*-cu12` wheels ship
the CUDA DLLs (the OCR engine adds them to PATH at runtime). Then pick **GPU** in
the UI's top bar.

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
.\start_server.ps1            # -Port, -Background, -NoReload available
```

## Project layout

```text
src/oc/
  cli/            console subcommands (detect, capture, collect, price, prices, teach, view, app, profiles)
  desktop_main.py release-mode entry: server + native window (PyInstaller targets this)
  interfaces.py   the ABCs (one per pluggable backend kind)
  registry.py     name -> implementation registry; lists modules to import
  settings.py     parses config/settings.yaml
  engine.py       the ONLY place that turns backend names into live objects
  types.py        backend-agnostic value types (FractionBox, PixelBox, Frame, …)
  capture/        screen/window capture backends (printwindow, mss)
  window/         win32 window provider + DPI awareness
  process/        process detection (psutil)
  ocr/            RapidOCR engine wrapper
  detect/         window/state classifier (matcher + classifier) + template match
  collect/        the tick pipeline: reader, grid, stability, precapture, store glue
  learn/          lexicon, fuzzy correctors, confusion map
  store/          stateful dataset store + change history + batches
  enrich/         post-capture enrichers (warframe.market, relics)
  profile/        pydantic profile models + YAML loader/merger
  web/            FastAPI app + static ES-module front-end (web UI, dashboard)
  web/desktop.py  native-window helpers (open_window, serve_in_thread, free_port)
config/
  settings.yaml   backend choices + tuning
  games/*.yaml    per-game profiles (authored in the UI)
data/             collected records, history, lexicon, enrichment output
packaging/        app icon generator (make_icon.py)
assets/oc.ico     app icon for the desktop shortcut
install.ps1       one-stop Windows setup (winget GPU OCR + desktop shortcut)
install.bat       double-click wrapper for install.ps1
```

## Design principles

- **Zero game knowledge in Python.** If a capability would otherwise be
  hard-coded per game, it belongs in the profile model + web UI instead.
- **Backends never import each other** — only `interfaces`/`types`. Cross-backend
  wiring happens only in `engine.py`.
- **Many small, single-concern files**; refactor wide for coherence.
- **Windows-first**, but non-Windows backends simply don't register, so logic and
  tests still work everywhere.

See [CLAUDE.md](CLAUDE.md) for the deeper architecture notes.
