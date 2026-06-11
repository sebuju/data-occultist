"""Resolve a raw OCR read into a final field value, learning and correcting.

Pipeline per field:
  1. clean/typed via the profile's regex + type (:func:`oc.collect.fields.coerce`)
  2. if the field is a number or not a learning field -> done
  3. if OCR was confident -> trust it AND teach the game dictionary
  4. otherwise -> snap to the closest known term if it clears the fuzzy threshold
  5. otherwise -> keep the (uncertain) text, but don't pollute the dictionary
"""

from __future__ import annotations

from dataclasses import dataclass

from ..collect.fields import coerce_rule
from ..interfaces import Corrector
from ..profile.models import FieldDef, FieldType
from .lexicon import Lexicon


@dataclass
class ResolvedField:
    value: object
    corrected: bool = False   # snapped to a dictionary term
    learned: bool = False     # taught to the dictionary this read
    score: float = 1.0        # correction similarity (1.0 when not corrected)
    # which configured fallback produced the value ("empty"/"if_number"/"if_text"),
    # None for a real read — substituted values are config, not OCR confidence
    substituted: str | None = None


class FieldResolver:
    def __init__(self, lexicon: Lexicon, corrector: Corrector, accept_confidence: float = 0.88,
                 confusions=None, dictionary=None, learn_enabled: bool = True):
        self._lex = lexicon
        self._corrector = corrector
        self._accept = accept_confidence
        self._confusions = confusions   # optional ConfusionMap
        self._dict = dictionary          # optional Dictionary (authored vocabulary)
        self._learn = learn_enabled      # False => read-only (e.g. teaching preview): never mutate
        # field id -> (lexicon term count, combined vocab). The dictionary is fixed and
        # the lexicon only grows, so a stale entry is detected by the count alone —
        # without this every resolve copies a multi-thousand-term list.
        self._vocab_cache: dict[str, tuple[int, list[str]]] = {}

    def _vocab(self, field: FieldDef) -> list[str]:
        """Authored dictionary + the field's learned terms (when it learns), cached."""
        dterms = self._dict.terms if self._dict else []
        if not field.learn:
            return dterms
        lterms = self._lex.terms(field.id)
        cached = self._vocab_cache.get(field.id)
        if cached is not None and cached[0] == len(lterms):
            return cached[1]
        vocab = list(dterms) + list(lterms)
        self._vocab_cache[field.id] = (len(lterms), vocab)
        return vocab

    def resolve(self, field: FieldDef, raw_text: str, confidence: float) -> ResolvedField:
        value, rule = coerce_rule(field, raw_text)
        if rule is not None:
            # a configured fallback fired — the value is authored, not read, so it
            # bypasses the dictionary (incl. dict_only) and is never learned
            return ResolvedField(value, substituted=rule)
        if value is None:
            return ResolvedField(None)

        # Numbers never touch the dictionary.
        if field.type is FieldType.number:
            return ResolvedField(value)

        text = str(value)

        # 1) Exact dictionary hit wins outright — handles a correct read plus OCR noise
        #    like case/spacing/punctuation ('neo v11' -> 'Neo V11'). No fuzzy needed.
        if self._dict:
            hit = self._dict.exact(text)
            if hit is not None:
                return ResolvedField(hit, corrected=(hit != text), score=1.0)

        # Nothing to match against: not a learning field AND no dictionary.
        if not field.learn and not self._dict:
            return ResolvedField(None) if field.dict_only else ResolvedField(value)

        # pre-correct the read with the learned OCR confusion map before matching
        cand = self._confusions.normalize(text) if self._confusions else text
        vocab = self._vocab(field)
        # Anything below the threshold we'd accept is discarded anyway — tell the
        # corrector so it can prune the search (the dominant cost on a big dictionary).
        # A dict_only field accepts any ≥ fuzzy match even on a confident read.
        cutoff = field.fuzzy if field.dict_only else (0.92 if confidence >= self._accept else field.fuzzy)
        match = self._corrector.best(cand, vocab, cutoff=cutoff) if vocab else None

        def correct(term, score):
            if self._confusions and self._learn:
                self._confusions.learn(text, term)   # learn the read->canonical confusions
            return ResolvedField(term, corrected=True, score=score)

        if confidence >= self._accept:
            # A near-identical known term wins even on a confident read, so OCR noise
            # like a dropped space ('35mmFilm' vs '35mm Film') snaps to the canonical
            # form instead of being kept as a duplicate.
            if match and match[1] >= 0.92:
                return correct(match[0], match[1])
            if field.dict_only:
                # must match the vocabulary: a fuzzy hit snaps, anything else is
                # dropped and NEVER learned (learning would make garbage valid)
                if match and match[1] >= field.fuzzy:
                    return correct(match[0], match[1])
                return ResolvedField(None)
            if field.learn and self._learn:
                self._lex.learn(field.id, text)
                return ResolvedField(text, learned=True)
            return ResolvedField(text)

        # Uncertain: repair against the dictionary / what we already know.
        if match and match[1] >= field.fuzzy:
            return correct(match[0], match[1])

        if field.dict_only:
            return ResolvedField(None)
        # Still unsure and nothing close — keep the raw text, don't learn from it.
        return ResolvedField(text)
