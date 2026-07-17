"""The ONE window-selection rule, shared by the runtime classifier and the teach-UI collision
check (CLAUDE.md rule 7).

Both must agree on which window a frame classifies to. They didn't: the collision check picked
the winner by best-fit SCORE while the classifier picks by PRIORITY (first passing window in
``window_priority``) — so a lower-priority window that merely scored higher was falsely reported
as winning, flagging a correctly-classified window as "misclassified". This module is the single
source of that decision so the two can never drift again. ``DetectClassifier.classify``'s priority
branch is the streaming (short-circuit, no-OCR-past-the-first-hit) form of the same rule;
``test_select`` asserts the two stay in agreement.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..profile.models import DetectCombine, GameProfile, WindowDef


def priority_order(profile: GameProfile) -> list[WindowDef]:
    """Windows in classification order: those named in ``window_priority`` first (in that order),
    then any remaining window in profile order. A priority id that no longer names a window is
    skipped. Empty ``window_priority`` -> profile order unchanged."""
    by_id = {w.id: w for w in profile.windows}
    seen: set[str] = set()
    out: list[WindowDef] = []
    for wid in profile.window_priority:
        w = by_id.get(wid)
        if w is not None and wid not in seen:
            seen.add(wid)
            out.append(w)
    for w in profile.windows:
        if w.id not in seen:
            out.append(w)
    return out


def aggregate_fit(contribs: list[float], mode: DetectCombine) -> float:
    """A window's 0..1 fit from its per-detector contributions: the WEAKEST contributor under
    ``all`` (every detector must fit, so the worst bounds it) and the STRONGEST under ``any`` (one
    good fit suffices). Empty -> 0.0. The tie-break between windows that both pass, in best-fit."""
    if not contribs:
        return 0.0
    return max(contribs) if mode == DetectCombine.any else min(contribs)


@dataclass(frozen=True)
class WinCand:
    """An evaluated window for :func:`select_winner`: whether it passed, its aggregate fit, and
    its enabled-detector count (the best-fit specificity tie-break)."""

    id: str
    matched: bool
    score: float
    ndet: int


def select_winner(profile: GameProfile, candidates: list[WinCand]) -> str | None:
    """The winning window id among ``candidates``, or ``None`` if none passed.

    * ``window_priority`` set -> priority mode: the FIRST passing window in priority order wins
      (pure true/false; score is irrelevant). A lower-priority window scoring higher must NOT win.
    * empty ``window_priority`` -> best fit: highest ``score``, then most detectors (specificity),
      then earliest in the candidate list (file order, since ``max`` is stable on ties)."""
    passers = [c for c in candidates if c.matched]
    if not passers:
        return None
    if profile.window_priority:
        rank = {w.id: i for i, w in enumerate(priority_order(profile))}
        return min(passers, key=lambda c: rank.get(c.id, len(rank))).id
    return max(passers, key=lambda c: (c.score, c.ndet)).id
