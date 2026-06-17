"""Read-only views over stored datasets, for the dashboard.

Delegates to :class:`DatasetStore` so what the dashboard shows is exactly the replayed
ledger — records, history (with revert flags), and summary counts. The ledger is never
mutated; a load may refresh the snapshot cache, but only ever to the same replay.

The key spec must be passed in: records are re-keyed from the raw values at replay
time, so the spec decides how rows dedup.
"""

from __future__ import annotations

import json

from pathlib import Path

from .dataset_store import CACHE_V, DatasetStore, file_src
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


def summarize(data_dir: Path | str, game: str, dataset: str,
              key: KeyMap | KeySpec = KeySpec(), aggregate: str = "latest") -> dict:
    """Dashboard digest for one dataset (counts + column preview + last change).

    Steady-state flow polls hit the tiny ``<dataset>.summary.json`` sidecar, validated
    against the history file's stat + the key spec — so a poll never opens the full state
    snapshot (which can be tens of MB). A miss (sidecar absent/stale/wrong key) falls back
    to a full store load, which rewrites the sidecar for next time."""
    d = _game_dir(data_dir, game)
    cached = _read_summary_sidecar(d / f"{dataset}.summary.json",
                                   d / f"{dataset}.history.jsonl", key)
    if cached is not None:
        return cached
    store = _reader(data_dir, game, dataset, key, aggregate)
    store.write_summary()   # rebuild the sidecar so the next poll takes the fast path
    return store.summary()


def _read_summary_sidecar(sidecar: Path, history: Path,
                          key: KeyMap | KeySpec) -> dict | None:
    """Return the cached digest iff it still matches the live ledger (history stat) and the
    requested key spec; else ``None`` so the caller rebuilds. Never parses the ledger."""
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    if (data.get("v") != CACHE_V or data.get("src") != file_src(history)
            or data.get("key") != key.meta()):
        return None
    return {k: data[k] for k in ("dataset", "present", "total", "removed",
                                 "columns", "last_ts", "last_op") if k in data}
