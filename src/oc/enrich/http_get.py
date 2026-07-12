"""Generic JSON-over-HTTP transport, shared by every network producer.

One place that speaks HTTP to any host so the generic ``http`` producer shares
connection pooling, key transforms, and JSON navigation across every fetch.

Transport is ``curl_cffi`` (impersonates a real browser's TLS fingerprint), not
stdlib ``urllib``/``http.client``: Cloudflare-fronted APIs (e.g. overframe.gg) key
their bot check off the TLS ClientHello (JA3), not the ``User-Agent`` header —
stdlib's TLS stack gets a 403 even with an identical browser header set, while curl
(and curl_cffi) pass. Every call is still best-effort: network or parse failures
raise the small set of errors in :data:`NET_ERRORS` for callers to swallow, so
external outages never compromise capture.

Nothing here knows about any specific API — the host, headers, endpoints, and JSON
shape all arrive as arguments (taught per game in the profile). :func:`slugify` and
:func:`key_transform` are the generic ``{key}`` builders; :func:`json_path` walks a
parsed response by a dotted/indexed path.
"""

from __future__ import annotations

import json
import re
import threading
import urllib.error

from curl_cffi.curl import CurlError
from curl_cffi.requests import Session
from curl_cffi.requests.exceptions import RequestException

# Errors any fetch may raise; callers catch these to degrade gracefully.
NET_ERRORS = (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError,
              RequestException, CurlError)


def slugify(name: str) -> str:
    """Convert a display name to a URL-safe ``url_name`` guess.

    e.g. "Soma Prime" -> "soma_prime". Lowercase, ``&`` -> ``and``, every other run
    of non-alphanumerics -> a single ``_``. OCR noise may make this imperfect; the
    ``catalogue`` key transform reconciles names against a fetched item list."""
    s = name.strip().lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def key_transform(name: str, mode: str = "slugify") -> str:
    """Turn a raw source name into the ``{key}`` a URL template substitutes.

    ``none`` keeps it verbatim, ``lowercase`` lowercases, ``slugify`` runs
    :func:`slugify`. The ``catalogue`` mode is NOT handled here — it needs a fetched
    item list, so the producer resolves it and passes the result as ``none``."""
    if mode == "none" or mode == "catalogue":
        return name
    if mode == "lowercase":
        return name.strip().lower()
    return slugify(name)


def json_path(obj: object, path: str) -> object:
    """Walk ``obj`` by a dotted path with optional ``[i]`` list indices.

    ``""`` returns ``obj`` unchanged. ``"a.b"`` -> ``obj["a"]["b"]``; ``"a[0].b"``
    indexes a list. Returns ``None`` when any segment is missing or the container is
    the wrong type — so a taught path that doesn't match just yields nothing (the
    field is dropped) rather than raising."""
    if not path:
        return obj
    cur = obj
    for seg in path.split("."):
        # split "name[0][1]" into the key "name" then indices [0], [1]
        m = re.match(r"([^\[\]]*)((?:\[\d+\])*)$", seg)
        if not m:
            return None
        key, idx = m.group(1), m.group(2)
        if key:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(key)
        for i in re.findall(r"\[(\d+)\]", idx):
            if not isinstance(cur, list):
                return None
            n = int(i)
            if n >= len(cur):
                return None
            cur = cur[n]
        if cur is None:
            return None
    return cur


# Keep-alive: one persistent (browser-impersonating) session PER THREAD (a sweep runs
# several worker threads). Reusing a session across an item's requests skips the
# TCP+TLS handshake every call — the dominant per-request cost once throttling is
# parallelised. Thread-local so concurrent workers never share a single (non-thread-
# safe) session; curl_cffi's Session manages its own connection pool per host.
_local = threading.local()


def _session() -> Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = Session(impersonate="chrome")
        _local.session = s
    return s


_SCRIPT_JSON_TMPL = r'<script id="{}"[^>]*>(.*?)</script>'


def http_get_json(url: str, *, headers: dict[str, str] | None = None,
                  timeout: float = 30.0, method: str = "GET",
                  query: dict[str, str] | None = None, html_extract: str = "") -> object:
    """Request ``url`` over the thread's keep-alive (browser-impersonating) session,
    returning parsed JSON.

    ``query`` is appended to the URL's own query string. Raises
    :class:`urllib.error.HTTPError` on a >=400 status (so 404 handling works
    unchanged); transport failures re-raise one of :data:`NET_ERRORS`.

    ``html_extract``, when set, treats the response as an HTML page rather than a bare
    JSON body: the id of a ``<script id="...">...</script>`` tag whose CONTENTS are the
    JSON to parse (e.g. Next.js's ``__NEXT_DATA__`` hydration blob — the only place
    some sites embed data with no JSON API of their own). Raises :class:`ValueError`
    when the tag isn't found."""
    resp = _session().request(method, url, headers=headers or None, params=query or None,
                              timeout=timeout)
    if resp.status_code >= 400:
        raise urllib.error.HTTPError(url, resp.status_code, resp.reason, None, None)
    text = resp.content.decode("utf-8")
    if html_extract:
        m = re.search(_SCRIPT_JSON_TMPL.format(re.escape(html_extract)), text, re.S)
        if not m:
            raise ValueError(f"script tag {html_extract!r} not found in response")
        return json.loads(m.group(1))
    return json.loads(text)
