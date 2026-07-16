"""Fingerprint of the subset-view compute source, used to bust :mod:`view_cache`.

Editing the join/pivot/derive/filter/sort logic (``enrich/subset.py`` and friends)
changes what a subset computes to, but nothing about the disk cache key (subset id +
source dataset revs) reflects that — the cache would keep serving results computed by
the old code. ``view_code_sig()`` content-hashes every ``.py`` file under the
view-affecting subpackage so :class:`~oc.web.view_cache.ViewCache` can wipe itself
whenever the code moves. Shares the :func:`~oc.web.code_sig.code_sig` primitive with
:func:`~oc.web.ocr_code_sig.ocr_code_sig` — content, not mtime, so a checkout / reinstall
that leaves bytes identical does not bust the cache.
"""

from __future__ import annotations

from pathlib import Path

from .code_sig import code_sig

_OC_ROOT = Path(__file__).resolve().parents[1]

# The subpackage that holds subset-view-affecting code: join/pivot/derive/filter/sort.
_VIEW_DIRS = ("enrich",)


def view_code_sig() -> str:
    """Content hash of every view-compute-related ``.py`` file. Content-based, so an
    mtime-only touch does not move it; missing files are skipped, never raised."""
    return code_sig(_OC_ROOT, _VIEW_DIRS)
