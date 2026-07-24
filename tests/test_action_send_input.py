"""Action-node send-events targets: a `"window:<id>"` source + `input_events` sends a scripted
key/mouse/scroll/delay sequence to that window when the action fires. Pure logic, no GPU, no real
`SendInput` — `send_token` is monkeypatched and the live session is a hand-rolled fake, so every
gate check and timed step is driven explicitly here (mirrors test_action_timing.py's FakeTimer
style for the OTHER async action primitive, repeated sound cues).

The two hard requirements this pins: (1) a send-events run is gated on the bound window being both
the CURRENTLY-RECOGNIZED one and FOREGROUND, re-checked before EVERY individual send (not just once
per fire) so a mid-sequence alt-tab stops the rest; (2) a denial is reported via
`action_history.record` — which, being a `HistoryRing` feeder, also lands in the node log file with
no extra plumbing.
"""

import pytest

from oc.collect import action_history, live
from oc.collect.triggers import fire_action
from oc.profile.models import ActionDef, GameProfile, InputEvent
from oc.window import send_input


class FakeTimer:
    """threading.Timer's shape, driven by hand — see test_action_timing.py's FakeTimer for the
    full rationale. Duplicated here (not imported) because pytest test modules aren't meant to
    import each other's fixtures; the shape is tiny and stable."""

    pending: list["FakeTimer"] = []

    def __init__(self, interval, function, args=None, kwargs=None):
        self.interval, self.function = interval, function
        self.args, self.kwargs = args or [], kwargs or {}

    def start(self):
        FakeTimer.pending.append(self)

    @classmethod
    def run_all(cls, limit=200):
        fired = []
        while cls.pending:
            if len(fired) >= limit:
                raise AssertionError("timer cascade did not terminate")
            t = cls.pending.pop(0)
            fired.append(t.interval)
            t.function(*t.args, **t.kwargs)
        return fired


class FakeSession:
    """Stands in for `LiveSession.current_input_target()` — a fixed or a scripted per-call
    (window_id, WindowInfo-or-None, foreground) triple, matching exactly what `_run_input_events`
    reads and nothing else (no real window handle needed since `send_token` is faked too)."""

    def __init__(self, answers):
        # a single (win, fg) pair (every call answers the same), or a list consumed one-per-call
        # (for a mid-sequence drop) — a `WindowInfo` stand-in is just `object()`, never inspected.
        self._answers = answers if isinstance(answers, list) else None
        self._fixed = answers if not isinstance(answers, list) else None
        self._i = 0

    def current_input_target(self):
        if self._fixed is not None:
            win, fg = self._fixed
        else:
            win, fg = self._answers[min(self._i, len(self._answers) - 1)]
            self._i += 1
        return (win, object() if win else None, fg)


@pytest.fixture(autouse=True)
def _clean_timers():
    FakeTimer.pending = []
    yield
    FakeTimer.pending = []


@pytest.fixture(autouse=True)
def _clean_session_and_history():
    yield
    live._ACTIVE_SESSIONS.pop("g", None)
    action_history.clear("g")


@pytest.fixture
def sent():
    """Capture every token `send_input.send_token` was called with, faking every call as a success
    so the test never actually touches the OS input queue."""
    seen: list[str] = []

    def fake(token):
        seen.append(token)
        return True
    orig = send_input.send_token
    send_input.send_token = fake
    yield seen
    send_input.send_token = orig


def _profile(*actions):
    return GameProfile(name="g", actions=list(actions))


def _fire(profile, action_id, tmp_path, trigger_id=None):
    action = next(a for a in profile.actions if a.id == action_id)
    return fire_action("g", action, tmp_path, profile=profile, trigger_id=trigger_id, timer_factory=FakeTimer)


# ---- the happy path: foreground + matching window sends everything, in order ------------------

def test_full_sequence_sends_in_order_when_gate_holds(tmp_path, sent):
    live._ACTIVE_SESSIONS["g"] = FakeSession(("equipment", True))
    prof = _profile(ActionDef(id="a", sources=["window:equipment"], input_events=[
        InputEvent(token="key:e", repeat=2, delay_ms=10),
        InputEvent(token="delay", delay_ms=50),
        InputEvent(token="scroll:down"),
    ]))
    assert _fire(prof, "a", tmp_path) is True
    assert FakeTimer.run_all() == [0.01, 0.05]   # between-repeat gap, then the delay row's wait
    assert sent == ["key:e", "key:e", "scroll:down"]
    hist = action_history.recent("g", "a")[0]
    assert (hist["sent"], hist["denied"], hist["reason"]) == (3, False, "")


