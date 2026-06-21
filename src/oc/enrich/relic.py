"""Relic-rewards producer.

Maps every Void relic (e.g. ``"Axi A1"``) to the items it can drop, each with its rarity,
drop chance, and ducat value, and writes one row per ``(relic, reward, state)`` into an output
dataset — joinable like any other data (and the ``item`` column can feed a warframe.market
producer's sources to price every drop). Reward / rarity / chance come from the WFCD
``warframe-drop-data`` ``relics.json``; ducats from the warframe.market v2 item endpoint.

This is a :class:`ProducerSource` (``type: relic``): heavy + cancellable, fired only on an
explicit refresh (the node button or a trigger — e.g. an interval trigger for periodic refresh),
never in the capture loop. The output dataset is the source of truth — no separate cache.
"""

from __future__ import annotations

import json
import re
import time
import urllib.request

from ..interfaces import ProducerCtx, ProducerSource
from ..registry import register_producer
from ..store import KeySpec, store_for
from .wm_client import NET_ERRORS, fetch_item_ducats, slugify

_RELICS_URL = "https://raw.githubusercontent.com/WFCD/warframe-drop-data/main/data/relics.json"
_DEFAULT_STATE = "Intact"

# Rewards with no Baro/market ducat value (untradeable) — warframe.market has no entry
# for them, so hard-code 0 to keep the table complete. Keyed by :func:`_norm` of the name.
_DUCAT_FALLBACK = {
    "FORMA BLUEPRINT": 0,
    "2X FORMA BLUEPRINT": 0,
    "FORMA": 0,
    "2X FORMA": 0,
}


def _norm(name: str) -> str:
    """Normalise a name for case/noise-insensitive matching: uppercase, strip a stray
    "RELIC" word, drop punctuation, collapse whitespace. ``"Axi A1 Relic" -> "AXI A1"``."""
    s = re.sub(r"[^A-Z0-9 ]+", " ", str(name).upper())
    s = re.sub(r"\bRELIC\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------------------
# Table build (network-heavy — only on the explicit refresh, never live)
# ---------------------------------------------------------------------------

def _fetch_relics_json() -> dict:
    req = urllib.request.Request(
        _RELICS_URL, headers={"User-Agent": "oc/0.1", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:   # noqa: S310 - fixed trusted URL
        return json.loads(r.read().decode("utf-8"))


def _resolve_ducats(items, fetch_ducats=None, *, throttle: float = 0.0,
                    on_item=None, should_stop=None) -> dict[str, int]:
    """``{itemName -> ducats}`` for every distinct reward, resolved once. Untradeable
    rewards (Forma) use the hard-coded fallback; anything the market can't price -> 0.

    ``throttle`` spaces the per-item market calls (the producer's network rate limit);
    ``on_item(done, total, slug, name, ok)`` reports progress; ``should_stop()`` aborts
    a cancelled refresh early (items not yet fetched stay unpriced)."""
    fetch_ducats = fetch_ducats or fetch_item_ducats
    out: dict[str, int] = {}
    names = sorted(items)
    total = len(names)
    for i, name in enumerate(names, 1):
        if should_stop is not None and should_stop():
            break
        fb = _DUCAT_FALLBACK.get(_norm(name))
        if fb is not None:
            out[name] = fb
        else:
            if throttle and i > 1:
                time.sleep(throttle)          # space network calls under the node's rate limit
            try:
                d = fetch_ducats(slugify(name))
            except NET_ERRORS:
                d = None
            out[name] = int(d) if d else 0
        if on_item is not None:
            on_item(i, total, slugify(name), name, name in out)
    return out


def relic_reward_rows(table: dict) -> list[dict]:
    """Flatten the nested table into one row per ``(relic, reward)`` — the producer's output
    records: ``{name, item, rarity, ducats}``. ``name`` is the RELIC (so the rows join an
    offered-relics dataset on ``name``); ``item`` is the reward (priceable via a warframe_market
    node sourcing this dataset with ``source_field: item``). State and per-state drop chance are
    intentionally dropped: the same reward is identical across states bar its ``chance``, so we
    dedup to one row per ``(name, item)`` (chance can be recomputed from relics.json if needed)."""
    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for relic, states in table.items():
        for rewards in states.values():
            for r in rewards:
                item = r.get("item", "")
                key = (relic, item)
                if key in seen:
                    continue
                seen.add(key)
                rows.append({
                    "name": relic, "item": item, "rarity": r.get("rarity", ""),
                    "ducats": r.get("ducats", 0),
                })
    return rows


def build_relic_table(*, fetch_relics=None, fetch_ducats=None,
                      throttle: float = 0.0, on_item=None, should_stop=None) -> dict:
    """Build ``{relic -> {state -> [{item, rarity, chance, ducats}, ...]}}`` from
    relics.json + market ducats. ``fetch_relics`` / ``fetch_ducats`` are injectable for
    tests; ``throttle`` / ``on_item`` / ``should_stop`` thread through to the ducat
    resolution (the producer refresh path). Network-heavy; fetches fresh every call."""
    raw = (fetch_relics or _fetch_relics_json)()
    items = {rw["itemName"] for r in raw.get("relics", [])
             for rw in r.get("rewards", []) if rw.get("itemName")}
    ducats = _resolve_ducats(items, fetch_ducats, throttle=throttle,
                             on_item=on_item, should_stop=should_stop)
    table: dict[str, dict[str, list]] = {}
    for r in raw.get("relics", []):
        rn = r.get("relicName")
        if not rn:                       # e.g. Requiem entries — not standard Void relics
            continue
        name = _norm(f"{r.get('tier', '')} {rn}")
        rewards = [
            {"item": rw["itemName"], "rarity": rw.get("rarity", ""),
             "chance": rw.get("chance"), "ducats": ducats.get(rw["itemName"], 0)}
            for rw in r.get("rewards", []) if rw.get("itemName")
        ]
        table.setdefault(name, {})[r.get("state", _DEFAULT_STATE)] = rewards
    return table


# ---------------------------------------------------------------------------
# Producer: refresh the relic table over the network, write (relic, reward, state) rows
# ---------------------------------------------------------------------------

@register_producer("relic")
class RelicProducer(ProducerSource):
    """Refresh the WFCD relic table + warframe.market ducats and write one row per
    ``(relic, reward, state)`` into the node's output dataset. Throttled + cancellable, so
    it only ever runs on an explicit refresh (button or trigger), never in the live loop."""

    def run(self, ctx: ProducerCtx) -> dict:
        node = ctx.node
        stop = ctx.should_stop or (lambda: False)
        table = build_relic_table(
            throttle=float(getattr(node, "throttle", 0.0) or 0.0),
            on_item=ctx.on_item, should_stop=ctx.should_stop)
        # Cancelled mid-fetch: the table is incomplete (partial ducats) — don't write a
        # half-baked dataset, just leave the prior rows untouched and report nothing written.
        if stop():
            return {"total": 0, "fetched": 0, "failed": 0}
        rows = relic_reward_rows(table)
        store = store_for(ctx.data_dir, ctx.game, ctx.dataset, profile=ctx.profile,
                          key=ctx.key or KeySpec(fields=("name", "item")))
        store.begin_batch()
        for row in rows:
            store.record_seen(row)
        store.save()
        return {"total": len(rows), "fetched": len(rows), "failed": 0}
