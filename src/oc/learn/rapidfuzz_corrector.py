"""Fuzzy corrector backed by :mod:`rapidfuzz` (fast C++ string matching)."""

from __future__ import annotations

from collections.abc import Sequence

from ..interfaces import Corrector
from ..registry import register_corrector


@register_corrector("rapidfuzz")
class RapidFuzzCorrector(Corrector):
    def __init__(self, scorer: str = "WRatio") -> None:
        self._scorer_name = scorer

    def _scorer(self):
        from rapidfuzz import fuzz

        return getattr(fuzz, self._scorer_name)

    def best(self, candidate: str, vocabulary: Sequence[str]) -> tuple[str, float] | None:
        if not vocabulary:
            return None
        from rapidfuzz import process

        match = process.extractOne(candidate, vocabulary, scorer=self._scorer())
        if match is None:
            return None
        term, score, _idx = match
        return term, score / 100.0  # rapidfuzz scores are 0..100
