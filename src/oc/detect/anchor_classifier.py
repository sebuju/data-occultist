"""Anchor-based window + state classifier.

Strategy: a window matches when ALL its anchors match. Among matching windows the
one with the most anchors (most specific) wins. Within that window, a state matches
when all its anchors match; the first matching state is returned. ``None`` state
means "window recognised, no specific state".
"""

from __future__ import annotations

from pathlib import Path

from ..interfaces import OcrEngine, WindowClassifier
from ..profile.models import GameProfile, WindowDef
from ..registry import register_classifier
from ..types import Frame
from .anchor import AnchorMatcher


@register_classifier("anchor")
class AnchorClassifier(WindowClassifier):
    def __init__(self, ocr: OcrEngine, profile_dir: Path | str = ".") -> None:
        self._matcher = AnchorMatcher(ocr, profile_dir)

    def _window_matches(self, window: WindowDef, frame: Frame) -> bool:
        active = [a for a in window.anchors if a.enabled]
        if not active:
            return False
        return all(self._matcher.matches(a, frame) for a in active)

    def _state_for(self, window: WindowDef, frame: Frame) -> str | None:
        for state in window.states:
            active = [a for a in state.anchors if a.enabled]
            if active and all(self._matcher.matches(a, frame) for a in active):
                return state.id
        return None

    def classify(self, frame: Frame, profile: GameProfile) -> tuple[str, str | None] | None:
        candidates = [w for w in profile.windows if self._window_matches(w, frame)]
        if not candidates:
            return None
        window = max(candidates, key=lambda w: len(w.anchors))
        return window.id, self._state_for(window, frame)
