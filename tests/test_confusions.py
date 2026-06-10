from oc.learn.confusions import ConfusionMap


def test_learn_and_normalize(tmp_path):
    cm = ConfusionMap(tmp_path / "c.json")
    # learn a consistent dropped-space confusion twice (min_count=2)
    cm.learn("35mmFilm", "35mm Film")
    cm.learn("35mmFilm", "35mm Film")
    assert cm.normalize("35mmFilm") == "35mm Film"


def test_below_min_count_not_applied(tmp_path):
    cm = ConfusionMap(tmp_path / "c.json")
    cm.learn("0", "O")                      # seen once
    assert cm.normalize("0") == "0"          # below min_count -> unchanged


def test_persists(tmp_path):
    p = tmp_path / "c.json"
    cm = ConfusionMap(p)
    cm.learn("rn", "m"); cm.learn("rn", "m")
    cm.save()
    assert ConfusionMap(p).normalize("rnax") == "max"


def test_noop_when_identical(tmp_path):
    cm = ConfusionMap(tmp_path / "c.json")
    cm.learn("same", "same")
    assert cm.normalize("same") == "same"
