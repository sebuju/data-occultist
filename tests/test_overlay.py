"""Overlay: visibility bus + host gating. Pure logic — never spawns a window."""

from __future__ import annotations

from oc.overlay import events, manager


def test_manager_is_disabled_under_pytest():
    """The suite must never spawn an overlay window: `available()` gates on PYTEST_CURRENT_TEST,
    which pytest sets for every test, so start() is a no-op here regardless of platform."""
    ok, why = manager.available()
    assert ok is False
    assert why
    assert manager.start("http://127.0.0.1:1/overlay") is False


def test_publish_and_read_current():
    events.reset()
    events.publish_overlays("g", ["hud", "alerts"])
    assert events.current("g") == ["alerts", "hud"]     # sorted, so order in never matters
    assert events.current("other") == []


def test_unchanged_set_does_not_notify():
    """The resolver may call this every gate tick (0.25s); an unchanged set must cost nothing."""
    events.reset()
    seen = []
    off = events.subscribe(lambda game, ids: seen.append((game, ids)))
    try:
        events.publish_overlays("g", ["hud"])
        events.publish_overlays("g", ["hud"])        # same
        events.publish_overlays("g", ["hud"])        # same again
        assert seen == [("g", ["hud"])]
        events.publish_overlays("g", ["hud", "x"])   # a real change does notify
        assert len(seen) == 2
    finally:
        off()


def test_ids_are_normalised_and_blanks_dropped():
    events.reset()
    events.publish_overlays("g", ["b", "", None, "a", "a"])
    assert events.current("g") == ["a", "a", "b"]


def test_empty_game_is_ignored():
    events.reset()
    events.publish_overlays("", ["hud"])
    assert events.current("") == []


def test_reset_clears_one_game_or_all():
    events.reset()
    events.publish_overlays("g1", ["a"])
    events.publish_overlays("g2", ["b"])
    events.reset("g1")
    assert events.current("g1") == []
    assert events.current("g2") == ["b"]
    events.reset()
    assert events.current("g2") == []


def test_bad_subscriber_cannot_break_the_resolver():
    events.reset()
    good = []
    off_bad = events.subscribe(lambda *_: (_ for _ in ()).throw(RuntimeError("boom")))
    off_good = events.subscribe(lambda game, ids: good.append(ids))
    try:
        events.publish_overlays("g", ["hud"])
        assert good == [["hud"]]
    finally:
        off_bad()
        off_good()
