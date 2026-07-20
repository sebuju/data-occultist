"""Action-node timing and non-dataset targets: `delay_ms`, repeated sound cues, and action->action
chaining. Pure logic, no GPU, no sleeping — the timer is injected, so every deferral is driven
explicitly here.

All scheduling for an action node lives server-side ON PURPOSE (a backgrounded browser tab throttles
its timers to ~1s but not its SSE delivery, so client-side spacing would silently stretch). These
tests are what pins that: a delayed action must do NOTHING until its timer runs, and `repeat` must
come out as N separate fire-bus pushes rather than one push carrying a schedule.
"""

import pytest

from oc.collect.triggers import fire_action
from oc.profile.models import ActionDef, GameProfile, SoundDef
from oc.store import fire_events


class FakeTimer:
    """threading.Timer's shape, driven by hand. Started timers land in `pending` (a class-level
    queue) in arming order; `run_all` fires them, including any armed BY a callback (that's how a
    repeat chain re-arms), so a test can assert on the fully-drained cascade."""

    pending: list["FakeTimer"] = []

    def __init__(self, interval, function, args=None, kwargs=None):
        self.interval, self.function = interval, function
        self.args, self.kwargs = args or [], kwargs or {}

    def start(self):
        FakeTimer.pending.append(self)

    @classmethod
    def run_all(cls, limit=200):
        """Drain the queue, newest arms included. `limit` keeps a runaway chain from hanging a test
        run — a cycle guard failure shows up as this raising, not as a wedged suite."""
        fired = []
        while cls.pending:
            if len(fired) >= limit:
                raise AssertionError("timer cascade did not terminate")
            t = cls.pending.pop(0)
            fired.append(t.interval)
            t.function(*t.args, **t.kwargs)
        return fired


@pytest.fixture(autouse=True)
def _clean_timers():
    FakeTimer.pending = []
    yield
    FakeTimer.pending = []


@pytest.fixture
def cues():
    """Capture every fire-bus push as (trigger_id, [sound ids])."""
    seen: list[tuple[str, list]] = []
    off = fire_events.subscribe(lambda game, tid, sounds: seen.append((tid, list(sounds))))
    yield seen
    off()


def _profile(*actions, sounds=("beep",), disabled=()):
    return GameProfile(
        name="g",
        sounds=[SoundDef(id=s, file=f"{s}.wav", enabled=s not in disabled) for s in sounds],
        actions=list(actions),
    )


def _fire(profile, action_id, tmp_path):
    action = next(a for a in profile.actions if a.id == action_id)
    return fire_action("g", action, tmp_path, profile=profile, timer_factory=FakeTimer)


# ---- sound targets: the cue, and repeat as N pushes ------------------------------------------

def test_sound_target_cues_the_browser(tmp_path, cues):
    prof = _profile(ActionDef(id="a", sources=["sound:beep"]))
    assert _fire(prof, "a", tmp_path) is True     # no dataset op, but it DID something
    assert cues == [("action:a", ["beep"])]


def test_repeat_publishes_one_cue_per_play_spaced_by_repeat_ms(tmp_path, cues):
    prof = _profile(ActionDef(id="a", sources=["sound:beep"], repeat=3, repeat_ms=250))
    _fire(prof, "a", tmp_path)
    assert cues == [("action:a", ["beep"])]       # first play is immediate
    assert FakeTimer.run_all() == [0.25, 0.25]    # then two more, at the set spacing
    assert cues == [("action:a", ["beep"])] * 3


def test_disabled_sound_is_never_cued(tmp_path, cues):
    prof = _profile(ActionDef(id="a", sources=["sound:beep"]), disabled=("beep",))
    assert _fire(prof, "a", tmp_path) is False
    assert cues == []


def test_unknown_sound_ref_is_dropped(tmp_path, cues):
    prof = _profile(ActionDef(id="a", sources=["sound:ghost"]))
    assert _fire(prof, "a", tmp_path) is False
    assert cues == []


# ---- delay: nothing happens until the timer runs ----------------------------------------------

