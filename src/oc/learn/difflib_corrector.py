"""Fuzzy corrector backed by stdlib :mod:`difflib` (zero dependencies, fallback)."""

from __future__ import annotations

from collections.abc import Sequence
from difflib import SequenceMatcher

from ..interfaces import Corrector
from ..registry import register_corrector


@register_corrector("difflib")
class DifflibCorrector(Corrector):
    def best(self, candidate: str, vocabulary: Sequence[str],
             cutoff: float = 0.0) -> tuple[str, float] | None:
        if not vocabulary:
            return None
        cand = candidate.lower()
        best_term = vocabulary[0]
        best_score = 0.0
        m = SequenceMatcher(None, cand)   # reuse: difflib caches the fixed sequence
        for term in vocabulary:
            m.set_seq2(term.lower())
            if m.real_quick_ratio() <= best_score or m.quick_ratio() <= best_score:
                continue   # upper bounds can't beat the current best -> skip the O(n^2) pass
            score = m.ratio()
            if score > best_score:
                best_term, best_score = term, score
        if best_score < cutoff:
            return None
        return best_term, best_score
