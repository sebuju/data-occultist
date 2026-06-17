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
import time
from contextlib import contextmanager

OCR_LOCK = threading.RLock()


class _JobTimer:
    """Compute time of one OCR job, in ms — measured AFTER the lock is acquired, so it
    excludes time spent queued behind another job. ``ms`` is None until the job ends."""

    __slots__ = ("ms",)

    def __init__(self):
        self.ms = None


@contextmanager
def ocr_job(engine=None):
    """Serialize a whole OCR job (a preview read, a detect pass, one precapture frame).

    Hold it for the entire job — not per call — so jobs queue instead of interleaving.
    Keep precapture's scope to ONE frame so the UI can slip a read in between frames.

    Pass ``engine`` (an :class:`~oc.interfaces.OcrEngine`) so its model is built BEFORE the
    timer starts. The model loads lazily on first use; on initial page load several reads
    fire while the background warmup is still building, and that one-time build would land
    INSIDE the timed region — every concurrent first read then collapses onto the build cost
    and they all report ~identical, inflated durations. Building first (outside the timer,
    and before the lock so a multi-second build never holds it) keeps ``.ms`` to real compute.

    Yields a :class:`_JobTimer` whose ``.ms`` is the job's own compute time (lock-wait and
    one-time model build excluded) once the block exits — so callers can report real per-op
    duration instead of wall-clock-since-issue, which on a busy serial backend is dominated
    by queue wait."""
    if engine is not None:
        prep = getattr(engine, "prepare", None)
        if prep is not None:
            prep()
    OCR_LOCK.acquire()
    job = _JobTimer()
    t0 = time.perf_counter()
    try:
        yield job
    finally:
        job.ms = (time.perf_counter() - t0) * 1000
        OCR_LOCK.release()