def test_delay_defers_everything_until_the_timer_fires(tmp_path, cues):
    prof = _profile(ActionDef(id="a", sources=["sound:beep"], delay_ms=500))
    assert _fire(prof, "a", tmp_path) is True     # scheduled counts as fired
    assert cues == []                             # ...but nothing ran yet
    assert FakeTimer.run_all() == [0.5]
    assert cues == [("action:a", ["beep"])]


def test_delay_is_not_a_debounce(tmp_path, cues):
    """Two fires inside the window are two delayed runs, not one — coalescing belongs on the
    trigger (throttle/settle), not here."""
    prof = _profile(ActionDef(id="a", sources=["sound:beep"], delay_ms=100))
    _fire(prof, "a", tmp_path)
    _fire(prof, "a", tmp_path)
    FakeTimer.run_all()
    assert cues == [("action:a", ["beep"])] * 2


# ---- chaining ---------------------------------------------------------------------------------

def test_chained_action_fires_downstream(tmp_path, cues):
    prof = _profile(
        ActionDef(id="a", sources=["action:b"]),
        ActionDef(id="b", sources=["sound:beep"]),
    )
    assert _fire(prof, "a", tmp_path) is True
    assert cues == [("action:b", ["beep"])]       # the cue is named by the node that OWNS the sound


def test_chain_delays_accumulate(tmp_path, cues):
    """Each link waits its own delay, so b lands `a.delay + b.delay` after the fire without any
    accumulation logic — b's timer is only armed once a's has run."""
    prof = _profile(
        ActionDef(id="a", sources=["action:b"], delay_ms=200),
        ActionDef(id="b", sources=["sound:beep"], delay_ms=300),
    )
    _fire(prof, "a", tmp_path)
    assert FakeTimer.run_all() == [0.2, 0.3]
    assert cues == [("action:b", ["beep"])]


def test_chain_cycle_terminates(tmp_path, cues):
    prof = _profile(
        ActionDef(id="a", sources=["action:b"]),
        ActionDef(id="b", sources=["action:a", "sound:beep"]),
    )
    _fire(prof, "a", tmp_path)      # would recurse forever without the `seen` guard
    FakeTimer.run_all()
    assert cues == [("action:b", ["beep"])]


def test_disabled_link_stops_the_chain(tmp_path, cues):
    prof = _profile(
        ActionDef(id="a", sources=["action:b"]),
        ActionDef(id="b", sources=["sound:beep"], enabled=False),
    )
    assert _fire(prof, "a", tmp_path) is False
    assert cues == []


# ---- back-compat: a plain dataset action still behaves ----------------------------------------

def test_actionless_node_with_no_targets_is_a_noop(tmp_path, cues):
    prof = _profile(ActionDef(id="a"))
    assert _fire(prof, "a", tmp_path) is False
    assert cues == []


def test_dataset_source_with_no_op_set_runs_nothing(tmp_path, cues):
    prof = _profile(ActionDef(id="a", sources=["dataset:loot"]))
    assert _fire(prof, "a", tmp_path) is False


def test_trigger_pulse_is_immediate_not_delayed(tmp_path, monkeypatch, cues):
    """The trigger->action wire should flash when the TRIGGER fires, not `delay_ms` later."""
    pulses = []
    monkeypatch.setattr("oc.collect.triggers.publish_flow",
                        lambda game, kind, src, dst, n: pulses.append((src, dst)))
    prof = _profile(ActionDef(id="a", sources=["sound:beep"], delay_ms=400))
    action = next(a for a in prof.actions if a.id == "a")
    fire_action("g", action, tmp_path, profile=prof, trigger_id="t1", timer_factory=FakeTimer)
    assert pulses == [("trigger:t1", "action:a")]
    assert cues == []


def test_sound_and_action_refs_survive_a_profile_round_trip():
    prof = GameProfile(name="g", actions=[ActionDef(
        id="a", sources=["dataset:loot", "sound:beep", "action:b"], delay_ms=250, repeat=4,
        repeat_ms=120)])
    back = GameProfile.model_validate(prof.model_dump())
    x = back.actions[0]
    assert x.sources == ["dataset:loot", "sound:beep", "action:b"]
    assert (x.delay_ms, x.repeat, x.repeat_ms) == (250, 4, 120)
