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
from . import readout_history
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


def gate_readouts(game: str, window_id: str, ro_field: dict, ro_trace: list,
                  readouts_now: dict, readout_confs_now: dict, ts: str) -> set[str]:
    """One tick's readout consensus + history pass, shared by the live collector and the
    teach-UI test feed (rule 7 — the loop used to live inline in ``Collector.tick`` only).

    For each read in ``ro_trace`` (``{id, value, raw, dropped, conf, trace}``, from
    ``RegionReader.read_readouts_detailed``'s ``trace_sink``): score expected QUALITY
    (:func:`expected_ok`), and for a readout with the gate enabled
    (``FieldDef.stability_reads > 0``) run the K-of-M window (:func:`consensus_pass`) over its
    recent history ring. Records EVERY evaluated read (passed or held) to the ring
    (:func:`readout_history.record`). Suppressed ids are POPPED from ``readouts_now`` /
    ``readout_confs_now`` in place (so the register/.ro-live/trigger maps hold their last value)
    and returned as a set. ``ro_field`` maps readout id -> its resolved ``FieldDef`` (or None).

    Because the ring is module-global and persists across calls, feeding images one at a time
    through this builds the same temporal stream a live collector sees."""
    suppressed: set[str] = set()
    for rec in ro_trace:
        rid = rec["id"]
        fdef = ro_field.get(rid)
        floor = (getattr(fdef, "min_confidence", 0.0) or 0.0) if fdef else 0.0
        ok = expected_ok(fdef, rec["value"], rec["dropped"], rec["conf"], floor)
        win = (getattr(fdef, "stability_reads", 0) or 0) if fdef else 0
        held = False
        if win > 0 and rid in readouts_now:
            prior = readout_history.recent(game, window_id, rid)
            flags = [ok] + [bool(e.get("ok", True)) for e in prior]
            if not consensus_pass(flags, win, getattr(fdef, "stability_min", 0) or 0):
                suppressed.add(rid)
                held = True
        readout_history.record(game, window_id, rid, ts=ts, raw=rec["raw"],
                               value=rec["value"], dropped=rec["dropped"], trace=rec["trace"],
                               conf=rec["conf"], ok=ok, held=held)
    for rid in suppressed:
        readouts_now.pop(rid, None)
        readout_confs_now.pop(rid, None)
    return suppressed
