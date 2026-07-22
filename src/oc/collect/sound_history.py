"""In-memory recent-play history per sound — non-persisted, process-memory only.

The teach UI's sound *play history* satellite node shows the last few times a sound was named in a
fire cue: WHEN, and BY WHOM (the trigger id that fired it) — the only two facts the server actually
knows, since sounds are always CLIENT-played (see :mod:`oc.store.fire_events`, ``sound.js``); the
server only knows the cue was published, not that audio actually sounded. Like the trigger-/readout-
/register-/process-/gate-/router-history rings this is deliberately transient: a ring buffer in
module memory, wiped on restart. The ring mechanics live in the shared
:class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the sound key +
play-record shape.

:meth:`oc.collect.triggers.TriggerRunner._emit_fire` calls :func:`record` once per sound id named in
a fire's resolved ``sound_ids``, right alongside :func:`oc.store.fire_events.publish_fire`; the manual
fire route (:mod:`oc.web.routes.triggers`) does the same. :func:`snapshot` is read by the live
heartbeat and delivered to the client, which paints it into an OPEN satellite (empty / no-op when
hidden).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200)


def record(game: str, sound_id: str, *, ts: str, trigger: str) -> None:
    """Append one sound play to its ring (newest first). ``ts`` is an ISO timestamp (the caller
    stamps it). ``trigger`` is the id of the trigger whose fire named this sound."""
    _ring.record((game, sound_id), {"ts": ts, "trigger": trigger})


def recent(game: str, sound_id: str) -> list[dict]:
    """This sound's recent plays, newest first (empty if nothing played this session)."""
    return _ring.recent((game, sound_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every sound's recent plays for ``game``, keyed by sound id — the shape the live heartbeat
    carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, sound_id: str | None = None) -> None:
    """Drop history for one sound, or (``sound_id=None``) every sound of ``game``."""
    _ring.clear(game, sound_id)
