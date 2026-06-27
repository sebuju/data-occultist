"""Decide which keys a *mirror* dataset should remove as the user scrolls a continuous grid.

The list scrolls continuously (overlapping rows) AND **reflows on removal**: consuming a relic
shifts every later relic up one slot. So a row's screen position is not stable, and even a
relic's absolute list position changes the moment something before it is consumed. Tracking a
position and removing on mere *absence* is therefore wrong twice over:
  * a flaky OCR miss of an on-screen relic would look "absent" -> false removal;
  * a consumption shifts many relics, so everything after the gap looks "moved/absent".

So removal keys off **replacement**, not absence: a stored relic is gone only when a DIFFERENT
relic is now read in its exact grid slot (same column AND same scroll-invariant row position).
When a relic is consumed, its successor reflows into its slot -> replacement seen -> removed.
A relic merely missed by OCR leaves its slot empty (nothing read there) -> NOT removed. A relic
still present is read at its (possibly shifted) slot -> excluded from candidates -> safe.

Each slot is identified by ``(xpos, vpos)``: ``xpos`` the column (0..1 of the data_area width,
scroll-invariant) and ``vpos`` the scroll-invariant **row index** in the whole list (the
collector builds it from the scrollbar + static cutout calibration). Two reads are "the same
slot" within ``ex`` (column fraction) / ``ev`` (rows) tolerances. ``vlo``/``vhi`` are the
row-index span currently on screen.

Safety: an occluded/partial frame is ``clean=False`` and contributes nothing; a replacement
must persist ``confirm_frames`` consecutive clean frames before the key is removed.

Pure logic (no OCR, store, or image work) so it unit-tests in isolation.
"""

from __future__ import annotations


class SliceSync:
    def __init__(self, confirm_frames: int, ex: float = 0.1, ev: float = 0.5) -> None:
        self._confirm = max(1, int(confirm_frames))
        self._ex = max(1e-6, float(ex))    # column-match tolerance (data_area x fraction)
        self._ev = max(1e-6, float(ev))    # row-match tolerance (row indices, ~half a row)
        self._cell: dict[str, tuple[float | None, float]] = {}  # key -> (xpos, vpos) last read at
        self._absence: dict[str, int] = {}                      # key -> consecutive replaced frames

    def observe(self, vlo: float, vhi: float, read_cells: dict[str, tuple[float, float]],
                present_keys: set[str], clean: bool) -> set[str]:
        """Fold one frame in and return the keys to soft-remove now.

        ``vlo``/``vhi`` — the row-index range visible this frame (``0, viewport_rows`` for a
        one-screen list). ``read_cells`` — ``{key: (xpos, vpos)}`` (vpos = row index) for every
        key read this frame. ``present_keys`` — keys currently present in the store. ``clean``
        — the frame had no occluded/below-floor cell.
        """
        if not clean:
            return set()                         # occluded frame: no evidence either way
        for k, slot in read_cells.items():       # seen keys refresh their slot, clear absence
            self._cell[k] = slot
            self._absence.pop(k, None)
        read_slots = list(read_cells.values())
        gone: set[str] = set()
        for k in present_keys:
            if k in read_cells:
                continue
            slot = self._cell.get(k)
            if slot is None:
                continue                         # never seen this run -> leave it
            xk, vk = slot
            if xk is None or not (vlo <= vk <= vhi):
                continue                         # slot not currently in view -> can't judge
            # replaced only if a DIFFERENT relic is read in K's exact slot now (column + row).
            replaced = any(abs(x - xk) < self._ex and abs(v - vk) < self._ev
                           for (x, v) in read_slots)
            if not replaced:
                continue                         # slot empty/flaky -> no positive evidence, keep
            n = self._absence.get(k, 0) + 1
            if n >= self._confirm:
                gone.add(k)
                self._absence.pop(k, None)
                self._cell.pop(k, None)
            else:
                self._absence[k] = n
        return gone

    def pos_map(self) -> dict[str, float]:
        """The learned key -> row-index map (for persistence / the table column)."""
        return {k: v for k, (_x, v) in self._cell.items()}

    def seed(self, pos: dict[str, float]) -> None:
        """Restore row indices learned on a previous run (column unknown until re-seen, so a
        seeded key isn't a removal candidate until read again — safe, never false-removes)."""
        for k, v in pos.items():
            if k not in self._cell:
                self._cell[k] = (None, v)
