"""Fingerprint of the OCR-related python source, used to bust :mod:`ocr_cache`.

Editing OCR code (the reader, field rules, correction, glyph matching, ...) changes
what a stashed image reads to, but nothing about the on-disk cache key (image id +
box/field config + engine sig) reflects that — the cache would keep serving results
computed by the old code. ``ocr_code_sig()`` hashes the CONTENT of every read-affecting
``.py`` file so :class:`~oc.web.ocr_cache.OcrCache` can wipe itself when that code moves.

Content, not mtime: the hash folds each file's BYTES, so a ``git checkout`` /
branch-switch / ``pip install -e`` / formatter re-save that leaves bytes identical does
NOT bust the cache — only a real code change does.

Scope, not "every .py under four dirs": ``ocr/`` (engine + read split), ``learn/`` (fuzzy
correction) and ``detect/`` (window/glyph classification) are hashed whole — every file
there shapes a read. ``collect/`` is hashed too, EXCEPT :data:`_COLLECT_SKIP` — the
live-collection / persistence / trigger / notification orchestration that has nothing to
do with what a stashed image OCRs to (editing ``live.py`` or ``register_history.py`` must
not wipe the OCR cache). The skip is a *denylist* on purpose: a new, unlisted ``collect/``
file defaults to being hashed → busts → safe. Under-including (missing a read-affecting
file) is the only dangerous direction, and even then it self-heals — the cache serves only
boot-phase reads; a live read or a post-boot edit always re-OCRs fresh.
"""

from __future__ import annotations

from pathlib import Path

from .code_sig import code_sig, sig_files

_OC_ROOT = Path(__file__).resolve().parents[1]

# Subpackages hashed in full: engine backends + tuning (ocr/), fuzzy correction (learn/),
# window/glyph classification (detect/).
_WHOLE_DIRS = ("ocr", "learn", "detect")

# collect/ is hashed too, minus these — live-collection / persistence / trigger / pretty
# orchestration that never changes what a STASHED image reads to. Anything not listed here
# stays hashed (safe-by-default: an unknown new file busts rather than risks a stale read).
_COLLECT_SKIP = frozenset({
    "collector.py", "live.py", "precapture.py", "settle.py", "sink.py", "slice_sync.py",
    "stability.py", "register_history.py", "register_ops.py",
    "producer_history.py", "readout_history.py", "trigger_history.py", "triggers.py",
    "commit.py", "templating.py", "detsig.py", "input_history.py",
})


def _sig_files() -> list[Path]:
    """The read-affecting ``.py`` files whose content feeds the signature — the whole of
    ``ocr/``/``learn/``/``detect/`` plus ``collect/`` minus :data:`_COLLECT_SKIP`."""
    return sig_files(_OC_ROOT, _WHOLE_DIRS, {"collect": _COLLECT_SKIP})


def ocr_code_sig() -> str:
    """Content hash of every read-affecting OCR source file (see :func:`_sig_files`).
    Content-based, so rewriting a file's mtime without changing its bytes does not move
    the signature; missing files are skipped, never raised."""
    return code_sig(_OC_ROOT, _WHOLE_DIRS, {"collect": _COLLECT_SKIP})
