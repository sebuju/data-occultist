"""Read-only views over stored datasets, for the dashboard.

Delegates to :class:`DatasetStore` so what the dashboard shows is exactly the replayed
ledger — records, history (with revert flags), and summary counts. The ledger is never
mutated; a load may refresh the snapshot cache, but only ever to the same replay.

The key spec must be passed in: records are re-keyed from the raw values at replay
time, so the spec decides how rows dedup.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .dataset_store import DatasetStore, _db_path
from .factory import store_for
from .keys import KeyMap, KeySpec


def _game_dir(data_dir: Path | str, game: str) -> Path:
    return Path(data_dir) / game


def _reader(data_dir: Path | str, game: str, dataset: str,
            key: KeyMap | KeySpec = KeySpec(), aggregate: str = "latest",
            keep_batches: int = 0) -> DatasetStore:
    return store_for(data_dir, game, dataset, key=key, aggregate=aggregate,
                     keep_batches=keep_batches)


def list_datasets(data_dir: Path | str, game: str) -> list[str]:
    """Datasets known on disk: those registered in the per-game SQLite DB."""
    names: set[str] = set()
    db = _db_path(data_dir, game)
    if db.exists():
        conn = sqlite3.connect(str(db))
        try:
            names |= {r[0] for r in conn.execute("SELECT dataset FROM datasets")}
        except sqlite3.OperationalError:
            pass
        finally:
            conn.close()
    return sorted(names)


def records(data_dir: Path | str, game: str, dataset: str, limit: int = 0) -> list[dict]:
    return _reader(data_dir, game, dataset).records(limit)


def history(data_dir: Path | str, game: str, dataset: str, n: int = 50) -> list[dict]:
    return _reader(data_dir, game, dataset).history(n)


def batches(data_dir: Path | str, game: str, dataset: str, n: int = 50) -> list[dict]:
    return _reader(data_dir, game, dataset).batches(n)


def summarize(data_dir: Path | str, game: str, dataset: str,
              key: KeyMap | KeySpec = KeySpec(), aggregate: str = "latest",
              keep_batches: int = 0) -> dict:
    """Dashboard digest for one dataset (counts + column preview + last change), read
    straight from the DB.

    ``keep_batches`` is passed in for the same reason ``key``/``aggregate`` are — this module
    stays profile-free, so the caller resolves it. It must be threaded: the digest only reports
    a batch count for a dataset that HAS a retention limit, so dropping it here silently reports
    ``batches: None`` and the UI can never tell that a dataset is over its window."""
    return _reader(data_dir, game, dataset, key, aggregate, keep_batches).summary()
