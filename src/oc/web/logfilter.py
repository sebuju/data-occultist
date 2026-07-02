"""Quieten uvicorn's access log: drop the flood of successful static-asset GETs.

The front-end is mounted at ``/`` (every .js/.css/.svg/.woff/page load is a request), and the
no-cache static handler returns 200 on every load — so a single browser refresh prints dozens of
access lines that bury the ones that matter (the ``/api`` calls, and any error). This filter keeps
ALL of those: it only silences a *successful* (<400) GET for a static asset or an HTML page. POSTs,
``/api`` calls, and anything ≥400 (a missing asset, a 500) still log. Wired into the access logger
via uvicorn's ``log_config`` (see :mod:`oc.cli.serve`).
"""

from __future__ import annotations

import logging
import re

# a request path that is a static asset (by extension) or an HTML page / root
_ASSET = re.compile(r"\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|wasm)$", re.IGNORECASE)


def _is_static(path: str) -> bool:
    path = path.split("?", 1)[0]          # ignore a cache-busting query string
    if path in ("/", "/index.html"):
        return True
    return path.endswith(".html") or bool(_ASSET.search(path))


class StaticAccessFilter(logging.Filter):
    """Return False (drop) for a successful static-asset/page GET; True (keep) for everything else.

    uvicorn logs an access record with ``args = (client_addr, method, full_path, http_version,
    status_code)``. We read the method/path/status off that tuple; any unexpected shape is kept."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 5:
            return True
        method, path, status = args[1], args[2], args[4]
        try:
            status = int(status)
        except (TypeError, ValueError):
            return True
        if method == "GET" and status < 400 and not str(path).startswith("/api") and _is_static(str(path)):
            return False
        return True


def install(verbose: bool = False) -> None:
    """Attach the filter to uvicorn's access logger — once. Called from the app lifespan so it
    applies on EVERY launch path (serve, ``--reload`` subprocess, desktop, bare uvicorn), not just
    when serve injects a log_config. ``verbose`` (the ``--verbose-access`` opt-out) skips it."""
    if verbose:
        return
    logger = logging.getLogger("uvicorn.access")
    if any(isinstance(f, StaticAccessFilter) for f in logger.filters):
        return   # idempotent: a reload re-import must not stack duplicate filters
    logger.addFilter(StaticAccessFilter())
