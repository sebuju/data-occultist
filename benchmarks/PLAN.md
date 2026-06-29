# Live-mode performance: benchmark plan + improvement candidates

Scope: every function on the **per-tick** path of `Collector.tick()` (CLI `collect`
and the web live session). Goal of this round: **measure the before, plan the after.**
No optimization is applied yet.

## 1. What now measures the hot path

### Live, per-stage (real game session) — `oc.store.stats_store`
`collector.tick()` now records one timing sample per stage under `win:<id>`, on top
of the existing `tk` (whole tick) and `oc` (OCR read):

| code | stage | covers |
|------|-------|--------|
| `tk` | tick | whole pass (already existed) |
| `oc` | ocr | `RegionReader.read` OCR inference (already existed) |
| `st` | settle | `settle.thumb` + `is_settled` staleness diff |
| `cl` | classify | `_classify` (window/state detect pass) |
| `sg` | signature | `region_signature` (OCR-skip change hash) |
| `cf` | confirm | `Confirmer.observe` temporal gate |
| `cm` | commit | store write + flow publish + mirror sync |

These show in the graph **Stats panel** (new buckets added to `OP_GROUPS`). This is
the authoritative before for the costs that need a real frame (capture, OCR) and the
real per-screen record counts. **Capture (`grab_window`) is still not broken out** —
it is the gap between `tk` and the sum of the stages; add a `cp` code if we want it
explicit (one more `record_timing`).

### Offline, pure-logic — `benchmarks/bench_live.py`
Standalone, no deps, no game/GPU. Times the logic-only stages over a synthetic 4K
frame + stubbed OCR so they can be tracked in isolation and in CI-like runs. Baseline
captured in `baseline.md`. `--real-ocr` adds an approximate CPU OCR floor.

## 2. Improvement candidates (NOT YET APPLIED)

Ordered by expected win (measured medians from `baseline.md`). Each notes the code that
should move.

> **Headline:** `settle.thumb` measures **~127 ms** on a 4K frame — it RUNS EVERY TICK
> (including moving/rejected frames) and is **~99% of the pure-logic per-tick cost**.
> Every other logic stage is sub-millisecond. This is the per-tick floor before capture
> or OCR; fixing it (candidate **0**) is worth more than everything else combined.

### 0. `settle.thumb` is the per-tick floor — ~118 ms/4K frame  *(st)*  **[DONE]**
`image.max(axis=2)` reduced all ~25M uint8 elements of a 4K BGR frame, then `cv2.resize`
(INTER_AREA) shrank the full-res frame to 48² — both on every grab.
**Fix applied** (`settle.py`): stride-subsample to a coarse intermediate (short side ~4·THUMB)
**first**, then run `.max(axis=2)` + INTER_AREA on that tiny array (~50x fewer elements). Kept
the channel-max (not a single channel) so the signature magnitude — and thus `THUMB_TOL`/
`MIN_CELLS` — is unchanged; only the sampling grid differs, which a coarse 48² diff is robust to.
Guarded by new `tests/test_settle.py` (identical→settled, big change→motion, cursor twitch→settled).

| measure | before | after | speedup |
|---|---|---|---|
| `settle.thumb (4K)` | 118.0 ms | **1.14 ms** | ~104x |
| `TICK end-to-end (real)` | 117.86 ms | **2.72 ms** | ~43x |

The pure-logic per-tick floor is now ~2.7 ms; live ticks are capture/OCR-bound as intended.
See `baseline.md` (before) vs `after.md` (after).

### A. Cache the authored grid + targets per window  *(sg, oc, tk)*
`expand_cells(window)` and `_targets_from_cells(...)` rebuild every tick, and **2-3x
per tick**: `region_signature` → `_pixel_targets` → `expand_cells`, then `read` →
`_resolve_cells` (static path) → `expand_cells`, then `_read_cells` → `_targets_from_cells`
again. The authored grid only changes when the profile is edited.
- Cache `expand_cells(window)` and the resolved pixel-`targets` keyed by window id +
  client (w,h). Invalidate on profile reload / resolution change.
- `region_signature` does not need per-field targets at all — it only needs the
  **union box**. Compute/caches the union once instead of tiling every field.

### B. `region_signature` should hash the data-area crop, not the field union  *(sg)*
For grid/item windows the meaningful change region is `data_area`. Hashing one
`data_area` crop (a single slice + strided `tobytes`) is cheaper and more correct than
unioning per-field static-grid boxes (which can miss dynamically-detected rows).

