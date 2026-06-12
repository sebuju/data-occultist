"""Recurring, throttled price sweep over an inventory dataset.

Reads the present records of a :class:`DatasetStore`, maps each to a market slug,
and fetches its warframe.market statistics one at a time with a delay between
requests (the API has no published limit; ~3 req/s is the community-respected
ceiling, so the default throttle stays under it). Each payload is merged into a
:class:`PriceStore`, which accumulates daily candles across sweeps.

This is the *enrichment* side — strictly post-capture, network-bound, and
cancellable — so it never runs inside the capture loop. One sweep can be driven
from the CLI (``oc prices``) or a web background task; both share this class.
"""

from __future__ import annotations

import time
import urllib.error
from collections.abc import Callable

from ..store import DatasetStore, KeySpec, PriceStore
from .wm_client import NET_ERRORS, fetch_items, fetch_statistics, slugify

# Persist progress every this many fetched items so a long sweep survives a crash
# and the web page can read partial results mid-sweep.
_SAVE_EVERY = 25


def inventory_slugs(records: list[dict], name_field: str = "name",
                    resolve=slugify) -> list[tuple[str, str]]:
    """Unique ``(slug, name)`` pairs from inventory records, in first-seen order.

    ``resolve(name) -> slug | None`` maps a display name to a market slug (defaults to
    naive :func:`slugify`; pass a :class:`SlugResolver` for catalogue-backed matching).
    Names that don't resolve are skipped. Several records can map to one slug (an arcane
    at different levels), so we dedup by slug — one fetch prices them all."""
    seen: dict[str, str] = {}
    for rec in records:
        name = rec.get(name_field)
        if not name:
            continue
        slug = resolve(str(name))
        if slug and slug not in seen:
            seen[slug] = str(name)
    return list(seen.items())


class PriceCollector:
    def __init__(self, store: PriceStore, throttle: float = 0.4, timeout: float = 30.0) -> None:
        self._store = store
        self._throttle = throttle
        self._timeout = timeout

    def sweep(
        self,
        items: list[tuple[str, str]],
        *,
        dataset_store: DatasetStore | None = None,
        on_item: Callable[[int, int, str, str, bool], None] | None = None,
        should_stop: Callable[[], bool] | None = None,
    ) -> dict:
        """Fetch statistics for every ``(slug, name)`` in ``items``, throttled, ingesting
        into the price store. When ``dataset_store`` is given, each priced item also pushes
        a current snapshot record into it (the producer path). ``on_item(idx, total, slug,
        name, ok)`` fires per item; ``should_stop()`` aborts between items."""
        total = len(items)
        fetched = failed = 0
        try:
            for idx, (slug, name) in enumerate(items):
                if should_stop is not None and should_stop():
                    break
                ok = False
                try:
                    payload = fetch_statistics(slug, self._timeout)
                    self._store.ingest_statistics(slug, name, payload)
                    if dataset_store is not None:
                        snap = self._store.snapshot(slug)
                        if snap is not None:
                            dataset_store.record_seen(snap)
                    ok = True
                    fetched += 1
                except urllib.error.HTTPError as e:
                    # 404 = no such market item (bad name guess / untradeable) — record it
                    # so the UI shows "no match". Other HTTP codes are transient; leave it.
                    failed += 1
                    if e.code == 404:
                        self._store.mark_missing(slug, name)
                except NET_ERRORS:
                    failed += 1
                if on_item is not None:
                    on_item(idx + 1, total, slug, name, ok)
                if fetched and fetched % _SAVE_EVERY == 0:
                    self._store.save()
                    if dataset_store is not None:
                        dataset_store.save()
                if self._throttle and idx + 1 < total:
                    time.sleep(self._throttle)
        finally:
            # ALWAYS flush — a cancel (break) or a mid-sweep crash must still persist the
            # items already priced, so partial data lands in the dataset.
            self._store.save()
            if dataset_store is not None:
                dataset_store.save()
        return {"total": total, "fetched": fetched, "failed": failed,
                "slugs": len(self._store.slugs())}


def sweep_catalogue(
    data_dir, game: str, out_dataset: str = "prices", *, key=None, throttle: float = 0.4,
    timeout: float = 30.0, limit: int = 0, on_item=None, should_stop=None,
    items: list[tuple[str, str]] | None = None,
) -> dict:
    """Producer sweep: price the WHOLE market catalogue and push one snapshot record per
    item into ``out_dataset`` (history accumulates in the price store). ``items`` may be
    supplied to skip the catalogue fetch (tests); otherwise it's fetched. ``limit`` caps
    distinct items (0 = all)."""
    if items is None:
        items = [(it["url_name"], it["item_name"]) for it in fetch_items(timeout)]
    if limit and limit > 0:
        items = items[:limit]
    store = PriceStore(data_dir, game)
    dstore = DatasetStore(data_dir, game, out_dataset, key=key or KeySpec(fields=("name",)))
    dstore.begin_batch()
    collector = PriceCollector(store, throttle=throttle, timeout=timeout)
    return collector.sweep(items, dataset_store=dstore, on_item=on_item, should_stop=should_stop)


def sweep_dataset(
    data_dir, game: str, dataset: str, *, key=None, throttle: float = 0.4,
    timeout: float = 30.0, limit: int = 0, name_field: str = "name",
    resolve=None, on_item=None, should_stop=None,
) -> dict:
    """Convenience: open the dataset + price stores, build the item list, run one sweep.

    ``key`` is the dataset's resolved KeyMap/KeySpec (so the store replays correctly);
    ``resolve(name)->slug`` maps names to slugs (defaults to naive slugify);
    ``limit`` caps how many distinct slugs to fetch (0 = all)."""
    ds = DatasetStore(data_dir, game, dataset, key=key) if key is not None \
        else DatasetStore(data_dir, game, dataset)
    records = [r for r in ds.records() if r.get("present", True)]
    items = inventory_slugs(records, name_field, resolve or slugify)
    if limit and limit > 0:
        items = items[:limit]
    store = PriceStore(data_dir, game)
    collector = PriceCollector(store, throttle=throttle, timeout=timeout)
    return collector.sweep(items, on_item=on_item, should_stop=should_stop)
