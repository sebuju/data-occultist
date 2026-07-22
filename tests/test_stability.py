from oc.collect.reader import Record
from oc.collect.stability import Confirmer, PruneGate
from oc.store.keys import KeySpec


def _rec(name, **extra):
    return Record(values={"name": name, **extra})


def _confirmer(frames, spec=KeySpec()):
    return Confirmer(spec.build, confirm_frames=frames)


def test_requires_confirm_frames():
    c = _confirmer(2)
    assert c.observe([_rec("Soma")]) == []          # first sighting: held
    out = c.observe([_rec("Soma")])                  # second: confirmed
    assert [r.values["name"] for r in out] == ["Soma"]
    assert c.count == 1


def test_flicker_resets_count():
    # A value that changes every frame (e.g. popup over the cell) never confirms.
    c = _confirmer(3)
    assert c.observe([_rec("Soma", count=1)]) == []
    assert c.observe([_rec("Soma", count=9)]) == []  # changed signature -> reset
    assert c.observe([_rec("Soma", count=9)]) == []  # only 2 stable so far
    assert c.observe([_rec("Soma", count=9)]) != []  # now 3 stable -> confirmed


def test_no_double_emit():
    c = _confirmer(1)
    assert c.observe([_rec("Soma")]) != []
    assert c.observe([_rec("Soma")]) == []           # already confirmed, not re-emitted


def test_missing_key_ignored():
    c = _confirmer(1)
    assert c.observe([Record(values={"count": 3})]) == []


def test_composite_key_confirms_levels_independently():
    # arcanes: same name, different level = different records, each confirmed alone
    c = _confirmer(1, KeySpec(("name", "level")))
    out = c.observe([_rec("Arcane Aegis", level=5), _rec("Arcane Aegis", level=3)])
    assert len(out) == 2 and c.count == 2
    # a read with the level occluded has no key -> held, never merged into either
    assert c.observe([_rec("Arcane Aegis")]) == []


# ---- PruneGate ---------------------------------------------------------------

def test_prune_gate_fires_at_confirm_frames():
    g = PruneGate(2)
    assert g.observe({"axi_a15"}) == set()          # 1st tick: held
    assert g.observe({"axi_a15"}) == {"axi_a15"}     # 2nd consecutive tick: fires


def test_prune_gate_resets_when_signal_stops():
    # A key that stops signalling (still owned again, or scrolled out of view) loses its
    # progress -- it must re-accumulate confirm_frames from scratch, not resume where it left off.
    g = PruneGate(2)
    assert g.observe({"axi_a15"}) == set()
    assert g.observe(set()) == set()                # signal gone -> re-armed
    assert g.observe({"axi_a15"}) == set()           # back to 1st tick, not 2nd
    assert g.observe({"axi_a15"}) == {"axi_a15"}


def test_prune_gate_refires_after_reset():
    # Unlike Confirmer (one-shot forever), the same key can prune again after being re-added
    # and depleted a second time.
    g = PruneGate(1)
    assert g.observe({"axi_a15"}) == {"axi_a15"}
    assert g.observe(set()) == set()                # re-owned: signal stops, re-arms
    assert g.observe({"axi_a15"}) == {"axi_a15"}     # depleted again: fires again


def test_prune_gate_tracks_keys_independently():
    g = PruneGate(2)
    assert g.observe({"axi_a15", "axi_a16"}) == set()
    assert g.observe({"axi_a15"}) == {"axi_a15"}     # axi_a16's signal stopped -> only a15 fires
