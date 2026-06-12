"""Stateful dataset storage with an add/update/remove history.

Each dataset keeps a current snapshot (keyed records) plus an append-only change
log, so you can answer "what did I gain or lose, and when". Adds and updates are
recorded live as records are confirmed; removals are a deliberate reconcile step
(a record missing from a *complete* pass), kept separate because a partial or
occluded view must never be mistaken for "everything sold".
"""

from . import inspect
from .change import ChangeEvent, ChangeOp
from .dataset_store import DatasetStore
from .keys import KeyMap, KeySpec

__all__ = ["ChangeEvent", "ChangeOp", "DatasetStore", "KeyMap", "KeySpec", "inspect"]
