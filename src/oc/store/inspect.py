"""Read-only views over stored datasets, for the dashboard.

Delegates to :class:`DatasetStore` so what the dashboard shows is exactly the replayed
ledger — records, history (with revert flags), and summary counts. The ledger is never
mutated; a load may refresh the snapshot cache, but only ever to the same replay.

The key spec must be passed in: records are re-keyed from the raw values at replay
time, so the spec decides how rows dedup.
"""

from __future__ import annotations

from pathlib import Path

from .dataset_store import DatasetStore
from .factory import store_for
from .keys import KeyMap, KeySpec


def _game_dir(data_dir: Path | str, game: str) -> Path:
    return Path(data_dir) / game


def _reader(data_dir: Path | str, game: str, dataset: str,
            key: KeyMap | KeySpec = KeySpec(), aggregate: str = "latest") -> DatasetStore:
    return store_for(data_dir, game, dataset, key=key, aggregate=aggregate)


def list_datasets(data_dir: Path | str, game: str) -> list[str]:
    d = _game_dir(data_dir, game)
    if not d.exists():
        return []
    names = {p.name[: -len(".history.jsonl")] for p in d.glob("*.history.jsonl")}
    names |= {p.name[: -len(".state.json")] for p in d.glob("*.state.json")}
    return sorted(names)


def records(data_dir: Path | str, game: str, dataset: str, limit: int = 0) -> list[dict]:
    return _reader(data_dir, game, dataset).records(limit)


def history(data_dir: Path | str, game: str, dataset: str, n: int = 50) -> list[dict]:
    return _reader(data_dir, game, dataset).history(n)


def batches(data_dir: Path | str, game: str, dataset: str, n: int = 50) -> list[dict]:
    return _reader(data_dir, game, dataset).batches(n)


_SUMMARY_HIDDEN = {"key", "present", "first_seen", "last_seen", "removed_at", "_count"}


def summarize(data_dir: Path | str, game: str, dataset: str,
              key: KeyMap | KeySpec = KeySpec(), aggregate: str = "latest") -> dict:
    store = _reader(data_dir, game, dataset, key, aggregate)
    hist = store.history(1)
    last = hist[0] if hist else None
    recs = store.records()
    present = store.present_count
    # data field names, from the union over a few rows (so the node can show what a
    # dataset actually holds instead of a meaningless dash)
    cols: list[str] = []
    for r in recs[:20]:
        for k in r:
            if k not in _SUMMARY_HIDDEN and k not in cols:
                cols.append(k)
    return {
        "dataset": dataset,
        "present": present,
        "total": len(recs),
        "removed": len(recs) - present,
        "columns": cols,
        "last_ts": last["ts"] if last else None,
        "last_op": last["op"] if last else None,
    }
