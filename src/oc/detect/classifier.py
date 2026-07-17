"""Detector-based window + state classifier.

Strategy: a window matches when its detectors combine to pass — ``all`` of them (AND,
the default) or ``any`` (OR), per ``WindowDef.detect_mode``. Each detector passes per
its own polarity (a ``negate`` detector passes when its landmark is ABSENT).

Two selection modes:

* ``window_priority`` set — try windows in that order and take the FIRST that matches
  (early-return). Cheap: a window's cheap (no-OCR) detectors run first and short-circuit,
  so a non-match costs only its cheap probes before the next is tried. The top-priority
  window is usually a cheap-detector "gate" for the on-screen gameplay HUD with NO
  dataset — when it matches, classify returns it and the collector reads nothing, so a
  continuously-running live session costs almost nothing between the brief moments worth
  reading. When it doesn't match, classify falls through to the real data windows.
* ``window_priority`` empty — BEST FIT: among all matching windows the one whose detectors
  score the highest aggregate similarity wins (ties -> more detectors, then file order), so
  two windows that both merely pass are separated by how WELL they match.

Within the winning window a state matches when ALL its detectors pass; the first matching
state is returned. ``None`` state means "window recognised, no specific state".
"""

from __future__ import annotations

from pathlib import Path

from ..interfaces import OcrEngine, WindowClassifier
from ..profile.models import GameProfile, WindowDef
from ..registry import register_classifier
from ..types import Frame
from .matcher import DetectMatcher, combine_passes, detector_passes
from .select import WinCand, aggregate_fit, priority_order, select_winner


@register_classifier("detect")
class DetectClassifier(WindowClassifier):
    def __init__(self, ocr: OcrEngine, profile_dir: Path | str = ".") -> None:
        self._matcher = DetectMatcher(ocr, profile_dir)

    @staticmethod
    def _cheap_first(detectors):
        """Cheap detectors (template / colour — a few ms, no OCR) before text detectors
        (a full OCR pass), so a failing cheap detector short-circuits ``all()`` before any
        OCR. ``DetectDef.is_cheap`` is the single source of "needs no OCR"."""
        return sorted((d for d in detectors if d.enabled), key=lambda d: 0 if d.is_cheap else 1)

    def _window_matches(self, window: WindowDef, frame: Frame) -> bool:
        if not window.enabled:   # disabled window: never classified/read/saved (UI disable toggle)
            return False
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
        contribs = [(1.0 - self._matcher.score(d, frame)) if d.negate
                    else self._matcher.score(d, frame) for d in active]
        return aggregate_fit(contribs, window.detect_mode)

    def _state_for(self, window: WindowDef, frame: Frame) -> str | None:
        # states always combine with AND; a state detector may still be negated.
        for state in window.states:
            active = self._cheap_first(state.detect)
            if active and all(detector_passes(self._matcher.matches(d, frame), d.negate) for d in active):
                return state.id
        return None

    @staticmethod
    def _text_detect_boxes(profile: GameProfile, frame: Frame):
        """Every enabled TEXT window-detector's search box (pixels) — what classify recognises
        for every window. State detectors are left out (read only for the window that wins)."""
        boxes = []
        for w in profile.windows:
            if not w.enabled:   # disabled window is never classified — don't OCR its detect boxes
                continue
            for d in w.detect:
                # text-kind = needs OCR = not a cheap (template/colour) detector. Includes an
                # empty-text "any text present" detector.
                if d.enabled and not d.is_cheap:
                    boxes.append(d.search.to_fraction().to_pixels(frame.client.w, frame.client.h))
        return boxes

    @staticmethod
    def _priority_order(profile: GameProfile) -> list[WindowDef]:
        return priority_order(profile)

    def classify(self, frame: Frame, profile: GameProfile) -> tuple[str, str | None] | None:
        # On GPU, recognise every window's title box in ONE batched pass up front (prewarm
        # no-ops on CPU / stub matcher / no frame) — turns N tiny launch-bound reads into one.
        prewarm = getattr(self._matcher, "prewarm", None)
        if frame is not None and prewarm is not None:
            prewarm(frame, self._text_detect_boxes(profile, frame))
        # Priority mode: the FIRST passing window in priority order wins (select.select_winner's
        # priority rule). Done as a STREAMING short-circuit here — not a post-hoc select_winner over
        # every window — because that's the whole perf point: a settled gameplay frame passes the
        # top-priority cheap gate and early-returns with NO OCR on the lower windows. Same rule, one
        # source (priority_order); test_select asserts this branch agrees with select_winner.
        if profile.window_priority:
            for w in priority_order(profile):
                if self._window_matches(w, frame):
                    return w.id, self._state_for(w, frame)
            return None
        # No priority authored: best fit. No short-circuit to exploit, so evaluate every window and
        # defer the winner rule to the shared select_winner (highest score, then most detectors).
        cands = [WinCand(w.id, True, self._window_score(w, frame), len([d for d in w.detect if d.enabled]))
                 for w in profile.windows if self._window_matches(w, frame)]
        winner_id = select_winner(profile, cands)
        if winner_id is None:
            return None
        return winner_id, self._state_for(profile.window(winner_id), frame)
