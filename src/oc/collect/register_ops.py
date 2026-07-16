"""Register-level data actions an action node can perform on a register source — clear its held
keys, or clone/move their latest values into a dataset. The register analogue of
:mod:`oc.store.dataset_ops`: an action node's ``sources`` can name registers (``"register:<id>"``)
as well as datasets, and this is the funnel both firing paths (the collector dispatch AND the web
"fire now" route) call for the register ones, so an automatic fire and a manual test fire behave
identically.

A register's held map lives only in the running :class:`oc.collect.live.LiveSession` (server
memory). With no live session there is nothing to act on, so every op here is a graceful no-op —
unlike a dataset op, which hits the on-disk store and works offline.

Ops mirror the dataset ones but a register has no batch grouping, so ``clone_batches`` and
``clone_resolved`` behave identically (one resolved write of the latest value per targeted key):

* **clear**        — drop the targeted keys from the held map.
* **clone (any)**  — write ``{name:<readout id>, value:<latest>}`` for each targeted key into
                     ``dest`` (the same row shape the register's ``persist`` flush writes).
* **move (any)**   — clone, then drop the targeted keys.

"Targeted keys" are the action's ``slots[reg_id]`` (a subset of the register's wired-readout keys),
or ALL currently-held keys when unset. Keys that are no longer held are silently skipped.
"""

from __future__ import annotations

from ..store import store_for
from ..store.flow_events import publish_flow

_ACTIONS = frozenset({"clear", "clone_batches", "clone_resolved", "move_batches", "move_resolved"})


def _targeted_keys(session, reg_id: str, slots) -> list[str]:
    """The keys an action operates on for one register: its ``slots`` subset (present-only) or,
    when unset/empty, every key the register currently holds."""
    held = session.register_keys(reg_id)
    if not slots:
        return held
    held_set = set(held)
    return [k for k in slots if k in held_set]


def run_register_action(data_dir, game: str, profile, session, *, action: str, reg_id: str,
                        dest: str = "", slots=None) -> dict:
    """Run one register ``action`` on ``reg_id``'s targeted keys (writing to ``dest`` for
    clone/move). Returns ``{"action", "reg", "dest", "keys"}`` on a real op, or ``{}`` on a no-op /
    guard failure (no session; unknown action; no targeted keys held; clone/move with no ``dest``)."""
    if session is None or action not in _ACTIONS:
        return {}
    keys = _targeted_keys(session, reg_id, slots)
    if not keys:
        return {}

    if action == "clear":
        session.clear_register_keys(reg_id, keys)
        return {"action": action, "reg": reg_id, "dest": "", "keys": keys}

    # clone_* / move_* — a register has no batches, so both collapse to one resolved write.
    if not dest:
        return {}
    rows = [{"name": k, "value": session.register_latest(reg_id, k)} for k in keys]
    store = store_for(data_dir, game, dest, profile=profile)
    store.begin_batch()
    store.record_many(rows)
    if action.startswith("move_"):
        session.clear_register_keys(reg_id, keys)
    return {"action": action, "reg": reg_id, "dest": dest, "keys": keys}


def fire_register_target(game: str, data_dir, profile, session, action, reg_id: str) -> bool:
    """Run ``action``'s register op (clear/clone/move) on ``reg_id`` — the shared funnel both the
    collector dispatch and the web fire-now route call, so automatic and manual fires can't drift
    (the register analogue of :func:`oc.store.dataset_ops.fire_dataset_target`). Runs nothing
    (returns False) when the action has no op set / no live session / nothing to act on. On a real
    op it emits the action->register control pulse and returns True. A misbehaving op must never
    crash the collector loop / a request."""
    if not getattr(action, "action", ""):
        return False
    slots = (getattr(action, "slots", {}) or {}).get(reg_id) or None
    try:
        result = run_register_action(data_dir, game, profile, session, action=action.action,
                                     reg_id=reg_id, dest=action.dest, slots=slots)
    except Exception:   # noqa: BLE001 - a bad op must not break firing
        return False
    if not result:
        return False
    publish_flow(game, "trigger", f"action:{action.id}", f"register:{reg_id}", 1)
    return True
