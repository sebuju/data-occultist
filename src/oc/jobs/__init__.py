"""Out-of-process job primitives.

The web server is single-worker uvicorn: one process, one event loop, one GIL. Any
sustained CPU-bound work run *in* that process (encoding a multi-MB JSON store, an OCR
pass, a fuzzy match over a whole catalogue) holds the GIL and freezes the event loop for
its duration — every other request and SSE push stalls. Threads / ``run_in_executor``
can't fix this: the GIL is the constraint.

The cure is to run heavy work in a **separate process** (its own GIL) and let the server
only supervise it. :class:`~oc.jobs.subprocess_job.SubprocessJob` is that general
primitive — spawn ``python -m oc <subcmd> ...``, drain its output, learn when it exits.
The price sweep is the first caller; anything heavy a new endpoint needs should reuse this
rather than reintroducing an in-process worker thread.
"""

from __future__ import annotations

from .subprocess_job import SubprocessJob

__all__ = ["SubprocessJob"]
