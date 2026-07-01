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
from ..store.flow_events import publish_flow
from ..store.keys import KeyMap
from .extract import DISMISSED
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
    # tail = read only the last N lines (streaming/log parsers only; documents always read whole).
    last_lines = (int(getattr(source, "tail_lines", 0) or 0)
                  if bool(getattr(source, "tail", True)) and getattr(parser, "stream", False) else 0)
    # Feed line numbers as position? Only meaningful for a line parser. The line-aware read reports
    # the absolute line where the tail window starts, so each row keeps its TRUE file line number.
    line_position = bool(getattr(source, "line_position", False)) and getattr(parser, "stream", False)
    if line_position:
        text, start_line = reader.read_lined(path, last_lines=last_lines, key=source.id)
        indexed = [(start_line - 1 + i, rec)
                   for i, rec in parser.parse_indexed(text, source.match, source.fields)]
    else:
        text = reader.read(path, last_lines=last_lines, key=source.id)
        indexed = parser.parse_indexed(text, source.match, source.fields)
    # drop rows a REQUIRED field dismissed — they never reach the dataset (the dismissed-rows
    # preview shows them instead). Kept rows carry no marker, so record_many gets clean dicts.
    indexed = [(ln, rec) for ln, rec in indexed if not rec.get(DISMISSED)]
    if not indexed:
        return 0
    # A source can pin its own key; else the dataset/profile default decides. BUT a dataset the
    # user set to no-dedup (accumulate every read) must win over a source's own key — else pinning
    # a key silently re-enables dedup and identical re-reads stop flowing. So consult the dataset
    # key map first and honour its no-dedup; only fall back to the source key when it still dedups.
    key = None
    if getattr(source, "key", None) is not None:
        ds_key = profile.key_map_for(source.dataset) if profile is not None else None
        key = ds_key if (ds_key is not None and ds_key.dedup is False) else KeyMap(source.key.spec())
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
    # Source-aware data hop for the graph blob animation: THIS source fed the dataset, so only
    # its edge lights up. Count rows that actually landed (add/update events), same as the other
    # write sites (collector/preview) — an unchanged re-read moves nothing, so it animates nothing.
    moved = sum(1 for ev in events if ev is not None)
    publish_flow(game, "data", f"src:{source.id}", f"ds:{source.dataset}", moved)
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
