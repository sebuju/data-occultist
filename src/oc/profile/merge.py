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

    # Game-level worthiness gate: like datasets/dictionaries it's game-scoped, so a
    # single-window teach save carries none — upsert by id and preserve existing, never
    # wipe the gate on an unrelated window save. (The graph editor saves the whole
    # profile with merge=false, so deletions there still propagate.)
    detect = {d.id: d for d in existing.detect}
    for d in incoming.detect:
        detect[d.id] = d
    # gate combine-mode: a single-window teach save doesn't carry the game gate, so keep
    # existing unless the incoming edit actually brought gate detectors (the game-node save).
    detect_mode = incoming.detect_mode if incoming.detect else existing.detect_mode

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

    # Layout is also game-level UI data a single-window save doesn't carry — keep the
    # existing layout unless the incoming edit actually brought one (has nodes).
    layout = incoming.layout if incoming.layout.nodes else existing.layout

    return GameProfile(
        name=name,
        process_names=process_names,
        window_title_hint=title,
        detect=list(detect.values()),
        detect_mode=detect_mode,
        fields=list(fields.values()),
        windows=list(windows.values()),
        datasets=list(datasets.values()),
        subsets=list(subsets.values()),
        dictionaries=list(dictionaries.values()),
        producers=list(producers.values()),
        file_sources=list(file_sources.values()),
        triggers=list(triggers.values()),
        layout=layout,
    )
