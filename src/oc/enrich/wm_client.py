"""Shared warframe.market HTTP client.

One place that speaks to the public API (``api.warframe.market/v1``) so the price
enricher and the recurring price collector share slugging, headers, and parsing.
Stdlib ``urllib`` only — no extra dependency. Every call is best-effort: network or
parse failures raise the small set of errors in :data:`NET_ERRORS` for callers to
swallow, so external outages never compromise capture.

Two endpoints are used:
  * ``/v2/orders/item/{slug}``      — live buy/sell orders (lowest current sell).
  * ``/v1/items/{slug}/statistics`` — daily price candles (90 days) + 48h live.

The statistics endpoint is the workhorse: one request returns ~90 daily candles
(volume, min/max/avg/median/weighted-avg/moving-avg), i.e. an item's whole recent
price history in a single throttled call — no scraping, no headless browser.
"""

from __future__ import annotations

import http.client
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

_HOST = "api.warframe.market"
_ITEM_PATH = "/v1/items/{slug}"
_HEADERS = {"User-Agent": "oc/0.1", "platform": "pc", "Accept": "application/json"}

# Errors any fetch may raise; callers catch these to degrade gracefully.
NET_ERRORS = (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError,
              http.client.HTTPException)


def slugify(name: str) -> str:
    """Convert a display name to a warframe.market ``url_name`` guess.

    e.g. "Soma Prime" -> "soma_prime". OCR noise may make this imperfect; a future
    pass can reconcile against the market's item list via the fuzzy corrector.
    """
    s = name.strip().lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


# Keep-alive: one persistent HTTPS connection PER THREAD (a sweep runs several worker
# threads). Reusing it across an item's many requests skips the TCP+TLS handshake every
# call — the dominant per-request cost once throttling is parallelised. Thread-local so
# concurrent workers never share a single (non-thread-safe) connection.
_local = threading.local()


def _conn(timeout: float) -> http.client.HTTPSConnection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = http.client.HTTPSConnection(_HOST, timeout=timeout)
        _local.conn = c
    return c


def _drop_conn() -> None:
    """Discard this thread's connection (after a transport error) so the next call
    reconnects cleanly rather than reusing a half-broken socket."""
    c = getattr(_local, "conn", None)
    if c is not None:
        try:
            c.close()
        except OSError:
            pass
        _local.conn = None


def _get(path: str, timeout: float) -> dict:
    """GET an api path over the thread's keep-alive connection, returning parsed JSON.
    Raises :class:`urllib.error.HTTPError` on a >=400 status (so existing 404 handling
    works unchanged); transport failures drop the connection and re-raise."""
    conn = _conn(timeout)
    try:
        conn.request("GET", path, headers=_HEADERS)
        resp = conn.getresponse()
        status, reason = resp.status, resp.reason
        body = resp.read()        # MUST fully read before the connection can be reused
    except (http.client.HTTPException, OSError):
        _drop_conn()
        raise
    if status >= 400:
        # not a transport fault — the keep-alive connection stays good (body was read)
        raise urllib.error.HTTPError(path, status, reason, resp.msg, None)
    return json.loads(body.decode("utf-8"))


def fetch_items(timeout: float = 30.0) -> list[dict]:
    """The whole market item catalogue, normalised to ``[{url_name, item_name, tags}]``.

    Used to reconcile noisy inventory names to real slugs. The catalogue is the **v2**
    endpoint (v1's ``/items`` is gone), but a v2 ``slug`` is exactly the ``url_name`` the
    v1 orders/statistics endpoints take, so the rest of the client stays on v1. Raises
    on failure.
    """
    req = urllib.request.Request(
        "https://api.warframe.market/v2/items",
        headers={"User-Agent": "oc/0.1", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        doc = json.loads(resp.read().decode("utf-8"))
    out: list[dict] = []
    for it in doc.get("data") or []:
        slug = it.get("slug")
        if not slug:
            continue
        name = ((it.get("i18n") or {}).get("en") or {}).get("name") or slug
        out.append({"url_name": slug, "item_name": name, "tags": it.get("tags") or []})
    return out


def _item_path(slug: str) -> str:
    """Item endpoint path, with the slug percent-encoded. Some catalogue slugs carry
    non-ASCII characters (e.g. ``ö``); without encoding the HTTP request line can't be
    built (``UnicodeEncodeError: 'ascii' codec``)."""
    return _ITEM_PATH.format(slug=urllib.parse.quote(slug, safe=""))


_ORDERS_PATH = "/v2/orders/item/{slug}"


def fetch_orders(slug: str, timeout: float = 30.0) -> list[dict]:
    """Live buy/sell orders for ``slug``. Raises on network/parse failure.

    Uses the **v2** orders endpoint: v1's ``/items/{slug}/orders`` now returns 403
    (the same way v1's ``/items`` catalogue was retired). v2 returns ``{data: [...]}``
    and renames each order's ``order_type`` field to ``type``."""
    payload = _get(_ORDERS_PATH.format(slug=urllib.parse.quote(slug, safe="")), timeout)
    return payload.get("data") or []


# A user is reachable for a trade only when online or in-game (not offline).
_ONLINE = {"ingame", "online"}


def online_sell_prices(orders: list[dict]) -> list[float]:
    """Ascending platinum of *currently sellable* offers: SELL orders from online users.
    The lowest is the right-now ask; the median of the lowest few resists a lone lowball.
    Shared by the live-orders price path and :class:`WarframeMarketEnricher`."""
    return sorted(
        o["platinum"]
        for o in orders
        if o.get("type") == "sell" and (o.get("user") or {}).get("status") in _ONLINE
    )


_ITEMS_V2_PATH = "/v2/items/{slug}"


def fetch_item_ducats(slug: str, timeout: float = 30.0) -> int | None:
    """Ducat value for ``slug`` from the v2 item endpoint (``data.ducats``).

    Returns ``None`` when the item isn't on the market (an untradeable reward like
    Forma 404s) or carries no ducat value. Raises the usual :data:`NET_ERRORS` on a
    transport fault for the caller to swallow. v1's single-item endpoint is retired
    (404s like the v1 catalogue), so this uses v2 — whose ``slug`` is the same string
    the v1 statistics endpoint takes."""
    payload = _get(_ITEMS_V2_PATH.format(slug=urllib.parse.quote(slug, safe="")), timeout)
    data = payload.get("data") or {}
    ducats = data.get("ducats")
    return int(ducats) if isinstance(ducats, (int, float)) else None


def fetch_statistics(slug: str, timeout: float = 30.0) -> dict:
    """Price statistics for ``slug``: ``{statistics_closed, statistics_live}`` each
    holding ``48hours`` and ``90days`` arrays of daily candles. Raises on failure."""
    payload = _get(_item_path(slug) + "/statistics", timeout)
    return payload.get("payload", {})
