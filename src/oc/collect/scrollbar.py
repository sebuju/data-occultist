"""Read a scrollbar's thumb position from its region — 0.0 (start) .. 1.0 (end).

Heuristic, no thresholds: along the scroll axis, the thumb is the segment whose
brightness deviates most from the track background. The brightness-weighted centre
of that deviation gives the thumb position as a fraction of the track.
"""

from __future__ import annotations

import numpy as np


def scroll_position(image: np.ndarray, orientation: str = "vertical") -> float | None:
    """0..1 position of the thumb's CENTRE along the track. Finds the thumb as the
    contiguous block (around the strongest deviation from the track) rather than a
    noise-sensitive weighted centroid."""
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
    # scroll fraction: thumb top over the reachable range -> 0 at top, 1 at bottom
    thumb_len = hi - lo + 1
    reach = n - thumb_len
    if reach <= 0:
        return 0.0
    return round(min(max(lo / reach, 0.0), 1.0), 3)
