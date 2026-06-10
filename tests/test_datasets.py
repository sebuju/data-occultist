"""Datasets own their dedup key (not the window)."""

from oc.profile import load_profile
from oc.profile.models import DatasetDef, GameProfile, WindowDef
from oc.store.dataset_store import DatasetStore


def test_key_for_uses_dataset_def():
    p = GameProfile(name="g", datasets=[DatasetDef(id="loot", key_field="item_name")])
    assert p.key_for("loot") == "item_name"


def test_key_for_defaults_to_name_without_def():
    p = GameProfile(name="g")
    assert p.key_for("anything") == "name"


def test_dataset_def_lookup():
    d = DatasetDef(id="loot", key_field="x")
    p = GameProfile(name="g", datasets=[d])
    assert p.dataset_def("loot") is d
    assert p.dataset_def("missing") is None


def test_window_has_no_key_field_attr():
    # the key moved to the dataset; the window must not carry it anymore
    w = WindowDef(id="w")
    assert not hasattr(w, "key_field")
    assert not hasattr(w, "dedup_field")


def test_warframe_profile_dataset_key(tmp_path):
    # the migrated profile keys its 'equip' dataset on item_name
    import pathlib
    games = pathlib.Path("config/games")
    p = load_profile(games, "warframe")
    assert p.key_for("equip") == "item_name"


def test_store_dedups_on_supplied_key(tmp_path):
    store = DatasetStore(tmp_path, "g", "loot", key_field="item_name")
    assert store.record_seen({"item_name": "Adra", "count": 1}) is not None  # add
    assert store.record_seen({"item_name": "Adra", "count": 1}) is None       # identical -> no event
    ev = store.record_seen({"item_name": "Adra", "count": 2})                  # field change -> update
    assert ev is not None and ev.changed == {"count": [1, 2]}
    assert store.present_count == 1   # same key merged, not duplicated
