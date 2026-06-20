"""Pretty Studio backend: transient overrides, the design sidecar, and manual record write."""

from oc.profile.models import GameProfile
from oc.profile.pretty import load_pretty, save_pretty
from oc.runtime import overrides as ov


def _profile():
    return GameProfile.model_validate({
        "name": "g",
        "windows": [{"id": "equipment", "dataset": "inv",
                     "fields": [{"id": "name", "min_confidence": 0.5}]}],
        "producers": [{"id": "p1", "dataset": "prices", "throttle": 0.4, "enabled": True}],
        "triggers": [{"id": "t1", "kind": "interval", "interval_s": 300}],
        "subsets": [{"id": "v1", "datasets": ["inv"], "limit": 0}],
    })


def test_apply_override_resolves_paths_and_coerces_types():
    ov.clear_override("g")
    ov.set_override("g", "triggers[t1].interval_s", "60")            # string -> float
    ov.set_override("g", "producers[p1].enabled", "false")          # string -> bool
    ov.set_override("g", "producers[p1].throttle", 1.5)
    ov.set_override("g", "windows[equipment].fields[name].min_confidence", 0.9)
    ov.set_override("g", "subsets[v1].limit", 25)
    p = _profile()
    ov.apply_overrides(p, "g")
    assert p.triggers[0].interval_s == 60.0
    assert p.producers[0].enabled is False
    assert p.producers[0].throttle == 1.5
    assert p.windows[0].fields[0].min_confidence == 0.9
    assert p.subsets[0].limit == 25
    ov.clear_override("g")


def test_stale_override_path_is_skipped_not_raised():
    ov.clear_override("g")
    ov.set_override("g", "triggers[GONE].interval_s", 99)       # no such trigger
    ov.set_override("g", "producers[p1].nope", 1)              # no such attribute
    p = _profile()
    ov.apply_overrides(p, "g")   # must not raise
    assert p.triggers[0].interval_s == 300.0
    ov.clear_override("g")


def test_clear_override_one_and_all():
    ov.clear_override("g")
    ov.set_override("g", "triggers[t1].interval_s", 60)
    ov.set_override("g", "producers[p1].throttle", 2)
    ov.clear_override("g", "triggers[t1].interval_s")
    assert "triggers[t1].interval_s" not in ov.get_overrides("g")
    assert "producers[p1].throttle" in ov.get_overrides("g")
    ov.clear_override("g")
    assert ov.get_overrides("g") == {}


def test_pretty_doc_round_trip(tmp_path):
    doc = {"version": 1, "theme": {"color": "#fff"},
           "pages": [{"id": "main", "title": "Main", "style": {"bg": "#111"},
                      "widgets": [{"id": "w1", "type": "label", "x": 10, "y": 20,
                                   "config": {"text": "hi {{dataset:inv}}"}, "style": {"bold": True}}]}]}
    save_pretty(tmp_path, "g", doc)
    back = load_pretty(tmp_path, "g")
    assert back["theme"]["color"] == "#fff"
    assert back["pages"][0]["widgets"][0]["config"]["text"] == "hi {{dataset:inv}}"
    assert back["pages"][0]["widgets"][0]["style"]["bold"] is True


def test_pretty_doc_default_when_missing(tmp_path):
    back = load_pretty(tmp_path, "absent")
    assert back["pages"] and back["pages"][0]["widgets"] == []
