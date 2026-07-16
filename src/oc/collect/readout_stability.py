"""Per-readout temporal consensus gate — the misfire filter for the live action screen.

A readout is surfaced from a SINGLE read every OCR-due tick, so a fast/animating game screen
that OCRs to garbage for a few frames pushes those garbage values straight to the register and
value triggers (the dataset/record path is shielded by its own Confirmer, ``stability.py``, but
the readout path had nothing). This gate adds the missing temporal defense: score each read for
QUALITY — does it match the field's expected type and clear the confidence floor — and only
surface the current read when enough of the recent stream was that-quality.

It keys on the read's TYPE, never its value, so a legitimately fast-changing number (health,
ammo — a different but still-numeric value every tick) always passes with zero lag; only a
burst where the reads stop being the expected type (the screen is too busy to read) suppresses
the readout until clean reads return. Opt-in per readout via ``FieldDef.stability_reads`` /
``stability_min`` (both 0 -> gate off). Pure logic, no capture/GPU — unit-testable off-Windows.
"""

from __future__ import annotations

from ..profile.models import FieldDef, FieldType
from .fields import _first_number, _to_number


def expected_ok(field: FieldDef | None, value: object, dropped: bool,
                conf: float, floor: float) -> bool:
    """Whether one read is expected-QUALITY: not dropped, non-empty, matches the field's
    expected type, and clears the confidence ``floor``. This is the flag the consensus window
    counts; it is computed from the read alone, INDEPENDENT of the gate's own decision, so a
    suppressed tick can't drag the window down and latch the readout off."""
    if dropped or value is None:
        return False
    if floor and conf < floor:
        return False
    ftype = field.type if field else FieldType.text
    if ftype in (FieldType.number, FieldType.pips, FieldType.diamonds):
        # numeric-typed: the read must actually carry a number
        return _to_number(_first_number(str(value))) is not None
    # text / symbol: any non-empty value is the expected type
    return str(value).strip() != ""


def consensus_pass(ok_flags: list[bool], window: int, min_good: int) -> bool:
    """Gate the current read given the recent quality flags. ``ok_flags`` is newest-first and
    INCLUDES this tick's flag at index 0 (mirrors ``readout_history`` order). ``window`` is M,
    ``min_good`` is K. Returns True (surface the read) when at least K of the last M flags are
    True. ``window <= 0`` -> gate disabled (always pass). K is clamped to 1..M."""
    if window <= 0:
        return True
    k = max(1, min(min_good, window))
    good = sum(1 for ok in ok_flags[:window] if ok)
    return good >= k
