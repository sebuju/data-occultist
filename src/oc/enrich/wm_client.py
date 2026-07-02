"""warframe.market ducat lookup — the one endpoint the relic producer still needs.

The generic ``http`` producer covers price fetching (warframe.market is just an
``http`` node in the profile). Only the relic producer's ducat-per-item lookup
remains hard-coded, so this shrank to that single call. Transport, ``slugify`` and
``NET_ERRORS`` are re-exported from :mod:`oc.enrich.http_get`.
"""

from __future__ import annotations

import urllib.parse

from .http_get import NET_ERRORS, http_get_json, slugify

__all__ = ["NET_ERRORS", "slugify", "fetch_item_ducats"]

_ITEMS_V2_URL = "https://api.warframe.market/v2/items/{slug}"
_HEADERS = {"User-Agent": "oc/0.1", "platform": "pc", "Accept": "application/json"}


def fetch_item_ducats(slug: str, timeout: float = 30.0) -> int | None:
    """Ducat value for ``slug`` from the v2 item endpoint (``data.ducats``).

    Returns ``None`` when the item isn't on the market (an untradeable reward like
    Forma 404s) or carries no ducat value. Raises the usual :data:`NET_ERRORS` on a
    transport fault for the caller to swallow."""
    url = _ITEMS_V2_URL.format(slug=urllib.parse.quote(slug, safe=""))
    payload = http_get_json(url, headers=_HEADERS, timeout=timeout)
    data = (payload or {}).get("data") or {} if isinstance(payload, dict) else {}
    ducats = data.get("ducats")
    return int(ducats) if isinstance(ducats, (int, float)) else None
