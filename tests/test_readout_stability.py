"""Pure-logic tests for the readout consensus (misfire) gate — no capture/GPU."""

from oc.collect.readout_stability import consensus_pass, expected_ok
from oc.profile.models import FieldDef, FieldType


def _num_field(**kw):
    return FieldDef(id="hp", type=FieldType.number, **kw)


def _text_field(**kw):
    return FieldDef(id="name", type=FieldType.text, **kw)


# ---- expected_ok: the per-read quality flag ---------------------------------

def test_ok_numeric_read_passes():
    assert expected_ok(_num_field(), 42, dropped=False, conf=0.9, floor=0.0) is True


def test_ok_number_field_rejects_non_numeric():
    assert expected_ok(_num_field(), "abc", dropped=False, conf=0.99, floor=0.0) is False


def test_ok_dropped_read_is_not_ok():
    assert expected_ok(_num_field(), None, dropped=True, conf=0.99, floor=0.0) is False


def test_ok_below_floor_is_not_ok():
    assert expected_ok(_num_field(), 42, dropped=False, conf=0.4, floor=0.6) is False


def test_ok_text_field_wants_non_empty():
    assert expected_ok(_text_field(), "Mag", dropped=False, conf=0.7, floor=0.0) is True
    assert expected_ok(_text_field(), "", dropped=False, conf=0.9, floor=0.0) is False


def test_ok_numeric_string_counts_as_number():
    # a number field whose value survived as a numeric string is still expected-quality
    assert expected_ok(_num_field(), "1,250", dropped=False, conf=0.9, floor=0.0) is True


# ---- consensus_pass: the K-of-M window --------------------------------------

def test_window_zero_disables_gate():
    assert consensus_pass([False, False, False], window=0, min_good=2) is True


def test_clean_stream_always_passes():
    # a legit fast-changing number reads numeric every tick -> never suppressed
    assert consensus_pass([True] * 5, window=3, min_good=2) is True


def test_garbage_burst_is_suppressed():
    # newest-first: this tick + last two all non-quality -> 0 of 3 < 2 -> drop
    assert consensus_pass([False, False, False, True, True], window=3, min_good=2) is False


def test_single_spike_survives_on_recent_history():
    # one bad read (index 0) among good history -> 2 of 3 good -> still passes... but the
    # bad current read is itself ok=False; the gate only suppresses when the COUNT falls short
    assert consensus_pass([False, True, True], window=3, min_good=2) is True


def test_recovery_reenables_after_burst():
    # stream recovers: newest reads good again -> back above threshold
    assert consensus_pass([True, True, False, False], window=3, min_good=2) is True


def test_k_clamped_to_window():
    # min_good larger than window clamps to window (can't require more than exist)
    assert consensus_pass([True, True, True], window=3, min_good=99) is True
    assert consensus_pass([True, True, False], window=3, min_good=99) is False


def test_k_at_least_one():
    # min_good 0 with an active window still requires at least one good read
    assert consensus_pass([False, False], window=2, min_good=0) is False
    assert consensus_pass([True, False], window=2, min_good=0) is True
