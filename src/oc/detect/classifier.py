"""Detector-based window + state classifier.

Strategy: a window matches when ALL its detectors match. Among matching windows
the one with the most detectors (most specific) wins. Within that window, a state
matches when all its detectors match; the first matching state is returned. ``None``
state means "window recognised, no specific state".
"""

from __future__ import annotations

from pathlib import Path

from ..interfaces import OcrEngine, WindowClassifier
from ..profile.models import GameProfile, WindowDef
from ..registry import register_classifier
from ..types import Frame
from .matcher import DetectMatcher


@register_classifier("detect")
class DetectClassifier(WindowClassifier):
    def __init__(self, ocr: OcrEngine, profile_dir: Path | str = ".") -> None:
        self._matcher = DetectMatcher(ocr, profile_dir)

    def _window_matches(self, window: WindowDef, frame: Frame) -> bool:
        active = [d for d in window.detect if d.enabled]
        if not active:
            return False
        return all(self._matcher.matches(d, frame) for d in active)

    def _state_for(self, window: WindowDef, frame: Frame) -> str | None:
        for state in window.states:
            active = [d for d in state.detect if d.enabled]
            if active and all(self._matcher.matches(d, frame) for d in active):
                return state.id
        return None

    def classify(self, frame: Frame, profile: GameProfile) -> tuple[str, str | None] | None:
        candidates = [w for w in profile.windows if self._window_matches(w, frame)]
        if not candidates:
            return None
        window = max(candidates, key=lambda w: len(w.detect))
        return window.id, self._state_for(window, frame)
