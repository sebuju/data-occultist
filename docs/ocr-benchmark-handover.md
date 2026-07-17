# OCR pipeline benchmark — handover

> **UPDATE 18/07/26 — implemented.** The floor described below has been attacked; this doc is now
> history + reference. What shipped:
> - **`ro` op**: readout OCR is timed directly (`stats_store` + stats panel), no more residual math.
> - **Gridless windows skip the grid path**: a window with no regions/items no longer pays the
>   whole-canvas OCR (~230ms/tick wasted on `live_game_window`) — `collector.py` gates the
>   signature/read block.
> - **Readout fast poll** (`tuning.readout_fast_poll`, default on): a throttled wake still
>   classifies (cache-cheap) and reads JUST the readouts — trigger cadence rides `gate_interval`
>   (0.25s), the heavy path keeps `collect_interval`.
> - **Colour-masked readouts read rec-only**: the mask output (black glyphs on white) is the
>   presence oracle — all-white → absent with zero OCR; glyphs → ONE batched rec pass
>   (`read_lines`, ppocr5 override via v3 `text_rec`; per-crop, no canvas). A box rec can't
>   segment (empty text despite glyph pixels — digit + cooldown-swirl sharing the mask) falls
>   back to det+rec so no value is lost. Det was also flaky on these masked tiny crops, so this
>   is a quality win too. ~12ms clean / ~100ms live on fallback frames vs ~100ms/box before.
> - **Unchanged-crop memo** (`RegionReader._ro_cache`): each readout's preprocessed crop is
>   compared (tolerant absdiff — exact hashes never survive live sensor noise) to the last
>   OCR'd one; unchanged reuses the last read (including confirmed absence) with zero OCR.
>   Carries static screens (arsenal); the chaotic live HUD rides the rec-only path instead.
> - **Mosaic batching tried and REJECTED**: packing crops into one canvas for one det pass broke
>   read quality — det/rec accuracy depends on the effective upscale each crop gets from det's
>   min-side resize (isolated tiny crops get ×20, canvas slots ~×2), so it missed boxes and
>   misread 5.7→5.1. Do not retry; the memo above wins without touching OCR output.
> - `OcrEngine.read_images(crops)` seam added (default loops `read_image`) — `_detect_reads`
>   sends its cache misses as one batch, so a future backend with a SAFE det-batch can slot in.

Status: ~~investigation only, no code change made to the read path~~ (see update above). This
documents where the live read latency went, what's measured, and the constraints.

Context: a live sound trigger (ability-cooldown countdown crossing <3.0s) was heard ~3s after the
in-game value changed. The **client sound-hop** half of that (~0.8–2.5s) was fixed separately (instant
`fire_events` SSE push — see `store/fire_events.py`, memory `instant-fire-sound-push`). What remains,
and what this doc is about, is the **read-cadence floor**: how fast the pipeline can re-read the value
at all.

## The key finding

`liveLimit` (the frame limiter, settings modal → `POST /api/live/interval` → persisted `live_interval`)
was set to **500ms**, yet live reads land at **~1 frame/second**. So the cadence is **OCR-compute-bound,
not limiter-bound** — the loop cannot re-read faster than one tick's OCR actually takes (~0.7–1s).
Lowering `liveLimit` below the compute cost does nothing.

The user chose to **leave this floor as-is** for now. This handover exists in case that changes.

## The loop

`Collector.run` — `collector.py:702-733`. Two-rate:

- Wakes every `gate_interval` (fast poll, default **0.25s**, `settings.py:46`).
- Runs the OCR-heavy path at most once per `collect_interval` (default **1.0s**, `settings.py:45`;
  live overrides with `live_interval`). Gate: `ocr_due = (now - last_ocr) >= interval` — `collector.py:704`.
- `last_ocr` is stamped only when the heavy path actually ran (`collector.py:706-707`), so a
  heavy-skipped tick (no window) doesn't spend the slot.

## What one OCR-due tick does (all serial, under ONE lock)

