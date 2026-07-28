"""Where this server is reachable — set once at launch, read by anything that must hand out a URL.

The overlay child is a browser: it loads a page from this server, so it needs the real host:port.
Nothing inside the app otherwise knows it (uvicorn owns the socket, and ``--reload`` workers are
respawned), so the launcher records it here and everyone else asks.

Falls back to the documented default rather than raising: a wrong URL shows an empty overlay, which
is a much better failure than a crashed launcher.
"""

from __future__ import annotations

import os

_DEFAULT = "http://127.0.0.1:8000"
_ENV = "OCC_BASE_URL"


def set_base_url(host: str, port: int) -> str:
    """Record where the server is listening. ``0.0.0.0``/``::`` are bind addresses, not reachable
    ones — a client must dial loopback instead. Stored in the environment so a ``--reload`` worker
    respawn inherits it (the same reason OCC_BOOT_ID lives there)."""
    if host in ("0.0.0.0", "::", ""):      # noqa: S104 - normalising a bind addr, not binding one
        host = "127.0.0.1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"                 # bare IPv6 needs brackets in a URL
    url = f"http://{host}:{int(port)}"
    os.environ[_ENV] = url
    return url


def base_url() -> str:
    return os.environ.get(_ENV) or _DEFAULT
