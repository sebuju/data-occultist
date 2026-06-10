"""Game-specific dictionary: known terms per field, with frequencies.

Persisted to ``data/<game>/lexicon.json`` as ``{field_id: {term: count}}``. Terms
are learned from high-confidence OCR reads and reused to correct uncertain ones.
Frequency lets the resolver prefer common terms when scores tie.
"""

from __future__ import annotations

import json
from pathlib import Path


class Lexicon:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._terms: dict[str, dict[str, int]] = {}
        self._dirty = False
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            self._terms = json.loads(self._path.read_text(encoding="utf-8"))

    def save(self) -> None:
        if not self._dirty:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(self._terms, ensure_ascii=False, indent=0, sort_keys=True),
            encoding="utf-8",
        )
        self._dirty = False

    def terms(self, field_id: str) -> list[str]:
        return list(self._terms.get(field_id, {}).keys())

    def frequency(self, field_id: str, term: str) -> int:
        return self._terms.get(field_id, {}).get(term, 0)

    def learn(self, field_id: str, term: str) -> None:
        term = term.strip()
        if not term:
            return
        bucket = self._terms.setdefault(field_id, {})
        bucket[term] = bucket.get(term, 0) + 1
        self._dirty = True

    def as_dict(self) -> dict[str, dict[str, int]]:
        return self._terms

    def set_terms(self, field_id: str, terms: list[str]) -> None:
        """Replace a field's terms (manual edit). Existing counts are preserved for
        kept terms; new terms start at 1; removed terms are dropped."""
        old = self._terms.get(field_id, {})
        bucket: dict[str, int] = {}
        for t in terms:
            t = t.strip()
            if t:
                bucket[t] = old.get(t, 1)
        self._terms[field_id] = bucket
        self._dirty = True

    def force_save(self) -> None:
        self._dirty = True
        self.save()

    @classmethod
    def for_game(cls, data_dir: Path | str, game: str) -> "Lexicon":
        return cls(Path(data_dir) / game / "lexicon.json")