`Collector.tick` — `collector.py:315-659`. Everything OCR runs under `with ocr_job(eng.ocr):`
(`collector.py:369`) — serialized against web `/api/preview` / detect calls so they don't thrash the
shared GPU session. Order inside the lock:

1. **classify** — `_classify(frame)` (`collector.py:371`), text/colour detectors. Cached with a
   tolerant compare. Timed → op `cl`.
2. **readouts** — `read_readouts_detailed(...)` (`collector.py:402`) → consensus gate `gate_readouts`
   (`readout_stability.py`, K-of-M = 2-of-3 for the cooldown fields `rof_3/5/7/9`). **This is the
   stage the countdown trigger depends on.** **NOT TIMED — see the gap below.**
3. **grid OCR** — `region_signature` (op `sg`, `collector.py:450`) then, on a pixel-signature miss,
   `self._reader.read(...)` (op `oc`, `collector.py:461-463`). A pixel-identical region is a cache
   hit and skips OCR entirely (`_frame_cache`, `collector.py:452-465`).

Capture (`grab_window`, op `cp`, `collector.py:328/443`) and settle (op `st`, `collector.py:444`)
happen before the lock but are timed under the same window.

## What's already measured — `stats_store`

Per-node execution timings live in `store/stats_store.py`, written by `record_timing(game, node, op, ms, n)`.
Storage: one CSV per node at `data/<game>/stats/<safe(node)>.csv`; rollup is windowed to the last
`WINDOW_N=20` samples. Surfaced by the **stats panel** (`web/routes/stats.py` → `web/static/js/graph/panels/stats.js`;
`aggregate()` / `history()`).

Op codes emitted on the read path (`OPS` in `stats_store.py:53`), all under node `win:<window_id>`:

| op | stage | recorded at |
|----|-------|-------------|
| `cp` | capture (window grab) | `collector.py:443` |
| `st` | settle thumb + staleness diff | `collector.py:444` |
| `cl` | classify | `collector.py:445` |
| `sg` | grid-region change hash (OCR-skip gate) | `collector.py:450` |
| `oc` | grid OCR inference | `collector.py:463` |
| `cf` | temporal confirm gate | `collector.py:515` |
| `cm` | store write + flow bookkeeping | `collector.py:629` |
| `tk` | **whole tick** (t0 → return) | `collector.py:478` (early-return paths) and `639` (full path) |

`tk` is the total wall-time of one OCR-due tick — so **the ~1s read cost is ALREADY logged and visible in
the stats panel** per window, no instrumentation needed.

## The measurement gap (small — the number is already derivable)

The one stage NOT broken out directly is **readout OCR** (`collector.py:402`, `read_readouts_detailed` —
no `record_timing` around it; grep-confirmed nothing times it anywhere). But it runs inside the tick that
`tk` measures, so its cost is obtainable by subtraction:

    ro ≈ tk − (cp + st + cl + sg + oc)     [+ small confirm/commit/overhead]

For a gameplay-HUD window that declares readouts but no grid dataset, `oc` is ~0 (no grid) and `tk`
minus `cp+cl` is essentially the readout cost.

**First step for whoever picks this up:** DON'T build a monitor — it exists (`stats_store` + stats panel).
Just read `tk`/`cp`/`cl`/`sg`/`oc` per `win:<id>` during live play (stats panel, or `data/<game>/stats/win:*.csv`)
and compute the readout residual. Only add a dedicated `ro` op (append to `OPS`, wrap line 402) if the
residual is noisy enough to want a clean number. Don't optimize before this split is known — the dominant
stage is currently a guess.

## How to benchmark

- **Capture path alone:** `data-occultist bench <game> [--seconds N] [--capture wgc|printwindow]`
  (`cli/bench.py`). Reports grabs/s and (WGC) distinct frames/s. No OCR/classify/save — isolates whether
  capture is a contributor. Note: at 4K, capture is known-heavy (memory: WGC ~6fps flip-limited at 4K).
