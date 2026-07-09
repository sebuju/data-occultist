"""Fingerprint of the OCR-related python source, used to bust :mod:`ocr_cache`.

Editing OCR code (the reader, field rules, correction, glyph matching, ...) changes
what a stashed image reads to, but nothing about the on-disk cache key (image id +
box/field config + engine sig) reflects that — the cache would keep serving results
computed by the old code. ``ocr_code_sig()`` hashes every ``.py`` file's mtime under
the OCR-relevant subpackages so :class:`~oc.web.ocr_cache.OcrCache` can wipe itself
whenever the code moves.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

_OC_ROOT = Path(__file__).resolve().parents[1]

# Every subpackage that holds OCR-affecting code: engine backends + tuning (ocr/),
# reader/grid/fields/stability/preprocess/atlas/glyph templating (collect/),
# fuzzy correction (learn/), window/glyph classification (detect/).
_OCR_DIRS = ("ocr", "collect", "learn", "detect")


def ocr_code_sig() -> str:
    """Stable hash of (relpath, mtime_ns) for every OCR-related .py file.

    Missing files / stat errors are skipped rather than raised — this must never
    break a cache load. A code checkout that only rewrites mtimes (not content)
    spuriously busts the cache; that's safe (just recomputes OCR), just not optimal.
    """
    entries = []
    for dirname in _OCR_DIRS:
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
