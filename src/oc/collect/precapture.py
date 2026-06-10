"""Precapture: record screenshots fast, then OCR them in a batch.

Live collection pays OCR + detection latency on every frame, so it can't keep up
with fast scrolling. Precapture splits the cost in two:

  1. **record** — a worker thread grabs frames as fast as the capture backend allows
     and stashes them JPEG-compressed (no OCR). Frames are written to disk too, so a
     session survives the modal closing AND a server restart, and can be re-processed.
  2. **process** — a second worker decodes each frame and runs the real pipeline
     (classify -> read -> stage), reporting progress and the data pulled so far, and
     honouring pause/cancel. One bad frame is skipped, never hangs the run.

Then the user **saves** the staged records into the real dataset (or discards them).

Speed comes from two skips during processing: when the *anchor* regions are
pixel-identical to the previous frame we reuse the last window/state classification,
and when a window's *data area* is identical we reuse its last read.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

import cv2
import numpy as np

from ..engine import Engine
from ..learn.confusions import ConfusionMap
from ..learn.lexicon import Lexicon
from ..learn.resolver import FieldResolver
from ..locate import WindowLocator
from ..profile.models import GameProfile, WindowDef
from ..store import DatasetStore
from ..store.dataset_store import norm_key
from ..types import Frame, FractionBox, PixelBox
from .collector import _load_cutouts
from .reader import RegionReader


class Phase(str, Enum):
    idle = "idle"
    recording = "recording"
    recorded = "recorded"
    processing = "processing"
    paused = "paused"
    done = "done"
    cancelled = "cancelled"
    saved = "saved"


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def _sig(image: np.ndarray) -> int:
    """Cheap downsampled pixel hash, like the reader's region signature."""
    if image is None or image.size == 0:
        return 0
    sy = max(1, image.shape[0] // 32)
    sx = max(1, image.shape[1] // 32)
    return hash(image[::sy, ::sx].tobytes())


_THUMB = 48          # frame thumbnail side for the perceptual diff
_THUMB_TOL = 16      # per-cell brightness delta that counts as "changed"
_THUMB_MIN_CELLS = 10  # below this many changed cells -> nothing real moved (cursor/noise)


def _thumb(image: np.ndarray) -> np.ndarray:
    gray = image.max(axis=2) if image.ndim == 3 else image
    return cv2.resize(gray, (_THUMB, _THUMB), interpolation=cv2.INTER_AREA)


def _changed_cells(a: np.ndarray, b: np.ndarray) -> int:
    return int((cv2.absdiff(a, b) > _THUMB_TOL).sum())


def _anchor_boxes(profile: GameProfile) -> list[FractionBox]:
    """Every region used for window/state detection — anchors on windows and states."""
    out: list[FractionBox] = []
    for w in profile.windows:
        for a in w.anchors:
            if a.enabled:
                out.append(a.search.to_fraction())
        for s in w.states:
            for a in s.anchors:
                out.append(a.search.to_fraction())
    return out


@dataclass
class _Staged:
    """Dedup accumulator for one dataset: key -> latest record values."""
    key_field: str
    rows: dict[str, dict] = field(default_factory=dict)


class PrecaptureSession:
    """One precapture run for a game. All public methods are thread-safe."""

    def __init__(self, engine: Engine, profile: GameProfile) -> None:
        self._engine = engine
        self._profile = profile
        self._tuning = engine.settings.tuning
        self._locator = WindowLocator(engine)
        self._lexicon = Lexicon.for_game(engine.settings.data_dir, profile.name)
        self._confusions = ConfusionMap.for_game(engine.settings.data_dir, profile.name)
        resolver = FieldResolver(self._lexicon, engine.corrector, self._tuning.accept_confidence,
                                 confusions=self._confusions)
        self._reader = RegionReader(engine.ocr, resolver, cutouts=_load_cutouts(engine, profile))
        self._anchor_fracs = _anchor_boxes(profile)
        self._dir = Path(engine.settings.captures_dir) / _safe(profile.name) / "precapture"

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._thread: threading.Thread | None = None

        self._frames: list[bytes] = []        # JPEG-encoded captures
        self._client: tuple[int, int] = (0, 0)
        self._staged: dict[str, _Staged] = {}
        self._phase = Phase.idle
        self._processed = 0
        self._read = 0          # records read this run (above the confidence floor)
        self._no_key = 0        # records dropped because they had no value under the dataset key
        self._t_decode = self._t_classify = self._t_read = 0.0   # perf accumulators (s)
        self._t0 = 0.0
        self._error: str | None = None
        self._rehydrate()

    # ---- disk persistence --------------------------------------------------

    def _rehydrate(self) -> None:
        """Reload frames recorded in a previous run (survives modal close / restart)."""
        try:
            files = sorted(self._dir.glob("*.jpg"))
        except OSError:
            return
        if not files:
            return
        frames = []
        for f in files:
            try:
                frames.append(f.read_bytes())
            except OSError:
                pass
        if not frames:
            return
        self._frames = frames
        img = cv2.imdecode(np.frombuffer(frames[0], np.uint8), cv2.IMREAD_COLOR)
        if img is not None:
            self._client = (img.shape[1], img.shape[0])
        self._phase = Phase.recorded

    def _clear_dir(self) -> None:
        try:
            if self._dir.exists():
                for f in self._dir.glob("*.jpg"):
                    f.unlink()
        except OSError:
            pass

    # ---- recording ---------------------------------------------------------

    def start_recording(self, max_frames: int = 300, interval_ms: int = 0) -> None:
        with self._lock:
            if self._phase in (Phase.recording, Phase.processing):
                return
            self._clear_dir()
            self._reset_locked()
            self._dir.mkdir(parents=True, exist_ok=True)
            self._phase = Phase.recording
            self._stop.clear()
            self._t0 = time.monotonic()
        self._thread = threading.Thread(
            target=self._record_loop, args=(max_frames, interval_ms / 1000.0), daemon=True)
        self._thread.start()

    def _record_loop(self, max_frames: int, interval: float) -> None:
        eng = self._engine
        last_thumb: np.ndarray | None = None
        # Floor the per-iteration delay so a static screen (every frame a duplicate)
        # can't spin the CPU and starve the web server — caps capture at ~30 fps.
        delay = max(interval, 0.03)
        try:
            while not self._stop.is_set():
                with self._lock:
                    if len(self._frames) >= max_frames:
                        break
                win = self._locator.locate(self._profile)
                if self._stop.is_set():       # locate can be slow (process scan) — bail promptly
                    break
                if win is None:
                    time.sleep(0.3)           # no window: back off, don't hammer the scan
                    continue
                frame = eng.capture.grab_window(win)
                thumb = _thumb(frame.image)
                if last_thumb is None or _changed_cells(thumb, last_thumb) >= _THUMB_MIN_CELLS:
                    ok, buf = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
                    if ok:
                        last_thumb = thumb
                        data = buf.tobytes()
                        with self._lock:
                            idx = len(self._frames)
                            self._frames.append(data)
                            self._client = (frame.client.w, frame.client.h)
                        try:
                            (self._dir / f"{idx:05d}.jpg").write_bytes(data)
                        except OSError:
                            pass
                time.sleep(delay)             # always yield — no tight loop on duplicates
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._error = str(exc)
        finally:
            with self._lock:
                if self._phase is Phase.recording:
                    self._phase = Phase.recorded

    def stop_recording(self) -> None:
        self._stop.set()

    # ---- processing --------------------------------------------------------

    def start_processing(self) -> None:
        with self._lock:
            if self._phase in (Phase.recording, Phase.processing) or not self._frames:
                return
            self._phase = Phase.processing
            self._processed = 0
            self._read = 0
            self._no_key = 0
            self._staged = {}
            self._error = None
            self._t_decode = self._t_classify = self._t_read = 0.0   # perf accumulators (s)
            self._stop.clear()
            self._pause.clear()
            self._t0 = time.monotonic()
            frames = list(self._frames)
            cw, ch = self._client
        self._thread = threading.Thread(target=self._process_loop, args=(frames, cw, ch), daemon=True)
        self._thread.start()

    def _process_loop(self, frames: list[bytes], cw: int, ch: int) -> None:
        eng = self._engine
        floor = self._tuning.min_confidence
        last_anchor_sig: int | None = None
        last_match = None
        last_data_sig: dict[str, int] = {}
        last_records: dict[str, list] = {}
        errors = 0
        for buf in frames:
            if self._stop.is_set():
                with self._lock:
                    self._phase = Phase.cancelled
                return
            while self._pause.is_set() and not self._stop.is_set():
                time.sleep(0.05)

            dt_decode = dt_classify = dt_read = 0.0
            try:
                t = time.perf_counter()
                img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
                dt_decode = time.perf_counter() - t
                if img is None:
                    raise ValueError("undecodable frame")
                frame = Frame(image=img, client=PixelBox(0, 0, cw or img.shape[1], ch or img.shape[0]))

                asig = self._signature(frame, self._anchor_fracs)
                if asig is not None and asig == last_anchor_sig:
                    match = last_match
                else:
                    t = time.perf_counter()
                    match = eng.classifier.classify(frame, self._profile)
                    dt_classify = time.perf_counter() - t
                    last_anchor_sig, last_match = asig, match

                if match is not None:
                    window_id, state_id = match
                    window = self._profile.window(window_id)
                    if window is not None and self._state_allows_save(window, state_id):
                        t = time.perf_counter()
                        records = self._read_cached(frame, window, last_data_sig, last_records)
                        dt_read = time.perf_counter() - t
                        self._stage(window, [r for r in records if r.confidence >= floor])
            except Exception as exc:   # a bad frame must never stall the whole run
                errors += 1
                with self._lock:
                    self._error = f"{exc} ({errors} frame(s) failed)"

            with self._lock:
                self._processed += 1
                self._t_decode += dt_decode
                self._t_classify += dt_classify
                self._t_read += dt_read
            time.sleep(0)   # yield the GIL so the web server services status/cancel promptly

        with self._lock:
            self._phase = Phase.done
        self._log_perf(errors)

    def _read_cached(self, frame: Frame, window: WindowDef, last_sig: dict, last_recs: dict) -> list:
        sig = self._reader.region_signature(frame, window)
        if sig is not None and last_sig.get(window.id) == sig:
            return last_recs.get(window.id, [])
        fields = {f.id: f for f in self._profile.fields_for(window)}
        records = self._reader.read(frame, window, fields)
        if sig is not None:
            last_sig[window.id] = sig
            last_recs[window.id] = records
        return records

    def _signature(self, frame: Frame, fracs: list[FractionBox]) -> int | None:
        if not fracs:
            return None
        h = 0
        for fb in fracs:
            pb = fb.to_pixels(frame.client.w, frame.client.h)
            crop = frame.image[pb.y: pb.y + pb.h, pb.x: pb.x + pb.w]
            h ^= _sig(crop)
        return h

    def _state_allows_save(self, window: WindowDef, state_id) -> bool:
        if not window.states:
            return True
        if state_id is None:
            return False
        state = next((s for s in window.states if s.id == state_id), None)
        return bool(state and state.valid_for_save)

    def _stage(self, window: WindowDef, records: list) -> None:
        if not records:
            return
        dataset = window.dataset_id
        key_field = self._profile.key_for(dataset)
        strip, case = self._profile.key_opts(dataset)
        with self._lock:
            self._read += len(records)
            acc = self._staged.get(dataset)
            if acc is None:
                acc = self._staged[dataset] = _Staged(key_field)
            for rec in records:
                key = norm_key(rec.values.get(key_field), strip, case)   # dedup as the store will
                if key is None:
                    self._no_key += 1
                    continue
                acc.rows[key] = dict(rec.values)

    # ---- control -----------------------------------------------------------

    def pause(self, on: bool = True) -> None:
        if on:
            self._pause.set()
            with self._lock:
                if self._phase is Phase.processing:
                    self._phase = Phase.paused
        else:
            self._pause.clear()
            with self._lock:
                if self._phase is Phase.paused:
                    self._phase = Phase.processing

    def cancel(self) -> None:
        self._stop.set()
        self._pause.clear()

    def reset(self) -> None:
        self._stop.set()
        self._pause.clear()
        with self._lock:
            self._clear_dir()
            self._reset_locked()

    def _reset_locked(self) -> None:
        self._frames = []
        self._staged = {}
        self._processed = 0
        self._read = 0
        self._no_key = 0
        self._phase = Phase.idle
        self._error = None

    # ---- save --------------------------------------------------------------

    def save(self) -> dict:
        """Commit staged records into the real per-dataset stores. Returns counts."""
        with self._lock:
            staged = {ds: dict(acc.rows) for ds, acc in self._staged.items()}
        written = {}
        for dataset, rows in staged.items():
            strip, case = self._profile.key_opts(dataset)
            store = DatasetStore(self._engine.settings.data_dir, self._profile.name,
                                 dataset, self._profile.key_for(dataset),
                                 strip_nonalnum=strip, case_sensitive=case)
            store.begin_batch()   # this save is one revertable batch
            n = 0
            for values in rows.values():
                if store.record_seen(values) is not None:
                    n += 1
            store.save()
            written[dataset] = n
        self._lexicon.save()
        self._confusions.save()
        with self._lock:
            self._phase = Phase.saved
        return written

    # ---- status ------------------------------------------------------------

    def _timing_locked(self) -> dict:
        """Per-frame OCR-pipeline timings (ms) + the OCR device — so the current speed
        is visible and runs are comparable for regressions."""
        n = max(1, self._processed)
        return {
            "device": getattr(self._engine.ocr, "device", "cpu"),
            "ms_per_frame": round(1000 * (self._t_decode + self._t_classify + self._t_read) / n, 1),
            "decode_ms": round(1000 * self._t_decode / n, 1),
            "classify_ms": round(1000 * self._t_classify / n, 1),
            "read_ms": round(1000 * self._t_read / n, 1),
        }

    def _log_perf(self, errors: int) -> None:
        """Append a perf record so speed is tracked across runs (regression history)."""
        with self._lock:
            rec = {
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "frames": len(self._frames), "processed": self._processed,
                "read": self._read, "errors": errors, **self._timing_locked(),
            }
        try:
            path = Path(self._engine.settings.data_dir) / _safe(self._profile.name) / "precapture_perf.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec) + "\n")
        except OSError:
            pass

    def _warning(self) -> str | None:
        """A human hint when records were read but nothing got staged — almost always a
        dataset key that doesn't match any field."""
        staged = sum(len(acc.rows) for acc in self._staged.values())
        if self._read > 0 and staged == 0 and self._no_key > 0:
            keys = ", ".join(sorted({acc.key_field for acc in self._staged.values()})) or "?"
            return f"read {self._read} rows but none had the dataset key ({keys}) — check the key field"
        return None

    def status(self) -> dict:
        with self._lock:
            total = len(self._frames)
            elapsed = max(1e-3, time.monotonic() - self._t0)
            if self._phase is Phase.recording:
                fps = total / elapsed
            elif self._phase in (Phase.processing, Phase.paused, Phase.done):
                fps = self._processed / elapsed
            else:
                fps = 0.0
            datasets = []
            for ds, acc in self._staged.items():
                rows = list(acc.rows.values())
                datasets.append({"dataset": ds, "key_field": acc.key_field,
                                 "count": len(rows), "sample": rows[-12:]})
            return {
                "phase": self._phase.value,
                "frames": total,
                "processed": self._processed,
                "read": self._read,
                "fps": round(fps, 1),
                "timing": self._timing_locked(),
                "error": self._error,
                "warning": self._warning(),
                "datasets": datasets,
            }
