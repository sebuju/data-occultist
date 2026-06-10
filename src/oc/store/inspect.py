"""Read-only views over stored datasets, for the dashboard.

Loads snapshots and history without instantiating a writable store, so the
dashboard can show "window -> dataset -> what's captured" and the recent
add/update/remove flow.
"""

from __future__ import annotations

import json
from pathlib import Path


def _game_dir(data_dir: Path | str, game: str) -> Path:
    return Path(data_dir) / game


def list_datasets(data_dir: Path | str, game: str) -> list[str]:
    d = _game_dir(data_dir, game)
    if not d.exists():
        return []
    return sorted(p.name[: -len(".state.json")] for p in d.glob("*.state.json"))


def read_state(data_dir: Path | str, game: str, dataset: str) -> dict:
    path = _game_dir(data_dir, game) / f"{dataset}.state.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def tail_history(data_dir: Path | str, game: str, dataset: str, n: int = 50) -> list[dict]:
    path = _game_dir(data_dir, game) / f"{dataset}.history.jsonl"
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    out = []
    for line in lines[-n:]:
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def summarize(data_dir: Path | str, game: str, dataset: str) -> dict:
    state = read_state(data_dir, game, dataset)
    present = sum(1 for e in state.values() if e.get("present", True))
    hist = tail_history(data_dir, game, dataset, n=1)
    last = hist[-1] if hist else None
    return {
        "dataset": dataset,
        "present": present,
        "total": len(state),
        "last_ts": last["ts"] if last else None,
        "last_op": last["op"] if last else None,
    }


def records(data_dir: Path | str, game: str, dataset: str, limit: int = 200) -> list[dict]:
    state = read_state(data_dir, game, dataset)
    rows = []
    for key, entry in state.items():
        rows.append({
            "key": key,
            "present": entry.get("present", True),
            "first_seen": entry.get("first_seen"),
            "last_seen": entry.get("last_seen"),
            **entry.get("values", {}),
        })
    rows.sort(key=lambda r: (not r["present"], r["key"]))
    return rows[:limit]
