"""Tolerant detector-region signature: decide "did the screen change enough to re-classify?"

Classifying a frame runs an OCR text read per detector across every window — the dominant
per-frame cost, and brutal on CPU. So both the live collector and precapture cache the last
classification and only re-run it when the detector search regions actually change. A BARE
pixel hash is the wrong test: capture noise or sub-threshold UI animation behind the title
(a glow pulse, an animated diorama) flips a hash every frame and forces a full re-classify
per frame — which on CPU is hundreds of ms each. Instead build a coarse grayscale feature
vector over just the detector regions and compare it within a noise floor; a steady screen
then classifies ONCE, and only a real window switch (title text redraws, well over the floor)
re-classifies. This is the shared core behind ``Collector._classify`` and precapture's
record-loop scroll-config gate — one primitive, two callers (see CLAUDE.md rule 7)."""

from __future__ import annotations

import cv2
import numpy as np

# Per-sample brightness delta that counts as "changed" (matches settle.THUMB_TOL).
TOL = 16
# Fewer changed samples than this across all regions -> nothing real moved (noise/animation).
MIN_CELLS = 8
# Each region is downsampled to CELL x CELL — a FIXED size so a 1px window-geometry jitter
# doesn't change the vector's shape (which would force a compare miss).
CELL = 16


def features(frame, fracs) -> np.ndarray | None:
    """Coarse grayscale samples of every detector search region, concatenated. Fixed-length
    per (frame-shape, fracs) so two frames line up sample-for-sample. ``None`` when there's
    nothing to sample (no regions / empty frame)."""
    img = frame.image
    if img is None or img.size == 0 or not fracs:
        return None
    cw, ch = frame.client.w, frame.client.h
    parts = []
    for fb in fracs:
        pb = fb.to_pixels(cw, ch)
        crop = img[pb.y : pb.y + pb.h, pb.x : pb.x + pb.w]
        if crop.size:
            # Stride-subsample the (wide, 4K) region FIRST so the area-resize doesn't read
            # every pixel, then resize to a FIXED CELL x CELL. Channel-max keeps the signature
            # magnitude stable so TOL/MIN_CELLS mean the same regardless of the sampling grid.
            hh, ww = crop.shape[:2]
            step = max(1, min(hh, ww) // (CELL * 4))
            g = crop[::step, ::step]
            g = g.max(axis=2) if g.ndim == 3 else np.ascontiguousarray(g)
            parts.append(cv2.resize(g, (CELL, CELL), interpolation=cv2.INTER_AREA).reshape(-1))
    if not parts:
        return None
    return np.concatenate(parts).astype(np.int16)   # int16: abs-diff without uint8 wrap


def changed(a: np.ndarray | None, b: np.ndarray | None, tol: int = TOL) -> int | None:
    """How many samples differ by more than ``tol``. ``None`` when the two vectors can't be
    compared (either missing, or different shapes) — the caller should treat that as "changed"."""
    if a is None or b is None or a.shape != b.shape:
        return None
    return int((np.abs(a - b) > tol).sum())
