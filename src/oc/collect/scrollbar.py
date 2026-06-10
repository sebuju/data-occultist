"""Read a scrollbar's thumb position from its region — 0.0 (start) .. 1.0 (end).

Heuristic, no thresholds: along the scroll axis, the thumb is the segment whose
brightness deviates most from the track background. The brightness-weighted centre
of that deviation gives the thumb position as a fraction of the track.
"""

from __future__ import annotations

import numpy as np


def scroll_detail(image: np.ndarray, orientation: str = "vertical") -> dict | None:
    """Locate the thumb and return ``{pos, thumb_px, thumb_len, conf}``:

      * ``pos``       — 0..1 position of the thumb top over the reachable range
      * ``thumb_px``  — the thumb's top offset IN PIXELS within the crop (along the axis)
      * ``thumb_len`` — the thumb's length in pixels
      * ``conf``      — how strongly the thumb stands out from the track (0..1)
    """
    if image is None or image.size == 0:
        return None
    gray = image.max(axis=2).astype(np.float32)            # brightest channel
    axis = 1 if orientation == "vertical" else 0           # collapse the short axis
    profile = gray.mean(axis=axis)
    n = profile.size
    if n < 2:
        return None
    dev = np.abs(profile - np.median(profile))             # thumb stands out from track
    peak = int(np.argmax(dev))
    if dev[peak] < 6:                                       # essentially flat -> no thumb
        return None
    thr = dev[peak] * 0.5
    lo = hi = peak                                          # grow the contiguous thumb block
    while lo > 0 and dev[lo - 1] >= thr:
        lo -= 1
    while hi < n - 1 and dev[hi + 1] >= thr:
        hi += 1
    thumb_len = hi - lo + 1
    reach = n - thumb_len
    pos = 0.0 if reach <= 0 else min(max(lo / reach, 0.0), 1.0)
    return {"pos": round(pos, 3), "thumb_px": int(lo), "thumb_len": int(thumb_len),
            "conf": round(min(1.0, float(dev[peak]) / 64.0), 2)}


def scroll_position(image: np.ndarray, orientation: str = "vertical") -> float | None:
    """0..1 position of the thumb top along the track (``None`` if no thumb)."""
    d = scroll_detail(image, orientation)
    return d["pos"] if d else None
