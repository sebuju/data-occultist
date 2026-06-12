"""Exact and per-word lookup over a game's authored word list.

A :class:`Dictionary` wraps a fixed vocabulary (item/weapon/relic names, …) and is
consulted by the resolver when reading a text field: an EXACT hit (ignoring case,
spacing and punctuation) wins outright; otherwise the resolver corrects the read
one WORD at a time against :attr:`word_map`. Unlike the self-learning lexicon it
never changes — it's authored by the user (or scraped) and just read.
"""

from __future__ import annotations

from ..interfaces import Corrector


def _norm(s: str) -> str:
    """Fold to a comparison key: lowercase, drop everything but letters/digits — so
    'Neo V11', 'neo v11' and 'NeoV11' are the same key."""
    return "".join(c for c in s.lower() if c.isalnum())


class Dictionary:
    def __init__(self, terms, corrector: Corrector) -> None:
        self._terms = [t for t in (terms or []) if t]
        self._exact: dict[str, str] = {}
        self._words: dict[str, str] = {}
        for t in self._terms:
            self._exact.setdefault(_norm(t), t)   # first spelling wins on collisions
            for wd in t.split():
                key = _norm(wd)
                if key:
                    self._words.setdefault(key, wd)
        self._corr = corrector

    def __bool__(self) -> bool:
        return bool(self._terms)

    @property
    def terms(self) -> list[str]:
        return self._terms

    @property
    def word_map(self) -> dict[str, str]:
        """``norm(word) -> canonical spelling`` over every word of every term."""
        return self._words

    def exact(self, text: str) -> str | None:
        """Canonical term for an exact match (case/space/punctuation-insensitive)."""
        return self._exact.get(_norm(text))
