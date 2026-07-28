"""Overlay visibility resolution — the four show-sources and the gate suppressor. Pure logic."""

from __future__ import annotations

from oc.overlay import visibility
from oc.profile.models import GameProfile, GateDef, OverlayDef


def _profile(*overlays, gates=()):
    return GameProfile(name="g", overlays=list(overlays), gates=list(gates))


def _ids(profile, **kw):
    visibility.clear_pulses()
    return visibility.visible_ids(profile, "g", **kw)


def test_follow_window_shows_only_on_the_bound_window():
    p = _profile(OverlayDef(id="hud", window="mission"))
    assert _ids(p, window_id="mission") == ["hud"]
    assert _ids(p, window_id="equipment") == []
    assert _ids(p, window_id="") == []


def test_states_narrow_the_window_match():
    p = _profile(OverlayDef(id="hud", window="mission", states=["in_mission"]))
    assert _ids(p, window_id="mission", state_id="in_mission") == ["hud"]
    assert _ids(p, window_id="mission", state_id="menu") == []
    # empty states = any state of that window
    p2 = _profile(OverlayDef(id="hud", window="mission"))
    assert _ids(p2, window_id="mission", state_id="menu") == ["hud"]


def test_follow_window_off_means_the_window_never_shows_it():
    p = _profile(OverlayDef(id="hud", window="mission", follow_window=False))
    assert _ids(p, window_id="mission") == []


def test_manual_shows_regardless_of_window():
    p = _profile(OverlayDef(id="hud", window="mission", manual=True))
    assert _ids(p, window_id="somewhere_else") == ["hud"]


def test_disabled_overlay_never_shows():
    p = _profile(OverlayDef(id="hud", window="mission", manual=True, enabled=False))
    assert _ids(p, window_id="mission") == []


def test_gate_alone_drives_visibility():
    p = _profile(OverlayDef(id="hud", window="mission", follow_window=False),
                 gates=[GateDef(id="g1", targets=["hud"])])
    assert visibility.visible_ids(p, "g", gate_states={"g1": True}) == ["hud"]
    assert visibility.visible_ids(p, "g", gate_states={"g1": False}) == []


def test_blocking_gate_suppresses_every_other_reason():
    """A gate means the same thing here as everywhere else: blocked is blocked, even when the
    window matches and the overlay is forced on manually."""
    p = _profile(OverlayDef(id="hud", window="mission", manual=True),
                 gates=[GateDef(id="g1", targets=["hud"])])
    assert visibility.visible_ids(p, "g", window_id="mission",
                                  gate_states={"g1": False}) == []
    assert visibility.visible_ids(p, "g", window_id="mission",
                                  gate_states={"g1": True}) == ["hud"]


def test_gate_with_no_live_state_is_ignored():
    """Live isn't running (or the gate is disabled) -> the gate neither shows nor suppresses."""
    p = _profile(OverlayDef(id="hud", window="mission"),
                 gates=[GateDef(id="g1", targets=["hud"])])
    assert visibility.visible_ids(p, "g", window_id="mission", gate_states={}) == ["hud"]


def test_pulse_shows_then_expires():
    p = _profile(OverlayDef(id="hud", window="mission", follow_window=False, pulse_ms=4000))
    visibility.clear_pulses()
    visibility.pulse("g", "hud", 4000)
    now = __import__("time").monotonic()
    assert visibility.visible_ids(p, "g", now=now) == ["hud"]
    assert visibility.visible_ids(p, "g", now=now + 3.9) == ["hud"]
    assert visibility.visible_ids(p, "g", now=now + 4.1) == []


def test_zero_pulse_records_nothing():
    p = _profile(OverlayDef(id="hud", window="mission", follow_window=False, pulse_ms=0))
    visibility.clear_pulses()
    visibility.pulse("g", "hud", 0)
    assert visibility.visible_ids(p, "g") == []


def test_pulse_is_per_game():
    p = _profile(OverlayDef(id="hud", window="mission", follow_window=False))
    visibility.clear_pulses()
    visibility.pulse("other", "hud", 4000)
    assert visibility.visible_ids(p, "g") == []
    visibility.clear_pulses()
