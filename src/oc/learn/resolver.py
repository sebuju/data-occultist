"""Resolve a raw OCR read into a final field value against the authored dictionary.

Pipeline per field:
  1. clean/typed via the profile's regex + type (:func:`oc.collect.fields.coerce`)
  2. if the field is a number -> done (numbers never touch the dictionary)
  3. exact whole-term dictionary hit -> canonical spelling
  4. WORD-PER-WORD correction against the vocabulary's words: each word snaps to a
     known word it nearly matches ('al1oy' -> 'Alloy'), a fused pair splits back
     ('AladV' -> 'Alad V'), and unknown combinations of known words pass through
     untouched. Whole-term fuzzy matching is deliberately NOT done: against an
     incomplete dictionary it collapses a component ("Akbronco Prime Link") into
     its parent term ("Akbronco Prime") and distinct records merge.

The vocabulary is the AUTHORED dictionary only — there is no self-learning: what
the dictionary lists is the whole truth, so a correction is always traceable to a
term someone taught. The field's ``dict_mode`` picks how it participates: ``off``
(not consulted), ``correct`` (fix words, keep unmatched), ``drop`` (validate only,
unmatched word -> None), ``correct_drop`` (fix words, unmatchable word -> None).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..collect.fields import coerce_rule
from ..interfaces import Corrector
from ..profile.models import DictMode, FieldDef, FieldType
from .dictionary import _norm


@dataclass
class ResolvedField:
    value: object
    corrected: bool = False   # one or more words snapped to the vocabulary
    score: float = 1.0        # worst word-correction similarity (1.0 when not corrected)
    # which configured fallback produced the value ("empty"/"if_number"/"if_text"),
    # None for a real read — substituted values are config, not OCR confidence
    substituted: str | None = None
    # HOW the value was confirmed against the authored dictionary — set only when EVERY
    # letter-bearing word is accounted for (a value with an unknown word is NOT verified).
    # "dict" (exact vocabulary), "split" (an unmerge), "fuzzy" (a similarity snap); the
    # reader may upgrade it to "glyph" (pixel glyph_check). None = not validated (dict off /
    # number / unknown word). The UI marks a verified read so the author sees it's trusted.
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
        self._dict = dictionary          # pooled Dictionary, used when a field pins none
        self._dict_map = dictionaries or {}   # id -> Dictionary, a field pins one via FieldDef.dictionary
        # cache the word vocabulary per Dictionary object (fields may use different
        # ones), keyed by object id since each dictionary is fixed.
        self._dict_words: dict[int, tuple[dict[str, str], list[str]]] = {}

    def _dict_for(self, field: FieldDef):
        """The Dictionary this field reads against: its pinned one
        (``FieldDef.dictionary``) when set and known, else the pooled default."""
        if field.dictionary and field.dictionary in self._dict_map:
            return self._dict_map[field.dictionary]
        return self._dict

    def _words(self, field: FieldDef) -> tuple[dict[str, str], list[str]]:
        """The field's word vocabulary: ``norm -> canonical`` plus a lowercase list for
        fuzzy matching — the authored dictionary's words, or empty when the field's
        dict mode is off. Cached."""
        d = self._dict_for(field)
        if not (d and field.dict_mode is not DictMode.off):
            return {}, []
        cached = self._dict_words.get(id(d))
        if cached is None:
            dmap = d.word_map
            cached = (dmap, [w.lower() for w in dmap.values()])
            self._dict_words[id(d)] = cached
        return cached

    def _correct_words(self, field: FieldDef, text: str, confidence: float):
        """Correct ``text`` one word at a time against the vocabulary's words.
        Returns ``(result, changed, worst_score, any_unknown, verified)`` — ``any_unknown``
        is True when a letter-bearing word matched nothing (the drop modes' gate); ``verified``
        is the weakest mechanism that accounted for every letter word (None if any is unknown)."""
        wmap, wlist = self._words(field)
        # Confident read: only a near-identical word may snap (one bad character,
        # case). Uncertain read: the field's fuzzy threshold. correct_drop always
        # uses the field threshold — its gate is "must match", not "prefer the read".
        cutoff = field.fuzzy if field.dict_mode is DictMode.correct_drop else (
            0.92 if confidence >= self._accept else field.fuzzy)
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

    def resolve(self, field: FieldDef, raw_text: str, confidence: float) -> ResolvedField:
        value, rule = coerce_rule(field, raw_text)
        if rule is not None:
            # a configured fallback fired — the value is authored, not read, so it
            # bypasses the dictionary (incl. the drop modes)
            return ResolvedField(value, substituted=rule)
        if value is None:
            return ResolvedField(None)

        # Numbers never touch the dictionary.
        if field.type is FieldType.number:
            return ResolvedField(value)

        text = str(value)
        mode = field.dict_mode

        # 1) Exact dictionary hit wins outright — handles a correct read plus OCR noise
        #    like case/spacing/punctuation ('neo v11' -> 'Neo V11'). No fuzzy needed.
        #    Only when the dictionary may rewrite the read (the correcting modes).
        d = self._dict_for(field)
        if d and mode in (DictMode.correct, DictMode.correct_drop):
            hit = d.exact(text)
            if hit is not None:
                return ResolvedField(hit, corrected=(hit != text), score=1.0, verified="dict")

        if mode is DictMode.drop:
            # validation only, nothing rewritten: every letter-bearing word must
            # already be vocabulary or the read is dropped
            wmap, _ = self._words(field)
            alpha = [t for t in text.split() if any(c.isalpha() for c in t)]
            if any(_norm(t) not in wmap for t in alpha):
                return ResolvedField(None)
            # all words known (or none to check) — verified only when there WAS a word
            result, changed, score, unknown = text, False, 1.0, False
            verified = "dict" if alpha else None
        else:
            # 2) Per-word correction (see module docstring for why never whole-term
            #    fuzzy). With mode off the dictionary's words are excluded, so nothing
            #    corrects and the read passes through verbatim.
            result, changed, score, unknown, verified = self._correct_words(field, text, confidence)

        if unknown and mode is DictMode.correct_drop:
            # a word that matches nothing -> not a real name: dropped
            return ResolvedField(None)
        if changed:
            return ResolvedField(result, corrected=True, score=score, verified=verified)
        return ResolvedField(result, verified=verified)
