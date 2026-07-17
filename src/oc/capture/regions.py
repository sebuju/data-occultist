"""Strip planning for partial-window grabs.

A BitBlt grab has a large FIXED per-call cost (~6-7ms measured at 4K — DWM sync), while
extra area is comparatively cheap: one 3840x200 strip costs the same as one 300x60 box,
and a full 3840x2160 frame ~5x that. So a partial grab must minimise the NUMBER of
grabs, not the grabbed area: cluster the wanted boxes into a few full-width horizontal
strips instead of grabbing each box on its own (15 per-box grabs measured 3x SLOWER
than one full frame).

Pure logic (no capture imports) so any backend can plan strips and tests need no screen.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..types import PixelBox

# Merge two strips when the gap between them is under this: a taller single BitBlt is
# cheaper than a second call (area is nearly free, calls are not).
GAP_PX = 220
# Each strip is one fixed-cost grab; above this count, merge the smallest gaps away.
MAX_STRIPS = 3
# When the strips would cover more than this fraction of the window anyway, a plain
# full grab is simpler and barely dearer — signal the caller to take it.
MAX_COVER = 0.55


def strip_spans(
    boxes: Sequence[PixelBox],
    client_h: int,
    *,
    gap: int = GAP_PX,
    max_strips: int = MAX_STRIPS,
    max_cover: float = MAX_COVER,
) -> list[tuple[int, int]] | None:
    """Cluster client-relative pixel ``boxes`` into few full-width ``(y0, y1)`` strips.

    Each box is padded vertically by its own height (min 16px) so downstream reads that
    grow their crop for context (the readout text union pass) stay inside real pixels.
    Returns sorted, non-overlapping spans — or ``None`` when a partial grab isn't
    worthwhile (no usable boxes, or the strips would cover > ``max_cover`` of the
    window) and the caller should grab the full window instead.
    """
    spans: list[list[int]] = []
    for b in boxes:
        pad = max(16, b.h)
        y0, y1 = max(0, b.y - pad), min(client_h, b.bottom + pad)
        if y1 > y0:
            spans.append([y0, y1])
    if not spans:
        return None
    spans.sort()
    merged = [spans[0]]
    for y0, y1 in spans[1:]:
        if y0 - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], y1)
        else:
            merged.append([y0, y1])
    while len(merged) > max_strips:
        i = min(range(len(merged) - 1), key=lambda j: merged[j + 1][0] - merged[j][1])
        merged[i][1] = merged[i + 1][1]
        del merged[i + 1]
    if sum(y1 - y0 for y0, y1 in merged) > max_cover * client_h:
        return None
    return [(y0, y1) for y0, y1 in merged]
