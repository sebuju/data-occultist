"""on_input trigger — pure logic, no OS hook. Feeds TriggerRunner.on_input a synthetic event
stream (the shape oc.input.win32_hook would normally produce) and asserts down/up/press/double
derivation, auto-repeat suppression, chord matching, window/rect gating, and throttle — plus the
disposition each event records (see oc.collect.input_history, the satellite's backing ring).
"""

import pytest

from oc.collect import input_history
from oc.collect.triggers import TriggerRunner
from oc.profile.models import GameProfile, ProducerDef, TriggerDef, WindowDef
from oc.types import PixelBox


@pytest.fixture(autouse=True)
def _clear_input_history():
    input_history.clear("g")
    yield
    input_history.clear("g")


def _ev(device="key", action="down", button="w", x=0, y=0):
    return {"device": device, "action": action, "button": button, "x": x, "y": y, "ts": 0.0}


def _profile(**trigger_kwargs):
    return GameProfile(
        name="g",
        windows=[WindowDef(id="equipment", title="Equipment")],
        producers=[ProducerDef(id="p", dataset="ds", mode="orders", sources=["s"])],
        triggers=[TriggerDef(id="t", kind="on_input", targets=["p"], **trigger_kwargs)],
    )


def _runner(profile, clock=None):
    calls = []
    kwargs = {"clock": lambda: clock[0]} if clock is not None else {}
    tr = TriggerRunner(profile, "data", fire=lambda pn, items: calls.append((pn.id, items)), **kwargs)
    return tr, calls


def _dispositions(game, tid):
    return [e["result"] for e in input_history.recent(game, tid)]   # newest-first


def test_down_fires_on_press_edge():
    tr, calls = _runner(_profile(input_event="down", input_button="key:w"))
    assert tr.on_input(_ev(action="down")) == ["t"]
    assert calls == [("p", None)]
    assert _dispositions("g", "t")[0] == "fired"


def test_down_ignores_os_autorepeat():
    tr, calls = _runner(_profile(input_event="down", input_button="key:w"))
    assert tr.on_input(_ev(action="down")) == ["t"]
    assert tr.on_input(_ev(action="down")) == []   # still held -> repeat, not a new edge
    assert calls == [("p", None)]


def test_up_does_not_fire_a_down_only_trigger():
    tr, calls = _runner(_profile(input_event="down", input_button="key:w"))
    tr.on_input(_ev(action="down"))
    assert tr.on_input(_ev(action="up")) == []
    assert calls == [("p", None)]


def test_wrong_button_is_never_considered():
    tr, calls = _runner(_profile(input_event="down", input_button="key:w"))
    assert tr.on_input(_ev(action="down", button="e")) == []
    assert calls == []
    assert input_history.recent("g", "t") == []   # irrelevant events aren't logged at all


def test_any_button_matches_either_device():
    tr, calls = _runner(_profile(input_event="down", input_button=""))
    assert tr.on_input(_ev(device="mouse", action="down", button="left")) == ["t"]
    assert calls == [("p", None)]


def test_chord_requires_held_modifier():
    tr, calls = _runner(_profile(input_event="down", input_button="key:w", input_mods=["ctrl"]))
    assert tr.on_input(_ev(action="down")) == []           # ctrl not held
    assert _dispositions("g", "t")[0] == "chord_miss"
    tr.on_input(_ev(action="up"))                            # release w before pressing it again
    tr.on_input(_ev(action="down", button="ctrl"))          # hold ctrl
    assert tr.on_input(_ev(action="down", button="w")) == ["t"]
    assert calls == [("p", None)]


def test_mouse_chord_modifier():
    tr, calls = _runner(_profile(input_event="down", input_button="key:e", input_mods=["mouse:left"]))
    assert tr.on_input(_ev(action="down", button="e")) == []   # left not held
    tr.on_input(_ev(action="up", button="e"))                  # release e before pressing it again
    tr.on_input(_ev(device="mouse", action="down", button="left"))
    assert tr.on_input(_ev(action="down", button="e")) == ["t"]


def test_window_gate_blocks_when_unrecognized():
    tr, calls = _runner(_profile(input_event="down", input_button="mouse:left",
                                 input_window="equipment"))
    down = _ev(device="mouse", action="down", button="left", x=50, y=50)
    up = _ev(device="mouse", action="up", button="left", x=50, y=50)
    assert tr.on_input(down) == []
    assert _dispositions("g", "t")[0] == "window_miss"
    tr.on_input(up)   # release before pressing again
    tr.set_input_context("equipment", PixelBox(0, 0, 100, 100))
    assert tr.on_input(down) == ["t"]
    assert calls == [("p", None)]


def test_rect_gate_maps_client_relative():
    tr, calls = _runner(_profile(input_event="down", input_button="mouse:left",
                                 input_window="equipment", input_rect=[0.5, 0.5, 0.25, 0.25]))
    tr.set_input_context("equipment", PixelBox(0, 0, 100, 100))
    outside = _ev(device="mouse", action="down", button="left", x=10, y=10)
    assert tr.on_input(outside) == []
    assert _dispositions("g", "t")[0] == "rect_miss"
    tr.on_input(_ev(device="mouse", action="up", button="left", x=10, y=10))   # release
    inside = _ev(device="mouse", action="down", button="left", x=60, y=60)   # fraction (0.6, 0.6)
    assert tr.on_input(inside) == ["t"]
    assert calls == [("p", None)]


def test_press_fires_on_release_of_a_matched_down():
    tr, calls = _runner(_profile(input_event="press", input_button="key:w"))
    assert tr.on_input(_ev(action="down")) == []     # armed, not fired yet
    assert tr.on_input(_ev(action="up")) == ["t"]
    assert calls == [("p", None)]


def test_double_requires_two_presses_within_window():
    clock = [0.0]
    tr, calls = _runner(_profile(input_event="double", input_button="key:w", input_double_ms=300),
                        clock)
    tr.on_input(_ev(action="down"))
    assert tr.on_input(_ev(action="up")) == []       # first press: armed, not a double yet
    assert _dispositions("g", "t")[0] == "awaiting_double"
    clock[0] = 0.1
    tr.on_input(_ev(action="down"))
    assert tr.on_input(_ev(action="up")) == ["t"]     # second press within 300ms -> double
    assert calls == [("p", None)]


def test_double_outside_window_is_two_singles_not_a_double():
    clock = [0.0]
    tr, calls = _runner(_profile(input_event="double", input_button="key:w", input_double_ms=100),
                        clock)
    tr.on_input(_ev(action="down"))
    tr.on_input(_ev(action="up"))
    clock[0] = 1.0   # well past the double window
    tr.on_input(_ev(action="down"))
    assert tr.on_input(_ev(action="up")) == []
    assert calls == []


def test_throttle_suppresses_and_logs():
    clock = [0.0]
    tr, calls = _runner(_profile(input_event="down", input_button="key:w", throttle_ms=1000), clock)
    assert tr.on_input(_ev(action="down")) == ["t"]
    tr.on_input(_ev(action="up"))
    clock[0] = 0.1
    assert tr.on_input(_ev(action="down")) == []   # inside the throttle window
    assert _dispositions("g", "t")[0] == "throttled"
    assert calls == [("p", None)]   # only the first fire went through
