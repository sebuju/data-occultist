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

import threading
import time
import urllib.error
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..eventlog import publish as _logev
from ..store import DatasetStore, KeySpec, PriceStore, store_for
from .wm_client import NET_ERRORS, fetch_items, fetch_orders, fetch_statistics, slugify

# Persist progress every this many fetched items so a long sweep survives a crash
# and the web page can read partial results mid-sweep.
_SAVE_EVERY = 25

# How many worker threads fetch concurrently. The serial loop wasted the whole network
# round-trip per item; with a shared rate limiter the pool keeps several requests in flight
# and sustains the throttle's req/s regardless of latency. warframe.market's community rate
# ceiling is ~3 req/s, so a handful of workers behind the limiter is plenty.
_WORKERS = 6


class _RateLimiter:
    """Spaces request *starts* across all worker threads to at most one per ``interval``
    seconds, so concurrency raises throughput up to — but never past — the throttle's
    sustained req/s. Each caller reserves the next time slot under a lock, then sleeps
    until it (outside the lock, so threads don't serialise on the sleep)."""

    def __init__(self, interval: float) -> None:
        self._interval = max(0.0, interval)
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        if self._interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next)
            self._next = slot + self._interval
        delay = slot - time.monotonic()
        if delay > 0:
            time.sleep(delay)


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
    def __init__(self, store: PriceStore, throttle: float = 0.4, timeout: float = 30.0,
                 workers: int = _WORKERS, mode: str = "statistics") -> None:
        self._store = store
        self._throttle = throttle
        self._timeout = timeout
        self._workers = max(1, workers)
        # "statistics" -> daily candles (history); "orders" -> live lowest online sell.
        self._mode = mode if mode in ("statistics", "orders") else "statistics"

    def sweep(
        self,
        items: list[tuple[str, str]],
        *,
        dataset_store: DatasetStore | None = None,
        on_item: Callable[[int, int, str, str, bool], None] | None = None,
        should_stop: Callable[[], bool] | None = None,
        game: str | None = None,
        log_dataset: str | None = None,
    ) -> dict:
        """Fetch statistics for every ``(slug, name)`` in ``items`` concurrently (rate-
        limited), ingesting into the price store. When ``dataset_store`` is given, each
        priced item also pushes a current snapshot record into it (the producer path).
        ``on_item(done, total, slug, name, ok)`` fires per completed item (in completion
        order); ``should_stop()`` aborts the sweep promptly.

        Worker threads do only the network fetch (the slow part); ingest + snapshot writes
        happen under a lock (the stores aren't thread-safe), and accounting + ``on_item`` +
        periodic saves run on this single consumer thread, so callbacks stay serialised."""
        total = len(items)
        fetched = failed = done = 0
        t0 = time.monotonic()
        store_lock = threading.Lock()
        limiter = _RateLimiter(self._throttle)
        stop = threading.Event()

        def work(slug: str, name: str) -> tuple[str, str, bool, bool]:
            """Fetch + ingest one item. Returns ``(slug, name, ok, missing)``; ``missing``
            marks a 404 (recorded so the UI shows 'no match')."""
            if stop.is_set() or (should_stop is not None and should_stop()):
                return slug, name, False, False
            limiter.wait()
            if stop.is_set() or (should_stop is not None and should_stop()):
                return slug, name, False, False
            try:
                if self._mode == "orders":
                    data = fetch_orders(slug, self._timeout)
                else:
                    data = fetch_statistics(slug, self._timeout)
                with store_lock:
                    if self._mode == "orders":
                        self._store.ingest_orders(slug, name, data)
                    else:
                        self._store.ingest_statistics(slug, name, data)
                    if dataset_store is not None:
                        snap = self._store.snapshot(slug)
                        if snap is not None:
                            dataset_store.record_seen(snap)
                return slug, name, True, False
            except urllib.error.HTTPError as e:
                # 404 = no such market item (bad name guess / untradeable). Other HTTP
                # codes are transient; leave them be.
                return slug, name, False, e.code == 404
            except NET_ERRORS:
                return slug, name, False, False

        try:
            with ThreadPoolExecutor(max_workers=self._workers) as ex:
                futures = [ex.submit(work, s, n) for s, n in items]
                for fut in as_completed(futures):
                    slug, name, ok, missing = fut.result()
                    if missing:
                        with store_lock:
                            self._store.mark_missing(slug, name)
                    done += 1
                    if ok:
                        fetched += 1
                    else:
                        failed += 1
                    if on_item is not None:
                        on_item(done, total, slug, name, ok)
                    if fetched and fetched % _SAVE_EVERY == 0:
                        with store_lock:
                            self._store.save()
                            if dataset_store is not None:
                                dataset_store.save()
                    if should_stop is not None and should_stop():
                        stop.set()   # queued workers now short-circuit without fetching
        finally:
            # ALWAYS flush — a cancel or a mid-sweep crash must still persist the items
            # already priced, so partial data lands in the dataset.
            with store_lock:
                self._store.save()
                if dataset_store is not None:
                    dataset_store.save()
        # ONE summary line per sweep (not one per fetch) — every price sweep funnels through
        # here, so it covers the trigger, manual-refresh, and CLI paths uniformly.
        dt = time.monotonic() - t0
        _logev(f"sweep {log_dataset or '?'} done · {fetched}/{total} ok"
               + (f" · {failed} failed" if failed else "") + f" · {dt:.1f}s",
               level="ok" if fetched and not failed else "info",
               game=game, dataset=log_dataset)
        return {"total": total, "fetched": fetched, "failed": failed,
                "slugs": len(self._store.slugs())}


def sweep_catalogue(
    data_dir, game: str, out_dataset: str = "prices", *, key=None, profile=None,
    throttle: float = 0.4, timeout: float = 30.0, limit: int = 0, workers: int = _WORKERS,
    mode: str = "statistics", on_item=None, should_stop=None,
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
    dstore = store_for(data_dir, game, out_dataset, profile=profile,
                       key=key or KeySpec(fields=("name",)))
    dstore.begin_batch()
    collector = PriceCollector(store, throttle=throttle, timeout=timeout, workers=workers, mode=mode)
    return collector.sweep(items, dataset_store=dstore, on_item=on_item, should_stop=should_stop,
                           game=game, log_dataset=out_dataset)


def sweep_dataset(
    data_dir, game: str, dataset: str, *, key=None, throttle: float = 0.4,
    timeout: float = 30.0, limit: int = 0, workers: int = _WORKERS, mode: str = "statistics",
    name_field: str = "name", resolve=None, on_item=None, should_stop=None,
) -> dict:
    """Convenience: open the dataset + price stores, build the item list, run one sweep.

    ``key`` is the dataset's resolved KeyMap/KeySpec (so the store replays correctly);
    ``resolve(name)->slug`` maps names to slugs (defaults to naive slugify);
    ``limit`` caps how many distinct slugs to fetch (0 = all)."""
    ds = store_for(data_dir, game, dataset, key=key)
    records = [r for r in ds.records() if r.get("present", True)]
    items = inventory_slugs(records, name_field, resolve or slugify)
    if limit and limit > 0:
        items = items[:limit]
    store = PriceStore(data_dir, game)
    collector = PriceCollector(store, throttle=throttle, timeout=timeout, workers=workers, mode=mode)
    return collector.sweep(items, on_item=on_item, should_stop=should_stop,
                           game=game, log_dataset=dataset)
