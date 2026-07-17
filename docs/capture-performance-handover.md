# Capture performance — handover

Status: **fix 1 SHIPPED (18/07/26)** — persistent thread-local `mss.MSS` instance +
`cv2.cvtColor` alpha drop in `capture/mss_backend.py`; bench `mss` went 13/s → 27.1/s
(36.95 ms/grab) at 4K, exactly the predicted floor. Fix 2 (partial-region grabs) remains
open and is the next step. Original investigation below, kept for the numbers. After the
readout-OCR work (18/07/26, see `docs/ocr-benchmark-handover.md`), OCR fell from ~600ms to
~20-85ms per readout tick — which makes **capture the dominant per-tick cost**: `cp` runs
~70-110ms per grab at 4K, paid on EVERY fast-poll wake (~3/s live). This documents where that
time goes, what's already measured, and the candidate fixes, so the work can be picked up cold.

## Current wiring

- `config/settings.yaml` capture = **`adaptive`** (`capture/adaptive_backend.py`): per grab it
  checks `GetForegroundWindow` — game foreground → **mss** (desktop BitBlt, CPU-only, no game
  re-render); backgrounded/occluded → **printwindow** (window's own surface, per-grab re-render
  cost). Black-frame guard falls foreground grabs back to the surface grab (exclusive
  fullscreen). So during live play the cost IS the mss path.
- `capture/mss_backend.py`: creates a **new `mss.mss()` instance per grab** (comment: one
  instance is not thread-safe — collector, precapture, and web preview all grab through the one
  shared `engine.capture`), then `np.asarray(shot)[:, :, :3].copy()` to drop alpha.
- One full-window grab per collector tick (`collector.py` `tick`, op `cp` in stats), including
  every readout fast-poll wake (`tuning.readout_fast_poll`).

## Where the ~80ms actually goes (measured 18/07/26, 3840×2160 primary)

Micro-bench of the exact backend pipeline, 10 reps, min/avg ms:

| piece | min | avg | note |
|---|---|---|---|
| full current pipeline (per-grab instance + slice copy) | 63.6 | 76.8 | matches live `cp` |
| `sct.grab` alone, persistent instance | 28.7 | 35.9 | the real BitBlt floor at 4K |
| `np.asarray(shot)[:, :, :3].copy()` | 25.6 | 28.6 | strided copy — the silent hog |
| same conversion via `cv2.cvtColor(BGRA2BGR)` | 2.9 | 3.5 | ~9× cheaper (SIMD) |
| per-grab `mss.mss()` instance overhead | ~10-15 | | derived: full − (grab + copy) |

So the 4K BitBlt itself is only ~30-36ms; the other half is instance churn + a slow
alpha-drop copy.

## Candidate fixes (ranked)

1. **[DONE 18/07/26] Persistent mss instance + `cv2.cvtColor`** — low-risk, pure win: `cp` ~80 → ~35ms.
   Shipped as written: `threading.local()` instance in `MssCaptureBackend` (with a
   drop-and-retry-once guard for stale handles after a display-config change), `mss.MSS()`,
   `cvtColor(BGRA2BGR)`. Verified: bench 27.1 grabs/s, pixel-identical output to the old
   slice path, 4-thread concurrent grabs clean.
   - Thread safety is WHY it's per-grab today: use `threading.local()` holding one instance
     per thread (collector thread, precapture thread, web workers each get their own).
   - Replace the `[:, :, :3].copy()` slice with `cv2.cvtColor(np.asarray(shot),
     cv2.COLOR_BGRA2BGR)`.
   - Note: `mss.mss` is deprecated in the installed version → use `mss.MSS`.
2. **Partial-region grabs on the readout fast path** — the end-game (~5ms): a fast-poll wake
   only needs the READOUT boxes (+ the classify cache's detector sample regions, `detsig`) —
   not the full 4K frame. BitBlt cost scales with area; the readout boxes are a few thousand
   px². Architectural: `Frame` is full-window (fraction→pixel math assumes it), settle thumb
   needs the full frame (fast readout ticks already ignore settle), classify's tolerant
   compare needs the detector regions grabbed too. Do it behind the profile model — a generic
   "grab these fraction boxes" capture call — not a readout special case. With OCR at ~12ms
   this is what makes a true 4/s cadence reachable (gate_interval 0.25 + ~20ms work).
3. **WGC revisited** (`wgc` backend): a grab returns the latest DWM-composited frame (cheap
   per grab, no re-render), but the session STREAMS off the GPU the whole time — rejected as
   the default precisely because GPU contention while playing is the currency (memories
   `wgc-default-capture`, `ppocr5-backend-switch`). Known: ~6fps distinct frames at 4K
   (flip-limited). Only revisit if 1+2 aren't enough, and check in-game FPS, not just cp.
4. **printwindow (background path)**: separate cost profile — every grab forces the game to
   re-render (stutter). Only matters when collecting backgrounded; measure before touching.

## Tooling

- **`data-occultist bench <game> [--seconds N] [--capture mss|wgc|printwindow]`**
  (`cli/bench.py`) — pure grab_window loop, reports grabs/s and (WGC) distinct frames/s.
  A/B backends without editing settings.
- **Live per-tick numbers**: stats panel / `data/<game>/stats/win_*.csv`, op `cp` (grab) next
  to `st`/`cl`/`ro`/`oc`/`tk`.
- Micro-bench split: time `mss.MSS()` reuse vs per-grab, `sct.grab(box)`, and the BGRA→BGR
  conversion separately (10-rep min/avg; numbers above from exactly this).
- `capture/fastcap.py` — standalone high-rate burst capturer (ring buffer, WGC dedup); not
  wired into collection, useful as a reference for streaming-style capture.

## Constraints / context (don't re-learn these)

- **GPU/game FPS is the currency** — a capture change that loads the GPU (WGC stream) trades
  the wrong resource even if `cp` improves. Verify with in-game FPS.
- `adaptive.streaming = False` on purpose: a grab is a real BitBlt/re-render — never
  tight-loop it (precapture relies on this flag too).
- Exclusive-fullscreen returns BLACK to desktop BitBlt — the adaptive fallback (and
  precapture's guard) must survive any refactor.
- The shared `engine.capture` is hit from multiple threads (collector, precapture, web
  preview) — that's the reason for today's per-grab instance; any persistent-handle fix must
  be per-thread.
- Readout OCR is no longer the floor: `ro` ~20-85ms live (rec-only masked path). After fix 1,
  the fast-tick budget is ~35 cp + ~15 cl + ~20-60 ro ≈ 70-110ms → ~2.5-3/s; after fix 2,
  ~4/s (gate_interval-bound).
