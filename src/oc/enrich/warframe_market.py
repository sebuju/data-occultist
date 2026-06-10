"""warframe.market price enricher.

Maps an item name to a platinum price using the public warframe.market API
(``/v1/items/{url_name}/orders``). Best-effort and defensive: any network/parse
failure returns ``{}`` so enrichment degrades gracefully.

Pricing model: among *sell* orders from users currently online (in-game or on
site), take the lowest few and report their min and median. That approximates
"what could I sell this for right now".
"""

from __future__ import annotations

import json
import re
import statistics
import urllib.error
import urllib.request

from ..interfaces import Enricher
from ..registry import register_enricher

_API = "https://api.warframe.market/v1/items/{slug}/orders"
_ONLINE = {"ingame", "online"}


def slugify(name: str) -> str:
    """Convert a display name to a warframe.market url_name guess.

    e.g. "Soma Prime" -> "soma_prime". OCR noise may make this imperfect; a future
    pass can reconcile against the market's item list via the fuzzy corrector.
    """
    s = name.strip().lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


@register_enricher("warframe_market")
class WarframeMarketEnricher(Enricher):
    def __init__(self, name_field: str = "name", depth: int = 5, timeout: float = 6.0) -> None:
        self._name_field = name_field
        self._depth = depth
        self._timeout = timeout

    def _fetch_orders(self, slug: str) -> list[dict]:
        url = _API.format(slug=slug)
        req = urllib.request.Request(url, headers={"User-Agent": "oc/0.1", "platform": "pc"})
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return payload.get("payload", {}).get("orders", [])

    def enrich(self, values: dict) -> dict:
        name = values.get(self._name_field)
        if not name:
            return {}
        slug = slugify(str(name))
        try:
            orders = self._fetch_orders(slug)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            return {}

        prices = sorted(
            o["platinum"]
            for o in orders
            if o.get("order_type") == "sell" and o.get("user", {}).get("status") in _ONLINE
        )
        if not prices:
            return {"wm_slug": slug, "wm_price": None}
        low = prices[: self._depth]
        return {
            "wm_slug": slug,
            "wm_price_min": low[0],
            "wm_price_median": round(statistics.median(low), 1),
            "wm_sell_orders": len(prices),
        }
