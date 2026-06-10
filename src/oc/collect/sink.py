"""Record sinks: where collected records go. Default is append-only JSONL."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path

from .reader import Record


class RecordSink(ABC):
    @abstractmethod
    def write(self, record: Record) -> None: ...

    def close(self) -> None:  # optional override
        pass


class JsonlSink(RecordSink):
    """Append each record as one JSON line under ``data/<game>/<window>.jsonl``."""

    def __init__(self, data_dir: Path | str, game: str, window: str) -> None:
        self._path = Path(data_dir) / game / f"{window}.jsonl"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self._path.open("a", encoding="utf-8")

    @property
    def path(self) -> Path:
        return self._path

    def write(self, record: Record) -> None:
        payload = {"_confidence": round(record.confidence, 4), **record.values}
        self._fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        self._fh.close()
