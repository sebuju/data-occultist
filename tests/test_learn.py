from oc.learn.dictionary import Dictionary
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


def _dict_resolver(tmp_path, terms):
    corr = DifflibCorrector()
    lex = Lexicon(tmp_path / "lex.json")
    return lex, FieldResolver(lex, corr, accept_confidence=0.85,
                              dictionary=Dictionary(terms, corr))


def test_dict_only_rejects_unknown_even_when_confident(tmp_path):
    lex, resolver = _dict_resolver(tmp_path, ["Soma Prime", "Boltor Prime"])
    field = FieldDef(id="name", learn=True, fuzzy=0.8, dict_only=True)

    res = resolver.resolve(field, "Random Tooltip Junk", confidence=0.97)
    assert res.value is None
    assert lex.terms("name") == []      # unmatched read must never be learned


def test_dict_only_accepts_fuzzy_match(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Soma Prime", "Boltor Prime"])
    field = FieldDef(id="name", fuzzy=0.7, dict_only=True)

    res = resolver.resolve(field, "Soma Pr1me", confidence=0.97)  # confident but noisy
    assert res.value == "Soma Prime"
    assert res.corrected is True


def test_dict_only_rejects_uncertain_no_match(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Soma Prime"])
    field = FieldDef(id="name", fuzzy=0.8, dict_only=True)

    assert resolver.resolve(field, "Zxqv", confidence=0.3).value is None


def test_substituted_value_bypasses_dictionary(tmp_path):
    # an if_number fallback is authored config, not a read: it survives dict_only,
    # is flagged substituted, and is never learned
    lex, resolver = _dict_resolver(tmp_path, ["Soma Prime"])
    field = FieldDef(id="name", learn=True, dict_only=True, if_number="unknown")

    res = resolver.resolve(field, "1234", confidence=0.99)
    assert res.value == "unknown"
    assert res.substituted == "if_number"
    assert lex.terms("name") == []


def test_real_read_is_not_flagged_substituted(tmp_path):
    lex = Lexicon(tmp_path / "lex.json")
    resolver = FieldResolver(lex, DifflibCorrector(), accept_confidence=0.85)

    res = resolver.resolve(FieldDef(id="name"), "Soma Prime", confidence=0.95)
    assert res.value == "Soma Prime"
    assert res.substituted is None


def test_dict_only_without_vocab_rejects_all(tmp_path):
    lex = Lexicon(tmp_path / "lex.json")
    resolver = FieldResolver(lex, DifflibCorrector(), accept_confidence=0.85)
    field = FieldDef(id="name", dict_only=True)   # no dictionary, no learning

    assert resolver.resolve(field, "Anything", confidence=0.99).value is None
