"""Composite record keys: KeySpec/KeyMap build + profile resolution + migration."""

from oc.profile.loader import _migrate_detect_thresholds, _migrate_keys
from oc.profile.models import Box, GameProfile, ItemDef, KeyDef, RegionDef, WindowDef
from oc.store.keys import KeyMap, KeySpec

CELL = Box(x=0.1, y=0.1, w=0.2, h=0.2)


def test_single_field_default_normalises():
    # trimmed, lowercased, whitespace runs -> single underscores
    ks = KeySpec()
    assert ks.build({"name": "  Soma  Prime "}) == "soma_prime"
    assert ks.build({"name": ""}) is None
    assert ks.build({}) is None


def test_composite_key_joins_in_order():
    ks = KeySpec(("name", "level"))
    assert ks.build({"name": "Arcane Aegis", "level": 5}) == "arcane_aegis|5"
    assert KeySpec(("level", "name"), sep="/").build({"name": "X", "level": 5}) == "5/x"


def test_any_empty_part_means_no_key():
    # an occluded level must never collide with another level's record
    ks = KeySpec(("name", "level"))
    assert ks.build({"name": "Arcane Aegis"}) is None
    assert ks.build({"name": "Arcane Aegis", "level": ""}) is None
    assert ks.build({"name": "", "level": 3}) is None


def test_zero_is_a_valid_part():
    assert KeySpec(("name", "level")).build({"name": "A", "level": 0}) == "a|0"


def test_case_sensitive_preserves_case():
    ks = KeySpec(("name",), case_sensitive=True)
    assert ks.build({"name": "Soma Prime"}) == "Soma_Prime"


def test_meta_changes_with_config():
    assert KeySpec().meta() != KeySpec(("name", "level")).meta()
    assert KeySpec().meta() != KeySpec(sep="/").meta()
    assert KeySpec().meta() != KeySpec(case_sensitive=True).meta()


def test_keymap_routes_by_item_tag():
    km = KeyMap(KeySpec(), {"arcane": KeySpec(("name", "level"))})
    assert km.build({"name": "A", "level": 3}) == "a"                       # untagged -> default
    assert km.build({"name": "A", "level": 3, "_item": "arcane"}) == "a|3"  # template's own key
    assert km.fields_used() == ["name", "level"]


def test_profile_resolves_window_key():
    p = GameProfile(name="g", windows=[
        WindowDef(id="w", dataset="ds", key=KeyDef(fields=["name", "level"]))])
    km = p.key_map_for("ds")
    assert km.build({"name": "X", "level": 3}) == "x|3"
    assert not p.key_conflict("ds")


def test_profile_single_item_key_acts_as_default():
    # a single-template window doesn't tag records, so its item key is the default
    it = ItemDef(id="arc", box=CELL, key=KeyDef(fields=["name", "level"]))
    p = GameProfile(name="g", windows=[WindowDef(id="w", dataset="w", items=[it])])
    assert p.key_map_for("w").build({"name": "A", "level": 1}) == "a|1"


def test_profile_multi_template_routes_by_item():
    arc = ItemDef(id="arcane", box=CELL, key=KeyDef(fields=["name", "level"]))
    # no explicit key -> defaults to the template's FIRST field ("name" here), never imaginary
    plain = ItemDef(id="normal", box=CELL, fields=[RegionDef(id="name", box=CELL, field="name")])
    p = GameProfile(name="g", windows=[WindowDef(id="w", dataset="w", items=[plain, arc])])
    km = p.key_map_for("w")
    assert km.build({"name": "A", "_item": "normal"}) == "a"            # first-field default
    assert km.build({"name": "A", "level": 2, "_item": "arcane"}) == "a|2"


def test_item_without_fields_is_unkeyable():
    # no explicit key and no fields -> empty spec -> records drop (no imaginary "name")
    plain = ItemDef(id="normal", box=CELL)
    p = GameProfile(name="g", windows=[WindowDef(id="w", dataset="w", items=[plain])])
    assert p.key_map_for("w").build({"name": "A", "_item": "normal"}) is None


