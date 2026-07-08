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

    # Window recognition priority is game-level (authored on the game node) — a single-window
    # teach save carries none, so keep existing unless the incoming edit actually brought one.
    window_priority = incoming.window_priority or existing.window_priority

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
    producers = {p.id: p for p in existing.producers}
    for p in incoming.producers:
        producers[p.id] = p
    file_sources = {s.id: s for s in existing.file_sources}
    for s in incoming.file_sources:
        file_sources[s.id] = s
    triggers = {t.id: t for t in existing.triggers}
    for t in incoming.triggers:
        triggers[t.id] = t
    toasts = {x.id: x for x in existing.toasts}
    for x in incoming.toasts:
        toasts[x.id] = x
    sounds = {x.id: x for x in existing.sounds}
    for x in incoming.sounds:
        sounds[x.id] = x
    actions = {x.id: x for x in existing.actions}
    for x in incoming.actions:
        actions[x.id] = x

    # Layout is also game-level UI data a single-window save doesn't carry — keep the
    # existing layout unless the incoming edit actually brought one (has nodes).
    layout = incoming.layout if incoming.layout.nodes else existing.layout

    # Cutout atlas is game-level (no per-entry id to merge on): a single-window teach save
    # carries none, so keep existing unless the incoming edit actually brought one.
    atlas = incoming.atlas if incoming.atlas else existing.atlas

    return GameProfile(
        name=name,
        process_names=process_names,
        window_title_hint=title,
        fields=list(fields.values()),
        windows=list(windows.values()),
        window_priority=window_priority,
        datasets=list(datasets.values()),
        subsets=list(subsets.values()),
        dictionaries=list(dictionaries.values()),
        producers=list(producers.values()),
        file_sources=list(file_sources.values()),
        triggers=list(triggers.values()),
        toasts=list(toasts.values()),
        sounds=list(sounds.values()),
        actions=list(actions.values()),
        atlas=atlas,
        layout=layout,
    )
