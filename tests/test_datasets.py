"""Record keys are taught on the item/window that reads them; datasets just store."""

from oc.profile import load_profile
from oc.profile.models import DatasetDef, GameProfile, KeyDef, WindowDef
from oc.store.dataset_store import DatasetStore
from oc.store.keys import KeySpec


def test_key_map_uses_window_key():
    p = GameProfile(name="g", windows=[
        WindowDef(id="w", dataset="loot", key=KeyDef(fields=["item_name"]))])
    assert p.key_map_for("loot").build({"item_name": "Adra"}) == "adra"


def test_key_map_defaults_to_name():
    p = GameProfile(name="g")
    assert p.key_map_for("anything").build({"name": "Adra"}) == "adra"


def test_dataset_def_lookup():
    d = DatasetDef(id="loot")
    p = GameProfile(name="g", datasets=[d])
    assert p.dataset_def("loot") is d
    assert p.dataset_def("missing") is None


def test_sync_mode_for():
    p = GameProfile(name="g", datasets=[
        DatasetDef(id="relics", sync_mode="mirror"),
        DatasetDef(id="mods")])
    assert p.sync_mode_for("relics") == "mirror"
    assert p.sync_mode_for("mods") == "accumulate"      # default
    assert p.sync_mode_for("missing") == "accumulate"   # unknown dataset
    assert DatasetDef(id="x").sync_mode == "accumulate"
    assert DatasetDef(id="x", sync_mode="mirror").model_dump()["sync_mode"] == "mirror"


def test_dataset_def_legacy_key_fields_gone():
    # legacy dataset keying (strip/case) moved to the item/window long ago
    d = DatasetDef(id="loot")
    assert not hasattr(d, "strip_nonalnum")
    assert not hasattr(d, "case_sensitive")


def test_dataset_key_override_and_no_dedup():
    from oc.store import KeySpec
    # default: inherit window/item keys (no override)
    p = GameProfile(name="g", datasets=[DatasetDef(id="loot")])
    assert p.key_map_for("loot").dedup is True
    # dataset-level single-field key override
    p2 = GameProfile(name="g", datasets=[DatasetDef(id="loot", key_field="slug")])
    assert p2.key_map_for("loot").default == KeySpec(fields=("slug",))
    # no-dedup: every read its own record
    p3 = GameProfile(name="g", datasets=[DatasetDef(id="loot", dedup=False)])
    assert p3.key_map_for("loot").dedup is False


def test_batch_mode_per_detection():
    # default = one batch per run
    assert GameProfile(name="g", datasets=[DatasetDef(id="d")]).batch_per_detection("d") is False
    # opt-in = new batch on each fresh window detection (relic offerings)
    p = GameProfile(name="g", datasets=[DatasetDef(id="d", batch_mode="detection")])
    assert p.batch_per_detection("d") is True
    # unknown / missing dataset -> run semantics
    assert p.batch_per_detection("nope") is False


def test_store_no_dedup_keeps_every_read(tmp_path):
    from oc.store import DatasetStore, KeyMap, KeySpec
    s = DatasetStore(tmp_path, "g", "d", key=KeyMap(KeySpec(), {}, dedup=False))
    s.begin_batch()
    s.record_seen({"name": "x", "p": 1})
    s.record_seen({"name": "x", "p": 2})   # same name, but dedup OFF -> own record
    s.record_seen({"name": "x", "p": 1})   # identical read -> still its own record
    assert len(s.records()) == 3
    # reopen: replay reconstructs the same 3 distinct records
    s2 = DatasetStore(tmp_path, "g", "d", key=KeyMap(KeySpec(), {}, dedup=False))
    assert len(s2.records()) == 3


def test_warframe_profile_keys(tmp_path):
    # the example profile keys arcanes on name+level, plain items on name
    import pathlib
    games = pathlib.Path("config/games")
    p = load_profile(games, "warframe")
    km = p.key_map_for("master")   # the equipment window's dataset id
    assert km.build({"name": "Amesha", "_item": "normal"}) == "amesha"
    assert km.build({"name": "Arcane Aegis", "arcane_level": 3, "_item": "arcane"}) == "arcane_aegis|3"


def test_store_dedups_on_supplied_key(tmp_path):
    store = DatasetStore(tmp_path, "g", "loot", key=KeySpec(("item_name",)))
    assert store.record_seen({"item_name": "Adra", "count": 1}) is not None  # add
    assert store.record_seen({"item_name": "Adra", "count": 1}) is None       # identical -> no event
    ev = store.record_seen({"item_name": "Adra", "count": 2})                  # field change -> update
    assert ev is not None and ev.changed == {"count": [1, 2]}
    assert store.present_count == 1   # same key merged, not duplicated


def test_store_separates_levels_with_composite_key(tmp_path):
    # the arcane case: same name, different level = two records with own counts
    store = DatasetStore(tmp_path, "g", "arc", key=KeySpec(("name", "level")))
    store.record_seen({"name": "Arcane Aegis", "level": 5, "count": 1})
    store.record_seen({"name": "Arcane Aegis", "level": 3, "count": 4})
    assert store.present_count == 2
    ev = store.record_seen({"name": "Arcane Aegis", "level": 3, "count": 5})
    assert ev is not None and ev.changed == {"count": [4, 5]}   # updates ITS level only
    assert store.present_count == 2


def test_store_drops_record_missing_a_key_part(tmp_path):
    store = DatasetStore(tmp_path, "g", "arc", key=KeySpec(("name", "level")))
    assert store.record_seen({"name": "Arcane Aegis"}) is None   # level unread -> unkeyable
    assert store.present_count == 0
