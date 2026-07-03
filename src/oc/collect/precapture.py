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
import shutil
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

import cv2
import numpy as np

from ..engine import Engine
from ..learn.dictionary import build_dictionaries
from ..learn.resolver import FieldResolver
from ..locate import WindowLocator
from ..profile.models import GameProfile, WindowDef
from ..store import KeyMap, store_for
from ..store.flow_events import publish_flow
from ..types import Frame, FractionBox, PixelBox
from ..capture.mss_backend import MssCaptureBackend
from ..ocr.device_switch import enter_device, exit_device
from ..ocr.serialize import ocr_job
from ..window.input import scroll_window
from . import detsig, settle
from .scrollbar import scroll_position
from .glyph_match import glyph_atlas
from .items import item_templates
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


# Auto-scroll: while recording, nudge the game's list down so the user needn't scroll by hand.
_AUTOSCROLL_CLICKS = 1       # wheel notches per nudge (small step keeps cross-scroll overlap)

# TIMED step-and-shoot record. Dead simple, deterministic: scroll by the window's scroll_clicks on an
# ABSOLUTE grid — each scroll fires exactly `interval` (the UI "target ms") after the previous one, so
# `interval` IS the time BETWEEN SCROLLS. The grab lands a full interval after its scroll (ease finished
# = settled), and grab/save/bookkeeping run AFTER the next scroll is fired, overlapping that interval
# instead of stacking on top of it. The SCROLLBAR THUMB is the source of truth for progress: if a step
# nudged the thumb even a hair, keep going; if it didn't move, that's the end (or a swallowed wheel) ->
# park at the top and pause. Only ADVANCING grabs are saved, so end-confirmation frames never become dups.
_PROF_LEN = 128        # samples in the row profile (used by _home_to_top's content settle; fixed length)
_MOVE_EPS = 0.004      # row-profile scroll AT/ABOVE this counts as motion (homing's ease detection)
_POS_EPS = 5e-4        # scrollbar thumb moved more than this (0..1) => the step advanced the list ("a tiny bit")
_END_STALL = 3         # consecutive no-move steps before declaring the end (the thumb lags a step from the
                       # top, so a single no-move is the render lag, not the bottom; the bottom plateaus)

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
    frames produced each key (the frequency vote used to kill OCR-noise doubles) and
    the key's parts (so composite keys consolidate per part, never across them)."""
    key_fields: list[str]
    rows: dict[str, dict] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    parts: dict[str, list[str]] = field(default_factory=dict)


# Two staged keys this similar are the same item read two ways — merge regardless of how
# often each was seen. Genuinely different Warframe names (even sharing a " blueprint"
# suffix) score below this.
_MERGE_RATIO = 0.86
# A looser bar that only applies to a CLEARLY RARER variant sitting next to a popular key
# (e.g. "arnesha" seen twice beside "amesha" seen thirty times) — that asymmetry is the
# signature of an OCR misread, so a single swapped/garbled character is enough.
_NOISE_RATIO = 0.72


