from oc.learn.dictionary import Dictionary
from oc.learn.difflib_corrector import DifflibCorrector
from oc.learn.lexicon import Lexicon
from oc.learn.resolver import FieldResolver
from oc.profile.models import DictMode, FieldDef


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


def test_correct_drop_rejects_unknown_even_when_confident(tmp_path):
    lex, resolver = _dict_resolver(tmp_path, ["Soma Prime", "Boltor Prime"])
    field = FieldDef(id="name", learn=True, fuzzy=0.8, dict_mode=DictMode.correct_drop)

    res = resolver.resolve(field, "Random Tooltip Junk", confidence=0.97)
    assert res.value is None
    assert lex.terms("name") == []      # unmatched read must never be learned


def test_correct_drop_accepts_fuzzy_match(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Soma Prime", "Boltor Prime"])
    field = FieldDef(id="name", fuzzy=0.7, dict_mode=DictMode.correct_drop)

    res = resolver.resolve(field, "Soma Pr1me", confidence=0.97)  # confident but noisy
    assert res.value == "Soma Prime"
    assert res.corrected is True


def test_correct_drop_rejects_uncertain_no_match(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Soma Prime"])
    field = FieldDef(id="name", fuzzy=0.8, dict_mode=DictMode.correct_drop)

    assert resolver.resolve(field, "Zxqv", confidence=0.3).value is None


def test_substituted_value_bypasses_dictionary(tmp_path):
    # an if_number fallback is authored config, not a read: it survives the drop modes,
    # is flagged substituted, and is never learned
    lex, resolver = _dict_resolver(tmp_path, ["Soma Prime"])
    field = FieldDef(id="name", learn=True, dict_mode=DictMode.correct_drop, if_number="unknown")

    res = resolver.resolve(field, "1234", confidence=0.99)
    assert res.value == "unknown"
    assert res.substituted == "all_digit"
    assert lex.terms("name") == []


def test_real_read_is_not_flagged_substituted(tmp_path):
    lex = Lexicon(tmp_path / "lex.json")
    resolver = FieldResolver(lex, DifflibCorrector(), accept_confidence=0.85)

    res = resolver.resolve(FieldDef(id="name"), "Soma Prime", confidence=0.95)
    assert res.value == "Soma Prime"
    assert res.substituted is None


def test_correct_drop_without_vocab_rejects_all(tmp_path):
    lex = Lexicon(tmp_path / "lex.json")
    resolver = FieldResolver(lex, DifflibCorrector(), accept_confidence=0.85)
    field = FieldDef(id="name", dict_mode=DictMode.correct_drop)   # no dictionary, no learning

    assert resolver.resolve(field, "Anything", confidence=0.99).value is None


# ---- word-per-word correction ----------------------------------------------

def test_component_name_not_collapsed_into_parent_term(tmp_path):
    # the dictionary knows the weapon but not its component; whole-term fuzzy used
    # to snap "Akbronco Prime Link" onto "Akbronco Prime" and merge the records.
    # word-level: every word is known, so the unknown combination passes untouched
    _, resolver = _dict_resolver(tmp_path, ["Akbronco Prime", "Abating Link"])
    field = FieldDef(id="name", fuzzy=0.7)

    res = resolver.resolve(field, "Akbronco Prime Link", confidence=0.97)
    assert res.value == "Akbronco Prime Link"
    assert res.corrected is False


def test_word_level_fix_inside_unknown_term(tmp_path):
    # OCR noise in one word of a name the dictionary doesn't list as a term
    _, resolver = _dict_resolver(tmp_path, ["Alloy Plate", "Akbronco Prime"])
    field = FieldDef(id="name", fuzzy=0.7)

    res = resolver.resolve(field, "Al1oy Prime", confidence=0.4)
    assert res.value == "Alloy Prime"
    assert res.corrected is True


def test_fused_words_split_back(tmp_path):
    # OCR dropped the space between two KNOWN words
    _, resolver = _dict_resolver(tmp_path, ["Mutalist Alad V Assassinate", "Stalker Sigil"])
    field = FieldDef(id="name", fuzzy=0.8)

    res = resolver.resolve(field, "AladV Sigil", confidence=0.95)
    assert res.value == "Alad V Sigil"
    assert res.corrected is True


def test_ambiguous_fuse_is_left_alone(tmp_path):
    # "abcd" splits as Ab|Cd AND A|Bcd — ambiguous, so no unmerge is attempted
    _, resolver = _dict_resolver(tmp_path, ["Ab Xy", "Cd Qq", "A Wz", "Bcd Pp"])
    field = FieldDef(id="name", fuzzy=0.95)

    res = resolver.resolve(field, "abcd", confidence=0.3)
    assert res.value == "abcd"
    assert res.corrected is False


def test_correct_drop_gates_per_word(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Alloy Plate", "Akbronco Prime", "Abating Link"])
    field = FieldDef(id="name", fuzzy=0.7, dict_mode=DictMode.correct_drop)

    # unknown combination of known words: allowed
    assert resolver.resolve(field, "Akbronco Prime Link", confidence=0.97).value == "Akbronco Prime Link"
    # a word matching nothing: the whole read is rejected
    assert resolver.resolve(field, "Zxqv Plate", confidence=0.97).value is None


def test_numeric_tokens_pass_through_word_correction(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Akbronco Prime"])
    field = FieldDef(id="name", fuzzy=0.7)

    res = resolver.resolve(field, "Akbr0nco Prime [30]", confidence=0.4)
    assert res.value == "Akbronco Prime [30]"
    assert res.corrected is True


def test_glyph_confused_code_snaps_to_known(tmp_path):
    # relic refinement codes are short alnum tokens where a g<->9 / l<->1 flip
    # halves the fuzzy ratio (too low to snap) and the confusion map has never seen
    # it. glyph-folding matches digit-bearing words visually.
    _, resolver = _dict_resolver(tmp_path, ["Meso A9", "Neo V11", "Axi G1"])
    field = FieldDef(id="name", fuzzy=0.9)

    assert resolver.resolve(field, "Meso AG", confidence=0.5).value == "Meso A9"
    assert resolver.resolve(field, "neo vll", confidence=0.5).value == "Neo V11"
    res = resolver.resolve(field, "Axi Gl", confidence=0.5)
    assert res.value == "Axi G1" and res.corrected is True


def test_glyph_fold_ambiguous_is_left_alone(tmp_path):
    # two known codes fold the same ('B2' and '82' -> '82'): ambiguous, no snap
    _, resolver = _dict_resolver(tmp_path, ["Meso B2", "Meso 82"])
    field = FieldDef(id="name", fuzzy=0.95)

    res = resolver.resolve(field, "Meso BZ", confidence=0.3)   # 'BZ' folds to '82'
    assert res.value == "Meso BZ" and res.corrected is False


# ---- dict modes -------------------------------------------------------------

def test_mode_correct_keeps_unmatched_words(tmp_path):
    # default mode: the dictionary only corrects, it never drops
    _, resolver = _dict_resolver(tmp_path, ["Alloy Plate"])
    field = FieldDef(id="name", fuzzy=0.7)          # dict_mode defaults to correct

    res = resolver.resolve(field, "Zxqv Plate", confidence=0.97)
    assert res.value == "Zxqv Plate"


def test_mode_off_ignores_dictionary(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Alloy Plate"])
    field = FieldDef(id="name", fuzzy=0.5, dict_mode=DictMode.off)

    # would fuzzy-correct under "correct"; off must keep the read verbatim
    res = resolver.resolve(field, "Al1oy Plate", confidence=0.3)
    assert res.value == "Al1oy Plate"
    assert res.corrected is False


def test_mode_drop_validates_without_rewriting(tmp_path):
    _, resolver = _dict_resolver(tmp_path, ["Alloy Plate", "Akbronco Prime"])
    field = FieldDef(id="name", fuzzy=0.5, dict_mode=DictMode.drop)

    # all words known (any combination): kept verbatim, no correction
    res = resolver.resolve(field, "Akbronco Plate", confidence=0.3)
    assert res.value == "Akbronco Plate"
    assert res.corrected is False
    # a noisy word would have fuzzy-corrected under the correcting modes,
    # but drop never rewrites — unknown word, read dropped
    assert resolver.resolve(field, "Al1oy Plate", confidence=0.3).value is None


def test_legacy_dict_only_migrates():
    assert FieldDef(id="n", dict_only=True).dict_mode is DictMode.correct_drop
    assert FieldDef(id="n", dict_only=False).dict_mode is DictMode.correct
    assert FieldDef(id="n").dict_mode is DictMode.correct
