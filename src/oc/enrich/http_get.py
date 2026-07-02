"""Generic JSON-over-HTTP transport, shared by every network producer.

One place that speaks HTTP to any host so the generic ``http`` producer shares
connection pooling, key transforms, and JSON navigation across every fetch. Stdlib
``urllib`` only — no extra dependency. Every call is best-effort:
network or parse failures raise the small set of errors in :data:`NET_ERRORS` for
callers to swallow, so external outages never compromise capture.

Nothing here knows about any specific API — the host, headers, endpoints, and JSON
shape all arrive as arguments (taught per game in the profile). :func:`slugify` and
:func:`key_transform` are the generic ``{key}`` builders; :func:`json_path` walks a
parsed response by a dotted/indexed path.
"""

from __future__ import annotations

import http.client
import json
import re
import threading
import urllib.error
import urllib.parse

# Errors any fetch may raise; callers catch these to degrade gracefully.
NET_ERRORS = (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError,
              http.client.HTTPException)


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


# Keep-alive: one persistent connection PER (scheme, host, port) PER THREAD (a sweep
# runs several worker threads, and a producer may talk to more than one host — the
# catalogue endpoint plus the per-item endpoint). Reusing a connection across an
# item's requests skips the TCP+TLS handshake every call — the dominant per-request
# cost once throttling is parallelised. Thread-local so concurrent workers never share
# a single (non-thread-safe) connection.
_local = threading.local()


def _conns() -> dict:
    d = getattr(_local, "conns", None)
    if d is None:
        d = {}
        _local.conns = d
    return d


def _conn(scheme: str, host: str, port: int | None, timeout: float):
    key = (scheme, host, port)
    conns = _conns()
    c = conns.get(key)
    if c is None:
        cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        c = cls(host, port, timeout=timeout)
        conns[key] = c
    return c


def _drop_conn(scheme: str, host: str, port: int | None) -> None:
    """Discard this thread's connection to a host (after a transport error) so the next
    call reconnects cleanly rather than reusing a half-broken socket."""
    conns = _conns()
    c = conns.pop((scheme, host, port), None)
    if c is not None:
        try:
            c.close()
        except OSError:
            pass


def http_get_json(url: str, *, headers: dict[str, str] | None = None,
                  timeout: float = 30.0, method: str = "GET",
                  query: dict[str, str] | None = None) -> object:
    """Request ``url`` over the thread's keep-alive connection, returning parsed JSON.

    ``query`` is appended to the URL's own query string. Raises
    :class:`urllib.error.HTTPError` on a >=400 status (so 404 handling works
    unchanged); transport failures drop the connection and re-raise one of
    :data:`NET_ERRORS`."""
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme or "https"
    host = parts.hostname or ""
    port = parts.port
    q = dict(urllib.parse.parse_qsl(parts.query))
    if query:
        q.update({k: str(v) for k, v in query.items()})
    path = parts.path or "/"
    if q:
        path = path + "?" + urllib.parse.urlencode(q)
    conn = _conn(scheme, host, port, timeout)
    try:
        conn.request(method, path, headers=headers or {})
        resp = conn.getresponse()
        status, reason = resp.status, resp.reason
        body = resp.read()        # MUST fully read before the connection can be reused
    except (http.client.HTTPException, OSError):
        _drop_conn(scheme, host, port)
        raise
    if status >= 400:
        # not a transport fault — the keep-alive connection stays good (body was read)
        raise urllib.error.HTTPError(url, status, reason, resp.msg, None)
    return json.loads(body.decode("utf-8"))
