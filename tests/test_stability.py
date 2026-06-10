from oc.collect.reader import Record
from oc.collect.stability import Confirmer


def _rec(name, **extra):
    return Record(values={"name": name, **extra})


def test_requires_confirm_frames():
    c = Confirmer("name", confirm_frames=2)
    assert c.observe([_rec("Soma")]) == []          # first sighting: held
    out = c.observe([_rec("Soma")])                  # second: confirmed
    assert [r.values["name"] for r in out] == ["Soma"]
    assert c.count == 1


def test_flicker_resets_count():
    # A value that changes every frame (e.g. popup over the cell) never confirms.
    c = Confirmer("name", confirm_frames=3)
    assert c.observe([_rec("Soma", count=1)]) == []
    assert c.observe([_rec("Soma", count=9)]) == []  # changed signature -> reset
    assert c.observe([_rec("Soma", count=9)]) == []  # only 2 stable so far
    assert c.observe([_rec("Soma", count=9)]) != []  # now 3 stable -> confirmed


def test_no_double_emit():
    c = Confirmer("name", confirm_frames=1)
    assert c.observe([_rec("Soma")]) != []
    assert c.observe([_rec("Soma")]) == []           # already confirmed, not re-emitted


def test_missing_key_ignored():
    c = Confirmer("name", confirm_frames=1)
    assert c.observe([Record(values={"count": 3})]) == []
