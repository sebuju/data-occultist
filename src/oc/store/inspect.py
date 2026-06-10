"""Read-only views over stored datasets, for the dashboard.

Delegates to :class:`DatasetStore` (without ever calling ``save``) so what the
dashboard shows is exactly the replayed ledger — records, history (with revert
flags), and summary counts — never a stale snapshot.
"""

from __future__ import annotations

from pathlib import Path

from .dataset_store import DatasetStore


def _game_dir(data_dir: Path | str, game: str) -> Path:
    return Path(data_dir) / game


def _reader(data_dir: Path | str, game: str, dataset: str) -> DatasetStore:
    # key_field is irrelevant for read-only views (records/history don't use it)
    return DatasetStore(data_dir, game, dataset, key_field="")


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


def summarize(data_dir: Path | str, game: str, dataset: str) -> dict:
    store = _reader(data_dir, game, dataset)
    hist = store.history(1)
    last = hist[0] if hist else None
    return {
        "dataset": dataset,
        "present": store.present_count,
        "total": len(store.records(10_000_000)),
        "last_ts": last["ts"] if last else None,
        "last_op": last["op"] if last else None,
    }
