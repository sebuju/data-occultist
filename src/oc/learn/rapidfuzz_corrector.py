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

    def best(self, candidate: str, vocabulary: Sequence[str],
             cutoff: float = 0.0) -> tuple[str, float] | None:
        if not vocabulary:
            return None
        from rapidfuzz import process

        # score_cutoff lets rapidfuzz abandon each comparison as soon as the term can
        # no longer reach it — on a big vocabulary this is several times faster.
        match = process.extractOne(candidate, vocabulary, scorer=self._scorer(),
                                   score_cutoff=cutoff * 100)
        if match is None:
            return None
        term, score, _idx = match
        return term, score / 100.0  # rapidfuzz scores are 0..100
