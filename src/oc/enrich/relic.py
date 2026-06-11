"""Relic-contents enricher — SCAFFOLD.

Maps a Void relic name (e.g. "Neo V11") to the items it can drop. Real data will come
from a drop-table source (warframe.market / official drop tables / DE export) loaded
into a lookup; for now this returns a structured placeholder so the subset UI and the
enrich pass are wired end-to-end and only the data source needs filling in.
"""

from __future__ import annotations

from ..interfaces import Enricher
from ..registry import register_enricher


@register_enricher("relic_contents")
class RelicContentsEnricher(Enricher):
    """Look up a relic's reward list. ``source_field`` is the column holding the relic
    name. Returns ``{relic_contents, relic_rewards}``."""

    def __init__(self, source_field: str = "name") -> None:
        self._field = source_field
        # TODO: load a {relic_name -> [rewards]} table from a drop-table source.
        self._table: dict[str, list[str]] = {}

    def enrich(self, values: dict) -> dict:
        relic = values.get(self._field)
        if not relic:
            return {}
        rewards = self._table.get(str(relic).strip())
        if rewards is None:
            return {"relic_contents": "(no data yet)", "relic_rewards": ""}
        return {"relic_contents": str(len(rewards)), "relic_rewards": ", ".join(rewards)}
