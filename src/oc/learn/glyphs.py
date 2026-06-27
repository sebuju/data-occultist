"""Glyph-confusion folding for OCR-ambiguous alphanumeric codes.

Some characters are visually near-identical, so OCR flips between them
('A9'->'AG', 'V1'->'Vl', 'G1'->'Gl'). For short codes a single such flip halves
the edit-distance ratio, so the fuzzy corrector can never snap them and the
learned :class:`~oc.learn.confusions.ConfusionMap` can never see a first match to
learn from — a chicken-and-egg miss.

:func:`glyph_fold` collapses each character to a representative of its confusable
class, so a read and a known word that differ ONLY by such flips fold equal. The
resolver uses this for vocabulary words that contain a digit (relic refinements
like ``A9``/``V11``/``G1``) — restricting to digit-bearing codes keeps ordinary
all-letter words from folding into one another. This is universal OCR behaviour,
not game knowledge.
"""

from __future__ import annotations

# Each group lists glyphs an OCR engine routinely confuses; the first member is
# the fold representative. Only strong visual ambiguities — kept conservative so
# distinct codes stay distinct.
_GROUPS = (
    "0o",
    "1li",
    "2z",
    "5s",
    "8b",
    "9gq",
    "7t",
)

_FOLD = {ch: g[0] for g in _GROUPS for ch in g}


def glyph_fold(s: str) -> str:
    """Lowercase ``s`` and map each confusable glyph to its class representative
    (so 'AG' and 'A9' both fold to 'a9')."""
    return "".join(_FOLD.get(c, c) for c in s.lower())
