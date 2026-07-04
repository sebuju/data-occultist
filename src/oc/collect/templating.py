"""Tiny server-side ``{{token}}`` substitution for notification text.

The Python analogue of the pretty UI's ``renderDynamicText`` (``static/js/pretty/binding.js``):
same ``{{ token }}`` grammar and number tidying, but it runs where a toast actually fires
(server-side, in the trigger runner / web routes), so it can't call the browser one. Tokens
resolve against a plain ``{key: value}`` map — for toasts that's the live ``{readout_id: value}``
readings, so a message like ``Health {{ro_1}}`` prints the current value.
"""

from __future__ import annotations

import re

_TOKEN = re.compile(r"\{\{(.+?)\}\}")


def _fmt(v) -> str:
    """Match the pretty renderer: ints bare, floats to 2dp, everything else str()."""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, (int, float)):
        f = float(v)
        return str(int(f)) if f.is_integer() else f"{f:.2f}"
    return str(v)


def render_template(text: str, values: dict | None) -> str:
    """Replace each ``{{token}}`` in ``text`` with ``values[token]`` (token trimmed).
    An unknown/missing token resolves to empty string (as the pretty renderer does); text
    with no ``{{`` passes straight through. ``values`` None/empty ⇒ every token empties."""
    if not text or "{{" not in text:
        return text or ""
    vals = values or {}

    def sub(m: re.Match) -> str:
        v = vals.get(m.group(1).strip())
        return "" if v is None else _fmt(v)

    return _TOKEN.sub(sub, text)