def test_no_window_source_is_a_noop(tmp_path, sent):
    """input_events with nothing bound to send them to does nothing (not even a gate check) —
    mirrors a dataset action op with no dataset source attached."""
    prof = _profile(ActionDef(id="a", input_events=[InputEvent(token="key:e")]))
    assert _fire(prof, "a", tmp_path) is False
    assert sent == []


def test_window_source_with_no_events_is_a_noop(tmp_path, sent):
    live._ACTIVE_SESSIONS["g"] = FakeSession(("equipment", True))
    prof = _profile(ActionDef(id="a", sources=["window:equipment"]))
    assert _fire(prof, "a", tmp_path) is False
    assert sent == []


# ---- denial: wrong window or not foreground, checked BEFORE the first send --------------------

def test_denied_when_bound_window_is_not_the_recognized_one(tmp_path, sent):
    live._ACTIVE_SESSIONS["g"] = FakeSession(("other", True))
    prof = _profile(ActionDef(id="a", sources=["window:equipment"],
                              input_events=[InputEvent(token="key:e")]))
    assert _fire(prof, "a", tmp_path, trigger_id="t1") is False
    assert sent == []
    hist = action_history.recent("g", "a")[0]
    assert (hist["sent"], hist["denied"], hist["reason"], hist["trigger"]) == (0, True, "window_inactive", "t1")


def test_denied_when_recognized_but_not_foreground(tmp_path, sent):
    live._ACTIVE_SESSIONS["g"] = FakeSession(("equipment", False))
    prof = _profile(ActionDef(id="a", sources=["window:equipment"],
                              input_events=[InputEvent(token="key:e")]))
    assert _fire(prof, "a", tmp_path) is False
    assert sent == []
    hist = action_history.recent("g", "a")[0]
    assert (hist["denied"], hist["reason"]) == (True, "not_foreground")


def test_denied_when_no_live_session(tmp_path, sent):
    prof = _profile(ActionDef(id="a", sources=["window:equipment"],
                              input_events=[InputEvent(token="key:e")]))
    assert _fire(prof, "a", tmp_path) is False
    assert sent == []
    hist = action_history.recent("g", "a")[0]
    assert (hist["denied"], hist["reason"]) == (True, "window_inactive")


# ---- the gate is re-checked between repeats, not just once -------------------------------------

def test_gate_recheck_stops_a_mid_sequence_alt_tab(tmp_path, sent):
    """Foreground holds for the first send, then drops — the SECOND repeat must never send, and the
    run is reported denied with a partial `sent` count, not silently truncated."""
    live._ACTIVE_SESSIONS["g"] = FakeSession([("equipment", True), ("equipment", True), ("equipment", False)])
    prof = _profile(ActionDef(id="a", sources=["window:equipment"],
                              input_events=[InputEvent(token="key:e", repeat=3, delay_ms=5)]))
    assert _fire(prof, "a", tmp_path) is True   # got past the FIRST gate check, so it did start
    FakeTimer.run_all()
    assert sent == ["key:e"]                    # only the first repeat landed
    hist = action_history.recent("g", "a")[0]
    assert (hist["sent"], hist["denied"], hist["reason"]) == (1, True, "not_foreground")


# ---- profile round-trip -------------------------------------------------------------------------

def test_input_events_survive_a_profile_round_trip():
    prof = GameProfile(name="g", actions=[ActionDef(
        id="a", sources=["window:equipment"], input_events=[
            InputEvent(token="key:e", repeat=2, delay_ms=80),
            InputEvent(token="delay", delay_ms=200),
        ])])
    back = GameProfile.model_validate(prof.model_dump())
    x = back.actions[0]
    assert x.sources == ["window:equipment"]
    assert [(e.token, e.repeat, e.delay_ms) for e in x.input_events] == [("key:e", 2, 80), ("delay", 1, 200)]
