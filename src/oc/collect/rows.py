"""Find where the grid's rows actually are, on the fly, from the OCR lines.

A scrollable list is rarely parked so its first row sits exactly on the authored
template — the real thing is scrolled to an arbitrary sub-row position. So instead
of tiling rows by a fixed stride from the data area's top, we cluster the OCR line
positions in the current frame into row bands. The grid then follows the content
wherever it happens to be, and partial/again-scrolled rows line up.

Everything here is in *client fractions* (0..1) so it's resolution independent.
"""

from __future__ import annotations

import math
from statistics import median


def detect_row_centers(
    centers_y: list[float],
    heights: list[float],
    expected_pitch: float,
    lo: float,
    hi: float,
    max_rows: int | None = None,
    anchor: str = "center",
) -> list[float]:
    """Cluster line y-centres (within ``[lo, hi]``) into row bands; return one anchor
    per band. A new band starts when the gap to the previous line exceeds ~0.6 of the
    expected row pitch (falling back to the median line height when no stride is set).

    ``anchor``: ``"center"`` returns each band's centroid; ``"top"`` returns the top of
    the band's topmost line (``center - height/2``). ``"top"`` is line-count invariant —
    a 1-line and a 2-line name both anchor at the same place — which keeps a grid's
    cells aligned regardless of how many lines each name wraps to."""
    pairs = sorted((c, h) for c, h in zip(centers_y, heights) if lo <= c <= hi)
    if not pairs:
        return []
    line_h = median(h for _, h in pairs)
    pitch = expected_pitch if expected_pitch and expected_pitch > 0 else line_h
    gap = max(pitch, line_h) * 0.6

    def band(cluster: list[tuple[float, float]]) -> float:
        if anchor == "top":
            return min(c - h / 2 for c, h in cluster)    # top of the topmost line
        if anchor == "bottom":
            return max(c for c, _ in cluster)            # centre of the bottommost line
        return sum(c for c, _ in cluster) / len(cluster)  # centroid

    rows: list[float] = []
    cluster = [pairs[0]]
    for c, h in pairs[1:]:
        if c - cluster[-1][0] > gap:
            rows.append(band(cluster))
            cluster = [(c, h)]
        else:
            cluster.append((c, h))
    rows.append(band(cluster))
    return rows[:max_rows] if max_rows else rows


def fit_row_lattice(
    centers_y: list[float],
    heights: list[float],
    expected_pitch: float,
    lo: float,
    hi: float,
    max_rows: int | None = None,
    anchor: str = "center",
    pitch_tol: float | None = None,
) -> list[float]:
    """Fit a regular pitch+phase lattice to the detected rows, then emit every lattice
    position spanning ``[lo, hi]``.

    The findings are *evidence*, not the grid: :func:`detect_row_centers` clusters the
    OCR lines into candidate rows, but a scrolled/consumed list leaves gaps (an occluded
    name drops its whole row) and noise (a stray line invents a phantom row). So we
    estimate the row pitch and phase from the candidate bands and lay a regular grid over
    the data area — filling rows that had no finding and rejecting bands that don't sit on
    the lattice.

    ``pitch_tol`` (0..1) is the opt-in switch: it both turns the lattice ON and clamps the
    derived pitch to ``expected_pitch * [1 - tol, 1 + tol]``. ``None`` means the window is
    static — the candidate bands are returned at face value (legacy clustering), unchanged.
    With fewer than two bands there's no measurable pitch either way, so a single finding
    stays a single row (never speculatively tiled).

    ``expected_pitch`` is the authored row pitch (the clamp centre and the clustering gap seed).
    """
    bands = detect_row_centers(centers_y, heights, expected_pitch, lo, hi, None, anchor)
    if pitch_tol is None or len(bands) < 2:
        return bands[:max_rows] if max_rows else bands

    diffs = [b - a for a, b in zip(bands, bands[1:])]
    # Seed from the authored pitch when given (robust against missing rows), else the
    # smallest observed gap (two adjacent rows ~= one pitch).
    seed = expected_pitch if expected_pitch and expected_pitch > 0 else min(diffs)
    if seed <= 0:
        return bands
    # Refine: a ~2x gap is one skipped row, so divide each diff by its row-count k and
    # take the median per-row pitch. One pass of re-binning settles a rough seed.
    pitch = seed
    for _ in range(2):
        per_row = [d / max(1, round(d / pitch)) for d in diffs]
        pitch = median(per_row)
        if pitch <= 0:
            return bands

    if pitch_tol is not None and expected_pitch and expected_pitch > 0:
        pitch = min(max(pitch, expected_pitch * (1 - pitch_tol)), expected_pitch * (1 + pitch_tol))

    # Least-squares phase: index each band to its nearest lattice line, then average the
    # residuals. A phantom off-lattice band only nudges the phase, it never adds a row.
    base = bands[0]
    phase = base + sum(b - (base + round((b - base) / pitch) * pitch) for b in bands) / len(bands)

    k_lo = math.ceil((lo - phase) / pitch)
    k_hi = math.floor((hi - phase) / pitch)
    out = [phase + k * pitch for k in range(k_lo, k_hi + 1)]
    return out[:max_rows] if max_rows else out
