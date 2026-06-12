"""Resolve a raw OCR read into a final field value, learning and correcting.

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
  5. confident, unchanged reads teach the lexicon; uncertain ones never do

The field's ``dict_mode`` picks how the authored dictionary participates: ``off``
(not consulted), ``correct`` (fix words, keep unmatched), ``drop`` (validate only,
unmatched word -> None), ``correct_drop`` (fix words, unmatchable word -> None).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..collect.fields import coerce_rule
from ..interfaces import Corrector
from ..profile.models import DictMode, FieldDef, FieldType
from .dictionary import _norm
from .lexicon import Lexicon


@dataclass
class ResolvedField:
    value: object
    corrected: bool = False   # one or more words snapped to the vocabulary
    learned: bool = False     # taught to the dictionary this read
    score: float = 1.0        # worst word-correction similarity (1.0 when not corrected)
    # which configured fallback produced the value ("empty"/"if_number"/"if_text"),
    # None for a real read — substituted values are config, not OCR confidence
    substituted: str | None = None


def _unmerge(wmap: dict[str, str], key: str) -> str | None:
    """A read that fused two KNOWN words ('aladv') splits back ('Alad V') — accepted
    only when the split is unambiguous (exactly one way both halves are vocabulary)."""
    hits = [(wmap[key[:i]], wmap[key[i:]]) for i in range(1, len(key))
            if key[:i] in wmap and key[i:] in wmap]
    if len(hits) == 1:
        return f"{hits[0][0]} {hits[0][1]}"
    return None


class FieldResolver:
    def __init__(self, lexicon: Lexicon, corrector: Corrector, accept_confidence: float = 0.88,
                 confusions=None, dictionary=None, learn_enabled: bool = True):
        self._lex = lexicon
        self._corrector = corrector
        self._accept = accept_confidence
        self._confusions = confusions   # optional ConfusionMap
        self._dict = dictionary          # optional Dictionary (authored vocabulary)
        self._learn = learn_enabled      # False => read-only (e.g. teaching preview): never mutate
        # field id -> (lexicon term count, word map, lowercase word list). The
        # dictionary is fixed and the lexicon only grows, so a stale entry is detected
        # by the count alone — without this every resolve rebuilds a thousand-word map.
        self._word_cache: dict[str, tuple[int, dict[str, str], list[str]]] = {}
        self._dict_words: tuple[dict[str, str], list[str]] | None = None

    def _words(self, field: FieldDef) -> tuple[dict[str, str], list[str]]:
        """The field's word vocabulary: ``norm -> canonical`` plus a lowercase list
        for fuzzy matching — the dictionary's words (unless the field's dict mode is
        off), joined by the words of the field's learned terms (when it learns).
        Cached."""
        use_dict = self._dict and field.dict_mode is not DictMode.off
        dmap = self._dict.word_map if use_dict else {}
        if not field.learn:
            if not use_dict:
                return {}, []
            if self._dict_words is None:
                self._dict_words = (dmap, [w.lower() for w in dmap.values()])
            return self._dict_words
        lterms = self._lex.terms(field.id)
        cached = self._word_cache.get(field.id)
        if cached is not None and cached[0] == len(lterms):
            return cached[1], cached[2]
        wmap = dict(dmap)
        for t in lterms:
            for wd in t.split():
                key = _norm(wd)
                if key:
                    wmap.setdefault(key, wd)
        wlist = [w.lower() for w in wmap.values()]
        self._word_cache[field.id] = (len(lterms), wmap, wlist)
        return wmap, wlist

    def _correct_words(self, field: FieldDef, text: str, confidence: float):
        """Correct ``text`` one word at a time against the vocabulary's words.
        Returns ``(result, changed, worst_score, any_unknown)`` — ``any_unknown``
        is True when a letter-bearing word matched nothing (the drop modes' gate)."""
        wmap, wlist = self._words(field)
        # Confident read: only a near-identical word may snap (one bad character,
        # case). Uncertain read: the field's fuzzy threshold. correct_drop always
        # uses the field threshold — its gate is "must match", not "prefer the read".
        cutoff = field.fuzzy if field.dict_mode is DictMode.correct_drop else (
            0.92 if confidence >= self._accept else field.fuzzy)
        out: list[str] = []
        changed, score, unknown = False, 1.0, False
        for tok in text.split():
            if not any(c.isalpha() for c in tok):
                out.append(tok)              # numbers/brackets aren't vocabulary
                continue
            key = _norm(tok)
            hit = wmap.get(key)
            if hit is not None:
                changed = changed or hit != tok
                out.append(hit)
                continue
            joined = _unmerge(wmap, key)     # OCR dropped a space: 'AladV' -> 'Alad V'
            if joined is not None:
                out.append(joined)
                changed = True
                continue
            cand = self._confusions.normalize(tok) if self._confusions else tok
            m = self._corrector.best(cand.lower(), wlist, cutoff=cutoff) if wlist else None
            if m is not None:
                out.append(wmap.get(_norm(m[0]), m[0]))
                changed = True
                score = min(score, m[1])
                if self._confusions and self._learn:
                    self._confusions.learn(tok, m[0])   # learn the read->canonical confusions
            else:
                out.append(tok)
                unknown = True
        return " ".join(out), changed, score, unknown

    def resolve(self, field: FieldDef, raw_text: str, confidence: float) -> ResolvedField:
        value, rule = coerce_rule(field, raw_text)
        if rule is not None:
            # a configured fallback fired — the value is authored, not read, so it
            # bypasses the dictionary (incl. the drop modes) and is never learned
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
        if self._dict and mode in (DictMode.correct, DictMode.correct_drop):
            hit = self._dict.exact(text)
            if hit is not None:
                return ResolvedField(hit, corrected=(hit != text), score=1.0)

        if mode is DictMode.drop:
            # validation only, nothing rewritten: every letter-bearing word must
            # already be vocabulary or the read is dropped (and never learned)
            wmap, _ = self._words(field)
            if any(_norm(t) not in wmap for t in text.split() if any(c.isalpha() for c in t)):
                return ResolvedField(None)
            result, changed, score, unknown = text, False, 1.0, False
        else:
            # 2) Per-word correction (see module docstring for why never whole-term
            #    fuzzy). With mode off the dictionary's words are excluded and only
            #    the field's learned terms correct.
            result, changed, score, unknown = self._correct_words(field, text, confidence)

        if unknown and mode is DictMode.correct_drop:
            # a word that matches nothing -> not a real name: dropped and NEVER
            # learned (learning would make garbage valid)
            return ResolvedField(None)
        if changed:
            return ResolvedField(result, corrected=True, score=score)
        if confidence >= self._accept and field.learn and self._learn:
            self._lex.learn(field.id, result)
            return ResolvedField(result, learned=True)
        # Unchanged and uncertain — keep the raw text, don't learn from it.
        return ResolvedField(result)
