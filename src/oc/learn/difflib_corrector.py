"""Fuzzy corrector backed by stdlib :mod:`difflib` (zero dependencies, fallback)."""

from __future__ import annotations

from collections.abc import Sequence
from difflib import SequenceMatcher

from ..interfaces import Corrector
from ..registry import register_corrector


@register_corrector("difflib")
class DifflibCorrector(Corrector):
    def best(self, candidate: str, vocabulary: Sequence[str]) -> tuple[str, float] | None:
        if not vocabulary:
            return None
        cand = candidate.lower()
        best_term = vocabulary[0]
        best_score = 0.0
        for term in vocabulary:
            score = SequenceMatcher(None, cand, term.lower()).ratio()
            if score > best_score:
                best_term, best_score = term, score
        return best_term, best_score
