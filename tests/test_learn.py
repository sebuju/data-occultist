from oc.learn.dictionary import Dictionary
from oc.learn.difflib_corrector import DifflibCorrector
from oc.learn.resolver import FieldResolver
from oc.profile.models import DictMode, FieldDef, FieldRule, RuleThen, RuleWhen


def _resolver(terms):
    """A resolver over an authored dictionary of ``terms`` (no self-learning)."""
    corr = DifflibCorrector()
    return FieldResolver(corr, accept_confidence=0.85, dictionary=Dictionary(terms, corr))


def _dfield(fuzzy=0.82, mode=DictMode.correct, dict_id=""):
    """A text field whose ONLY rule is a ``dictionary`` correction — dictionary config now
    lives on the rule, not the field (a bare field never consults the dictionary)."""
    return FieldDef(id="name", rules=[FieldRule(then=RuleThen.dictionary, dict_mode=mode,
                                                fuzzy=fuzzy, dict_id=dict_id)])


def test_difflib_best_match():
    c = DifflibCorrector()
    term, score = c.best("Soma Pr1me", ["Soma Prime", "Boltor Prime"])
    assert term == "Soma Prime"
    assert score > 0.8


def test_dictionary_corrects_noisy_read():
    resolver = _resolver(["Soma Prime", "Boltor Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Soma Pr1me", confidence=0.4)  # noisy, unsure
    assert res.value == "Soma Prime"
    assert res.corrected is True


def test_unknown_read_kept_verbatim_under_correct():
    resolver = _resolver(["Soma Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.9), "Zxqv", confidence=0.3)
    assert res.value == "Zxqv"
    assert res.corrected is False


def test_correct_drop_rejects_unknown_even_when_confident():
    resolver = _resolver(["Soma Prime", "Boltor Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.8, mode=DictMode.correct_drop), "Random Tooltip Junk", confidence=0.97)
    assert res.value is None
    assert res.dropped is True


def test_correct_drop_accepts_fuzzy_match():
    resolver = _resolver(["Soma Prime", "Boltor Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.7, mode=DictMode.correct_drop), "Soma Pr1me", confidence=0.97)
    assert res.value == "Soma Prime"
    assert res.corrected is True


def test_correct_drop_rejects_uncertain_no_match():
    resolver = _resolver(["Soma Prime"])
    assert resolver.resolve(_dfield(fuzzy=0.8, mode=DictMode.correct_drop), "Zxqv", confidence=0.3).value is None


def test_set_rule_marks_value_substituted():
    # a ``set`` rule authors the value (config, not OCR) and reports its ``when`` label so
    # the reader knows not to sink the record on OCR confidence
    resolver = _resolver(["Soma Prime"])
    field = FieldDef(id="name", rules=[FieldRule(when=RuleWhen.all_digit, then=RuleThen.set, value="unknown")])
    res = resolver.resolve(field, "1234", confidence=0.99)
    assert res.value == "unknown"
    assert res.substituted == "all_digit"


def test_real_read_is_not_flagged_substituted():
    resolver = FieldResolver(DifflibCorrector(), accept_confidence=0.85)
    res = resolver.resolve(FieldDef(id="name"), "Soma Prime", confidence=0.95)
    assert res.value == "Soma Prime"
    assert res.substituted is None


def test_bare_field_never_consults_dictionary():
    # dictionary config is a rule now: a field with no dictionary rule passes the read through
    resolver = _resolver(["Soma Prime"])
    res = resolver.resolve(FieldDef(id="name"), "Soma Pr1me", confidence=0.4)
    assert res.value == "Soma Pr1me"      # NOT corrected — no dictionary rule
    assert res.corrected is False


def test_correct_drop_without_vocab_rejects_all():
    resolver = FieldResolver(DifflibCorrector(), accept_confidence=0.85)
    field = _dfield(mode=DictMode.correct_drop)   # dictionary rule but no vocabulary
    assert resolver.resolve(field, "Anything", confidence=0.99).value is None


# ---- word-per-word correction ----------------------------------------------

def test_component_name_not_collapsed_into_parent_term():
    # the dictionary knows the weapon but not its component; whole-term fuzzy used
    # to snap "Akbronco Prime Link" onto "Akbronco Prime" and merge the records.
    # word-level: every word is known, so the unknown combination passes untouched
    resolver = _resolver(["Akbronco Prime", "Abating Link"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Akbronco Prime Link", confidence=0.97)
    assert res.value == "Akbronco Prime Link"
    assert res.corrected is False


def test_word_level_fix_inside_unknown_term():
    # OCR noise in one word of a name the dictionary doesn't list as a term
    resolver = _resolver(["Alloy Plate", "Akbronco Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Al1oy Prime", confidence=0.4)
    assert res.value == "Alloy Prime"
    assert res.corrected is True


def test_fused_words_split_back():
    # OCR dropped the space between two KNOWN words
    resolver = _resolver(["Mutalist Alad V Assassinate", "Stalker Sigil"])
    res = resolver.resolve(_dfield(fuzzy=0.8), "AladV Sigil", confidence=0.95)
    assert res.value == "Alad V Sigil"
    assert res.corrected is True


def test_ambiguous_fuse_is_left_alone():
    # "abcd" splits as Ab|Cd AND A|Bcd — ambiguous, so no unmerge is attempted
    resolver = _resolver(["Ab Xy", "Cd Qq", "A Wz", "Bcd Pp"])
    res = resolver.resolve(_dfield(fuzzy=0.95), "abcd", confidence=0.3)
    assert res.value == "abcd"
    assert res.corrected is False


def test_correct_drop_gates_per_word():
    resolver = _resolver(["Alloy Plate", "Akbronco Prime", "Abating Link"])
    field = _dfield(fuzzy=0.7, mode=DictMode.correct_drop)
    # unknown combination of known words: allowed
    assert resolver.resolve(field, "Akbronco Prime Link", confidence=0.97).value == "Akbronco Prime Link"
    # a word matching nothing: the whole read is rejected
    assert resolver.resolve(field, "Zxqv Plate", confidence=0.97).value is None


def test_numeric_tokens_pass_through_word_correction():
    resolver = _resolver(["Akbronco Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Akbr0nco Prime [30]", confidence=0.4)
    assert res.value == "Akbronco Prime [30]"
    assert res.corrected is True


def test_close_code_not_snapped_to_wrong_valid_term():
    # No hardcoded glyph-confusion fold: a correctly-read 'Q3' is NEVER rewritten to a
    # visually-close, in-vocabulary 'G3'. Only pixel-level glyph_check (taught atlas) or
    # a real fuzzy match may change a code — never a baked confusion table.
    resolver = _resolver(["Lith G3"])   # only G3 is vocabulary, not Q3
    field = _dfield(fuzzy=0.82)
    assert resolver.resolve(field, "Lith Q3", confidence=0.9).value == "Lith Q3"
    assert resolver.resolve(field, "Lith Q3", confidence=0.3).value == "Lith Q3"


# ---- dict modes -------------------------------------------------------------

def test_mode_correct_keeps_unmatched_words():
    # correct mode: the dictionary only corrects, it never drops
    resolver = _resolver(["Alloy Plate"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Zxqv Plate", confidence=0.97)
    assert res.value == "Zxqv Plate"


def test_mode_off_ignores_dictionary():
    resolver = _resolver(["Alloy Plate"])
    field = _dfield(fuzzy=0.5, mode=DictMode.off)
    # would fuzzy-correct under "correct"; off must keep the read verbatim
    res = resolver.resolve(field, "Al1oy Plate", confidence=0.3)
    assert res.value == "Al1oy Plate"
    assert res.corrected is False


def test_mode_drop_validates_without_rewriting():
    resolver = _resolver(["Alloy Plate", "Akbronco Prime"])
    field = _dfield(fuzzy=0.5, mode=DictMode.drop)
    # all words known (any combination): kept verbatim, no correction
    res = resolver.resolve(field, "Akbronco Plate", confidence=0.3)
    assert res.value == "Akbronco Plate"
    assert res.corrected is False
    # a noisy word would have fuzzy-corrected under the correcting modes,
    # but drop never rewrites — unknown word, read dropped
    assert resolver.resolve(field, "Al1oy Plate", confidence=0.3).value is None


# ---- verified (how a value was confirmed) ----------------------------------

def test_verified_dict_on_exact_term():
    # a clean read that IS a known term is dictionary-verified, even though nothing changed
    resolver = _resolver(["Soma Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Soma Prime", confidence=0.95)
    assert res.corrected is False and res.verified == "dict"


def test_verified_dict_when_all_words_known():
    # unknown COMBINATION of known words: every word is vocabulary, so still verified
    resolver = _resolver(["Akbronco Prime", "Abating Link"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Akbronco Prime Link", confidence=0.97)
    assert res.value == "Akbronco Prime Link" and res.verified == "dict"


def test_verified_fuzzy_reports_weakest_mechanism():
    # one word snapped by fuzzy, the other exact -> the weakest link (fuzzy) is reported
    resolver = _resolver(["Alloy Plate", "Akbronco Prime"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Al1oy Prime", confidence=0.4)
    assert res.value == "Alloy Prime" and res.verified == "fuzzy"


def test_verified_split_on_unmerge():
    resolver = _resolver(["Mutalist Alad V Assassinate", "Stalker Sigil"])
    res = resolver.resolve(_dfield(fuzzy=0.8), "AladV Sigil", confidence=0.95)
    assert res.value == "Alad V Sigil" and res.verified == "split"


def test_unverified_when_a_word_is_unknown():
    # under 'correct' an unknown word passes through -> the value is NOT confirmed
    resolver = _resolver(["Alloy Plate"])
    res = resolver.resolve(_dfield(fuzzy=0.7), "Zxqv Plate", confidence=0.97)
    assert res.value == "Zxqv Plate" and res.verified is None


def test_verified_none_without_dictionary():
    resolver = FieldResolver(DifflibCorrector(), accept_confidence=0.85)
    res = resolver.resolve(FieldDef(id="name"), "Soma Prime", confidence=0.95)
    assert res.verified is None


def test_verified_dict_under_drop_mode():
    resolver = _resolver(["Alloy Plate", "Akbronco Prime"])
    field = _dfield(fuzzy=0.5, mode=DictMode.drop)
    res = resolver.resolve(field, "Akbronco Plate", confidence=0.3)
    assert res.value == "Akbronco Plate" and res.verified == "dict"
