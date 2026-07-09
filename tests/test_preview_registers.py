"""/api/preview -> LiveSession register feed (pure logic; no OCR/network/game window).

A register's `persist` must work off a one-shot /api/preview OCR read too, not just a running
live collector -- see LiveSession.feed_registers. _feed_live_registers is the small glue that
routes a preview read's readouts into `game`'s live session, cache-hit or not.
"""

from oc.web.routes import preview as preview_routes


def test_feed_live_registers_calls_session_feed(monkeypatch):
    calls = []

    class _FakeSession:
        def feed_registers(self, readouts, confs):
            calls.append((readouts, confs))

    monkeypatch.setattr(preview_routes, "session_for", lambda game, create=False: _FakeSession())
    preview_routes._feed_live_registers(
        "warframe", {"readouts_all": {"health": 1}, "readout_confs_all": {"health": 0.9}})
    assert calls == [({"health": 1}, {"health": 0.9})]


def test_feed_live_registers_creates_session_lazily(monkeypatch):
    seen = {}

    def _fake(game, create=False):
        seen["args"] = (game, create)
        return None

    monkeypatch.setattr(preview_routes, "session_for", _fake)
    preview_routes._feed_live_registers("warframe", {"readouts_all": {"health": 1}})
    assert seen["args"] == ("warframe", True)   # create=True -- a preview read must not 404


def test_feed_live_registers_noop_without_readouts(monkeypatch):
    calls = []
    monkeypatch.setattr(preview_routes, "session_for", lambda game, create=False: calls.append(1))
    preview_routes._feed_live_registers("warframe", {"readouts_all": {}})
    preview_routes._feed_live_registers("warframe", {})
    assert calls == []   # nothing to feed -> never even look up a session


def test_feed_live_registers_noop_without_game():
    # capture-less / no-game preview calls (a bare live-grab with no stashed image context)
    # must not raise for lack of a game to key a session by.
    preview_routes._feed_live_registers("", {"readouts_all": {"health": 1}})
    preview_routes._feed_live_registers(None, {"readouts_all": {"health": 1}})


def test_feed_live_registers_tolerates_no_session(monkeypatch):
    monkeypatch.setattr(preview_routes, "session_for", lambda game, create=False: None)
    preview_routes._feed_live_registers("warframe", {"readouts_all": {"health": 1}})   # must not raise
