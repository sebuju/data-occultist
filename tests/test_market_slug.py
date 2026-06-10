from oc.enrich.warframe_market import slugify


def test_slugify_basic():
    assert slugify("Soma Prime") == "soma_prime"


def test_slugify_punctuation_and_amp():
    assert slugify("Vauban & Helminth!") == "vauban_and_helminth"


def test_slugify_collapses_separators():
    assert slugify("  Mag   Prime  ") == "mag_prime"