- **Per-stage during live play:** open the stats panel (or read `data/<game>/stats/win:*.csv`) while a live
  session runs. Gives cp/st/cl/sg/oc per window. Add the readout timing first (see gap).
- **Offline reader probe** (memory `offline-reader-probe`): run `RegionReader` offline against the bound
  capture (`_bindings.json`) to time/observe reads without the live loop — good for A/B on a single frame.
- **Preprocess bench:** `scripts/bench_preprocess.py` for the per-readout preprocess (colour mask + upscale).

## Candidate optimizations (once the split is known)

Ranked by likely leverage, all UNVERIFIED — pick after measuring:

1. **Decouple readout OCR from the heavy grid/classify path.** The countdown trigger needs only the 4
   cooldown readouts. If those are cheap relative to the grid, read them on the fast poll (`gate_interval`,
   0.25s) using the last-known window classification, and keep the grid OCR at the 1s interval. Would take
   the trigger's read cadence from ~1/s toward ~4/s. Requires: skip re-classify on the fast readout path,
   skip settle, and mind `ocr_job` lock contention (4× readout OCR/s is 4× the lock hold). This is the real
   architectural win but the biggest change — do it behind the profile model, not a warframe branch.
2. **Check `/api/preview` lock contention.** During live play with the live panel open, a preview OCR can
   hold `ocr_job` (`collector.py:369`) and stall the collector tick — this alone could turn a 500ms read
   into ~1s. Verify whether the live view issues repeated preview OCRs while collecting; if so, gate/skip
   them while a collector is running.
3. **Shrink the readout crop / capture region.** If readout OCR dominates because it OCRs a large region
   at 4K, capture/preprocess only the cooldown crop. See `FieldDef.preprocess` (colour mask + upscale) —
   already the hardening seam (memory `readout-ocr-hardening`).
4. **Faster OCR knobs.** OCR is ppocr5/rapidocr v3 (memory `ppocr5-backend-switch`), thread caps 2/1 for
   game FPS, det-only scale split. Any change here trades game FPS — the whole reason the caps exist.

## Constraints / decisions already made (do not re-litigate blind)

- **FPS is the currency.** Reading faster = more OCR/s = more GPU contention with the game. The thread caps
  and no-GPU-pacing choices exist for game FPS (memory `ppocr5-backend-switch`). Any cadence win must be
  checked against in-game FPS, not just read latency.
- **`stable` aggregate on `ability_register`** (set in commit `94c45e5`) can hold back a fresh reading up
  to ~2s in noisy OCR (`live.py:402-405`, `_STABLE_K`). User chose to **keep it** for noise rejection.
  It's a *separate* lag source from the read cadence — don't conflate.
- **User rejects content-hiding LOD / value filters** (memory: `node-virtualization-rejected`,
  `readout-ocr-hardening`). Fix OCR quality/speed at the source (preprocess, crop), not with downstream
  range caps or consensus hacks.
- **Client sound-hop is already fixed** — don't re-attack it; it's not the remaining floor.

## Pointers

- Loop / tick: `src/oc/collect/collector.py` (`run` 702-733, `tick` 315-659, lock 369, readout 398-427,
  grid 447-465).
- Timings: `src/oc/store/stats_store.py` (`OPS` 53, `record_timing` 195, `aggregate`/`history` 313-337).
- Stats UI: `src/oc/web/routes/stats.py`, `src/oc/web/static/js/graph/panels/stats.js`.
- Capture bench: `src/oc/cli/bench.py`. Web bench route: `src/oc/web/routes/bench.py`.
- Readout consensus gate: `src/oc/collect/readout_stability.py`.
- Frame limiter: `src/oc/web/routes/live.py` (`live_interval` 23-28, `POST /api/live/interval` 94-103),
  UI `#liveLimit` in `settings_modal.js:237`.
- Settings defaults: `src/oc/settings.py:42-52`, mirrored `config/settings.yaml:41-49`.
