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
from .keys import KeyMap, KeySpec


def _game_dir(data_dir: Path | str, game: str) -> Path:
    return Path(data_dir) / game


def _reader(data_dir: Path | str, game: str, dataset: str,
            key: KeyMap | KeySpec = KeySpec()) -> DatasetStore:
    return DatasetStore(data_dir, game, dataset, key=key)


def list_datasets(data_dir: Path | str, game: str) -> list[str]:
    d = _game_dir(data_dir, game)
    if not d.exists():
        return []
    names = {p.name[: -len(".history.jsonl")] for p in d.glob("*.history.jsonl")}
    names |= {p.name[: -len(".state.json")] for p in d.glob("*.state.json")}
    return sorted(names)


def records(data_dir: Path | str, game: str, dataset: str, limit: int = 200) -> list[dict]:
    return _reader(data_dir, game, dataset).records(limit)


def history(data_dir: Path | str, game: str, dataset: str, n: int = 50) -> list[dict]:
    return _reader(data_dir, game, dataset).history(n)


def batches(data_dir: Path | str, game: str, dataset: str, n: int = 50) -> list[dict]:
    return _reader(data_dir, game, dataset).batches(n)


def summarize(data_dir: Path | str, game: str, dataset: str,
              key: KeyMap | KeySpec = KeySpec()) -> dict:
    store = _reader(data_dir, game, dataset, key)
    hist = store.history(1)
    last = hist[0] if hist else None
    return {
        "dataset": dataset,
        "present": store.present_count,
        "total": len(store.records(10_000_000)),
        "last_ts": last["ts"] if last else None,
        "last_op": last["op"] if last else None,
    }
