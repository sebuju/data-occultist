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


def test_merge_preserves_triggers_and_price_sources():
    existing = GameProfile(
        name="g", windows=[],
        producers=[{"id": "live", "dataset": "prices", "mode": "orders", "sources": ["master"]}],
        triggers=[{"id": "t", "kind": "on_change", "watch": ["relic_rewards"], "targets": ["live"]}],
    )
    incoming = GameProfile(name="g", windows=[_WIN])   # single-window save carries no game-level defs
    m = merge_profiles(existing, incoming)
    assert m.producers[0].sources == ["master"]
    assert [t.id for t in m.triggers] == ["t"]
    assert m.triggers[0].watch == ["relic_rewards"] and m.triggers[0].targets == ["live"]


def test_merge_preserves_atlas():
    # the cutout atlas is game-level (no per-entry id to upsert on) -- a single-window save
    # carries none, so it must survive untouched.
    existing = GameProfile(
        name="g", windows=[],
        atlas=[{"label": "H", "image": "cutout-1.png", "kind": "glyph"}],
    )
    incoming = GameProfile(name="g", windows=[_WIN])
    m = merge_profiles(existing, incoming)
    assert [c.label for c in m.atlas] == ["H"]


def test_legacy_glyphs_key_migrates_into_atlas():
    # older profiles keyed the atlas as `glyphs: [{char,image,enabled}]`; loading one must
    # fold it into the unified `atlas` list as kind=glyph, no ``glyphs`` attribute surviving.
    profile = GameProfile.model_validate({
        "name": "g", "windows": [],
        "glyphs": [{"char": "Q", "image": "glyph-1.png", "enabled": True}],
    })
    assert len(profile.atlas) == 1
    assert profile.atlas[0].label == "Q"
    assert profile.atlas[0].image == "glyph-1.png"
    assert profile.atlas[0].kind == "glyph"
    assert not hasattr(profile, "glyphs")
