"""Pull dictionary terms from a dataset's stored columns.

A :class:`~oc.profile.models.DictionaryDef` may declare ``feeds``: datasets whose column
values become its vocabulary. This is the derived counterpart to a hand-typed word list —
a collected dataset teaches the dictionary the terms its own reads should snap to (e.g. the
``relic_contents`` dataset feeds every relic/item name into a dictionary). Terms are pulled
through the shared :func:`oc.store.factory.store_for` funnel so a fed dataset keys/aggregates
exactly as it does everywhere else, then flattened across the chosen columns and deduped.

Refreshed from two places (both call :func:`apply_feeds`):
  * the profile-save route, when the feed config itself changes;
  * a change-bus subscriber (:class:`DictFeeder`), when the fed data changes.
"""

from __future__ import annotations

import threading
from pathlib import Path

from ..store.factory import store_for


def pull_terms(data_dir: Path | str, game: str, profile, dict_def) -> list[str]:
    """Every value of ``dict_def``'s fed columns across all stored rows, order-preserving and
    de-duplicated case-insensitively (matching the pooled-vocabulary dedup)."""
    seen: set[str] = set()
    out: list[str] = []
    for feed in dict_def.feeds:
        if not feed.dataset or not feed.columns:
            continue
        try:
            store = store_for(data_dir, game, feed.dataset, profile=profile)
            rows = store.records()
        except Exception:  # noqa: BLE001 - a missing/odd store just yields no terms
            continue
        for row in rows:
            for col in feed.columns:
                v = str(row.get(col, "") or "").strip()
                if v and v.lower() not in seen:
                    seen.add(v.lower())
                    out.append(v)
    return out


def apply_feeds(data_dir: Path | str, game: str, profile) -> list:
    """For each dictionary with feeds, REPLACE its ``terms`` with the pulled+deduped values.
    Returns the dictionaries that were refreshed (so a caller can persist just those)."""
    changed = []
    for d in profile.dictionaries:
        if d.feeds:
            d.terms = pull_terms(data_dir, game, profile, d)
            changed.append(d)
    return changed


class DictFeeder:
    """Change-bus subscriber that re-pulls fed dictionaries when their source data changes.

    Signature ``(game, dataset, records)`` — on a write to any dataset that some dictionary
    feeds, it re-reads that dictionary's columns and rewrites its term file (deduped). Bursts
    are coalesced with a trailing timer (a collection tick writes many rows) so a run rewrites
    the file once, not per row. Term-file writes never touch the change bus, so there is no
    feedback loop. Best-effort: any failure is swallowed so a bad pull never breaks a write."""

    def __init__(self, profiles_dir: Path | str, data_dir: Path | str, delay: float = 0.5) -> None:
        self._profiles_dir = Path(profiles_dir)
        self._data_dir = Path(data_dir)
        self._delay = delay
        self._lock = threading.Lock()
        self._pending: set[tuple[str, str]] = set()
        self._timer: threading.Timer | None = None

    def __call__(self, game: str, dataset: str, records: list, data_changed: bool = True,
                 batch: int | None = None) -> None:
        if not game or not dataset:
            return
        with self._lock:
            self._pending.add((game, dataset))
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self._delay, self._flush)
            self._timer.daemon = True
            self._timer.start()

    def _flush(self) -> None:
        with self._lock:
            pending = self._pending
            self._pending = set()
            self._timer = None
        # collapse to the set of games touched — a game's feeds are re-pulled wholesale
        for game in {g for g, _ in pending}:
            try:
                self._refresh_game(game, {ds for g, ds in pending if g == game})
            except Exception:  # noqa: BLE001 - best-effort
                pass

    def _refresh_game(self, game: str, datasets: set[str]) -> None:
        from ..profile.loader import list_profiles, load_profile, write_dictionary

        if game not in list_profiles(self._profiles_dir):
            return
        profile = load_profile(self._profiles_dir, game)
        for d in profile.dictionaries:
            if not d.feeds or not any(f.dataset in datasets for f in d.feeds):
                continue
            terms = pull_terms(self._data_dir, game, profile, d)
            if d.source:
                write_dictionary(self._profiles_dir, d.source, terms)
