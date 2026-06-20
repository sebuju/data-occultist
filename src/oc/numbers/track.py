"""Associate per-frame blobs into motion tracks so each floating number is ONE entity.

A damage number is on screen for many frames while it drifts (usually upward) and fades.
Detection sees it afresh every frame; without tracking, OCR would read it N times and the
value would be counted N times. This module links a blob in frame K to the same blob in
frame K+1 by predicted position — numbers move smoothly and consistently, so last
position + estimated velocity predicts the next one well — and assigns a stable track id.

A track is born when an unmatched blob appears, lives while blobs keep matching it
(absorbing small motion via an EMA velocity), and is *finalized* when no blob matches for
``max_misses`` consecutive frames (it faded or left). The processor reads a track exactly
once over its life; that, plus one-emit-per-track, is the no-double-read guarantee.

Pure Python / numpy-free-of-cv2 — fully unit-testable without a GPU, OpenCV, or a screen.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..types import PixelBox


@dataclass
class TrackConfig:
    """Association + lifecycle knobs.

    ``max_dist``      max distance (px) between a track's PREDICTED centroid and a blob's
                      centroid to consider them the same number. Scales the gate; too small
                      drops fast-floating numbers, too large cross-links neighbours.
    ``gate_by_size``  add half the blob's diagonal to ``max_dist`` so big numbers (which
                      jump farther per frame) still associate.
    ``vel_alpha``     EMA weight for velocity updates (0..1). Higher = snappier to changes,
                      noisier; lower = smoother, laggier prediction.
    ``max_misses``    consecutive unmatched frames before a track is finalized (declared
                      gone). 0 = finalize the instant it isn't seen.
    ``min_hits``      a track must match this many frames before it's considered real (the
                      processor won't OCR/emit a track below this — kills one-frame specks).
    ``predict``       use last_centroid + velocity to predict; off = associate on last
                      position only (fine for slow text, worse for fast float).
    """

    max_dist: float = 48.0
    gate_by_size: bool = True
    vel_alpha: float = 0.5
    max_misses: int = 6
    min_hits: int = 2
    predict: bool = True


@dataclass
class Track:
    """One tracked number across its life. Identity is ``id``; the value fields are filled
    in by the processor when it OCRs the track (``read`` flips True so it's never re-read)."""

    id: int
    cx: float
    cy: float
    box: PixelBox
    vx: float = 0.0
    vy: float = 0.0
    hits: int = 1
    misses: int = 0
    age: int = 0                       # frames since birth
    first_t: float = 0.0
    last_t: float = 0.0
    first_seq: int = 0
    last_seq: int = 0
    peak_box: PixelBox | None = None   # largest box seen (best crop to OCR)
    peak_area: int = 0
    path: list[tuple[float, float]] = field(default_factory=list)

    # filled by the processor
    read: bool = False
    value: str | None = None
    number: float | None = None
    confidence: float = 0.0

    def predict(self) -> tuple[float, float]:
        return self.cx + self.vx, self.cy + self.vy


def _dist(ax: float, ay: float, bx: float, by: float) -> float:
    return math.hypot(ax - bx, ay - by)


class NumberTracker:
    """Greedy nearest-prediction tracker. Feed it each frame's blobs; it returns the tracks
    that finalized (faded/left) on that frame so the caller can harvest them."""

    def __init__(self, config: TrackConfig | None = None) -> None:
        self.config = config or TrackConfig()
        self._tracks: dict[int, Track] = {}
        self._next_id = 1

    @property
    def active(self) -> list[Track]:
        return list(self._tracks.values())

    def _gate(self, track: Track, blob) -> float:
        d = self.config.max_dist
        if self.config.gate_by_size:
            d += 0.5 * math.hypot(blob.box.w, blob.box.h)
        return d

    def update(self, blobs, t: float = 0.0, seq: int = 0) -> list[Track]:
        """Match ``blobs`` to existing tracks, spawn/age the rest, and return the tracks
        finalized this step (no match for > ``max_misses`` frames)."""
        cfg = self.config
        tracks = list(self._tracks.values())

        # Candidate pairs (track, blob, distance) within each track's gate.
        pairs = []
        for ti, tr in enumerate(tracks):
            px, py = tr.predict() if cfg.predict else (tr.cx, tr.cy)
            gate = None
            for bi, b in enumerate(blobs):
                d = _dist(px, py, b.cx, b.cy)
                gate = self._gate(tr, b)
                if d <= gate:
                    pairs.append((d, ti, bi))
        pairs.sort(key=lambda p: p[0])

        matched_t: set[int] = set()
        matched_b: set[int] = set()
        for d, ti, bi in pairs:
            if ti in matched_t or bi in matched_b:
                continue
            matched_t.add(ti)
            matched_b.add(bi)
            self._absorb(tracks[ti], blobs[bi], t, seq)

        # Unmatched tracks age; finalize the stale ones.
        finalized: list[Track] = []
        for ti, tr in enumerate(tracks):
            if ti in matched_t:
                continue
            tr.misses += 1
            tr.age += 1
            if tr.misses > cfg.max_misses:
                finalized.append(tr)
                del self._tracks[tr.id]

        # Unmatched blobs become new tracks.
        for bi, b in enumerate(blobs):
            if bi in matched_b:
                continue
            self._spawn(b, t, seq)

        return finalized

    def flush(self) -> list[Track]:
        """Finalize and return every still-live track (call when the stream ends)."""
        out = list(self._tracks.values())
        self._tracks.clear()
        return out

    def reset(self) -> None:
        self._tracks.clear()
        self._next_id = 1

    # -- internals --------------------------------------------------------

    def _absorb(self, tr: Track, blob, t: float, seq: int) -> None:
        cfg = self.config
        ndx, ndy = blob.cx - tr.cx, blob.cy - tr.cy
        a = cfg.vel_alpha
        # EMA velocity; seed it on the first real motion so prediction kicks in immediately.
        if tr.hits == 1:
            tr.vx, tr.vy = ndx, ndy
        else:
            tr.vx = (1 - a) * tr.vx + a * ndx
            tr.vy = (1 - a) * tr.vy + a * ndy
        tr.cx, tr.cy = blob.cx, blob.cy
        tr.box = blob.box
        tr.hits += 1
        tr.misses = 0
        tr.age += 1
        tr.last_t = t
        tr.last_seq = seq
        tr.path.append((blob.cx, blob.cy))
        if blob.area > tr.peak_area:
            tr.peak_area = blob.area
            tr.peak_box = blob.box

    def _spawn(self, blob, t: float, seq: int) -> None:
        tr = Track(
            id=self._next_id, cx=blob.cx, cy=blob.cy, box=blob.box,
            first_t=t, last_t=t, first_seq=seq, last_seq=seq,
            peak_box=blob.box, peak_area=blob.area, path=[(blob.cx, blob.cy)],
        )
        self._tracks[self._next_id] = tr
        self._next_id += 1
