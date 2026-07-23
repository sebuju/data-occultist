"""In-memory recent-input-event history per ``on_input`` trigger — non-persisted, web-process only.

The twin of :mod:`oc.collect.trigger_history`: where that ring records only the fires an
``on_input`` trigger actually MADE, this one records every raw hook event the trigger CONSIDERED
and matched in some way — fired, throttled, gated, awaiting a second tap — so the teach UI's
input-log satellite doubles as a "why isn't this firing" debugger. Window/rect/chord misses are
NOT recorded (pure noise — every unbound click/keypress on the whole desktop would otherwise
flood the ring). Like every other history ring
([[trigger_history]] and siblings) it is deliberately transient — wiped on restart, a live debugging
view rather than an audit log. The ring mechanics live in the shared
:class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the trigger key +
considered-event record shape.

:func:`record` is called from every disposition branch of
:meth:`oc.collect.triggers.TriggerRunner.on_input`. :func:`snapshot` is read by the live heartbeat
(``activity.build_activity``) under the top-level ``input_history`` key and delivered to the client,
which paints it into an OPEN satellite (no-op when hidden) and — because that ``<kind>_history``
shape is auto-discovered — into the merged node-log panel too (``panels/nodelog.js``).

Naming note: the SATELLITE keeps its ``inlog:`` node id / ``inputlog`` vttable kind even though this
ring is ``input_history``. Satellite node ids are persisted in the profile's ``layout`` (positions,
sizes, per-table column state), so renaming them would strand stale ids in the YAML; the heartbeat
field name is what the node-log panel keys off, and that is what this module owns.
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200, kind="input")


def record(game: str, trigger_id: str, *, ts: str, event: str, button: str,
           mods: list[str], x: int, y: int, result: str) -> None:
    """Append one considered input event to the trigger's ring (newest first). ``ts`` is an ISO
    timestamp (the caller stamps it so tests stay deterministic); ``event`` is the raw hook action
    (down/up/move); ``result`` is the trigger's disposition — ``"fired"``, ``"deferred"``,
    ``"throttled"``, ``"gated"``, or ``"awaiting_double"``."""
    _ring.record((game, trigger_id), {"ts": ts, "event": event, "button": button,
                                      "mods": list(mods), "x": x, "y": y, "result": result})


def recent(game: str, trigger_id: str) -> list[dict]:
    """The trigger's recently considered input events, newest first."""
    return _ring.recent((game, trigger_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every ``on_input`` trigger's considered events for ``game``, keyed by trigger id — the shape
    the live heartbeat carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, trigger_id: str | None = None) -> None:
    """Drop the log for one trigger, or (``trigger_id=None``) every trigger of ``game``."""
    _ring.clear(game, trigger_id)
