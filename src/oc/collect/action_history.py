"""In-memory recent-run history per action node — non-persisted, process-memory only.

The teach UI's action *run history* satellite node shows the last few times an action node ran: WHEN,
BY WHOM (the trigger id that fired it, or ``None`` for a manual/chained fire — see ``trigger``),
whether a dataset/register op actually RAN, which SOUNDS it cued, and which downstream ACTIONS it
chained into. Like the trigger-/readout-/register-/process-/gate-/router-/sound-history rings this is
deliberately transient: a ring buffer in module memory, wiped on restart. The ring mechanics live in
the shared :class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the action
key + run-record shape.

:func:`oc.collect.triggers._run_action` calls :func:`record` once per action run — the single funnel
every fire path (auto trigger dispatch, the trigger fire-now route, the action's own fire-now route,
and a chained action) goes through, so no path drifts. :func:`snapshot` is read by the live heartbeat
and delivered to the client, which paints it into an OPEN satellite (empty / no-op when hidden).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200)


def record(game: str, action_id: str, *, ts: str, trigger: str | None, ran: bool,
           sounds, chained) -> None:
    """Append one action run to its ring (newest first). ``ts`` is an ISO timestamp (the caller
    stamps it). ``trigger`` is the firing trigger's id (``None`` for a manual/chained fire), ``ran``
    whether a dataset/register op actually ran, ``sounds`` the sound ids cued, ``chained`` the
    downstream action ids fired."""
    _ring.record((game, action_id), {"ts": ts, "trigger": trigger, "ran": ran,
                                     "sounds": list(sounds or []), "chained": list(chained or [])})


def recent(game: str, action_id: str) -> list[dict]:
    """This action's recent runs, newest first (empty if nothing ran this session)."""
    return _ring.recent((game, action_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every action's recent runs for ``game``, keyed by action id — the shape the live heartbeat
    carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, action_id: str | None = None) -> None:
    """Drop history for one action, or (``action_id=None``) every action of ``game``."""
    _ring.clear(game, action_id)
