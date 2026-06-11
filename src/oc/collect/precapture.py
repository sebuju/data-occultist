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

Speed comes from two skips during processing: when the *detect* regions are
pixel-identical to the previous frame we reuse the last window/state classification,
and when a window's *data area* is identical we reuse its last read.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

import cv2
import numpy as np

from ..engine import Engine
from ..learn.confusions import ConfusionMap
from ..learn.dictionary import Dictionary
from ..learn.lexicon import Lexicon
from ..learn.resolver import FieldResolver
from ..locate import WindowLocator
from ..profile.models import GameProfile, WindowDef
from ..store import DatasetStore
from ..store.dataset_store import norm_key
from ..types import Frame, FractionBox, PixelBox
from ..capture.mss_backend import MssCaptureBackend
from ..ocr.serialize import ocr_job
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


def _detect_boxes(profile: GameProfile) -> list[FractionBox]:
    """Every region used for window/state detection — detectors on windows and states."""
    out: list[FractionBox] = []
    for w in profile.windows:
        for d in w.detect:
            if d.enabled:
                out.append(d.search.to_fraction())
        for s in w.states:
            for d in s.detect:
                out.append(d.search.to_fraction())
    return out


@dataclass
class _Staged:
    """Dedup accumulator for one dataset: key -> latest record values, plus how many
    frames produced each key (the frequency vote used to kill OCR-noise doubles)."""
    key_field: str
    rows: dict[str, dict] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)


# Two staged keys this similar are the same item read two ways — merge regardless of how
# often each was seen. Genuinely different Warframe names (even sharing a " blueprint"
# suffix) score below this.
_MERGE_RATIO = 0.86
# A looser bar that only applies to a CLEARLY RARER variant sitting next to a popular key
# (e.g. "arnesha" seen twice beside "amesha" seen thirty times) — that asymmetry is the
# signature of an OCR misread, so a single swapped/garbled character is enough.
_NOISE_RATIO = 0.72


def _consolidate(rows: dict[str, dict], counts: dict[str, int],
                 ratio: float = _MERGE_RATIO, noise_ratio: float = _NOISE_RATIO) -> dict[str, dict]:
    """Collapse near-duplicate keys created by OCR noise. Precapture sees each item across
    many frames, so the true reading is frequent and a misread is rare. Walk keys most-
    frequent first (canonicals are therefore always at least as frequent as later keys);
    fold a later key into a kept canonical when it's near-identical, OR when it's a much
    rarer variant that's merely similar. Drops the rarer spelling. O(n·canon)."""
    canon: list[str] = []
    out: dict[str, dict] = {}
    for key in sorted(rows, key=lambda k: (counts.get(k, 0), k), reverse=True):
        kc = counts.get(key, 0)
        merged = False
        for c in canon:
            r = SequenceMatcher(None, key, c).ratio()
            if r >= ratio or (r >= noise_ratio and kc <= max(2, 0.25 * counts.get(c, 0))):
                merged = True
                break
        if not merged:
            canon.append(key)
            out[key] = rows[key]
    return out