def test_first_field_is_default_key():
    # a window with regions and no explicit key defaults to its FIRST region's field
    p = GameProfile(name="g", windows=[WindowDef(id="w", dataset="w",
        regions=[RegionDef(id="r1", box=CELL, field="title"),
                 RegionDef(id="r2", box=CELL, field="count")])])
    assert p.key_map_for("w").build({"title": "Soma", "count": 3}) == "soma"


def test_key_conflict_when_window_defaults_disagree():
    p = GameProfile(name="g", windows=[
        WindowDef(id="a", dataset="ds", key=KeyDef(fields=["name"])),
        WindowDef(id="b", dataset="ds", key=KeyDef(fields=["name", "level"]))])
    assert p.key_conflict("ds")
    # first window wins
    assert p.key_map_for("ds").default == KeySpec(("name",))


def test_file_source_key_drives_dataset_keymap():
    # A dataset fed only by a file source must resolve the SAME key the source writes with —
    # else the write key and read key fight and re-key the ledger to NULL on open (regression).
    from oc.profile.models import FileSourceDef, SourceField
    p = GameProfile(name="g", file_sources=[
        FileSourceDef(id="log", dataset="ds", key=KeyDef(fields=["time", "message"]),
                      fields=[SourceField(id="time"), SourceField(id="message")])])
    km = p.key_map_for("ds")
    assert km.fields_used() == ["time", "message"]
    assert km.build({"time": "3.07", "message": "hi"}) == "3.07|hi"


def test_file_source_without_key_falls_back_to_first_field():
    from oc.profile.models import FileSourceDef, SourceField
    p = GameProfile(name="g", file_sources=[
        FileSourceDef(id="log", dataset="ds", fields=[SourceField(id="line"), SourceField(id="extra")])])
    assert p.key_map_for("ds").default == KeySpec(("line",))


def test_migration_synthesizes_window_key_from_old_shapes():
    raw = {
        "name": "g",
        "datasets": [{"id": "loot", "key_field": "item_name", "strip_nonalnum": True}],
        "windows": [
            {"id": "w1", "dataset": "loot"},                            # dataset key -> window key
            {"id": "w2", "scroll": {"rows": 2, "dedup_field": "label"}},  # scroll dedup -> window key
            {"id": "w3", "scroll": {"rows": 2, "dedup_field": "name"}},   # default -> nothing to keep
        ],
    }
    out = _migrate_keys(raw)
    assert out["windows"][0]["key"] == {"fields": ["item_name"], "case_sensitive": False}
    assert out["windows"][1]["key"] == {"fields": ["label"]}
    assert "key" not in out["windows"][2]
    assert out["datasets"][0] == {"id": "loot"}                         # old knobs stripped
    assert "dedup_field" not in out["windows"][1]["scroll"]
    p = GameProfile.model_validate(out)                                  # validates post-migration
    assert p.key_map_for("loot").build({"item_name": "Adra"}) == "adra"


def test_migration_backfills_missing_detect_threshold():
    # threshold is now required; an old profile that predates the UI always writing
    # it must still load (backfilled to the default), not fail validation.
    raw = {
        "name": "g",
        "windows": [{
            "id": "w1",
            "detect": [{"id": "a", "search": CELL.model_dump(), "text": "inv"}],   # no threshold
            "states": [{"id": "s", "detect": [
                {"id": "b", "search": CELL.model_dump(), "text": "name"}]}],         # no threshold
        }],
    }
    out = _migrate_detect_thresholds(raw)
    w = out["windows"][0]
    assert w["detect"][0]["threshold"] == 0.8
    assert w["states"][0]["detect"][0]["threshold"] == 0.8
    GameProfile.model_validate(out)                                          # would raise if unfilled
