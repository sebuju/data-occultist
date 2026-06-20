"""warframe.market producer backend.

The original (and only network-pricing) producer: sweep market items and push one current
snapshot record per item into the node's output dataset, while daily candles accumulate in
the :class:`~oc.store.price_store.PriceStore`. All the heavy lifting already lives in
:func:`oc.enrich.price_collector.sweep_catalogue`; this is the thin :class:`ProducerSource`
adapter that resolves the node's item sources and hands off.
"""

from __future__ import annotations

from ..interfaces import ProducerCtx, ProducerSource
from ..registry import register_producer
from .price_collector import sweep_catalogue


@register_producer("warframe_market")
class WarframeMarketProducer(ProducerSource):
    def run(self, ctx: ProducerCtx) -> dict:
        node = ctx.node
        items = ctx.items
        # Item source: explicit `items` (e.g. on_change changed keys) > the node's `sources`
        # datasets/views > the whole catalogue (items stays None -> sweep_catalogue fetches it).
        if items is None and getattr(node, "sources", None):
            from .price_runner import gather_source_items
            items = gather_source_items(
                ctx.data_dir, ctx.game, ctx.profile, node.sources,
                name_field=getattr(node, "source_field", "name"))
        return sweep_catalogue(
            ctx.data_dir, ctx.game, ctx.dataset, key=ctx.key, profile=ctx.profile,
            throttle=getattr(node, "throttle", 0.4), timeout=ctx.timeout, limit=ctx.limit,
            workers=ctx.workers, mode=getattr(node, "mode", "statistics"),
            on_item=ctx.on_item, should_stop=ctx.should_stop, items=items)
