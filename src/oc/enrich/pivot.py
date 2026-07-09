"""Pivot flat ``{name, value}`` rows into wide rows, grouped by a shared id-prefix.

A register's held readouts mirror to a dataset as one row per readout id
(``{name: "slot_1_school", value: "madurai"}``). Several such rows often describe one logical
instance (a warframe's slot 1: its equipped mod, drain, polarity) but differ only in an id
SUFFIX. :func:`apply_pivot` folds them back into one row per prefix, so a subset can filter/sort
on the combined shape (e.g. "slots whose ``name`` is empty"). The suffix vocabulary
(:class:`~oc.profile.models.PivotSpec.attributes`) is taught in profile config — this module
has no game-specific knowledge of what a suffix means.
"""

from __future__ import annotations


def apply_pivot(rows: list[dict], spec) -> list[dict]:
    """Reshape ``rows`` (each carrying ``spec.name_field``/``spec.value_field``) into wide rows
    keyed by ``spec.key_column``. A row's ``name_field`` is matched against ``spec.attributes``
    (longest suffix wins, so e.g. ``_school`` isn't shadowed by a shorter overlapping suffix);
    a row matching no taught suffix is dropped — it isn't part of any group. Rows sharing a
    prefix merge into one dict, first value wins per attribute, prefixes kept in first-seen
    order."""
    attrs = sorted((a for a in spec.attributes if a), key=len, reverse=True)
    if not attrs:
        return []
    groups: dict[str, dict] = {}
    order: list[str] = []
    for row in rows:
        name = str(row.get(spec.name_field, "") or "")
        suffix = next((a for a in attrs if name.endswith(a)), None)
        if suffix is None:
            continue
        prefix = name[: -len(suffix)]
        col = suffix.lstrip("_")
        if prefix not in groups:
            groups[prefix] = {spec.key_column: prefix}
            order.append(prefix)
        group = groups[prefix]
        if col not in group:
            group[col] = row.get(spec.value_field)
    return [groups[p] for p in order]
