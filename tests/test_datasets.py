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


def test_dataset_def_carries_no_key():
    # datasets only receive/store rows; the key moved to the item/window
    d = DatasetDef(id="loot")
    assert not hasattr(d, "key_field")
    assert not hasattr(d, "strip_nonalnum")
    assert not hasattr(d, "case_sensitive")


def test_warframe_profile_keys(tmp_path):
    # the example profile keys arcanes on name+level, plain items on name
    import pathlib
    games = pathlib.Path("config/games")
    p = load_profile(games, "warframe")
    km = p.key_map_for("equip")
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