class PrecaptureSession:
    """One precapture run for a game. All public methods are thread-safe."""

    def __init__(self, engine: Engine, profile: GameProfile) -> None:
        self._engine = engine
        self._profile = profile
        self._tuning = engine.settings.tuning
        self._locator = WindowLocator(engine)
        self._lexicon = Lexicon.for_game(engine.settings.data_dir, profile.name)
        self._confusions = ConfusionMap.for_game(engine.settings.data_dir, profile.name)
        dictionary = Dictionary(profile.dictionary_terms(), engine.corrector)
        resolver = FieldResolver(self._lexicon, engine.corrector, self._tuning.accept_confidence,
                                 confusions=self._confusions, dictionary=dictionary)
        self._reader = RegionReader(engine.ocr, resolver, cutouts=_load_cutouts(engine, profile))
        self._detect_fracs = _detect_boxes(profile)
        # Recordings are kept as named SESSIONS under precapture/<id>/ (frames +
        # ocr_state.json + meta.json), so a set can be re-processed and re-saved without
        # re-recording. ``_session`` selects the active one; ``_dir`` resolves to it.
        self._base = Path(engine.settings.captures_dir) / _safe(profile.name) / "precapture"
        self._session: str | None = None
        # Recording copies pixels straight off the composited desktop (mss) instead of
        # the engine's window capture: PrintWindow forces the game to re-render its whole
        # surface every grab and tanks its frame rate. mss just reads what's already on
        # screen (WindowInfo.client is absolute screen px) — near-zero game impact.
        self._screen = MssCaptureBackend()

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
        self._t_end = 0.0       # monotonic time the run finished; freezes fps once idle/done
        self._error: str | None = None
        self._init_sessions()

    # ---- sessions ----------------------------------------------------------

    @property
    def _dir(self) -> Path:
        """Active session directory (frames + checkpoint + meta live here)."""
        return self._base / (self._session or "_scratch")

    def _new_session_id(self) -> str:
        # microseconds so two recordings in the same second don't collide
        return datetime.now().strftime("%Y%m%d-%H%M%S-%f")

    def _session_dirs(self) -> list[Path]:
        try:
            return [p for p in self._base.iterdir() if p.is_dir()]
        except OSError:
            return []

    def _init_sessions(self) -> None:
        """Migrate a pre-sessions flat recording into a session, then make the most
        recent session active and load it (so the modal opens where you left off)."""
        # legacy layout: frames sat directly in precapture/*.jpg — fold them into a session
        try:
            legacy = sorted(self._base.glob("*.jpg"))
        except OSError:
            legacy = []
        if legacy:
            sid = self._new_session_id()
            dst = self._base / sid
            try:
                dst.mkdir(parents=True, exist_ok=True)
                for f in legacy:
                    f.replace(dst / f.name)
                old_state = self._base / "ocr_state.json"
                if old_state.exists():
                    old_state.replace(dst / "ocr_state.json")
                self._session = sid
                self._write_meta(label="recovered")
            except OSError:
                pass
        dirs = sorted(self._session_dirs(), key=lambda p: p.name, reverse=True)
        if dirs:
            self._session = dirs[0].name
            self._rehydrate()

    def _meta_path(self, d: Path) -> Path:
        return d / "meta.json"

    def _read_meta(self, d: Path) -> dict:
        try:
            return json.loads(self._meta_path(d).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _write_meta(self, **fields) -> None:
        """Merge fields into the active session's meta.json (created stamped once)."""
        meta = self._read_meta(self._dir)
        meta.setdefault("created", datetime.now().isoformat(timespec="seconds"))
        for k, v in fields.items():
            if v is not None:
                meta[k] = v
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            self._meta_path(self._dir).write_text(json.dumps(meta), encoding="utf-8")
        except OSError:
            pass

    def _peek_state(self, d: Path) -> dict:
        """Cheap read of a session's checkpoint for the listing: how far it processed and
        how many records it holds, without loading frames."""
        try:
            st = json.loads((d / "ocr_state.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        records = sum(len(v.get("rows", {})) for v in st.get("staged", {}).values())
        return {"processed": int(st.get("processed", 0)), "records": records}

    def list_sessions(self) -> list[dict]:
        """Every saved session, newest first: id, label, frame count, processed/record
        counts, and whether it's the active one."""
        out = []
        for p in self._session_dirs():
            meta = self._read_meta(p)
            try:
                frames = len(list(p.glob("*.jpg")))
            except OSError:
                frames = 0
            st = self._peek_state(p)
            out.append({
                "id": p.name, "label": meta.get("label", ""),
                "created": meta.get("created"), "saved_at": meta.get("saved_at"),
                "frames": frames, "processed": st.get("processed", 0),
                "records": st.get("records", 0), "active": p.name == self._session,
            })
        out.sort(key=lambda s: s["id"], reverse=True)
        return out

    def load_session(self, sid: str) -> None:
        """Make ``sid`` active and load its frames + checkpoint, ready to re-process/save."""
        self._join_prev()
        target = self._base / _safe(sid)
        if not target.is_dir():
            raise KeyError(sid)
        with self._lock:
            self._session = _safe(sid)
            self._reset_locked()
        self._rehydrate()

    def delete_session(self, sid: str) -> None:
        """Remove a session from disk. If it was active, fall back to the newest remaining."""
        self._join_prev()
        target = self._base / _safe(sid)
        try:
            if target.is_dir():
                for f in target.iterdir():
                    f.unlink()
                target.rmdir()
        except OSError:
            pass
        with self._lock:
            self._reset_locked()
            self._session = None
        dirs = sorted(self._session_dirs(), key=lambda p: p.name, reverse=True)
        if dirs:
            self._session = dirs[0].name
            self._rehydrate()

    def rename_session(self, sid: str, label: str) -> None:
        target = self._base / _safe(sid)
        if not target.is_dir():
            raise KeyError(sid)
        meta = self._read_meta(target)
        meta.setdefault("created", datetime.now().isoformat(timespec="seconds"))
        meta["label"] = label
        try:
            self._meta_path(target).write_text(json.dumps(meta), encoding="utf-8")
        except OSError:
            pass

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
        self._load_ocr_state()

    def _state_file(self) -> Path:
        return self._dir / "ocr_state.json"

    def _save_ocr_state(self) -> None:
        """Checkpoint OCR progress (staged records + frame cursor) so a process kill
        doesn't throw the work away — frames already persist to disk; this makes the
        results persist too. Written atomically; the worker thread is the only caller."""
        with self._lock:
            state = {
                "frames": len(self._frames),
                "processed": self._processed,
                "read": self._read,
                "no_key": self._no_key,
                "staged": {ds: {"key_field": acc.key_field, "rows": dict(acc.rows),
                                "counts": dict(acc.counts)}
                           for ds, acc in self._staged.items()},
            }
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            tmp = self._state_file().with_suffix(".json.tmp")
            tmp.write_text(json.dumps(state), encoding="utf-8")
            tmp.replace(self._state_file())
        except OSError:
            pass

    def _load_ocr_state(self) -> None:
        """Restore a checkpoint left by a killed process. Only valid for the exact frame
        set it was written against; a finished run rehydrates as done (staged records
        ready to save), a partial one as recorded with the cursor set so processing
        resumes instead of starting over."""
        try:
            state = json.loads(self._state_file().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if state.get("frames") != len(self._frames):   # frame set changed -> stale
            return
        try:
            self._staged = {ds: _Staged(d["key_field"], dict(d["rows"]),
                                        {k: int(v) for k, v in d["counts"].items()})
                            for ds, d in state.get("staged", {}).items()}
            self._processed = int(state.get("processed", 0))
            self._read = int(state.get("read", 0))
            self._no_key = int(state.get("no_key", 0))
        except (KeyError, TypeError, ValueError):
            self._staged = {}
            self._processed = self._read = self._no_key = 0
            return
        if self._processed >= len(self._frames):
            self._phase = Phase.done

    # ---- recording ---------------------------------------------------------

    def start_recording(self, max_frames: int = 300, interval_ms: int = 0, label: str = "") -> None:
        with self._lock:
            if self._phase in (Phase.recording, Phase.processing):
                return
        self._join_prev()   # bury any lingering worker BEFORE clearing _stop (see _join_prev)
        with self._lock:
            self._session = self._new_session_id()   # each recording is its own session
            self._reset_locked()
            self._dir.mkdir(parents=True, exist_ok=True)
            self._phase = Phase.recording
            self._stop.clear()
            self._t0 = time.monotonic()
            self._t_end = 0.0
        self._write_meta(label=label or "")
        self._thread = threading.Thread(
            target=self._record_loop, args=(max_frames, interval_ms / 1000.0), daemon=True)
        self._thread.start()

    def _pick_grab(self, win):
        """Choose the capture path once per run. Prefer the cheap desktop copy (mss),
        which doesn't disturb the game; fall back to the engine's window capture
        (PrintWindow) only if mss comes back black — exclusive-fullscreen or a fully
        occluded window, where a desktop copy can't see the game."""
        try:
            f = self._screen.grab_window(win)
            if f.image is not None and f.image.size and int(f.image.max()) > 8:
                return self._screen.grab_window
        except Exception:
            pass
        return self._engine.capture.grab_window

    def _record_loop(self, max_frames: int, interval: float) -> None:
        prev_thumb: np.ndarray | None = None   # the immediately preceding grab
        saved_thumb: np.ndarray | None = None  # the last frame we kept
        # Keep a frame only once the screen has SETTLED: the same frame twice in a row
        # (small mouse movement ignored — it's below the diff threshold). Transition
        # animations keep changing, so no two consecutive grabs match and they're all
        # dropped; only the steady state survives. Of the matching pair, store just one.
        # Capture FAST while anything is moving so the settle is caught promptly; once
        # the screen is still, ease off to a gentle poll.
        fast = max(interval, 0.03)
        idle = max(interval, 0.5)
        grab = None                           # chosen once, on the first located window
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
                if grab is None:
                    grab = self._pick_grab(win)
                frame = grab(win)
                thumb = _thumb(frame.image)
                settled = prev_thumb is not None and _changed_cells(thumb, prev_thumb) < _THUMB_MIN_CELLS
                new_view = saved_thumb is None or _changed_cells(thumb, saved_thumb) >= _THUMB_MIN_CELLS
                if settled and new_view:       # steady AND different from the last kept frame -> keep one
                    ok, buf = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
                    if ok:
                        saved_thumb = thumb
                        data = buf.tobytes()
                        with self._lock:
                            idx = len(self._frames)
                            self._frames.append(data)
                            self._client = (frame.client.w, frame.client.h)
                        try:
                            (self._dir / f"{idx:05d}.jpg").write_bytes(data)
                        except OSError:
                            pass
                moving = not settled           # screen changing (transition) -> grab fast to catch the settle
                prev_thumb = thumb
                # wait ON the stop event so cancel is instant even mid idle-poll
                self._stop.wait(fast if moving else idle)
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._error = str(exc)
        finally:
            with self._lock:
                if self._phase is Phase.recording:
                    self._phase = Phase.recorded
                self._t_end = time.monotonic()   # freeze the recording clock (fps stops drifting)

    def stop_recording(self) -> None:
        self._stop.set()

    # ---- processing --------------------------------------------------------

    def start_processing(self) -> None:
        with self._lock:
            if self._phase in (Phase.recording, Phase.processing) or not self._frames:
                return
        self._join_prev()   # bury any lingering worker BEFORE clearing _stop (see _join_prev)
        with self._lock:
            # A rehydrated half-done run (the OCR checkpoint survived a process kill)
            # resumes at the saved cursor with its staged records intact. Any other
            # start — fresh recording, re-process after done/cancel — is from scratch.
            resume = self._phase is Phase.recorded and 0 < self._processed < len(self._frames)
            if not resume:
                self._processed = 0
                self._read = 0
                self._no_key = 0
                self._staged = {}
            self._phase = Phase.processing
            self._error = None
            self._t_decode = self._t_classify = self._t_read = 0.0   # perf accumulators (s)
            self._stop.clear()
            self._pause.clear()
            self._t0 = time.monotonic()
            self._t_end = 0.0
            frames = list(self._frames[self._processed:])
            cw, ch = self._client
        self._thread = threading.Thread(target=self._process_loop, args=(frames, cw, ch), daemon=True)
        self._thread.start()

    def _process_loop(self, frames: list[bytes], cw: int, ch: int) -> None:
        eng = self._engine
        floor = self._tuning.min_confidence
        last_detect_sig: int | None = None
        last_match = None
        last_data_sig: dict[str, int] = {}
        last_records: dict[str, list] = {}
        errors = 0
        for buf in frames:
            if self._stop.is_set():
                self._save_ocr_state()   # keep the work done so far restartable
                with self._lock:
                    self._phase = Phase.cancelled
                    self._t_end = time.monotonic()
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

                # one OCR job per frame: held only for this frame, then released, so a UI
                # read/detect can take a turn between frames instead of fighting the GPU.
                with ocr_job():
                    asig = self._signature(frame, self._detect_fracs)
                    if asig is not None and asig == last_detect_sig:
                        match = last_match
                    else:
                        t = time.perf_counter()
                        match = eng.classifier.classify(frame, self._profile)
                        dt_classify = time.perf_counter() - t
                        last_detect_sig, last_match = asig, match

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
                checkpoint = self._processed % 25 == 0
            if checkpoint:   # periodic OCR checkpoint: a process kill loses ≤25 frames of work
                self._save_ocr_state()
            time.sleep(0)   # yield the GIL so the web server services status/cancel promptly

        self._save_ocr_state()   # final checkpoint: done-but-unsaved results survive a kill
        with self._lock:
            self._phase = Phase.done
            self._t_end = time.monotonic()
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
                acc.counts[key] = acc.counts.get(key, 0) + 1   # frequency vote for noise merge

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

    def _join_prev(self) -> None:
        """Make sure the previous worker thread is dead before a new one starts.

        Without this, reset()/cancel() set ``_stop`` but the thread may still be
        mid-frame; the next start then calls ``_stop.clear()``, un-killing the orphan,
        and TWO loops pound the one shared OCR engine at once — processing crawls to
        seconds per frame (looks like a CPU fallback even on GPU). Must NOT hold the
        lock while joining: the worker grabs it every frame."""
        t = self._thread
        if t is not None and t.is_alive():
            self._stop.set()
            self._pause.clear()
            t.join(timeout=5.0)
        self._thread = None

    def is_running(self) -> bool:
        """True while a worker thread (recording or processing) is alive."""
        t = self._thread
        return bool(t is not None and t.is_alive())

    def kill(self, timeout: float = 5.0) -> bool:
        """Stop the worker and WAIT for it to actually exit. Returns True if it died."""
        self._stop.set()
        self._pause.clear()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout)
        return not self.is_running()

    def cancel(self) -> None:
        self._stop.set()
        self._pause.clear()

    def reset(self) -> None:
        """Discard the active session (frames + records) and fall back to the newest one."""
        if self._session:
            self.delete_session(self._session)
        else:
            self._stop.set()
            self._pause.clear()
            with self._lock:
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
            staged = {ds: (dict(acc.rows), dict(acc.counts)) for ds, acc in self._staged.items()}
        written = {}
        for dataset, (rows, counts) in staged.items():
            rows = _consolidate(rows, counts)   # merge OCR-noise doubles before committing
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
        # keep the checkpoint: the session retains its processed records so it can be
        # re-saved later. Just stamp the session as saved (and remember what it wrote).
        self._save_ocr_state()
        self._write_meta(saved_at=datetime.now().isoformat(timespec="seconds"),
                         saved_counts=written)
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
            # once the run has ended, measure against the frozen finish time so fps stops
            # ticking down every poll (elapsed would otherwise keep growing while idle)
            now = self._t_end or time.monotonic()
            elapsed = max(1e-3, now - self._t0)
            if self._phase is Phase.recording:
                fps = total / elapsed
            elif self._phase in (Phase.processing, Phase.paused, Phase.done):
                fps = self._processed / elapsed
            else:
                fps = 0.0
            datasets = []
            for ds, acc in self._staged.items():
                # while processing keep it cheap (raw); once settled show the deduped set
                rows = list((acc.rows if self._phase is Phase.processing
                             else _consolidate(acc.rows, acc.counts)).values())
                datasets.append({"dataset": ds, "key_field": acc.key_field,
                                 "count": len(rows), "sample": rows[-12:]})
            meta = self._read_meta(self._dir) if self._session else {}
            return {
                "phase": self._phase.value,
                "session": self._session,
                "label": meta.get("label", ""),
                "saved_at": meta.get("saved_at"),
                "frames": total,
                "processed": self._processed,
                "read": self._read,
                "fps": round(fps, 1),
                "timing": self._timing_locked(),
                "error": self._error,
                "warning": self._warning(),
                "datasets": datasets,
            }
