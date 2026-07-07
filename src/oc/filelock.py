"""Cross-process advisory file lock, for the rare sidecar (e.g. the OCR result cache) that
more than one process may write concurrently — a plain ``threading.Lock`` only serializes
threads inside ONE process; it does nothing across two ``data-occultist`` instances (the
desktop app + ``serve``, or a ``--reload`` worker overlapping its predecessor during restart).

Windows uses ``msvcrt.locking`` on a ``<path>.lock`` sidecar; POSIX uses ``fcntl.flock``.
Either import failing (a platform with neither) makes this a no-op context manager — the
caller degrades to single-process safety only, same as before this module existed.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from pathlib import Path

try:
    import msvcrt

    def _lock(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)

    def _unlock(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)

except ImportError:
    try:
        import fcntl

        def _lock(fh) -> None:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)

        def _unlock(fh) -> None:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    except ImportError:
        _lock = _unlock = None   # neither backend available -> file_lock() is a no-op


@contextmanager
def file_lock(path: Path | str, timeout: float = 5.0):
    """Hold an exclusive lock on ``<path>.lock`` for the block's duration, creating the
    sidecar if needed. Blocks (polling) up to ``timeout`` seconds, then proceeds unlocked
    rather than hanging forever — a stuck lock must never wedge every OCR request."""
    if _lock is None:
        yield   # no lock backend on this platform -> best-effort, same as before this module
        return
    lock_path = Path(str(path) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    fh = open(lock_path, "a+b")
    try:
        while True:
            try:
                _lock(fh)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    break   # give up waiting; proceed unlocked rather than hang
                time.sleep(0.02)
        try:
            yield
        finally:
            try:
                _unlock(fh)
            except OSError:
                pass
    finally:
        fh.close()
