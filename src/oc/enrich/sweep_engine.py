"""Generic, throttled, cancellable fan-out sweep — the shared engine every producer
runs on.

A sweep fetches one unit of work per ``(key, name)`` over the network concurrently,
rate-limited to a sustained req/s, and writes each result into an output
:class:`DatasetStore`. The *what to fetch* (``fetch_one``) and *what to write*
(``write_one``) are injected, so this module knows nothing about any specific API —
it owns only the concurrency, rate limiting, progress, periodic checkpointing,
prompt cancellation, the partial-flush guarantee, and the one summary log line.

Extracted so the ``http`` producer and any future network backend are *callers*, not
copies (one throttle model, one cancel path, one summary line for every sweep).
"""

from __future__ import annotations

import threading
import time
import urllib.error
from collections.abc import Callable

from ..eventlog import publish as _logev
from ..store import DatasetStore
from .http_get import NET_ERRORS

# Persist progress at most this often (seconds) during a sweep so a long run survives a
# crash and the web page can read partial results mid-sweep. TIME-based, not per-N-items:
# each save re-serializes the whole (often multi-MB) store, so a per-item cadence would
# stall the server's event loop on a big store.
_SAVE_INTERVAL = 15.0

# Default worker count. The serial loop wasted the whole network round-trip per item;
# with a shared rate limiter the pool keeps several requests in flight and sustains the
# throttle's req/s regardless of latency.
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


def unique_items(records: list[dict], name_field: str = "name",
                 resolve: Callable[[str], str | None] = lambda n: n
                 ) -> list[tuple[str, str]]:
    """Unique ``(key, name)`` pairs from records, in first-seen order.

    ``resolve(name) -> key | None`` maps a display name to the fetch key (defaults to
    identity — the producer applies its own transform later). Names that resolve to a
    falsy key are skipped; several records can share one key (e.g. an item at different
    levels), so we dedup by key — one fetch covers them all."""
    seen: dict[str, str] = {}
    for rec in records:
        name = rec.get(name_field)
        if not name:
            continue
        key = resolve(str(name))
        if key and key not in seen:
            seen[key] = str(name)
    return list(seen.items())


def run_sweep(
    items: list[tuple[str, str]],
    fetch_one: Callable[[str], object],
    write_one: Callable[[str, str, object], None],
    *,
    dataset_store: DatasetStore,
    throttle: float = 0.4,
    workers: int = _WORKERS,
    on_item: Callable[[int, int, str, str, bool], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    on_missing: Callable[[str, str], None] | None = None,
    game: str | None = None,
    log_dataset: str | None = None,
) -> dict:
    """Fetch every ``(key, name)`` in ``items`` concurrently (rate-limited) and write
    each result into ``dataset_store``.

    ``fetch_one(key) -> data`` runs on a worker thread (network only, the slow part);
    it may raise :class:`urllib.error.HTTPError` (a 404 marks the item missing) or any
    of :data:`NET_ERRORS`. ``write_one(key, name, data)`` runs on this single consumer
    thread under an implicit lock (stores aren't thread-safe), so writes + ``on_item``
    + periodic saves stay serialised. ``on_missing(key, name)`` fires on a 404;
    ``should_stop()`` aborts promptly. The store is ALWAYS flushed (a cancel or crash
    still persists what was already fetched)."""
    total = len(items)
    fetched = failed = done = 0
    t0 = time.monotonic()
    last_save = t0
    limiter = _RateLimiter(throttle)
    stop = threading.Event()

    def work(key: str, name: str) -> tuple[str, str, object, bool, bool]:
        """Fetch one item. Returns ``(key, name, data, ok, missing)``."""
        if stop.is_set() or (should_stop is not None and should_stop()):
            return key, name, None, False, False
        limiter.wait()
        if stop.is_set() or (should_stop is not None and should_stop()):
            return key, name, None, False, False
        try:
            return key, name, fetch_one(key), True, False
        except urllib.error.HTTPError as e:
            # 404 = no such item (bad key / untradeable). Other codes are transient.
            return key, name, None, False, e.code == 404
        except NET_ERRORS:
            return key, name, None, False, False

    try:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            futures = [ex.submit(work, k, n) for k, n in items]
            for fut in as_completed(futures):
                key, name, data, ok, missing = fut.result()
                if ok:
                    write_one(key, name, data)
                    fetched += 1
                else:
                    if missing and on_missing is not None:
                        on_missing(key, name)
                    failed += 1
                done += 1
                if on_item is not None:
                    on_item(done, total, key, name, ok)
                now = time.monotonic()
                if fetched and now - last_save >= _SAVE_INTERVAL:
                    last_save = now
                    dataset_store.save()      # cheap mid-sweep checkpoint
                if should_stop is not None and should_stop():
                    stop.set()   # queued workers now short-circuit without fetching
    finally:
        # ALWAYS flush — a cancel or a mid-sweep crash must still persist the items
        # already written, so partial data lands in the dataset.
        dataset_store.save()

    # ONE summary line per sweep (not one per fetch) — every sweep funnels through here,
    # so it covers the trigger, manual-refresh, and CLI paths uniformly.
    dt = time.monotonic() - t0
    _logev(f"sweep {log_dataset or '?'} done · {fetched}/{total} ok"
           + (f" · {failed} failed" if failed else "") + f" · {dt:.1f}s",
           level="ok" if fetched and not failed else "info",
           game=game, dataset=log_dataset)
    return {"total": total, "fetched": fetched, "failed": failed}