### C. One frame downsample shared by all three change gates  *(st, cl, sg)*
Each tick does **three** independent numpy downsample+hash passes over (overlapping)
regions: `settle.thumb` (whole frame → 48²), `_detect_signature` (detector regions),
`region_signature` (grid region). Compute one coarse grayscale downsample of the client
area once and slice the sub-rects from it for the two signature hashes. Saves two
crop+`tobytes`+`hash` passes.

### D. (folded into candidate 0 — settle.thumb is the headline fix)

### E. `_gather` is O(cells·fields·lines)  *(oc/read)*
`_read_cells` calls `_gather(lines, box)` per target; each `_gather` scans **all** OCR
lines (`_center_in`) and sorts the hits. For a 24-cell × 2-field grid with ~50 lines
that is ~2400 center tests + many small sorts per read. Pre-bucket lines into cells once
(by y-band → cell row, then x → col), turning it into O(lines + cells).

### F. `Confirmer._signature` via `json.dumps` per record per tick  *(cf)*
`json.dumps(values, sort_keys=True, default=str)` for every kept record every tick is
heavy next to the rest of `observe`. A `tuple(sorted(values.items()))` repr (or a hash)
is far cheaper and equally stable as a change key.

### G2. Batch the classifier's per-window title reads  *(cl)*  **[REVERTED — regressed]**
Tried: gather every text-detector box and recognise them in ONE `read_lines` batch before the
window walk. Measured WORSE live (~80 ms → 120-224 ms) and reverted. Two reasons it backfired:
(1) it defeated `combine_passes`' short-circuit — windows that fail a cheap/template detector
first never read their text box, but eager batching read them all; (2) RapidOCR's batched
`text_rec` pads every crop to the batch's max width, and the title crops are WIDE at 4K, so the
padded batch did more work than the sequential rec-only `read_line` calls. Lesson: don't batch
when the sequential path short-circuits AND the crops have very different widths.

Real levers for `cl` instead (highest first):
- **Classify cache must hold.** `_classify` skips the whole pass when `_detect_signature`
  (downsampled hash of the detector regions) is unchanged. If `cl` is ~80 ms EVERY settled tick,
  some detector search box overlaps animating pixels (cursor, blink, tooltip) → cache never holds
  → re-OCR every tick. Fixing that drops `cl` to ~0 on steady screens — far bigger than any read
  speedup. Diagnose: log signature hits/misses, or shrink/move the offending detector box.
- **Template, not text, for the title landmark.** `cv2.matchTemplate` is far cheaper than an OCR
  recognition pass; a title bar is a fixed glyph image. Authoring the window detector as a
  template tell instead of text removes the read entirely (profile change, not code).
- **Run OCR on GPU / cap CPU threads** (see the CPU note below) — moves the cost off the CPU.

### G. Classifier double-scores detectors  *(cl)*
`classify` runs `_window_matches` (→ `matcher.score`) for **all** windows, then
`_window_score` recomputes `matcher.score` for candidates, then `_state_for` again.
Text reads are memoised per frame (cheap re-call) but **template `score` is not** —
`best_match` (`cv2.matchTemplate`) re-runs. Two fixes:
- Memoise `score()` per `(detector identity, frame)`, not just the OCR read.
- Have `_window_matches` return the per-detector scores it computed and feed them to
  `_window_score` (no recompute). Note this whole pass is skipped on an unchanged
  screen via the `_classify` cache, so the win is concentrated on scrolling sessions.

### H. `record_timing` walks the whole buffer every call  *(tk overhead)*
`pending = sum(len(rows) for rows in _buffer[game].values())` runs on **every** sample;
with the new per-stage codes that is ~8 calls/tick. Keep a running pending counter
instead of summing each call. (Self-inflicted by the instrumentation — worth doing.)

### I. Micro: hoist `import re` out of `matcher._norm`  *(cl)*
`_norm` does `import re` on every call (cached by Python but still a dict lookup +
function-call overhead per detector per frame). Move to module top.

### Out of scope for Python-level perf (noted, not planned here)
- `capture.grab_window` — backend cost (WGC already default; flip-limited ~6fps at 4K).
- OCR inference — model/engine cost; already tuned (rec batch 16, cls dropped, CUDA
  arena caps, downscaled detect). The biggest absolute cost but not a logic fix.

## 3. After we optimize
Re-run `bench_live.py --md after.md` and diff against `baseline.md`; compare live
`tk`/stage medians in the Stats panel across a matched session. A candidate that does
not move its tagged code gets reverted.
