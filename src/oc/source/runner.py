"""Run a file-source: locate -> parse -> write rows to its dataset.

:func:`read_source` is the SINGLE funnel every read path uses — the manual route, the watcher
daemon, and a trigger that targets a source — so per-read behaviour can't drift between callers
(mirrors :func:`oc.collect.triggers.fire_target`). Writing through :func:`oc.store.store_for`
publishes the dataset change bus, so an on_change trigger watching the source's dataset, and the
UI's live push, both light up for free.
"""

from __future__ import annotations

import os

from ..registry import build_parser
from ..store import store_for
from ..store.keys import KeyMap
from .locate import resolve_path
from .reader import default_reader


def read_source(game: str, source, data_dir, *, profile=None, reader=None) -> int:
    """Read ``source`` once and write its parsed rows to ``source.dataset``. Returns the number
    of rows parsed (0 when disabled, the file is missing, or nothing matched)."""
    if source is None or not getattr(source, "enabled", True) or not source.dataset:
        return 0
    path = resolve_path(source)
    if not path or not os.path.exists(path):
        return 0
    reader = reader or default_reader()
    parser = build_parser(source.format)
    # tail only for streaming (log) parsers; documents always re-read whole.
    tail = bool(getattr(source, "tail", True)) and getattr(parser, "stream", False)
    text = reader.read(path, tail=tail, key=source.id)
    records = parser.parse(text, source.match, source.fields)
    if not records:
        return 0
    # A source can pin its own key; else the dataset/profile default decides.
    key = KeyMap(source.key.spec()) if getattr(source, "key", None) is not None else None
    store = store_for(data_dir, game, source.dataset, profile=profile, key=key)
    store.begin_batch()
    for rec in records:
        store.record_seen(rec)
    return len(records)


class SourceRunner:
    """Holds a profile + data dir so callers can read sources by object or id. Thin wrapper
    over :func:`read_source` (the funnel); kept symmetric with :class:`TriggerRunner`."""

    def __init__(self, profile, data_dir, *, reader=None) -> None:
        self._profile = profile
        self._data_dir = data_dir
        self._reader = reader or default_reader()

    def read(self, source) -> int:
        return read_source(self._profile.name, source, self._data_dir,
                           profile=self._profile, reader=self._reader)

    def read_id(self, source_id: str) -> int:
        src = self._profile.file_source(source_id)
        return self.read(src) if src is not None else 0
