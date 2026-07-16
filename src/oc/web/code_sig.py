"""Shared source-fingerprint primitive for the compute caches (:mod:`ocr_cache`,
:mod:`view_cache`).

A disk cache keyed on data inputs (image + box config, or subset id + source revs) can't
see a change to the *code* that turns those inputs into a result — so it would keep serving
results computed by the old logic. Each cache pairs its key with a ``*_code_sig()`` that
hashes the relevant source and wipes the cache when it moves.

This module is the ONE implementation both signatures build on (see hard rule 7): a
CONTENT hash — not mtime — of a selected set of ``.py`` files. Content, not mtime, so a
``git checkout`` / reinstall / formatter re-save that leaves bytes identical does not bust
the cache; only a real edit does.

Callers describe their scope with :func:`sig_files`: ``whole_dirs`` are hashed in full,
``scoped`` maps a dir to a denylist of filenames to skip within it.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from pathlib import Path


def sig_files(root: Path, whole_dirs: Iterable[str],
              scoped: Mapping[str, frozenset[str]] | None = None) -> list[Path]:
    """The ``.py`` files a signature covers: every file under each ``whole_dirs`` entry,
    plus each ``scoped`` dir minus its skip set. Sorted by relpath so the hash is
    order-stable. Selection is kept separate from hashing so it's testable in isolation."""
    files: list[Path] = []
    for dirname in whole_dirs:
        base = root / dirname
        if base.is_dir():
            files.extend(base.rglob("*.py"))
    for dirname, skip in (scoped or {}).items():
        base = root / dirname
        if base.is_dir():
            files.extend(f for f in base.rglob("*.py") if f.name not in skip)
    files.sort(key=lambda f: f.relative_to(root).as_posix())
    return files


def code_sig(root: Path, whole_dirs: Iterable[str],
             scoped: Mapping[str, frozenset[str]] | None = None) -> str:
    """Stable content hash of (relpath, sha1(bytes)) for every file :func:`sig_files`
    selects. Missing files / read errors are skipped, never raised — a cache load must
    never fail on this.
    """
    h = hashlib.sha1()
    for f in sig_files(root, whole_dirs, scoped):
        try:
            data = f.read_bytes()
        except OSError:
            continue
        h.update(f.relative_to(root).as_posix().encode("utf-8"))
        h.update(b"\x01")
        h.update(hashlib.sha1(data).digest())
        h.update(b"\x00")
    return h.hexdigest()
