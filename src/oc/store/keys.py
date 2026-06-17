"""Composite record keys: what makes two reads "the same row".

A :class:`KeySpec` is the teachable recipe — an ordered list of field ids joined
with a separator. One field (``name``) suffices for most data, but some items are
only distinct together with another field: "Arcane Aegis" at level 5 and at level 3
are different records with their own counts, so their key is ``name`` + ``level``.

A record with ANY key part missing/empty is unkeyable (``build`` returns ``None``)
and is dropped rather than guessed at: an arcane whose level is occluded must
neither collide with nor update a different level's record. Note ``0`` is a valid
part (an unranked arcane keys as ``arcane_aegis|0``).

A :class:`KeyMap` resolves WHICH spec keys a record. Each item template can define
its own key (a window may mix an 'arcane' template with a generic 'item' one), and
the reader tags multi-template records with ``_item``; untagged records use the
default spec. Both classes are pure data with no imports, so every layer
(collect, store, web) can share them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


def _norm_part(value, case_sensitive: bool) -> str | None:
    if value in (None, ""):
        return None
    # whitespace runs become single underscores so keys are stable across OCR
    # spacing noise and read as one token ("Arcane Aegis" -> "arcane_aegis")
    s = re.sub(r"\s+", "_", str(value).strip())
    if not case_sensitive:
        s = s.lower()
    return s or None


@dataclass(frozen=True)
class KeySpec:
    """One key recipe: ordered field ids, joined by ``sep``. Parts are trimmed,
    whitespace becomes underscores, and (by default) they're lowercased — OCR
    case/spacing is noisy."""

    fields: tuple[str, ...] = ("name",)
    sep: str = "|"
    case_sensitive: bool = False

    def parts(self, values: dict) -> list[str] | None:
        """The normalised key parts, or ``None`` when any part is missing/empty.
        An empty recipe (no fields) is itself unkeyable — a record is dropped, never
        collapsed under a blank key."""
        if not self.fields:
            return None
        out = []
        for f in self.fields:
            p = _norm_part(values.get(f), self.case_sensitive)
            if p is None:
                return None
            out.append(p)
        return out

    def build(self, values: dict) -> str | None:
        parts = self.parts(values)
        return self.sep.join(parts) if parts is not None else None

    def meta(self) -> dict:
        """JSON-stable fingerprint — a change here re-keys the dataset on replay.
        ``norm`` versions the part normalisation itself, so snapshots cached under
        older key rules (e.g. spaces kept) replay once and re-key."""
        return {"fields": list(self.fields), "sep": self.sep, "case": self.case_sensitive,
                "norm": 2}


@dataclass(frozen=True)
class KeyMap:
    """Which :class:`KeySpec` keys a record: the template's own spec when the record
    is tagged with the item that read it (``_item``), else the default.

    ``dedup`` False turns OFF the 1->many collapse for the dataset: every observation is
    kept as its OWN record (keyed per-event in the store) instead of merging same-key reads.
    """

    default: KeySpec = KeySpec()
    by_item: dict[str, KeySpec] = field(default_factory=dict)
    dedup: bool = True

    def spec_for(self, values: dict) -> KeySpec:
        return self.by_item.get(values.get("_item"), self.default)

    def parts(self, values: dict) -> list[str] | None:
        return self.spec_for(values).parts(values)

    def build(self, values: dict) -> str | None:
        return self.spec_for(values).build(values)

    def fields_used(self) -> list[str]:
        """Every field id any spec keys on, deduped in order — for status/warnings."""
        out: list[str] = []
        for spec in (self.default, *self.by_item.values()):
            for f in spec.fields:
                if f not in out:
                    out.append(f)
        return out

    def meta(self) -> dict:
        return {"default": self.default.meta(), "dedup": self.dedup,
                "by_item": {k: v.meta() for k, v in sorted(self.by_item.items())}}
