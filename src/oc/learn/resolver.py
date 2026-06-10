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

from ..collect.fields import coerce
from ..interfaces import Corrector
from ..profile.models import FieldDef, FieldType
from .lexicon import Lexicon


@dataclass
class ResolvedField:
    value: object
    corrected: bool = False   # snapped to a dictionary term
    learned: bool = False     # taught to the dictionary this read
    score: float = 1.0        # correction similarity (1.0 when not corrected)


class FieldResolver:
    def __init__(self, lexicon: Lexicon, corrector: Corrector, accept_confidence: float = 0.88,
                 confusions=None):
        self._lex = lexicon
        self._corrector = corrector
        self._accept = accept_confidence
        self._confusions = confusions   # optional ConfusionMap

    def resolve(self, field: FieldDef, raw_text: str, confidence: float) -> ResolvedField:
        value = coerce(field, raw_text)
        if value is None:
            return ResolvedField(None)

        # Numbers and non-learning fields bypass the dictionary entirely.
        if field.type is FieldType.number or not field.learn:
            return ResolvedField(value)

        text = str(value)
        vocab = self._lex.terms(field.id)
        # pre-correct the read with the learned OCR confusion map before matching
        cand = self._confusions.normalize(text) if self._confusions else text
        match = self._corrector.best(cand, vocab) if vocab else None

        def correct(term, score):
            if self._confusions:
                self._confusions.learn(text, term)   # learn the read->canonical confusions
            return ResolvedField(term, corrected=True, score=score)

        if confidence >= self._accept:
            # A near-identical known term wins even on a confident read, so OCR noise
            # like a dropped space ('35mmFilm' vs '35mm Film') snaps to the canonical
            # form instead of being learned as a duplicate.
            if match and match[1] >= 0.92:
                return correct(match[0], match[1])
            self._lex.learn(field.id, text)
            return ResolvedField(text, learned=True)

        # Uncertain: repair against what we already know.
        if match and match[1] >= field.fuzzy:
            return correct(match[0], match[1])

        # Still unsure and nothing close — keep the raw text, don't learn from it.
        return ResolvedField(text)
