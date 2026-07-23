"""Resolve a raw OCR read into a final field value by running the field's rule pipeline.

The pipeline itself lives in :mod:`oc.collect.fields`; this module supplies the one thing
that pipeline can't do on its own — the ``dictionary`` action, which needs a corrector and
the game's authored vocabulary. :meth:`FieldResolver.apply_dictionary` is handed to
``run_rules`` as its ``dict_hook`` so a ``dictionary`` rule, wherever it sits in the field's
rule order, corrects/validates the running value against the dictionary the rule names.

A ``dictionary`` rule's ``dict_mode`` picks how the vocabulary participates: ``off`` (not
consulted), ``correct`` (fix words, keep unmatched), ``drop`` (validate only, an unmatched
word -> the record is dropped), ``correct_drop`` (fix words, an unmatchable word -> dropped).
The vocabulary is the AUTHORED dictionary only — there is no self-learning, so a correction
is always traceable to a term someone taught. Word-per-word correction (not whole-term
fuzzy) keeps distinct records from collapsing into a shared parent term.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..collect.fields import DictOutcome, run_rules
from ..interfaces import Corrector
from ..profile.models import DictMode, FieldDef, FieldRule
from .dictionary import _norm


@dataclass
class ResolvedField:
    value: object
    corrected: bool = False   # one or more words snapped to the vocabulary
    score: float = 1.0        # worst word-correction similarity (1.0 when not corrected)
    dropped: bool = False      # a ``drop`` action (or a drop-mode dictionary) fired -> drop the cell
    prune: bool = False        # a ``prune`` action fired -> caller actively removes the record's key
    # which rule authored the value (a ``set`` rule's ``when`` label), None for a value
    # derived from the genuine read — substituted values are config, not OCR confidence
    substituted: str | None = None
    # HOW the value was confirmed against the authored dictionary — set only when EVERY
    # letter-bearing word is accounted for. "dict" (exact vocabulary), "split" (an unmerge),
    # "fuzzy" (a similarity snap); the reader may upgrade it to "glyph" (pixel glyph_check).
    # None = not validated (no dictionary rule / unknown word). The UI marks a verified read.
    verified: str | None = None


# weakest (least certain) mechanism wins when a term mixes them, so the badge is honest
# about the shakiest word: a fuzzy guess is less certain than an exact vocabulary hit.
_VERIFY_RANK = {"fuzzy": 0, "split": 1, "dict": 2}


def _unmerge(wmap: dict[str, str], key: str) -> str | None:
    """A read that fused two KNOWN words ('aladv') splits back ('Alad V') — accepted
    only when the split is unambiguous (exactly one way both halves are vocabulary)."""
    hits = [(wmap[key[:i]], wmap[key[i:]]) for i in range(1, len(key))
            if key[:i] in wmap and key[i:] in wmap]
    if len(hits) == 1:
        return f"{hits[0][0]} {hits[0][1]}"
    return None


class FieldResolver:
    def __init__(self, corrector: Corrector, accept_confidence: float = 0.88,
                 dictionary=None, dictionaries=None):
        self._corrector = corrector
        self._accept = accept_confidence
        self._dict = dictionary          # pooled Dictionary, used when a rule pins none
        self._dict_map = dictionaries or {}   # id -> Dictionary, a rule pins one via FieldRule.dict_id
        # cache the word vocabulary per Dictionary object (rules may use different
        # ones), keyed by object id since each dictionary is fixed.
        self._dict_words: dict[int, tuple[dict[str, str], list[str]]] = {}

    def _dict_for(self, dict_id: str):
        """The Dictionary a ``dictionary`` rule reads against: its pinned one
        (``FieldRule.dict_id``) when set and known, else the pooled default."""
        if dict_id and dict_id in self._dict_map:
            return self._dict_map[dict_id]
        return self._dict

    def _words(self, dict_id: str, mode: DictMode) -> tuple[dict[str, str], list[str]]:
        """The rule's word vocabulary: ``norm -> canonical`` plus a lowercase list for
        fuzzy matching — the authored dictionary's words, or empty when the mode is off.
        Cached."""
        d = self._dict_for(dict_id)
        if not (d and mode is not DictMode.off):
            return {}, []
        cached = self._dict_words.get(id(d))
        if cached is None:
            dmap = d.word_map
            cached = (dmap, [w.lower() for w in dmap.values()])
            self._dict_words[id(d)] = cached
        return cached

    def _correct_words(self, rule: FieldRule, text: str, confidence: float):
        """Correct ``text`` one word at a time against the rule's vocabulary. Returns
        ``(result, changed, worst_score, any_unknown, verified)`` — ``any_unknown`` is True
        when a letter-bearing word matched nothing (the drop modes' gate); ``verified`` is
        the weakest mechanism that accounted for every letter word (None if any is unknown)."""
        wmap, wlist = self._words(rule.dict_id, rule.dict_mode)
        # Confident read: only a near-identical word may snap (one bad character, case).
        # Uncertain read: the rule's fuzzy threshold. correct_drop always uses the rule
        # threshold — its gate is "must match", not "prefer the read".
        cutoff = rule.fuzzy if rule.dict_mode is DictMode.correct_drop else (
            0.92 if confidence >= self._accept else rule.fuzzy)
        out: list[str] = []
        changed, score, unknown = False, 1.0, False
        kinds: list[str] = []            # the mechanism that accounted for each letter word
        for tok in text.split():
            if not any(c.isalpha() for c in tok):
                out.append(tok)              # numbers/brackets aren't vocabulary
                continue
            key = _norm(tok)
            hit = wmap.get(key)
            if hit is not None:
                changed = changed or hit != tok
                out.append(hit)
                kinds.append("dict")
                continue
            joined = _unmerge(wmap, key)     # OCR dropped a space: 'AladV' -> 'Alad V'
            if joined is not None:
                out.append(joined)
                changed = True
                kinds.append("split")
                continue
            m = self._corrector.best(tok.lower(), wlist, cutoff=cutoff) if wlist else None
            if m is not None:
                out.append(wmap.get(_norm(m[0]), m[0]))
                changed = True
                score = min(score, m[1])
                kinds.append("fuzzy")
            else:
                out.append(tok)
                unknown = True
        # every letter word matched -> the value is dictionary-verified; report the weakest link
        verified = None if (unknown or not kinds) else min(kinds, key=_VERIFY_RANK.get)
        return " ".join(out), changed, score, unknown, verified

    def apply_dictionary(self, value: object, rule: FieldRule, confidence: float) -> DictOutcome:
        """The ``dict_hook`` handed to ``run_rules``: correct/validate the running value
        against the rule's dictionary. See the module docstring for the four modes."""
        text = str(value)
        mode = rule.dict_mode
        if mode is DictMode.off:
            return DictOutcome(text)

        # 1) Exact whole-term hit wins outright — handles a correct read plus OCR noise like
        #    case/spacing/punctuation ('neo v11' -> 'Neo V11'). Correcting modes only.
        d = self._dict_for(rule.dict_id)
        if d and mode in (DictMode.correct, DictMode.correct_drop):
            hit = d.exact(text)
            if hit is not None:
                return DictOutcome(hit, corrected=(hit != text), verified="dict")

        if mode is DictMode.drop:
            # validation only, nothing rewritten: every letter-bearing word must already be
            # vocabulary or the read is dropped
            wmap, _ = self._words(rule.dict_id, mode)
            alpha = [t for t in text.split() if any(c.isalpha() for c in t)]
            if any(_norm(t) not in wmap for t in alpha):
                return DictOutcome(None, dropped=True)
            return DictOutcome(text, verified=("dict" if alpha else None))

        # 2) Per-word correction (see module docstring for why never whole-term fuzzy).
        result, changed, score, unknown, verified = self._correct_words(rule, text, confidence)
        if unknown and mode is DictMode.correct_drop:
            return DictOutcome(None, dropped=True)
        return DictOutcome(result, corrected=changed, score=score, verified=verified)

    def resolve(self, field: FieldDef, raw_text: str, confidence: float = 1.0) -> ResolvedField:
        res = run_rules(field, raw_text, dict_hook=self.apply_dictionary, confidence=confidence)
        return ResolvedField(value=res.value, corrected=res.corrected, score=res.score,
                             dropped=res.dropped, prune=res.prune, substituted=res.substituted,
                             verified=res.verified)

