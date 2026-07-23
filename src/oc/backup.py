"""Format-agnostic snapshot machinery shared by every versioned backup in the app.

A "snapshot store" is just a directory of timestamp-named files (``<stamp>.<ext>``). This
module owns the parts that don't care WHAT is being snapshotted: minting a fresh,
collision-free, sortable UTC stamp; listing snapshots chronologically; pruning to a kept
set; and the two retention policies. Profile backups (YAML, in :mod:`oc.profile.loader`)
and database backups (SQLite, in :mod:`oc.store.db_backup`) both build on this rather than
each re-implementing the stamp/list/prune dance.

Stamp format is ``%Y%m%d-%H%M%S-%f`` (UTC) so a plain string sort is chronological and the
stamp round-trips to a datetime for age math.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

STAMP_FMT = "%Y%m%d-%H%M%S-%f"


def parse_stamp(stamp: str) -> datetime | None:
    """The UTC datetime a stamp encodes, or ``None`` if it isn't a parseable stamp."""
    try:
        return datetime.strptime(stamp, STAMP_FMT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def new_stamp_path(backup_dir: Path | str, ext: str, now: datetime) -> tuple[str, Path]:
    """A fresh ``<stamp>.<ext>`` path under ``backup_dir`` that doesn't yet exist.

    Windows' wall clock has ~15ms resolution, so two snapshots in quick succession can mint
    an identical ``%f`` stamp; bump by a microsecond until the path is free so a snapshot
    never silently overwrites another (the stamp stays parseable + sortable). Does NOT
    create the directory — the caller writes the file."""
    d = Path(backup_dir)
    ext = ext.lstrip(".")
    while True:
        stamp = now.strftime(STAMP_FMT)
        path = d / f"{stamp}.{ext}"
        if not path.exists():
            return stamp, path
        now += timedelta(microseconds=1)


def list_snapshots(backup_dir: Path | str, ext: str, *, prefix: str = "") -> list[Path]:
    """All ``<prefix>*.<ext>`` snapshots in ``backup_dir``, oldest first (stamp sorts
    chronologically). Pass ``prefix`` when ``backup_dir`` is SHARED by more than one
    snapshot kind under the same ``ext`` (e.g. ``logs/`` holds both ``logbar-*.log`` and
    ``nodelog-*.log``) — without it, a keep-last-N prune sorts and caps stems from every
    kind together, so one kind rotating faster can evict every snapshot of the other."""
    d = Path(backup_dir)
    if not d.exists():
        return []
    return sorted(d.glob(f"{prefix}*.{ext.lstrip('.')}"))


def prune(backup_dir: Path | str, ext: str, keep: set[str], *, prefix: str = "") -> None:
    """Delete every ``<prefix>*.<ext>`` snapshot whose stamp isn't in ``keep``. ``prefix``
    must match whatever was passed to build ``keep`` — see :func:`list_snapshots`."""
    for p in list_snapshots(backup_dir, ext, prefix=prefix):
        if p.stem not in keep:
            p.unlink(missing_ok=True)


def retention_keep(stamps: list[str], now: datetime) -> set[str]:
    """Thinning policy: which stamps to KEEP (caller deletes the rest). Dense recent,
    sparse old:

    * keep ALL snapshots from the last 48h (active authoring -> fine-grained undo),
    * keep the newest one per calendar day for the prior 30 days,
    * keep the newest one per ISO week older than that.

    ``now`` is passed in (not read from the clock) so the policy is pure and testable.
    Unparseable stamps are kept (never silently delete something we don't understand)."""
    keep: set[str] = set()
    keep_buckets: set = set()
    # Newest first so the first stamp seen in each day/week bucket is the one we keep.
    for s in sorted(stamps, reverse=True):
        dt = parse_stamp(s)
        if dt is None:
            keep.add(s)
            continue
        age = now - dt
        if age.total_seconds() <= 48 * 3600:
            keep.add(s)                       # all of the last 48h
            continue
        if age.days <= 30:
            bucket = ("D", dt.year, dt.month, dt.day)        # one per calendar day
        else:
            iso = dt.isocalendar()
            bucket = ("W", iso[0], iso[1])                   # one per ISO week
        if bucket not in keep_buckets:
            keep_buckets.add(bucket)
            keep.add(s)
    return keep


def keep_last_n(stamps: list[str], n: int) -> set[str]:
    """Keep-last-N policy: the ``n`` newest stamps (caller deletes the rest). Used where
    snapshots are large (a whole SQLite file) so a flat count cap beats time-thinning.
    Unparseable stamps still sort last-ish by string; ``n <= 0`` keeps nothing."""
    if n <= 0:
        return set()
    return set(sorted(stamps, reverse=True)[:n])


def gfs_keep(stamps: list[str], now: datetime, *, recent: int = 3,
             weekly_weeks: int = 8) -> set[str]:
    """Grandfather-father-son retention: which stamps to KEEP (caller deletes the rest).

    * the ``recent`` newest snapshots, unconditionally (dense, for quick rollback),
    * then the newest snapshot per ISO week for the last ``weekly_weeks`` weeks,
    * then the newest snapshot per calendar month for everything older.

    Bounds growth to ~``recent`` + ``weekly_weeks`` + one-per-month-forever, so a large
    snapshot (a whole SQLite file) doesn't pile up. ``now`` is passed in so the policy is
    pure and testable; unparseable stamps are kept (never silently delete the unknown)."""
    keep: set[str] = set()
    buckets: set = set()
    weekly_cutoff = weekly_weeks * 7 * 24 * 3600
    for i, s in enumerate(sorted(stamps, reverse=True)):   # newest first
        dt = parse_stamp(s)
        if dt is None:
            keep.add(s)
            continue
        if i < recent:
            keep.add(s)                                    # always keep the freshest few
            continue
        if (now - dt).total_seconds() <= weekly_cutoff:
            iso = dt.isocalendar()
            bucket = ("W", iso[0], iso[1])                 # one per ISO week (recent weeks)
        else:
            bucket = ("M", dt.year, dt.month)              # one per calendar month (older)
        if bucket not in buckets:
            buckets.add(bucket)
            keep.add(s)
    return keep
