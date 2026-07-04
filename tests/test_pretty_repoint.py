"""Token repoint after a graph-node rename (oc.profile.pretty_repoint)."""

from oc.profile.pretty_repoint import repoint_pretty


def _doc(text):
    return {"pages": [{"widgets": [{"config": {"text": text}}]}]}


def _text(doc):
    return doc["pages"][0]["widgets"][0]["config"]["text"]


def test_dataset_head_and_slice_and_field():
    doc = _doc("rows {{dataset:master.name[0:5] | count}} of {{dataset:master}}")
    n = repoint_pretty(doc, [{"kind": "dataset", "old": "master", "new": "inv"}])
    assert n == 2
    assert _text(doc) == "rows {{dataset:inv.name[0:5] | count}} of {{dataset:inv}}"


def test_dataset_head_respects_boundary():
    # `master` must not clobber `master_prime` (different dataset)
    doc = _doc("{{dataset:master_prime}} {{dataset:master}}")
    repoint_pretty(doc, [{"kind": "dataset", "old": "master", "new": "inv"}])
    assert _text(doc) == "{{dataset:master_prime}} {{dataset:inv}}"


def test_subset_head_and_node_path():
    doc = _doc("{{subset:prime}} {{node:subsets[prime].limit}}")
    n = repoint_pretty(doc, [{"kind": "subset", "old": "prime", "new": "sets"}])
    assert n == 2
    assert _text(doc) == "{{subset:sets}} {{node:subsets[sets].limit}}"


def test_node_trigger_producer_window():
    doc = _doc("{{node:triggers[t1].enabled}}|{{node:producers[p1].mode}}|{{node:windows[w1].live}}")
    repoint_pretty(doc, [
        {"kind": "trigger", "old": "t1", "new": "t2"},
        {"kind": "producer", "old": "p1", "new": "p2"},
        {"kind": "window", "old": "w1", "new": "w2"},
    ])
    assert _text(doc) == "{{node:triggers[t2].enabled}}|{{node:producers[p2].mode}}|{{node:windows[w2].live}}"


def test_field_and_item_are_window_scoped():
    doc = _doc("{{node:windows[equip].fields[name].fuzzy}} {{node:windows[arcane].fields[name].fuzzy}}")
    # renaming `name` only in window `equip` must leave `arcane`'s same-named field untouched
    n = repoint_pretty(doc, [{"kind": "field", "old": "name", "new": "title", "win": "equip"}])
    assert n == 1
    assert _text(doc) == "{{node:windows[equip].fields[title].fuzzy}} {{node:windows[arcane].fields[name].fuzzy}}"


def test_window_rename_carries_field_paths_under_it():
    doc = _doc("{{node:windows[w1].fields[name].min}} {{node:windows[w1].items[row].priority}}")
    repoint_pretty(doc, [{"kind": "window", "old": "w1", "new": "w2"}])
    assert _text(doc) == "{{node:windows[w2].fields[name].min}} {{node:windows[w2].items[row].priority}}"


def test_bare_condition_source_is_repointed():
    # conditions rules hold a bare token (no braces) in `source`
    doc = {"pages": [{"widgets": [{"conditions": {"rules": [{"source": "dataset:master.name"}]}}]}]}
    repoint_pretty(doc, [{"kind": "dataset", "old": "master", "new": "inv"}])
    assert doc["pages"][0]["widgets"][0]["conditions"]["rules"][0]["source"] == "dataset:inv.name"


def test_prose_is_not_touched():
    doc = _doc("Master parts list for windows and datasets")
    assert repoint_pretty(doc, [{"kind": "dataset", "old": "master", "new": "inv"}]) == 0


def test_noop_when_same_or_missing():
    doc = _doc("{{dataset:master}}")
    assert repoint_pretty(doc, [{"kind": "dataset", "old": "master", "new": "master"}]) == 0
    assert repoint_pretty(doc, [{"kind": "dataset", "old": "", "new": "x"}]) == 0
    assert _text(doc) == "{{dataset:master}}"
