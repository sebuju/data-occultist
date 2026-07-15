"""Fingerprint of the subset-view compute source, used to bust :mod:`view_cache`.

Editing the join/pivot/derive/filter/sort logic (``enrich/subset.py`` and friends)
changes what a subset computes to, but nothing about the disk cache key (subset id +
source dataset revs) reflects that — the cache would keep serving results computed by
the old code. ``view_code_sig()`` hashes every ``.py`` file's mtime under the
view-affecting subpackage so :class:`~oc.web.view_cache.ViewCache` can wipe itself
whenever the code moves. Mirrors :func:`~oc.web.ocr_code_sig.ocr_code_sig`.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

_OC_ROOT = Path(__file__).resolve().parents[1]

# The subpackage that holds subset-view-affecting code: join/pivot/derive/filter/sort.
_VIEW_DIRS = ("enrich",)


def view_code_sig() -> str:
    """Stable hash of (relpath, mtime_ns) for every view-compute-related .py file.

    Missing files / stat errors are skipped rather than raised — this must never
    break a cache load. A code checkout that only rewrites mtimes (not content)
    spuriously busts the cache; that's safe (just recomputes the view), just not
    optimal.
    """
    entries = []
    for dirname in _VIEW_DIRS:
        base = _OC_ROOT / dirname
        if not base.is_dir():
            continue
        for f in base.rglob("*.py"):
            try:
                st = f.stat()
            except OSError:
                continue
            entries.append((f.relative_to(_OC_ROOT).as_posix(), st.st_mtime_ns))
    entries.sort()
    blob = "\x00".join(f"{rel}\x01{mtime}" for rel, mtime in entries)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()
