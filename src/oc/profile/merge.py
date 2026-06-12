"""Merge an incoming profile edit into an existing on-disk profile.

The teaching UI edits one window at a time and sends a single-window profile. To
let a game accumulate *several* windows (equipment, inventory, foundry, ...), a
save must upsert that window into the existing profile rather than replace the
whole file. Windows and fields are merged by id; incoming wins on conflict.
"""

from __future__ import annotations

from .models import GameProfile


def merge_profiles(existing: GameProfile, incoming: GameProfile) -> GameProfile:
    # Scalars: take incoming when meaningfully set, else keep existing.
    name = incoming.name or existing.name
    title = incoming.window_title_hint or existing.window_title_hint
    process_names = incoming.process_names or existing.process_names

    fields = {f.id: f for f in existing.fields}
    for f in incoming.fields:
        fields[f.id] = f  # incoming overrides same-id

    windows = {w.id: w for w in existing.windows}
    for w in incoming.windows:
        windows[w.id] = w  # upsert by id; other windows preserved

    # Datasets/subsets/dictionaries are game-level, not window-scoped, so a single-window
    # save carries none of them — preserving existing is essential (dropping them silently
    # lost standalone dataset defs, subsets and OCR dictionaries on every teach-page save).
    datasets = {d.id: d for d in existing.datasets}
    for d in incoming.datasets:
        datasets[d.id] = d
    subsets = {s.id: s for s in existing.subsets}
    for s in incoming.subsets:
        subsets[s.id] = s
    dictionaries = {d.id: d for d in existing.dictionaries}
    for d in incoming.dictionaries:
        dictionaries[d.id] = d

    return GameProfile(
        name=name,
        process_names=process_names,
        window_title_hint=title,
        fields=list(fields.values()),
        windows=list(windows.values()),
        datasets=list(datasets.values()),
        subsets=list(subsets.values()),
        dictionaries=list(dictionaries.values()),
    )
