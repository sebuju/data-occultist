"""Trailing decimal-places directive, shared by notification templating and subset derived math.

A ``|round:N`` (aliases ``|dp:N`` / ``|fixed:N`` / ``|.Nf``) segment on a ``|``-delimited token or
expression fixes its output to N decimals (``0`` => integer). ONE parser so the toast renderer
(:mod:`oc.collect.templating`) and subset column math (:mod:`oc.enrich.subset`) never drift.
"""

from __future__ import annotations

import re

# `round:N` / `dp:N` / `fixed:N` / `.Nf` — N is the fixed decimal count (0 => integer).
_FMT = re.compile(r"(?:round|dp|fixed):(\d+)|\.(\d+)f", re.IGNORECASE)


def split_dp(inner: str) -> tuple[str, int | None]:
    """Pull a trailing decimal-places directive off a ``|``-segmented string. Returns
    ``(core, dp)`` where ``dp`` is the fixed decimal count (``0`` => integer), or
    ``(inner, None)`` when the last ``|`` segment isn't a directive."""
    parts = inner.split("|")
    if len(parts) > 1:
        m = _FMT.fullmatch(parts[-1].strip())
        if m:
            return "|".join(parts[:-1]).strip(), int(m.group(1) if m.group(1) is not None else m.group(2))
    return inner, None
