"""Detector-based window + state classifier.

Strategy: a window matches when its detectors combine to pass — ``all`` of them (AND,
the default) or ``any`` (OR), per ``WindowDef.detect_mode``. Each detector passes per
its own polarity (a ``negate`` detector passes when its landmark is ABSENT). Among
matching windows the BEST FIT wins — the window whose detectors score the highest
aggregate similarity, not the one with the most detectors or the first in the file.
That way two windows that both merely *pass* their thresholds are separated by how
WELL they match (e.g. a refinement screen whose title reads 'REFINEMENT' beats a
select screen that only caught a coincidental substring). Within the winning window,
a state matches when ALL its detectors pass; the first matching state is returned.
``None`` state means "window recognised, no specific state".
"""

from __future__ import annotations

from pathlib import Path

from ..interfaces import OcrEngine, WindowClassifier
from ..profile.models import DetectCombine, GameProfile, WindowDef
from ..registry import register_classifier
from ..types import Frame
from .matcher import DetectMatcher, combine_passes, detector_passes


@register_classifier("detect")
class DetectClassifier(WindowClassifier):
    def __init__(self, ocr: OcrEngine, profile_dir: Path | str = ".") -> None:
        self._matcher = DetectMatcher(ocr, profile_dir)

    @staticmethod
    def _cheap_first(detectors):
        """Template detectors (a few ms of matchTemplate) before text detectors (a full
        OCR pass), so a failing cheap detector short-circuits ``all()`` before any OCR."""
        return sorted((d for d in detectors if d.enabled), key=lambda d: 0 if d.template else 1)

    def _window_matches(self, window: WindowDef, frame: Frame) -> bool:
        active = self._cheap_first(window.detect)
        if not active:
            return False
        # generator -> combine_passes' any()/all() still short-circuits the OCR work
        passes = (detector_passes(self._matcher.matches(d, frame), d.negate) for d in active)
        return combine_passes(passes, window.detect_mode)

    def _window_score(self, window: WindowDef, frame: Frame) -> float:
        """Aggregate 0..1 similarity of a window's detectors to the frame — the tie-break
        between windows that both *pass*. Each detector contributes its raw score, flipped
        for a ``negate`` detector (``1 - score``: how ABSENT its landmark is). The window's
        score is the WEAKEST contributor under ``all`` mode (every detector must fit, so the
        worst one bounds the fit) and the STRONGEST under ``any`` mode (one good fit suffices)."""
        active = [d for d in window.detect if d.enabled]
        if not active:
            return 0.0
        contribs = [(1.0 - self._matcher.score(d, frame)) if d.negate
                    else self._matcher.score(d, frame) for d in active]
        return max(contribs) if window.detect_mode == DetectCombine.any else min(contribs)

    def _state_for(self, window: WindowDef, frame: Frame) -> str | None:
        # states always combine with AND; a state detector may still be negated.
        for state in window.states:
            active = self._cheap_first(state.detect)
            if active and all(detector_passes(self._matcher.matches(d, frame), d.negate) for d in active):
                return state.id
        return None

    def classify(self, frame: Frame, profile: GameProfile) -> tuple[str, str | None] | None:
        candidates = [w for w in profile.windows if self._window_matches(w, frame)]
        if not candidates:
            return None
        # best fit: the passing window whose detectors score highest. Ties (e.g. two windows
        # both at 1.0) fall back to the more specific window (more detectors), then file order.
        window = max(candidates, key=lambda w: (self._window_score(w, frame), len(w.detect)))
        return window.id, self._state_for(window, frame)
