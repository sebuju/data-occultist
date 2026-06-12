"""warframe.market price enricher.

Maps an item name to a platinum price using the public warframe.market API
(``/v1/items/{url_name}/orders``). Best-effort and defensive: any network/parse
failure returns ``{}`` so enrichment degrades gracefully.

Pricing model: among *sell* orders from users currently online (in-game or on
site), take the lowest few and report their min and median. That approximates
"what could I sell this for right now".
"""

from __future__ import annotations

import statistics

from ..interfaces import Enricher
from ..registry import register_enricher
from .wm_client import NET_ERRORS, fetch_orders, slugify

_ONLINE = {"ingame", "online"}

__all__ = ["WarframeMarketEnricher", "slugify"]


@register_enricher("warframe_market")
class WarframeMarketEnricher(Enricher):
    def __init__(self, source_field: str = "name", depth: int = 5, timeout: float = 30.0,
                 name_field: str | None = None) -> None:
        # ``name_field`` kept as a back-compat alias for the cli.
        self._name_field = name_field or source_field
        self._depth = depth
        self._timeout = timeout

    def enrich(self, values: dict) -> dict:
        name = values.get(self._name_field)
        if not name:
            return {}
        slug = slugify(str(name))
        try:
            orders = fetch_orders(slug, self._timeout)
        except NET_ERRORS:
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
