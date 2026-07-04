"""Orchestrate detect -> track -> read into deduplicated number readings.

Ties the three stages together with the no-double-read contract front and centre:

1. Each frame is detected (:class:`NumberDetector`) and the blobs are fed to the tracker
   (:class:`NumberTracker`), which links them to existing floating numbers.
2. A track is OCR'd **exactly once**, when it first becomes "ripe" (``min_hits`` matched
   frames — enough to be real and to have grown to a readable size). The crop comes from
   the current frame at the track's peak box. The read flips ``track.read`` so it is never
   read again, no matter how many more frames it floats for.
3. The parsed value is emitted once as a :class:`ReadNumber`. A spatial+temporal dedup
   guard suppresses a number that gets re-tracked (a flicker that broke one track into two)
   from being emitted twice.

OCR for all ripe tracks in a frame is batched through ``OcrEngine.read_lines`` (one GPU
pass for the whole frame's worth of numbers) to keep throughput high. The OCR engine is
built by name and constructed lazily, so importing this module costs nothing.

Feed it ``(image, t)`` pairs, or hand it :class:`oc.capture.fastcap.CapturedFrame` objects
straight from a high-FPS burst. It never blocks on capture; processing is fully decoupled.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import numpy as np

from ..registry import build_ocr
from ..types import PixelBox
from .detect import DetectConfig, NumberDetector
from .track import NumberTracker, Track, TrackConfig

# Default value extractor: optional sign, digits with optional thousands separators and a
# decimal part, optional k/m/b magnitude suffix (common in damage popups). Anchored loosely
# so it picks the number out of noisy OCR like "12,345!" or "8.2k".
_NUM_RE = re.compile(r"[-+]?\d[\d.,]*\s*[kmbKMB]?")
_SUFFIX = {"k": 1e3, "m": 1e6, "b": 1e9}


@dataclass
class NumberConfig:
    """End-to-end config. ``detect`` and ``track`` nest the stage configs.

    OCR:
        ``ocr``            registered OCR backend name (uses its fast ``read_lines`` rec-only
                           path — detection is skipped, the box is known to be one number).
        ``ocr_options``    kwargs passed to the OCR backend constructor.
        ``min_conf``       drop a read below this OCR confidence (0..1).
        ``pad``            pixels to pad the crop on each side before OCR (glyphs clipped
                           tight read worse).

    Read timing:
        ``read_at_hits``   OCR a track once it reaches this many hits (defaults to the
                           tracker's ``min_hits``; raise to wait for a bigger/clearer glyph).
        ``read_unripe_on_finalize`` if a track dies before reaching ``read_at_hits``, OCR it
                           once at finalize anyway instead of dropping it (catches very brief
                           numbers at the cost of a smaller crop).

    Value parsing:
        ``pattern``        regex whose match is taken as the number text (``None`` = default
                           damage-number extractor). The first match in the OCR string wins.
        ``require_digit``  reject reads with no digit (filter stray glyph clusters).
        ``apply_suffix``   expand a trailing k/m/b into the magnitude (``"8.2k" -> 8200``).
        ``min_value/max_value`` accept only numbers in this range (``None`` = unbounded);
                           rejects absurd OCR like a 9-digit damage number.

    Dedup guard (beyond per-track single-read):
        ``dedup_seconds``  suppress emitting the same value again within this window if it
                           spawns near a recent emit (a re-tracked flicker). ``0`` disables.
        ``dedup_radius``   spatial radius (px, around spawn centroid) for that guard.
    """

    detect: DetectConfig = field(default_factory=DetectConfig)
    track: TrackConfig = field(default_factory=TrackConfig)

    ocr: str = "ppocr5"
    ocr_options: dict = field(default_factory=dict)
    min_conf: float = 0.30
    pad: int = 3

    read_at_hits: int | None = None
    read_unripe_on_finalize: bool = False

    pattern: str | None = None
    require_digit: bool = True
    apply_suffix: bool = True
    strict_format: bool = True   # reject reads carrying letters/CJK other than a K/M/B suffix
    min_value: float | None = None
    max_value: float | None = None

    dedup_seconds: float = 0.0
    dedup_radius: float = 40.0


@dataclass(frozen=True)
class ReadNumber:
    """One deduplicated number reading emitted from a finished/ripe track."""

    track_id: int
    value: str                 # the matched number text as read (e.g. "12,345")
    number: float | None       # parsed numeric value (suffix-expanded), or None if unparsable
    confidence: float
    box: PixelBox              # box the value was read from (peak box)
    cx: float
    cy: float                  # spawn centroid (where it first appeared)
    first_t: float
    last_t: float
    first_seq: int
    last_seq: int
    hits: int


class NumberProcessor:
    """Stateful processor: ``feed`` frames in capture order, collect :class:`ReadNumber`s.

    Holds the detector, tracker, OCR engine, and a small recent-emit list for the dedup
    guard. One instance per capture session/stream.
    """

    def __init__(self, config: NumberConfig | None = None) -> None:
        self.config = config or NumberConfig()
        self.detector = NumberDetector(self.config.detect)
        self.tracker = NumberTracker(self.config.track)
        self._ocr = None
        self._re = re.compile(self.config.pattern) if self.config.pattern else _NUM_RE
        self._recent: list[ReadNumber] = []   # for dedup_seconds guard
        self.emitted: list[ReadNumber] = []   # full log of everything emitted
        self._last_image: np.ndarray | None = None   # for reading trailing tracks at flush

    # -- engine -----------------------------------------------------------

    def _engine(self):
        if self._ocr is None:
            self._ocr = build_ocr(self.config.ocr, **self.config.ocr_options)
        return self._ocr

    def prepare(self) -> None:
        """Build the OCR model now (outside any timed read) so the first ripe track isn't
        charged for lazy model construction."""
        eng = self._engine()
        prep = getattr(eng, "prepare", None)
        if callable(prep):
            prep()

    # -- main loop --------------------------------------------------------

    def feed(self, image: np.ndarray, t: float = 0.0, seq: int = 0) -> list[ReadNumber]:
        """Process one frame; return numbers newly emitted from it (usually 0..a few)."""
        cfg = self.config
        self._last_image = image
        blobs = self.detector.detect(image)
        finalized = self.tracker.update(blobs, t=t, seq=seq)

        ripe_hits = cfg.read_at_hits if cfg.read_at_hits is not None else cfg.track.min_hits

        # Collect tracks to read THIS frame: ripe-and-unread live tracks (crop from current
        # frame), plus finalized-but-never-read tracks if configured to salvage them.
        to_read: list[Track] = [
            tr for tr in self.tracker.active
            if not tr.read and tr.hits >= ripe_hits
        ]
        salvage: list[Track] = []
        if cfg.read_unripe_on_finalize:
            salvage = [tr for tr in finalized if not tr.read]

        out: list[ReadNumber] = []
        out += self._read_and_emit(to_read, image)
        # Salvaged tracks are already gone from the tracker; their peak box may not be in
        # THIS frame, but the peak crop is the best we have — read from current frame at it.
        out += self._read_and_emit(salvage, image)
        return out

    def feed_captured(self, frame) -> list[ReadNumber]:
        """Feed a :class:`oc.capture.fastcap.CapturedFrame` (uses its ``t`` and ``seq``)."""
        return self.feed(frame.image, t=frame.t, seq=frame.seq)

    def process(self, frames) -> list[ReadNumber]:
        """Run a whole sequence of CapturedFrames (or ``(image, t, seq)`` tuples) and return
        every emitted number. Flushes still-live tracks at the end."""
        out: list[ReadNumber] = []
        for fr in frames:
            if hasattr(fr, "image"):
                out += self.feed(fr.image, t=getattr(fr, "t", 0.0), seq=getattr(fr, "seq", 0))
            else:
                img, t, seq = (fr + (0, 0))[:3] if isinstance(fr, tuple) else (fr, 0.0, 0)
                out += self.feed(img, t=t, seq=seq)
        out += self.flush()
        return out

    def flush(self) -> list[ReadNumber]:
        """Finalize every live track and emit any ripe/salvageable-but-unread one, read off
        the last frame seen. Call once after the last frame so trailing numbers aren't lost."""
        cfg = self.config
        ripe_hits = cfg.read_at_hits if cfg.read_at_hits is not None else cfg.track.min_hits
        leftover = self.tracker.flush()
        pending = [tr for tr in leftover
                   if not tr.read and (tr.hits >= ripe_hits or cfg.read_unripe_on_finalize)]
        if not pending or self._last_image is None:
            return []
        return self._read_and_emit(pending, self._last_image)

    # -- read + emit ------------------------------------------------------

    def _read_and_emit(self, tracks: list[Track], image: np.ndarray) -> list[ReadNumber]:
        if not tracks:
            return []
        crops = [self._crop(image, tr.peak_box or tr.box) for tr in tracks]
        reads = self._engine().read_lines(crops)
        out: list[ReadNumber] = []
        for tr, (text, conf) in zip(tracks, reads):
            tr.read = True   # mark read regardless of outcome -> never re-OCR this track
            if conf < self.config.min_conf:
                continue
            value, number = self._parse(text)
            if value is None:
                continue
            tr.value, tr.number, tr.confidence = value, number, conf
            spawn = tr.path[0] if tr.path else (tr.cx, tr.cy)
            rn = ReadNumber(
                track_id=tr.id, value=value, number=number, confidence=conf,
                box=tr.peak_box or tr.box, cx=spawn[0], cy=spawn[1],
                first_t=tr.first_t, last_t=tr.last_t,
                first_seq=tr.first_seq, last_seq=tr.last_seq, hits=tr.hits,
            )
            if self._is_dupe(rn):
                continue
            out.append(rn)
            self.emitted.append(rn)
            if self.config.dedup_seconds > 0:
                self._recent.append(rn)
        return out

    def _crop(self, image: np.ndarray, box: PixelBox) -> np.ndarray:
        p = self.config.pad
        h, w = image.shape[:2]
        x0 = max(0, box.x - p)
        y0 = max(0, box.y - p)
        x1 = min(w, box.x + box.w + p)
        y1 = min(h, box.y + box.h + p)
        if x1 <= x0 or y1 <= y0:
            return np.empty((0, 0), dtype=np.uint8)
        return image[y0:y1, x0:x1]

    def _parse(self, text: str) -> tuple[str | None, float | None]:
        cfg = self.config
        if not text:
            return None, None
        # Format guard: a damage number is digits + separators + at most a trailing K/M/B
        # magnitude. If the OCR text carries ANY other letter (stray glyph) or CJK, it's junk,
        # not a number — drop it. This is what kills the gibberish: detection-noise blobs that
        # OCR into "8L"/"LCA"/CJK no longer slip through just because they contain a digit.
        if cfg.strict_format:
            letters = re.findall(r"[^\d\W_]", text)   # unicode letters only (not digits/punct)
            if any(c.lower() not in _SUFFIX for c in letters):
                return None, None
        m = self._re.search(text)
        if not m:
            return None, None
        raw = m.group(0).strip()
        digits = re.sub(r"[^\d]", "", raw)
        if cfg.require_digit and not digits:
            return None, None
        # numeric parse: drop thousands separators, keep one decimal point, apply suffix.
        suffix = raw[-1].lower() if raw and raw[-1].lower() in _SUFFIX else ""
        body = raw[:-1] if suffix else raw
        body = body.replace(",", "").replace(" ", "")
        try:
            num = float(body)
            if cfg.apply_suffix and suffix:
                num *= _SUFFIX[suffix]
        except ValueError:
            num = None
        if num is not None:
            if cfg.min_value is not None and num < cfg.min_value:
                return None, None
            if cfg.max_value is not None and num > cfg.max_value:
                return None, None
        return raw, num

    def _is_dupe(self, rn: ReadNumber) -> bool:
        win = self.config.dedup_seconds
        if win <= 0:
            return False
        r = self.config.dedup_radius
        # prune old entries, then check value + spawn proximity within the window.
        self._recent = [e for e in self._recent if rn.first_t - e.last_t <= win]
        for e in self._recent:
            if e.value == rn.value and math.hypot(e.cx - rn.cx, e.cy - rn.cy) <= r:
                return True
        return False
