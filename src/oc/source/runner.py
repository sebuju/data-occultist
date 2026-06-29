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
    # Feed line numbers as position? Only meaningful for a line parser. Use the line-aware read so
    # it STAYS tailing (no whole-file re-read+rewrite per call — that timed out on big logs) yet
    # numbers each row by its ABSOLUTE file line.
    line_position = bool(getattr(source, "line_position", False)) and getattr(parser, "stream", False)
    if line_position:
        text, start_line = reader.read_lined(path, tail=tail, key=source.id)
        indexed = [(start_line - 1 + i, rec)
                   for i, rec in parser.parse_indexed(text, source.match, source.fields)]
    else:
        text = reader.read(path, tail=tail, key=source.id)
        indexed = parser.parse_indexed(text, source.match, source.fields)
    if not indexed:
        return 0
    # A source can pin its own key; else the dataset/profile default decides.
    key = KeyMap(source.key.spec()) if getattr(source, "key", None) is not None else None
    store = store_for(data_dir, game, source.dataset, profile=profile, key=key)
    store.begin_batch()
    # ONE bulk write (single txn + single change-bus announce) — a per-row record_seen would fire
    # one fsync commit AND one SSE publish per matched line, starving the web app's event loop on a
    # big log (tens of thousands of lines). record_many returns events aligned 1:1 with the input.
    events = store.record_many([rec for _, rec in indexed])
    if line_position:
        # set_positions wants {key: (xpos, vpos)} — single column (xpos 0) at row = line number.
        positions = {ev.key: (0.0, float(lineno))
                     for (lineno, _), ev in zip(indexed, events)
                     if ev is not None and ev.key}
        if positions:
            store.set_positions(positions)
    return len(indexed)


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
