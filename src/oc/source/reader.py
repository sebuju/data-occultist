"""Coalesced file reads, keyed by absolute path.

Several source nodes can point at the SAME file (the user's "if multiple nodes exist to the
same log file, route via the same reads internally"). :class:`SourceReader` caches a file's
text by ``(path, mtime, size)`` so concurrent reads of an unchanged file hit disk ONCE. For
``tail`` logs each caller keeps its own consumed-length so it only sees newly appended text,
while the underlying disk read is still shared.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path


def _tail_lines(text: str, n: int) -> tuple[str, int]:
    """The last ``n`` lines of ``text`` plus the 1-based absolute line number where that window
    starts. Keeps line endings so downstream line counts are unchanged."""
    lines = text.splitlines(keepends=True)
    if n >= len(lines):
        return text, 1
    window = lines[-n:]
    return "".join(window), len(lines) - len(window) + 1


class SourceReader:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._cache: dict[str, tuple[int, int, str]] = {}   # abspath -> (mtime_ns, size, text)
        self._consumed: dict[tuple[str, str], int] = {}     # (abspath, key) -> chars already read
        self._lines: dict[tuple[str, str], int] = {}        # (abspath, key) -> COMPLETE lines already read
        self.reads = 0   # disk-read counter — tests assert coalescing

    def stat(self, path) -> tuple[int, int] | None:
        try:
            st = os.stat(path)
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size)

    def _load(self, abspath: str) -> str | None:
        sig = self.stat(abspath)
        if sig is None:
            return None
        cached = self._cache.get(abspath)
        if cached is not None and (cached[0], cached[1]) == sig:
            return cached[2]
        try:
            text = Path(abspath).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        self.reads += 1
        self._cache[abspath] = (sig[0], sig[1], text)
        return text

    def read(self, path, *, tail: bool = False, key: str = "", last_lines: int = 0) -> str:
        """Return the file's text. ``last_lines > 0`` returns only the LAST ``last_lines`` lines
        (read X rows from the end). ``tail`` (legacy) returns only the text appended since this
        ``key`` last read it. One disk read per ``(path, mtime, size)`` no matter how many callers
        ask."""
        with self._lock:
            ap = os.path.abspath(str(path))
            text = self._load(ap)
            if text is None:
                return ""
            if last_lines and last_lines > 0:
                return _tail_lines(text, last_lines)[0]
            if not tail:
                return text
            ck = (ap, key or "")
            seen = self._consumed.get(ck, 0)
            if seen > len(text):   # file rotated/truncated -> re-read from the start
                seen = 0
            self._consumed[ck] = len(text)
            return text[seen:]

    def read_lined(self, path, *, tail: bool = False, key: str = "", last_lines: int = 0) -> tuple[str, int]:
        """Like :meth:`read` but also returns the 1-based ABSOLUTE line number of the chunk's first
        line — so rows are numbered by their TRUE file position. ``last_lines > 0`` returns the last
        ``last_lines`` lines and the absolute line number where that window starts. ``tail`` (legacy)
        returns only complete newly-appended lines. A rotated/shrunk file restarts at line 1."""
        with self._lock:
            ap = os.path.abspath(str(path))
            text = self._load(ap)
            if text is None:
                return "", 1
            if last_lines and last_lines > 0:
                return _tail_lines(text, last_lines)
            ck = (ap, key or "")
            if not tail:
                return text, 1
            seen = self._consumed.get(ck, 0)
            base = self._lines.get(ck, 0)
            if seen > len(text):   # rotated/truncated -> start over
                seen, base = 0, 0
            chunk = text[seen:]
            cut = chunk.rfind("\n")
            if cut == -1:          # no complete line appended yet -> consume nothing
                return "", base + 1
            chunk = chunk[: cut + 1]
            self._consumed[ck] = seen + len(chunk)
            self._lines[ck] = base + chunk.count("\n")
            return chunk, base + 1


_READER: SourceReader | None = None


def default_reader() -> SourceReader:
    """The process-wide shared reader (one cache + tail offsets across daemon/route/runner)."""
    global _READER
    if _READER is None:
        _READER = SourceReader()
    return _READER
