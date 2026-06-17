"""The ONE place a dataset's :class:`DatasetStore` is opened.

Every read/write path used to construct a ``DatasetStore`` by hand and re-resolve the record
key + aggregate locally — seven copies that quietly disagreed (a couple omitted the aggregate,
the sweep fell back to a name-only key). That is exactly the drift CLAUDE.md rule 7 exists to
prevent: a dataset MUST key and aggregate identically no matter who opens it, else the same
rows dedup one way on write and another on read.

``store_for`` is that single funnel. Give it the profile and it resolves both from the profile
(``key_map_for`` / ``aggregate_for``); pass ``key``/``aggregate`` explicitly to override (tests,
or a profile-less generic reader). ``profile`` is duck-typed — only its ``key_map_for`` /
``aggregate_for`` are called — so this module stays free of any profile import (no cycle).
"""

from __future__ import annotations

from pathlib import Path

from .dataset_store import DatasetStore


def store_for(data_dir: Path | str, game: str, dataset: str, *, profile=None,
              key=None, aggregate=None, **kw) -> DatasetStore:
    """Open ``dataset``'s store with a key + aggregate resolved ONCE from ``profile``.

    Explicit ``key``/``aggregate`` win over the profile (a caller that already holds a
    conflict-checked KeyMap passes it; a generic reader with no profile passes neither and
    gets the store defaults). Extra kwargs (e.g. ``clock``) pass straight through.
    """
    if key is None and profile is not None:
        key = profile.key_map_for(dataset)
    if aggregate is None and profile is not None:
        aggregate = profile.aggregate_for(dataset)
    if key is not None:
        kw["key"] = key
    if aggregate is not None:
        kw["aggregate"] = aggregate
    return DatasetStore(data_dir, game, dataset, **kw)
