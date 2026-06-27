"""The ONE way records land in a dataset store, shared by live collection and the teaching
UI's manual commit (CLAUDE.md rule 7) — so "commit" writes exactly what "capture for real"
would, never a parallel reimplementation that can drift.

Upstream gates differ by caller (the collector adds the temporal confirmer + mirror sync; a
one-shot commit has a single frame), but the act of folding confirmed records into the store
is identical and lives here.
"""

from __future__ import annotations

from .reader import Record


def commit_records(store, records: list[Record]) -> tuple[int, int, list[dict]]:
    """Write each record into ``store`` via ``record_seen``. Returns
    ``(written, skipped, changed)``: ``written`` = records that added/updated a key,
    ``skipped`` = records whose key was unresolvable or whose read matched the current value
    (nothing to track), ``changed`` = the values of each written record (for triggers/pricing).
    """
    written = skipped = 0
    changed: list[dict] = []
    for rec in records:
        if store.record_seen(rec.values) is not None:
            written += 1
            changed.append(dict(rec.values))
        else:
            skipped += 1
    return written, skipped, changed
