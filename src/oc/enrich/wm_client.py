"""Shared warframe.market HTTP client.

One place that speaks to the public API (``api.warframe.market/v1``) so the price
enricher and the recurring price collector share slugging, headers, and parsing.
Stdlib ``urllib`` only — no extra dependency. Every call is best-effort: network or
parse failures raise the small set of errors in :data:`NET_ERRORS` for callers to
swallow, so external outages never compromise capture.

Two endpoints are used:
  * ``/items/{slug}/orders``      — live buy/sell orders (lowest current sell).
  * ``/items/{slug}/statistics``  — daily price candles (90 days) + 48h live.

The statistics endpoint is the workhorse: one request returns ~90 daily candles
(volume, min/max/avg/median/weighted-avg/moving-avg), i.e. an item's whole recent
price history in a single throttled call — no scraping, no headless browser.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

_BASE = "https://api.warframe.market/v1/items/{slug}"
_HEADERS = {"User-Agent": "oc/0.1", "platform": "pc", "Accept": "application/json"}

# Errors any fetch may raise; callers catch these to degrade gracefully.
NET_ERRORS = (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError)


def slugify(name: str) -> str:
    """Convert a display name to a warframe.market ``url_name`` guess.

    e.g. "Soma Prime" -> "soma_prime". OCR noise may make this imperfect; a future
    pass can reconcile against the market's item list via the fuzzy corrector.
    """
    s = name.strip().lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def _get(url: str, timeout: float) -> dict:
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


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


def _item_url(slug: str) -> str:
    """Item endpoint base, with the slug percent-encoded. Some catalogue slugs carry
    non-ASCII characters (e.g. ``ö``); without encoding urllib can't even build the
    request line (``UnicodeEncodeError: 'ascii' codec``)."""
    return _BASE.format(slug=urllib.parse.quote(slug, safe=""))


def fetch_orders(slug: str, timeout: float = 30.0) -> list[dict]:
    """Live buy/sell orders for ``slug``. Raises on network/parse failure."""
    payload = _get(_item_url(slug) + "/orders", timeout)
    return payload.get("payload", {}).get("orders", [])


def fetch_statistics(slug: str, timeout: float = 30.0) -> dict:
    """Price statistics for ``slug``: ``{statistics_closed, statistics_live}`` each
    holding ``48hours`` and ``90days`` arrays of daily candles. Raises on failure."""
    payload = _get(_item_url(slug) + "/statistics", timeout)
    return payload.get("payload", {})
