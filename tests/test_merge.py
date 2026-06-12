"""Merging a single-window teach-page save into the on-disk profile must preserve the
game-level defs (datasets, subsets, dictionaries) it doesn't carry."""

from oc.profile.merge import merge_profiles
from oc.profile.models import GameProfile

_WIN = {"id": "equip", "detect": [], "states": [], "regions": []}


def test_merge_preserves_game_level_defs():
    existing = GameProfile(
        name="g", windows=[],
        datasets=[{"id": "mods"}],
        subsets=[{"id": "v", "dataset": "mods"}],
        dictionaries=[{"id": "d"}],
    )
    incoming = GameProfile(name="g", windows=[_WIN])   # one window, no game-level defs
    m = merge_profiles(existing, incoming)
    assert [d.id for d in m.datasets] == ["mods"]
    assert [s.id for s in m.subsets] == ["v"]
    assert [d.id for d in m.dictionaries] == ["d"]
    assert [w.id for w in m.windows] == ["equip"]


def test_merge_upserts_defs_by_id():
    existing = GameProfile(name="g", windows=[], datasets=[{"id": "mods"}])
    incoming = GameProfile(name="g", windows=[], datasets=[{"id": "arsenal"}])
    m = merge_profiles(existing, incoming)
    assert {d.id for d in m.datasets} == {"mods", "arsenal"}
