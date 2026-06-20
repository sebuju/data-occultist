"""Generic, teachable text canonicalisation.

One parameterised normaliser used to bridge *near-match* values — two strings that
mean the same thing but differ in case, punctuation, spacing, or a stray word. The
canonical use is a subset join: ``"Axi A1 Relic"`` (raw window read) and ``"AXI A1"``
(a producer's normalised name) collapse to the same key so they join.

This is deliberately data-driven (every knob is an argument, nothing game-specific is
baked in) so the SAME function backs any near-match join — the word list (e.g.
``relic``) lives in the profile YAML, never here. It is the shared primitive new
join/normalise needs should be built on rather than hand-rolling a fresh regex chain
next to :func:`oc.store.keys._norm_part` or :func:`oc.enrich.relic._norm` (the latter
is a candidate to later delegate here; its hard-coded ``RELIC`` stays producer-internal
for now).
"""

from __future__ import annotations

import re

_PUNCT = re.compile(r"[^\w\s]+")
_WS = re.compile(r"\s+")


def norm_text(value, *, lower: bool = True, strip_punct: bool = False,
              collapse_ws: bool = True, strip_words=()) -> str:
    """Canonicalise ``value``. Steps run in order so each sees the previous result:
    lowercase -> drop punctuation -> drop whole words -> collapse whitespace. So
    ``"Relic,"`` (punctuation then word) drops cleanly, and ``"Axi  A1"`` trims to
    ``"axi a1"``. ``strip_words`` matches whole tokens (case-folded when ``lower``)."""
    s = str(value or "")
    if lower:
        s = s.lower()
    if strip_punct:
        s = _PUNCT.sub(" ", s)
    if strip_words:
        drop = {(w.lower() if lower else w) for w in strip_words}
        s = " ".join(t for t in s.split() if (t.lower() if lower else t) not in drop)
    if collapse_ws:
        s = _WS.sub(" ", s).strip()
    return s