def _consolidate(rows: dict[str, dict], counts: dict[str, int],
                 parts: dict[str, list[str]] | None = None,
                 ratio: float = _MERGE_RATIO, noise_ratio: float = _NOISE_RATIO) -> dict[str, dict]:
    """Collapse near-duplicate keys created by OCR noise. Precapture sees each item across
    many frames, so the true reading is frequent and a misread is rare. Walk keys most-
    frequent first (canonicals are therefore always at least as frequent as later keys);
    fold a later key into a kept canonical when it's near-identical, OR when it's a much
    rarer variant that's merely similar. Drops the rarer spelling. O(n·canon).

    Composite keys compare PER PART (similarity = the worst part) — never on the joined
    string, where "arcane aegis|5" vs "arcane aegis|3" would look 93% alike and two
    genuinely different levels would merge. A name part still folds its OCR doubles.

    Hot loop is O(n·canon) SequenceMatcher.ratio(), which blows up past ~1-2k keys, so each
    pair is first pruned by a SAFE upper bound (length + shared-character count). Any merge
    needs ratio >= ``noise_ratio``; when the upper bound is below it the real ratio can't
    reach it either, so the costly compute is skipped and 0.0 returned — same decision."""
    pmap = parts or {}
    _counts: dict[str, Counter] = {}

    def _cc(s: str) -> Counter:
        c = _counts.get(s)
        if c is None:
            c = _counts[s] = Counter(s)
        return c

    def _can_reach(a: str, b: str) -> bool:
        # real_quick_ratio: 2*|shared chars| / (len a + len b), an upper bound on .ratio()
        la, lb = len(a), len(b)
        tot = la + lb
        if tot == 0:
            return True
        if 2.0 * min(la, lb) < noise_ratio * tot:     # length alone caps it — cheap reject
            return False
        shared = sum((_cc(a) & _cc(b)).values())
        return 2.0 * shared >= noise_ratio * tot

    def _sim(a: str, b: str) -> float:
        pa, pb = pmap.get(a), pmap.get(b)
        if pa is not None and pb is not None:
            if len(pa) != len(pb):
                return 0.0
            if any(not _can_reach(x, y) for x, y in zip(pa, pb)):
                return 0.0                            # a part can't reach the bar -> min can't
            return min(SequenceMatcher(None, x, y).ratio() for x, y in zip(pa, pb))
        if not _can_reach(a, b):
            return 0.0
        return SequenceMatcher(None, a, b).ratio()

    canon: list[str] = []
    out: dict[str, dict] = {}
    for key in sorted(rows, key=lambda k: (counts.get(k, 0), k), reverse=True):
        kc = counts.get(key, 0)
        merged = False
        for c in canon:
            r = _sim(key, c)
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
        self._tuning = engine.settings.tuning
        self._locator = WindowLocator(engine)
        self._key_maps: dict[str, KeyMap] = {}
        # profile-derived state (reader, detect boxes, key cache) — rebuilt by _apply_profile
        # so a UI edit between recording and processing actually reaches classify/read.
        self._apply_profile(profile)
        # Recordings are kept as named SESSIONS under precapture/<id>/ (frames +
        # ocr_state.json + meta.json), so a set can be re-processed and re-saved without
        # re-recording. ``_session`` selects the active one; ``_dir`` resolves to it.
        self._base = Path(engine.settings.captures_dir) / _safe(profile.name) / "precapture"
        self._session: str | None = None
        # Fallback foreground grabber used ONLY when the engine backend isn't streaming
        # (see _grab_frame). A streaming backend (WGC default) reads the window's own cached
        # surface for free; a non-streaming engine backend would either re-render the game
        # (PrintWindow) or BitBlt the desktop per grab, so for a foreground window mss —
        # reading what's already on screen (WindowInfo.client is absolute screen px) — is the
        # cheaper, no-game-impact path. Unused entirely under the default WGC engine.
        self._screen = MssCaptureBackend()

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._autoscroll = threading.Event()   # live-toggled; drives the record loop's scroll
        self._scroll_clicks = _AUTOSCROLL_CLICKS   # wheel notches per nudge (live-adjustable)
        # when set, a recording that ENDS ON ITS OWN (auto-scroll list-end or max_frames)
        # immediately launches processing — record -> process with no manual stop/process click
        self._auto_process = False
        self._worker_kind: str | None = None   # "recording" | "processing" — restores phase on resume
        self._thread: threading.Thread | None = None
        # "auto" device policy: set to "gpu" by the web layer to run the PROCESSING batch on
        # GPU (many frames -> GPU batching wins), then restore the baseline device (which
        # frees the GPU). None = use whatever device the engine is already on.
        self.batch_device: str | None = None

        self._frames: list[bytes] = []        # JPEG-encoded captures held in RAM (live recording)
        self._frame_paths: list[Path] = []    # on-disk frames of a loaded session (read lazily)
        self._client: tuple[int, int] = (0, 0)
        self._staged: dict[str, _Staged] = {}
        self._phase = Phase.idle
        self._processed = 0
        self._read = 0          # records read this run (above the confidence floor)
        self._no_key = 0        # records dropped because they had no value under the dataset key
        self._gaps = 0          # coverage gaps seen while recording (a step overshot the measurable overlap)
        self._rec: dict = {}    # per-step recording timings (ms) so a loop hitch is VISIBLE, not guessed at
        # recognition during processing: the just-classified window/state, plus a per-frame
        # tally keyed "window/state" ("" = a miss, i.e. classify matched no window).
        self._cur_window: str | None = None
        self._cur_state: str | None = None
        self._recog: dict[str, int] = {}
        self._t_decode = self._t_classify = self._t_read = 0.0   # perf accumulators (s)
        self._t0 = 0.0
        self._t_end = 0.0       # monotonic time the run finished; freezes fps once idle/done
        self._error: str | None = None
        self._init_sessions()

    # ---- profile -----------------------------------------------------------

    def _apply_profile(self, profile: GameProfile) -> None:
        """(Re)build everything that depends on the profile: the resolver/reader, the
        detect-box list used for the staleness signature, and the key-map cache. The
        session is created ONCE per game and cached for the server's life, so without
        this a detect/region edit made in the UI would never reach precapture's
        classify/read — the editor would pass and precapture would still fail."""
        eng = self._engine
        self._profile = profile
        pooled, dict_map = build_dictionaries(profile, eng.corrector)
        resolver = FieldResolver(eng.corrector, self._tuning.accept_confidence,
                                 dictionary=pooled, dictionaries=dict_map)
        from ..web import captures_store
        templates = item_templates(profile.windows,
                                   captures_store.cutout_loader(eng.settings.captures_dir, profile.name))
        glyphs = glyph_atlas(profile.glyphs,
                             captures_store.glyph_loader(eng.settings.captures_dir, profile.name))
        self._reader = RegionReader(eng.ocr, resolver, templates, glyphs)
        self._detect_fracs = _detect_boxes(profile)
        self._key_maps = {}

    def update_profile(self, profile: GameProfile) -> None:
        """Swap in a freshly-loaded profile — but NEVER mid-run (a worker reads these
        every frame). A no-op while recording/processing; the next idle start picks it up."""
        with self._lock:
            if self.is_running():
                return
            self._apply_profile(profile)

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
            frames, nbytes = 0, 0
            try:
                for f in p.glob("*.jpg"):
                    frames += 1
                    nbytes += f.stat().st_size
            except OSError:
                pass
            st = self._peek_state(p)
            out.append({
                "id": p.name, "label": meta.get("label", ""),
                "created": meta.get("created"), "saved_at": meta.get("saved_at"),
                "frames": frames, "bytes": nbytes, "processed": st.get("processed", 0),
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
        shutil.rmtree(target, ignore_errors=True)   # rmtree: handles the .thumb/ cache subdir too
        with self._lock:
            self._reset_locked()
            self._session = None
        dirs = sorted(self._session_dirs(), key=lambda p: p.name, reverse=True)
        if dirs:
            self._session = dirs[0].name
            self._rehydrate()

    def delete_all_sessions(self) -> None:
        """Remove every saved session from disk and clear the active one. No-op while a
        worker runs (the caller gates on busy), so frames in flight are never yanked."""
        self._join_prev()
        for p in list(self._session_dirs()):
            shutil.rmtree(p, ignore_errors=True)   # rmtree: handles the .thumb/ cache subdir too
        with self._lock:
            self._reset_locked()
            self._session = None

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
        """Make a previous run's frames available WITHOUT reading them — loading a session
        only needs the staged records (to review/save); the frame pixels are read lazily,
        one at a time, when processing actually runs. So just enumerate the files and peek
        the first for the client dimensions."""
        try:
            files = sorted(self._dir.glob("*.jpg"))
        except OSError:
            return
        if not files:
            return
        self._frame_paths = files
        self._frames = []
        try:
            img = cv2.imdecode(np.frombuffer(files[0].read_bytes(), np.uint8), cv2.IMREAD_COLOR)
            if img is not None:
                self._client = (img.shape[1], img.shape[0])
        except OSError:
            pass
        self._phase = Phase.recorded
        self._load_ocr_state()

    def _frame_count(self) -> int:
        """Total frames in the active session — in-RAM ones (a live recording) or, for a
        loaded session, the files on disk (not yet read)."""
        return len(self._frames) if self._frames else len(self._frame_paths)

    def _state_file(self) -> Path:
        return self._dir / "ocr_state.json"

    def _save_ocr_state(self) -> None:
        """Checkpoint OCR progress (staged records + frame cursor) so a process kill
        doesn't throw the work away — frames already persist to disk; this makes the
        results persist too. Written atomically; the worker thread is the only caller."""
        with self._lock:
            state = {
                "frames": self._frame_count(),
                "processed": self._processed,
                "read": self._read,
                "no_key": self._no_key,
                "staged": {ds: {"key_fields": list(acc.key_fields), "rows": dict(acc.rows),
                                "counts": dict(acc.counts), "parts": dict(acc.parts)}
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
        if state.get("frames") != self._frame_count():   # frame set changed -> stale
            return
        try:
            self._staged = {ds: _Staged(list(d["key_fields"]), dict(d["rows"]),
                                        {k: int(v) for k, v in d["counts"].items()},
                                        {k: list(v) for k, v in d["parts"].items()})
                            for ds, d in state.get("staged", {}).items()}
            self._processed = int(state.get("processed", 0))
            self._read = int(state.get("read", 0))
            self._no_key = int(state.get("no_key", 0))
        except (KeyError, TypeError, ValueError):
            self._staged = {}
            self._processed = self._read = self._no_key = 0
            return
        if self._processed >= self._frame_count():
            self._phase = Phase.done

    # ---- recording ---------------------------------------------------------

    def _row_profile(self, img, da_frac, cw, ch):
        """A cheap fixed-length (``_PROF_LEN``) 1-D vertical intensity profile of the data_area
        (mean per row, downsampled). Cross-correlating two of these (``_vscroll``) gives how far
        the LIST scrolled between the frames — in-place icon animation shifts no rows, so it
        doesn't register. ``None`` when the crop is empty."""
        pb = da_frac.to_pixels(cw, ch)
        crop = img[pb.y:pb.y + pb.h, pb.x:pb.x + pb.w]
        if crop.size == 0:
            return None
        g = crop.max(axis=2) if crop.ndim == 3 else crop
        prof = g.mean(axis=1).astype(np.float32)
        return cv2.resize(prof.reshape(-1, 1), (1, _PROF_LEN), interpolation=cv2.INTER_AREA).ravel()

    @staticmethod
    def _vscroll(a, b) -> float:
        """Downward scroll from ``a`` to ``b`` as a fraction (0..1) of the profile height: the
        offset of ``b`` that best matches ``a`` (content scrolled up and out the top), by minimum
        SSD over the top half. 0 when they align in place — so in-place animation reads as no
        scroll. ``a``/``b`` are ``_row_profile`` outputs; 0.0 if either is None."""
        if a is None or b is None:
            return 0.0
        n = len(a)
        best_ssd = None
        best = 0
        for dy in range(0, n // 2):
            la = a[dy:]
            lb = b[:len(la)]
            d = la - lb
            s = float(np.dot(d, d)) / len(la)
            if best_ssd is None or s < best_ssd:
                best_ssd, best = s, dy
        return best / n

    def _window_for_frame(self, frame):
        """The WindowDef the frame classifies to, or None. Best-effort — a classify hiccup
        must never break recording."""
        try:
            match = self._engine.classifier.classify(frame, self._profile)
            if match:
                return next((w for w in self._profile.windows if w.id == match[0]), None)
        except Exception:  # pragma: no cover - a classify hiccup must not break recording
            pass
        return None

    def _scroll_cfg_for_frame(self, frame) -> tuple[bool, int]:
        """Classify the window shown in ``frame`` and return its ``(autoscroll, clicks)``.
        The ON-SCREEN window decides — so recording can start on any screen and auto-scroll
        engages once the user reaches a window configured for it (and disengages when they
        leave). Best-effort: no match / no scroll config -> auto-scroll off."""
        return self._scroll_cfg_for_window(self._window_for_frame(frame))

    @staticmethod
    def _scroll_cfg_for_window(wd) -> tuple[bool, int]:
        sc = wd.scroll if wd else None
        if sc and sc.enabled and sc.autoscroll:
            return True, max(1, int(sc.scroll_clicks or 1))
        return False, _AUTOSCROLL_CLICKS

    def _apply_window_autoscroll(self) -> None:
        """Seed auto-scroll from whatever window is on screen at record start (best-effort).
        The record loop re-reads this live every settled frame, so it's only the initial
        status value — recording started off the equipment screen will still pick auto-scroll
        up once the user navigates there."""
        on, clicks = False, _AUTOSCROLL_CLICKS
        try:
            win = self._locator.locate(self._profile)
            if win is not None:
                on, clicks = self._scroll_cfg_for_frame(self._engine.capture.grab_window(win))
        except Exception:  # pragma: no cover - record start must not die on a classify hiccup
            pass
        self.set_autoscroll(on, clicks)

    def start_recording(self, max_frames: int = 300, interval_ms: int = 0, label: str = "",
                        auto_process: bool = False) -> None:
        with self._lock:
            if self._phase in (Phase.recording, Phase.processing):
                return
        self._join_prev()   # bury any lingering worker BEFORE clearing _stop (see _join_prev)
        self._apply_window_autoscroll()   # use the on-screen window's per-window scroll config
        with self._lock:
            self._session = self._new_session_id()   # each recording is its own session
            self._reset_locked()
            self._auto_process = auto_process
            self._dir.mkdir(parents=True, exist_ok=True)
            self._phase = Phase.recording
            self._worker_kind = "recording"
            self._stop.clear()
            self._t0 = time.monotonic()
            self._t_end = 0.0
        self._write_meta(label=label or "")
        self._thread = threading.Thread(
            target=self._record_loop, args=(max_frames, interval_ms / 1000.0), daemon=True)
        self._thread.start()

    def _grab_frame(self, win, foreground: bool):
        """Capture the game, picking the path that reads the RIGHT pixels with the least game
        impact. A STREAMING backend (WGC, the default) is a passive readback of the frame DWM
        already composited — no re-render, background-safe, and no per-grab full-desktop BitBlt
        — so it's used for both foreground and background. Only a non-streaming engine backend
        falls back to the per-frame split below.

        BACKGROUND / mss came back black (exclusive-fullscreen): fall back to the engine
        capture — a streaming backend (WGC) reads the window's own cached surface even
        occluded; a non-streaming one (PrintWindow) re-renders it. Snapshot the live backend
        once: a web-UI swap replaces engine.capture at runtime, so grab off the SAME object."""
        cap = self._engine.capture
        # Streaming backend (WGC): a passive readback of the already-composited frame — no
        # re-render, and (unlike mss) no repeated full-desktop 4K BitBlt, which steals ~20% of
        # the game's FPS while recording and thereby slows the very scroll animation the record
        # loop waits on. Use it for BOTH foreground and background. (pull-gated, so a grab costs
        # one on-demand copy, not the game's full present rate.)
        if getattr(cap, "streaming", False):
            return cap.grab_window(win)
        # Non-streaming engine backend (printwindow/mss): foreground -> our own mss (a cheap
        # desktop BitBlt of real pixels); background / mss-black -> engine capture (PrintWindow
        # reads the window's own surface even occluded, at a re-render cost).
        if foreground:
            try:
                f = self._screen.grab_window(win)
                if f.image is not None and f.image.size and int(f.image.max()) > 8:
                    return f
            except Exception:
                pass
        return cap.grab_window(win)

    def _home_to_top(self, win, wd) -> None:
        """Park the list at the TOP before recording, so coverage starts from a known origin.
        Coverage-driven capture assumes it begins at row 0; if the user opened the window
        already scrolled, everything above is silently lost.

        Nothing is captured while homing, so DON'T wait the ease per step — just hammer up as
        fast as the wheel registers, polling the thumb, and stop when it reads the top. Only the
        FINAL confirm waits the ease to settle, so the very first recorded frame is clean. The
        thumb lags while spamming, so the break may land a few no-op up-scrolls late — harmless
        (already at the top). Best-effort — a hiccup must never break recording."""
        sc = wd.scroll if wd else None
        if not (sc and sc.enabled):
            return
        orient = sc.scrollbar_orientation
        up = max(5, 5 * int(sc.scroll_clicks or 1))     # big up-steps reach the top in few iters
        da = wd.data_area.to_fraction() if wd.data_area is not None else None

        def read():
            """One grab -> (thumb pos 0..1 or None, data_area row-profile or None)."""
            try:
                f = self._grab_frame(win, True)
            except Exception:   # pragma: no cover - a grab hiccup must not break homing
                return None, None
            img = f.image
            if img is None or img.size == 0:
                return None, None
            pos = None
            if sc.scrollbar is not None:
                box = sc.scrollbar.to_fraction().to_pixels(f.client.w, f.client.h)
                crop = img[box.y:box.y + box.h, box.x:box.x + box.w]
                if crop.size:
                    pos = scroll_position(crop, orient)
            rp = self._row_profile(img, da, f.client.w, f.client.h) if da is not None else None
            return pos, rp

        def wait_settled():
            """Grab until the scroll ease finishes — the indicator (thumb pos, else the row
            profile) stops changing between consecutive grabs. Returns the settled (pos, rp)."""
            pos, rp = read()
            for _ in range(60):                         # cap: ~1.8s worst case per settle
                if self._stop.is_set():
                    return pos, rp
                self._stop.wait(0.03)
                npos, nrp = read()
                if npos is not None and pos is not None:
                    moved = abs(npos - pos) > 0.005
                elif nrp is not None and rp is not None:
                    moved = max(self._vscroll(nrp, rp), self._vscroll(rp, nrp)) >= _MOVE_EPS
                else:
                    moved = False                       # nothing to compare -> treat as settled
                pos, rp = npos, nrp
                if not moved:
                    break
            return pos, rp

        prev_rp = None
        for _ in range(120):                            # hard cap so a bad read can't spin forever
            if self._stop.is_set():
                return
            scroll_window(win, -up)
            self._stop.wait(0.02)                       # only enough for the wheel to register; NOT the ease
            pos, rp = read()
            if pos is not None:
                if pos <= 0.02:                         # thumb at top -> done
                    break
            elif prev_rp is not None and rp is not None:
                # no scrollbar: an up-scroll that moved the content nowhere == at top
                if max(self._vscroll(rp, prev_rp), self._vscroll(prev_rp, rp)) < _MOVE_EPS:
                    break
            prev_rp = rp
        # ONE safety scroll up, then WAIT for the ease to actually settle at the top (only here)
        scroll_window(win, -up)
        wait_settled()

    def _save_frame(self, frame, gap: bool = False) -> bool:
        """JPEG-encode a captured frame and stash it (RAM + disk). Returns True if kept."""
        ok, buf = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            return False
        data = buf.tobytes()
        with self._lock:
            idx = len(self._frames)
            self._frames.append(data)
            self._client = (frame.client.w, frame.client.h)
            if gap:
                self._gaps += 1
        try:
            (self._dir / f"{idx:05d}.jpg").write_bytes(data)
        except OSError:
            pass
        return True

    def _scroll_pos(self, img, wd, cw, ch):
        """The scrollbar thumb position (0..1) for this frame, or None if the window has no
        scrollbar / it can't be read. Lets the list-end test KNOW it's at the bottom instead of
        guessing from 'the content didn't move' (which a swallowed wheel event also looks like)."""
        sc = wd.scroll if wd else None
        if not (sc and sc.enabled and sc.scrollbar) or img is None or img.size == 0:
            return None
        box = sc.scrollbar.to_fraction().to_pixels(cw, ch)
        crop = img[box.y:box.y + box.h, box.x:box.x + box.w]
        if crop.size == 0:
            return None
        return scroll_position(crop, sc.scrollbar_orientation)

    def _reclog(self, **rec) -> None:
        """Append one per-step trace line to reclog.jsonl in the session dir — the record loop's
        black box, so a bad run can be READ back instead of theorised about."""
        try:
            with (self._dir / "reclog.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec) + "\n")
        except OSError:
            pass

    def _rec_note(self, **ms) -> None:
        """Record per-step timings so a loop hitch is measured, not blamed on the game. Keeps the
        latest values plus the worst cycle seen (surfaced in status/timing)."""
        with self._lock:
            cyc = ms.get("cycle_ms", 0.0)
            self._rec = {**{k: round(v, 1) for k, v in ms.items()},
                         "max_cycle_ms": round(max(self._rec.get("max_cycle_ms", 0.0), cyc), 1)}

    def _record_loop(self, max_frames: int, interval: float) -> None:
        prev_thumb: np.ndarray | None = None   # the immediately preceding grab (fallback settle path)
        saved_thumb: np.ndarray | None = None  # the last frame we kept        (fallback settle path)
        idle = max(interval, 0.5)             # gentle poll when there's nothing to do (no window / not auto)
        pos_ref = None                        # scrollbar thumb pos at the last captured frame (progress reference)
        stall = 0                             # consecutive steps the thumb didn't move (end only after _END_STALL)
        scroll_feat: np.ndarray | None = None  # tolerant detect-region features the scroll cfg was read at
        wd = None                             # last-classified window (persists across skip-reclassify frames)
        homed = False                         # parked the list at the top yet? (once, per auto-scroll window)
        natural_end = False                   # loop ended on its own (max_frames / list-end), not a user stop
        try:
            while not self._stop.is_set():
                with self._lock:
                    if len(self._frames) >= max_frames:
                        natural_end = True
                        break
                if self._pause.is_set():        # paused (e.g. auto-scroll hit the list end)
                    while self._pause.is_set() and not self._stop.is_set():
                        self._stop.wait(0.05)
                    if self._stop.is_set():
                        break
                    pos_ref = None              # resumed -> re-anchor progress from the current position
                win = self._locator.locate(self._profile)
                if self._stop.is_set():       # locate can be slow (process scan) — bail promptly
                    break
                if win is None:
                    time.sleep(0.3)           # no window: back off, don't hammer the scan
                    continue
                try:
                    fg = self._engine.window.is_foreground(win)
                except Exception:
                    fg = True   # provider can't say -> assume on top (mss path self-falls-back)
                frame = self._grab_frame(win, fg)   # streaming (WGC) surface, or mss/PrintWindow fallback
                img = frame.image
                # Re-classify only when the detect anchors change beyond a noise floor (detsig is
                # ~1ms; a scroll keeps the top/title anchors fixed so this holds through it and
                # classify() — an OCR read per detector — runs once per window, not per row). From
                # the classified window take BOTH the auto-scroll config and the data_area the
                # scroll profile watches.
                delta = detsig.changed(feat := detsig.features(frame, self._detect_fracs), scroll_feat)
                if delta is None or delta >= detsig.MIN_CELLS:   # first frame / shape change / real switch
                    scroll_feat = feat
                    wd = self._window_for_frame(frame)
                    if wd is not None:
                        self.set_autoscroll(*self._scroll_cfg_for_window(wd))
                auto = self._autoscroll.is_set()
                # Park at the top once, the first time we reach an auto-scroll window on top — so
                # capture always starts from row 0 (the user may have opened it mid-list).
                if not homed and auto and fg and wd is not None and wd.scroll is not None:
                    self._home_to_top(win, wd)
                    homed = True
                    pos_ref = None
                    continue
                # ---- TIMED step-and-shoot (auto-scroll window with a scrollbar) ----
                # Scroll one step -> wait for the in-game scroll ease to finish -> capture. The
                # scrollbar thumb decides progress: nudged even a hair, keep going; didn't move at
                # all, that's the end (or a dead scroll) -> park at the top and pause.
                has_bar = wd is not None and wd.scroll is not None and wd.scroll.scrollbar is not None
                if auto and fg and has_bar:
                    # TIME-BASED step-and-shoot. Scroll -> wait -> capture -> save, one frame per tick,
                    # unconditionally (no dedup). Each next scroll is timed a full `interval` from the
                    # ACTUAL fire time of the PREVIOUS scroll — NOT a fixed grid. So a scroll can only
                    # ever fire LATE (if a cycle's work overran), NEVER early: the interval is ALWAYS
                    # >= `interval`, and every capture gets at least a full ease. A fixed grid would
                    # "catch up" after a hitch by firing the next scroll early -> gap < `interval`
                    # -> that frame grabbed mid-animation. We don't do that. Overhead only pushes the
                    # interval UP (by ~the one grab), never down. Grab lands a full interval since its
                    # scroll (settled); the next scroll fires IMMEDIATELY after the grab so the slow work
                    # (save = JPEG encode + disk) runs UNDER the following interval, off the path. The
                    # thumb is read ONLY to detect the list end (sustained no-move), never to gate saves.
                    if pos_ref is None:                        # FRESH scan (origin / post-home / post-resume):
                        self._save_frame(frame)                # shoot row 0, THEN take the first step down.
                        pos_ref = self._scroll_pos(img, wd, frame.client.w, frame.client.h)
                        scroll_window(win, max(1, self._scroll_clicks))   # first step (only on a fresh scan)
                    # RE-ENTRY (pos_ref already set) after a transient fg/detect blip broke the loop: a
                    # scroll already fired before the break, so DON'T fire another here — that extra,
                    # un-timed step was the double-scroll. Just resume the timed cadence below.
                    now = t_prev = time.perf_counter()         # anchor the wait; grab is >= `interval` away
                    while not self._stop.is_set() and not self._pause.is_set():
                        with self._lock:
                            if len(self._frames) >= max_frames:
                                natural_end = True
                                break
                        # Sleep until `interval` past THIS scroll's real fire time. Never fires early;
                        # if the prior cycle's work already ran past it, wait <= 0 and we grab at once
                        # (still a full interval since the scroll — the work ate the wait, not the ease).
                        wait = (now + interval) - time.perf_counter()
                        if wait > 0:
                            self._stop.wait(wait)
                        if self._stop.is_set():
                            break
                        f = self._grab_frame(win, fg)           # settled: a full interval since its scroll
                        scroll_window(win, max(1, self._scroll_clicks))   # next scroll fires NOW, before any work
                        now = time.perf_counter()               # anchor the NEXT wait on this real fire
                        self._save_frame(f)                     # slow (encode + disk) — runs UNDER the next interval
                        pos = self._scroll_pos(f.image, wd, f.client.w, f.client.h)
                        moved = pos is None or pos_ref is None or abs(pos - pos_ref) > _POS_EPS
                        stall = 0 if moved else stall + 1
                        self._rec_note(wait_ms=max(0.0, wait) * 1000, cycle_ms=(now - t_prev) * 1000,
                                       clicks=self._scroll_clicks)
                        self._reclog(pos=(None if pos is None else round(pos, 4)),
                                     pos_ref=(None if pos_ref is None else round(pos_ref, 4)),
                                     moved=moved, stall=stall, frames=len(self._frames),
                                     dwell_ms=round(max(0.0, wait) * 1000, 1),
                                     period_ms=round((now - t_prev) * 1000, 1))
                        t_prev = now
                        pos_ref = pos
                        try:
                            fg = self._engine.window.is_foreground(win)
                        except Exception:
                            fg = True
                        # window changed under us (a popup / navigated away) -> back to the outer loop
                        # to re-classify. Cheap: detsig runs on the frame we ALREADY captured.
                        left = (not fg) or (detsig.changed(detsig.features(f, self._detect_fracs),
                                                            scroll_feat) or 0) >= detsig.MIN_CELLS
                        if left:
                            break
                        # The thumb LAGS a step from the top, so a single no-move is render lag, not the
                        # bottom; end only on SUSTAINED no-movement (the bottom plateaus).
                        if stall >= _END_STALL:
                            self._home_to_top(win, wd)
                            pos_ref = None
                            stall = 0
                            if self._auto_process:
                                natural_end = True
                            else:
                                self.pause(True)
                            break
                    if natural_end:            # max_frames / auto-process end -> leave the outer loop too
                        break
                    continue

                # ---- fallback: whole-frame settle (window declares no data_area) ----
                thumb = settle.thumb(img, crop_px=settle.CROP_PX)
                settled = settle.is_settled(thumb, prev_thumb)
                new_view = settled and (saved_thumb is None
                                        or settle.changed_cells(thumb, saved_thumb) >= settle.MIN_CELLS)
                kept = False
                if new_view and (fg or not auto):
                    if self._save_frame(frame):
                        kept = True
                        saved_thumb = thumb
                scrolled = False
                if auto and fg and kept:                       # one nudge per kept frame
                    scrolled = scroll_window(win, self._scroll_clicks)
                prev_thumb = thumb
                self._stop.wait(max(interval, 0.03) if (not settled or scrolled) else idle)
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._error = str(exc)
        finally:
            self._pause.clear()
            with self._lock:
                if self._phase in (Phase.recording, Phase.paused):
                    self._phase = Phase.recorded
                self._t_end = time.monotonic()   # freeze the recording clock (fps stops drifting)
                # auto-process: a self-ended recording with frames rolls straight into OCR.
                # Launch OUTSIDE the lock (and never via start_processing -> _join_prev, which
                # would join this very thread) — _launch_processing just spawns the next worker.
                launch = self._auto_process and natural_end and self._frame_count() > 0
            if launch:
                self._launch_processing()

    def set_autoscroll(self, on: bool, clicks: int | None = None) -> None:
        """Live-toggle auto-scroll (and optionally its wheel-notch step). Unchecking mid-
        record stops it at once; rechecking resumes — the record loop re-reads both the
        flag and the step every grab."""
        if clicks is not None:
            self._scroll_clicks = max(1, int(clicks))
        if on:
            self._autoscroll.set()
        else:
            self._autoscroll.clear()

    def stop_recording(self) -> None:
        self._stop.set()

    # ---- processing --------------------------------------------------------

    def start_processing(self) -> None:
        with self._lock:
            if self._phase in (Phase.recording, Phase.processing) or not self._frame_count():
                return
        self._join_prev()   # bury any lingering worker BEFORE clearing _stop (see _join_prev)
        self._launch_processing()

    def _launch_processing(self) -> None:
        """Spawn the processing worker (reset counters / pick resume cursor / start thread).

        The ONE place a processing thread is started — shared by ``start_processing`` (manual,
        which joins the prior worker first) and the auto-process path inside ``_record_loop``'s
        finally (which must NOT join, as that would join its own dying thread)."""
        with self._lock:
            # A rehydrated half-done run (the OCR checkpoint survived a process kill)
            # resumes at the saved cursor with its staged records intact. Any other
            # start — fresh recording, re-process after done/cancel — is from scratch.
            resume = self._phase is Phase.recorded and 0 < self._processed < self._frame_count()
            if not resume:
                self._processed = 0
                self._read = 0
                self._no_key = 0
                self._staged = {}
                self._recog = {}
            self._cur_window = self._cur_state = None
            self._phase = Phase.processing
            self._worker_kind = "processing"
            self._error = None
            self._t_decode = self._t_classify = self._t_read = 0.0   # perf accumulators (s)
            self._stop.clear()
            self._pause.clear()
            self._t0 = time.monotonic()
            self._t_end = 0.0
            # frame SOURCES from the cursor on: in-RAM bytes (live recording) or disk paths
            # (loaded session) read lazily in the loop so loading never paid for the pixels
            sources = list((self._frames or self._frame_paths)[self._processed:])
            cw, ch = self._client
        self._thread = threading.Thread(target=self._process_loop, args=(sources, cw, ch), daemon=True)
        self._thread.start()

    def _process_loop(self, sources: list, cw: int, ch: int) -> None:
        restore = enter_device(self._engine, self.batch_device)
        try:
            self._process_batch(sources, cw, ch)
        finally:
            exit_device(self._engine, restore)

    def _process_batch(self, sources: list, cw: int, ch: int) -> None:
        eng = self._engine
        floor = self._tuning.min_confidence
        last_detect_sig: int | None = None
        last_match = None
        last_data_sig: dict[str, int] = {}
        last_records: dict[str, list] = {}
        errors = 0
        for src in sources:
            if self._stop.is_set():
                self._save_ocr_state()   # keep the work done so far restartable
                with self._lock:
                    self._phase = Phase.cancelled
                    self._t_end = time.monotonic()
                return
            while self._pause.is_set() and not self._stop.is_set():
                time.sleep(0.05)

            dt_decode = dt_classify = dt_read = 0.0
            cur_window: str | None = None   # window/state this frame classified to (None = miss)
            cur_state: str | None = None
            try:
                # lazy: in-RAM bytes (live recording) or read the frame file now (loaded session)
                buf = src if isinstance(src, (bytes, bytearray)) else src.read_bytes()
                t = time.perf_counter()
                img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
                dt_decode = time.perf_counter() - t
                if img is None:
                    raise ValueError("undecodable frame")
                frame = Frame(image=img, client=PixelBox(0, 0, cw or img.shape[1], ch or img.shape[0]))

                # one OCR job per frame: held only for this frame, then released, so a UI
                # read/detect can take a turn between frames instead of fighting the GPU.
                with ocr_job(eng.ocr):
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
                        cur_window, cur_state = window_id, state_id
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
                self._cur_window, self._cur_state = cur_window, cur_state
                key = f"{cur_window}/{cur_state}" if cur_window is not None else ""
                self._recog[key] = self._recog.get(key, 0) + 1
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
        records, _sentinel = self._reader.read(frame, window, fields)
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

    def _key_map(self, dataset: str) -> KeyMap:
        if dataset not in self._key_maps:
            self._key_maps[dataset] = self._profile.key_map_for(dataset)
        return self._key_maps[dataset]

    def _stage(self, window: WindowDef, records: list) -> None:
        if not records:
            return
        dataset = window.dataset_id
        if dataset is None:
            return   # no dataset -> records discarded, nothing to stage
        km = self._key_map(dataset)
        with self._lock:
            self._read += len(records)
            acc = self._staged.get(dataset)
            if acc is None:
                acc = self._staged[dataset] = _Staged(km.fields_used())
            for rec in records:
                spec = km.spec_for(rec.values)
                parts = spec.parts(rec.values)     # dedup as the store will
                if parts is None:
                    self._no_key += 1
                    continue
                key = spec.sep.join(parts)
                acc.rows[key] = dict(rec.values)
                acc.counts[key] = acc.counts.get(key, 0) + 1   # frequency vote for noise merge
                acc.parts[key] = parts

    # ---- control -----------------------------------------------------------

    def pause(self, on: bool = True) -> None:
        if on:
            self._pause.set()
            with self._lock:
                if self._phase in (Phase.processing, Phase.recording):
                    self._phase = Phase.paused
        else:
            self._pause.clear()
            with self._lock:
                if self._phase is Phase.paused:
                    # resume into whichever worker is running (recording vs processing)
                    self._phase = (Phase.recording if self._worker_kind == "recording"
                                   else Phase.processing)

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
        self._frame_paths = []
        self._staged = {}
        self._consolidated = None
        self._processed = 0
        self._read = 0
        self._no_key = 0
        self._gaps = 0
        self._rec = {}
        self._phase = Phase.idle
        self._error = None

    # ---- save --------------------------------------------------------------

    def save(self) -> dict:
        """Commit staged records into the real per-dataset stores. Returns counts.

        Fuzzy consolidation runs HERE, once, and only here: the staging dedup keeps exact
        keys distinct, but OCR misreads land as *different* keys the store can't unify, so
        they're folded by frequency just before commit (the UI shows raw counts until then)."""
        with self._lock:
            staged = {ds: (dict(acc.rows), dict(acc.counts), dict(acc.parts))
                      for ds, acc in self._staged.items()}
        written = {}
        for dataset, (rows, counts, parts) in staged.items():
            rows = _consolidate(rows, counts, parts)   # merge OCR-noise doubles before committing
            store = store_for(self._engine.settings.data_dir, self._profile.name, dataset,
                              profile=self._profile, key=self._key_map(dataset))
            store.begin_batch()   # this save is one revertable batch
            n = 0
            for values in rows.values():
                if store.record_seen(values) is not None:
                    n += 1
            store.save()
            written[dataset] = n
            if n:
                # Source-aware data hops for the graph animation. A precapture save is a whole
                # session commit, so EVERY window feeding this dataset genuinely produced — light
                # each of their edges (the multi-feeder fan-in is correct here, unlike live where
                # only the one writing window should animate).
                for w in self._profile.windows:
                    if w.dataset_id == dataset:
                        publish_flow(self._profile.name, "data", f"win:{w.id}",
                                     f"ds:{dataset}", n)
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
                "frames": self._frame_count(), "processed": self._processed,
                "read": self._read, "errors": errors, **self._timing_locked(),
            }
        # Also feed the per-node stats panel: precapture is per-game, so it lands on a
        # synthetic ``precap`` node, op ``fr`` (per-frame ms across the OCR pipeline).
        from ..store import stats_store
        stats_store.record_timing(self._profile.name, "precap", "fr",
                                  rec.get("ms_per_frame", 0.0), n=rec.get("processed", 0))
        try:
            path = Path(self._engine.settings.data_dir) / _safe(self._profile.name) / "precapture_perf.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec) + "\n")
        except OSError:
            pass

    def _warning(self) -> str | None:
        """A human hint when something needs attention: a coverage gap during recording
        (a freeze jumped ~a viewport, so rows may be missing), or records read but nothing
        staged (a dataset key that doesn't match any field)."""
        if self._gaps > 0:
            return (f"{self._gaps} coverage gap(s) while scrolling — the list jumped ~a viewport "
                    "in one frame (freeze/lag); some rows may be missing, re-record that stretch")
        staged = sum(len(acc.rows) for acc in self._staged.values())
        if self._read > 0 and staged == 0 and self._no_key > 0:
            keys = ", ".join(sorted({f for acc in self._staged.values()
                                     for f in acc.key_fields})) or "?"
            return (f"read {self._read} rows but none had a complete key ({keys}) — "
                    "check the item's key fields")
        return None

    def status(self) -> dict:
        with self._lock:
            total = self._frame_count()
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
                # raw staged counts — fuzzy noise-merge happens only at save (cheap here)
                rows = list(acc.rows.values())
                # send every staged row (no cap) — the UI caps height + scrolls
                datasets.append({"dataset": ds, "count": len(rows), "sample": rows})
            meta = self._read_meta(self._dir) if self._session else {}
            return {
                "phase": self._phase.value,
                "session": self._session,
                "autoscroll": self._autoscroll.is_set(),
                "scroll_clicks": self._scroll_clicks,
                "auto_process": self._auto_process,
                "kind": self._worker_kind,
                "label": meta.get("label", ""),
                "saved_at": meta.get("saved_at"),
                "frames": total,
                "processed": self._processed,
                "read": self._read,
                "no_key": self._no_key,   # rows read but dropped (no complete dataset key)
                "gaps": self._gaps,       # coverage gaps while recording (a step overshot the measurable overlap)
                "rec": dict(self._rec),   # per-step recording timings (ms) — makes a loop hitch visible
                "fps": round(fps, 1),
                "timing": self._timing_locked(),
                # recognition: the current frame's window/state, plus a per-frame tally
                # (count-desc; the "" key — a miss, classified to no window — flagged for the UI)
                "window": self._cur_window,
                "state": self._cur_state,
                "recognized": [{"key": k, "count": n, "miss": k == ""}
                               for k, n in sorted(self._recog.items(),
                                                  key=lambda kv: kv[1], reverse=True)],
                "error": self._error,
                "warning": self._warning(),
                "datasets": datasets,
            }
