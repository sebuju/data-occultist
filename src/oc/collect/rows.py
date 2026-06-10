"""Find where the grid's rows actually are, on the fly, from the OCR lines.

A scrollable list is rarely parked so its first row sits exactly on the authored
template — the real thing is scrolled to an arbitrary sub-row position. So instead
of tiling rows by a fixed stride from the data area's top, we cluster the OCR line
positions in the current frame into row bands. The grid then follows the content
wherever it happens to be, and partial/again-scrolled rows line up.

Everything here is in *client fractions* (0..1) so it's resolution independent.
"""

from __future__ import annotations

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
