from oc.learn.difflib_corrector import DifflibCorrector
from oc.learn.lexicon import Lexicon
from oc.learn.resolver import FieldResolver
from oc.profile.models import FieldDef


def test_lexicon_learn_and_persist(tmp_path):
    path = tmp_path / "lex.json"
    lex = Lexicon(path)
    lex.learn("name", "Soma Prime")
    lex.learn("name", "Soma Prime")
    lex.save()

    reloaded = Lexicon(path)
    assert "Soma Prime" in reloaded.terms("name")
    assert reloaded.frequency("name", "Soma Prime") == 2


def test_difflib_best_match():
    c = DifflibCorrector()
    term, score = c.best("Soma Pr1me", ["Soma Prime", "Boltor Prime"])
    assert term == "Soma Prime"
    assert score > 0.8


def test_resolver_learns_on_high_confidence(tmp_path):
    lex = Lexicon(tmp_path / "lex.json")
    resolver = FieldResolver(lex, DifflibCorrector(), accept_confidence=0.85)
    field = FieldDef(id="name", learn=True, fuzzy=0.8)

    res = resolver.resolve(field, "Soma Prime", confidence=0.95)
    assert res.value == "Soma Prime"
    assert res.learned is True
    assert "Soma Prime" in lex.terms("name")


def test_resolver_corrects_on_low_confidence(tmp_path):
    lex = Lexicon(tmp_path / "lex.json")
    lex.learn("name", "Soma Prime")
    resolver = FieldResolver(lex, DifflibCorrector(), accept_confidence=0.85)
    field = FieldDef(id="name", learn=True, fuzzy=0.7)

    res = resolver.resolve(field, "Soma Pr1me", confidence=0.4)  # noisy, unsure
    assert res.value == "Soma Prime"
    assert res.corrected is True
    assert res.learned is False


def test_resolver_keeps_unknown_when_no_match(tmp_path):
    lex = Lexicon(tmp_path / "lex.json")
    resolver = FieldResolver(lex, DifflibCorrector(), accept_confidence=0.85)
    field = FieldDef(id="name", learn=True, fuzzy=0.9)

    res = resolver.resolve(field, "Zxqv", confidence=0.3)
    assert res.value == "Zxqv"
    assert res.corrected is False
    assert lex.terms("name") == []  # did not pollute the dictionary
