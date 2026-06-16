"""Runtime-only state that rides on top of the authored profile.

Currently: transient Pretty Studio node-input overrides (see :mod:`oc.runtime.overrides`).
These never touch the YAML on disk — they live in process memory and are applied to a
freshly-loaded profile by :func:`load_live_profile`.
"""

from __future__ import annotations

from .overrides import (
    apply_overrides,
    clear_override,
    get_overrides,
    load_live_profile,
    set_override,
)

__all__ = [
    "apply_overrides",
    "clear_override",
    "get_overrides",
    "load_live_profile",
    "set_override",
]
