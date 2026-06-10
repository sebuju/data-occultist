"""One global serialization point for ALL OCR work.

There is a single OCR model on a single device, so two OCR jobs running at once never
go faster — they thrash the GPU (each switches the other's working set / cuDNN plans)
and BOTH end up far slower than if they had run back to back. So every OCR job takes
this lock and runs to completion before the next starts.

It is an ``RLock`` on purpose: a job wraps its whole unit of work in :func:`ocr_job`
(held coarsely, so jobs don't interleave), and the engine ALSO takes it around each
individual inference (a safety net for any call site that forgot the wrapper). The
re-entrancy means the per-call take is free while a job already holds it, yet a
DIFFERENT thread's job still blocks at the boundary until this one finishes.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager

OCR_LOCK = threading.RLock()


@contextmanager
def ocr_job():
    """Serialize a whole OCR job (a preview read, a detect pass, one precapture frame).

    Hold it for the entire job — not per call — so jobs queue instead of interleaving.
    Keep precapture's scope to ONE frame so the UI can slip a read in between frames."""
    OCR_LOCK.acquire()
    try:
        yield
    finally:
        OCR_LOCK.release()
