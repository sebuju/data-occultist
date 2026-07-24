"""Register-level data actions an action node can perform on a register source — write/clear its
held keys, or clone/move their latest values into a dataset. The register analogue of
:mod:`oc.store.dataset_ops`: an action node's ``sources`` can name registers (``"register:<id>"``)
as well as datasets, and this is the funnel both firing paths (the collector dispatch AND the web
"fire now" route) call for the register ones, so an automatic fire and a manual test fire behave
identically. Unlike a dataset target (one shared ``action``/``dest`` for the whole node), each
register target carries its OWN op in ``ActionDef.reg_ops[reg_id]`` (:class:`~oc.profile.models.RegisterOp`).

A register's held map lives only in the running :class:`oc.collect.live.LiveSession` (server
memory). With no live session there is nothing to act on, so every op here is a graceful no-op —
unlike a dataset op, which hits the on-disk store and works offline.

* **set**          — apply each :class:`~oc.profile.models.RegisterWrite` row: a non-remove row
                     APPENDS its value (blank -> an explicit ``None``) to that key's ring, same as a
                     genuine feed sample; a ``remove`` row drops the key. Runs fully live —
                     :meth:`~oc.collect.live.LiveSession.apply_register_writes` flushes the
                     register's ``persist`` mirror and reaches ``on_register`` triggers/gates in the
                     same call, not on the next collector tick. Ignores ``keys``/slot-narrowing
                     (the rows themselves say which keys) and runs even when nothing is held yet
                     (a `set` can create a key from scratch).
* **remove_all**   — drop every key currently held, ignoring ``keys`` narrowing.
* **clone**        — write each targeted key's latest value into ``dest`` (a PREFIXED ref,
                     ``"dataset:<id>"`` or ``"register:<id>"`` — self-describing, no separate kind
                     field), keeping the register's own held values untouched. A register has no
                     batch grouping (a dataset target's ``clone_batches``/``clone_resolved``
                     distinction doesn't apply here — this always resolves one value per targeted
                     key). ``"dataset:<id>"`` writes ``{name:<readout id>, value:<latest>}`` rows,
                     the same shape the register's ``persist`` flush writes; ``"register:<id>"``
                     applies each key as a live :class:`~oc.profile.models.RegisterWrite` on that
                     register via :meth:`~oc.collect.live.LiveSession.apply_register_writes` — same
                     fully-live funnel ``set`` uses: ring-append, persist flush, ``on_register``
                     re-evaluation, all immediate, not next tick.
* **move**         — clone, then drop the targeted keys from the register.

"Targeted keys" (clone/move only) are the op's ``keys`` subset (a subset of the register's
wired-readout keys), or ALL currently-held keys when unset. Keys that are no longer held are
silently skipped. A ``"register:<reg_id>"`` dest naming ITSELF (cloning/moving into itself) is a
no-op.
"""

from __future__ import annotations

from ..profile.models import RegisterWrite
from ..store import store_for
from ..store.flow_events import publish_flow

_ACTIONS = frozenset({"set", "remove_all", "clone", "move"})


def _targeted_keys(session, reg_id: str, slots) -> list[str]:
    """The keys a clone/move op operates on for one register: its ``keys`` subset (present-only) or,
    when unset/empty, every key the register currently holds. Not used by ``set``/``remove_all``,
    which don't narrow by held keys (a set can create one; remove_all always means everything)."""
    held = session.register_keys(reg_id)
    if not slots:
        return held
    held_set = set(held)
    return [k for k in slots if k in held_set]


def run_register_action(data_dir, game: str, profile, session, *, action: str, reg_id: str,
                        dest: str = "", slots=None, writes=None) -> dict:
    """Run one register ``action`` on ``reg_id`` (writing to ``dest`` for clone/move — a PREFIXED
    ref, ``"dataset:<id>"`` or ``"register:<id>"``; ``writes`` for ``set``). Returns
    ``{"action", "reg", "dest", "keys"}`` on a real op, or ``{}`` on a no-op / guard failure (no
    session; unknown action; nothing touched; clone/move with no ``dest``, a malformed ``dest``, or
    targeting itself)."""
    if session is None or action not in _ACTIONS:
        return {}

    if action == "set":
        keys = session.apply_register_writes(reg_id, writes or [])
        return {"action": action, "reg": reg_id, "dest": "", "keys": keys} if keys else {}

    if action == "remove_all":
        keys = session.register_keys(reg_id)   # ALL currently held — ignores keys narrowing
        if not keys:
            return {}
        session.clear_register_keys(reg_id, keys)
        return {"action": action, "reg": reg_id, "dest": "", "keys": keys}

    # clone / move — a register has no batches, so this always resolves one value per key.
    dest_kind, _, dest_id = (dest or "").partition(":")
    if dest_kind not in ("dataset", "register") or not dest_id:
        return {}
    keys = _targeted_keys(session, reg_id, slots)
    if not keys or (dest_kind == "register" and dest_id == reg_id):
        return {}
    if dest_kind == "register":
        latest_writes = []
        for k in keys:
            v = session.register_latest(reg_id, k)
            latest_writes.append(RegisterWrite(key=k, value="" if v is None else str(v)))
        session.apply_register_writes(dest_id, latest_writes)
    else:
        rows = [{"name": k, "value": session.register_latest(reg_id, k)} for k in keys]
        store = store_for(data_dir, game, dest_id, profile=profile)
        store.begin_batch()
        store.record_many(rows)
    if action == "move":
        session.clear_register_keys(reg_id, keys)
    return {"action": action, "reg": reg_id, "dest": dest, "keys": keys}


def fire_register_target(game: str, data_dir, profile, session, action, reg_id: str) -> bool:
    """Run ``action.reg_ops[reg_id]``'s op (set/remove_all/clone/move) on ``reg_id`` — the shared
    funnel both the collector dispatch and the web fire-now route call, so automatic and manual
    fires can't drift (the register analogue of :func:`oc.store.dataset_ops.fire_dataset_target`).
    Runs nothing (returns False) when this register has no op set / no live session / nothing to
    act on. On a real op it emits the action->register control pulse and returns True. A
    misbehaving op must never crash the collector loop / a request."""
    op = (getattr(action, "reg_ops", {}) or {}).get(reg_id)
    if op is None or not getattr(op, "op", ""):
        return False
    try:
        result = run_register_action(data_dir, game, profile, session, action=op.op, reg_id=reg_id,
                                     dest=op.dest, slots=(op.keys or None), writes=op.writes)
    except Exception:   # noqa: BLE001 - a bad op must not break firing
        return False
    if not result:
        return False
    publish_flow(game, "trigger", f"action:{action.id}", f"register:{reg_id}", 1)
    return True
