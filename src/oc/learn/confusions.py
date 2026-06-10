"""Per-game OCR confusion map — learned, then used to pre-correct reads.

Whenever a noisy OCR read is matched to a canonical dictionary term, the two are
aligned and their differences recorded as substring substitutions (e.g. ``T``->``E``,
``rn``->``m``, ``mmf``->``mm f``). ``normalize`` then applies the most-confident
substitutions to a fresh read, so consistent OCR mistakes are fixed before the
dictionary lookup — improving first-try matches, especially for partly-known words.

Persisted to ``data/<game>/confusions.json`` as ``{src: {dst: count}}``.
"""

from __future__ import annotations

import json
from difflib import SequenceMatcher
from pathlib import Path

_MAX_OP = 4  # ignore long, unreliable alignment chunks


class ConfusionMap:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._subs: dict[str, dict[str, int]] = {}
        self._dirty = False
        if self._path.exists():
            self._subs = json.loads(self._path.read_text(encoding="utf-8"))

    def learn(self, read: str, canonical: str) -> None:
        if not read or not canonical or read == canonical:
            return
        for tag, i1, i2, j1, j2 in SequenceMatcher(None, read, canonical).get_opcodes():
            if tag == "equal":
                continue
            # include one char of context each side so insertions/deletions aren't
            # empty (an empty src would match between every character).
            lo_r, hi_r = max(0, i1 - 1), min(len(read), i2 + 1)
            lo_c, hi_c = max(0, j1 - 1), min(len(canonical), j2 + 1)
            src, dst = read[lo_r:hi_r], canonical[lo_c:hi_c]
            if not src or src == dst or len(src) > _MAX_OP or len(dst) > _MAX_OP:
                continue
            bucket = self._subs.setdefault(src, {})
            bucket[dst] = bucket.get(dst, 0) + 1
            self._dirty = True

    def normalize(self, text: str, min_count: int = 2) -> str:
        """Apply the most-confident learned substitutions to a read."""
        if not text or not self._subs:
            return text
        # strongest substitutions first; apply each once if it occurs
        ops = []
        for src, dsts in self._subs.items():
            dst, cnt = max(dsts.items(), key=lambda kv: kv[1])
            if cnt >= min_count and src and src != dst:
                ops.append((cnt, src, dst))
        ops.sort(reverse=True)
        out = text
        for _cnt, src, dst in ops:
            if src in out:
                out = out.replace(src, dst)
        return out

    def save(self) -> None:
        if not self._dirty:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(self._subs, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        self._dirty = False

    @classmethod
    def for_game(cls, data_dir: Path | str, game: str) -> "ConfusionMap":
        return cls(Path(data_dir) / game / "confusions.json")
