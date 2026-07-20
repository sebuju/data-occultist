"""HTTP-route tests for the testing-inspector feed endpoint (POST /api/test/feed_readouts).

The node inspector feeds synthetic readout values into a game's live session with no OCR and
no game running — these lock that the feed actually lands in LiveSession state (not just a
fake ack) and that bad window/readout ids are rejected cleanly.
"""

from __future__ import annotations

import pytest

pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from oc.profile import save_profile  # noqa: E402
from oc.profile.loader import load_profile  # noqa: E402
from oc.profile.models import (  # noqa: E402
    DatasetDef, FieldDef, GameProfile, ReadoutDef, TestFeedDef, TestingDef, WindowDef,
)
from oc.settings import Settings  # noqa: E402
from oc.web.app import create_app  # noqa: E402

GAME = "g"


@pytest.fixture
def env(tmp_path, monkeypatch):
    profiles_dir = tmp_path / "profiles"
    data_dir = tmp_path / "data"
    profiles_dir.mkdir()
    data_dir.mkdir()

    profile = GameProfile(
        name=GAME,
        windows=[WindowDef(
            id="win1",
            fields=[FieldDef(id="f1", type="number"), FieldDef(id="f2", type="text")],
            readouts=[ReadoutDef(id="ro1", field="f1",
                                 box={"x": 0, "y": 0, "w": 0.1, "h": 0.1}, enabled=True),
                      ReadoutDef(id="ro2", field="f2",
                                 box={"x": 0, "y": 0.2, "w": 0.1, "h": 0.1}, enabled=True)],
        )],
    )
    save_profile(profiles_dir, profile)

    settings = Settings(profiles_dir=profiles_dir, data_dir=data_dir, captures_dir=tmp_path / "caps")
    # session_for() (live.py) resolves the game's session through this settings accessor.
    monkeypatch.setattr("oc.web.routes.live.get_settings", lambda: settings)
    return TestClient(create_app(), client=("127.0.0.1", 50001)), profile


def _post(client, profile, window_id="win1", values=None, game=GAME):
    return client.post(f"/api/test/feed_readouts?game={game}",
                       json={"profile": profile.model_dump(mode="json"),
                             "window_id": window_id, "values": values or {}})


def test_feed_readouts_lands_in_live_session(env):
    client, profile = env
    r = _post(client, profile, values={"ro1": 42})
    assert r.status_code == 200
    assert r.json() == {"fed": ["ro1"]}

    status = client.get(f"/api/live/{GAME}/status").json()
    assert status["readouts"]["ro1"] == 42
    assert status["readouts_all"]["ro1"] == 42


def test_feed_partial_does_not_500(env):
    """Feeding SOME of a window's readouts must not blow up on the ones left out. Regression: the
    trace built an entry for every enabled readout with `conf=None` for the un-fed ones, and
    readout_history.record does `round(conf, 3)` -> TypeError (a 500 on every real partial feed;
    the single-readout fixture never hit it)."""
    client, profile = env
    r = _post(client, profile, values={"ro1": 7})       # ro2 deliberately omitted
    assert r.status_code == 200, r.text
    assert r.json() == {"fed": ["ro1"]}
    # only the FED readout gets a history row — an un-fed readout was never read, so recording it
    # would invent a phantom read
    hist = client.get(f"/api/live/{GAME}/status").json().get("readout_history") or {}
    assert "win1:ro1" in hist
    assert "win1:ro2" not in hist


def test_feed_readouts_unknown_window_404(env):
    client, profile = env
    r = _post(client, profile, window_id="nope", values={"ro1": 1})
    assert r.status_code == 404


def test_feed_readouts_unknown_readout_400(env):
    client, profile = env
    r = _post(client, profile, values={"ghost": 1})
    assert r.status_code == 400


def test_feed_readouts_unknown_game_404(env):
    client, profile = env
    r = _post(client, profile, values={"ro1": 1}, game="nope")
    assert r.status_code == 404


# ---- testing-inspector configs persist to YAML (all optional) --------------------------------
# The panel writes what you typed onto the def it feeds, so a reload restores the row instead of
# resetting it. These lock the round-trip AND that an untouched profile carries no test blocks.

def test_test_configs_absent_by_default(tmp_path):
    """A profile nobody test-fed must not sprout `test:` / `testing:` noise."""
    d = tmp_path / "p"
    d.mkdir()
    save_profile(d, GameProfile(name="g", windows=[WindowDef(id="w")], datasets=[DatasetDef(id="ds")]))
    text = (d / "g.yaml").read_text(encoding="utf-8")
    assert "test_row" not in text
    assert "testing:" not in text
    assert "test:" not in text
    back = load_profile(d, "g")
    assert back.testing is None
    assert back.datasets[0].test_row is None


def test_readout_and_dataset_test_configs_round_trip(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    profile = GameProfile(
        name="g",
        windows=[WindowDef(
            id="w", fields=[FieldDef(id="f1", type="number")],
            readouts=[ReadoutDef(id="ro1", field="f1", box={"x": 0, "y": 0, "w": 0.1, "h": 0.1},
                                 test=TestFeedDef(mode="countdown", min="0", max="10", step="1"))],
        )],
        datasets=[DatasetDef(id="ds", test_row={"name": TestFeedDef(mode="random", pool="a, b"),
                                                "plat": TestFeedDef(mode="random", type="number",
                                                                    min="1", max="50", integer=True)})],
        testing=TestingDef(loop_ms=250, garble=True, garble_pct=35, include_datasets=True),
    )
    save_profile(d, profile)
    back = load_profile(d, "g")

    ro = back.windows[0].readouts[0].test
    assert ro.mode == "countdown" and ro.min == "0" and ro.max == "10" and ro.step == "1"
    cols = back.datasets[0].test_row
    assert cols["name"].mode == "random" and cols["name"].pool == "a, b"
    assert cols["plat"].type == "number" and cols["plat"].integer is True
    t = back.testing
    assert (t.loop_ms, t.garble, t.garble_pct, t.include_datasets) == (250, True, 35, True)


def test_readout_test_config_survives_a_rename(tmp_path):
    """The config rides the ReadoutDef, so renaming the readout carries it — no repoint site."""
    d = tmp_path / "p"
    d.mkdir()
    profile = GameProfile(name="g", windows=[WindowDef(
        id="w", fields=[FieldDef(id="f1")],
        readouts=[ReadoutDef(id="old", field="f1", box={"x": 0, "y": 0, "w": 0.1, "h": 0.1},
                             test=TestFeedDef(mode="countup", max="7"))])])
    profile.windows[0].readouts[0].id = "new"      # what renameReadout does to the def
    save_profile(d, profile)
    ro = load_profile(d, "g").windows[0].readouts[0]
    assert ro.id == "new" and ro.test.mode == "countup" and ro.test.max == "7"


def test_disabled_test_config_round_trips(tmp_path):
    """`enabled: false` is itself configuration — a row muted at otherwise-stock settings must
    survive a save/load, not get pruned as an "empty" block and come back silently enabled."""
    d = tmp_path / "p"
    d.mkdir()
    profile = GameProfile(name="g", windows=[WindowDef(
        id="w", fields=[FieldDef(id="f1")],
        readouts=[ReadoutDef(id="ro1", field="f1", box={"x": 0, "y": 0, "w": 0.1, "h": 0.1},
                             test=TestFeedDef(enabled=False))])],
        datasets=[DatasetDef(id="ds", test_row={"plat": TestFeedDef(enabled=False, mode="random")})])
    save_profile(d, profile)
    back = load_profile(d, "g")
    assert back.windows[0].readouts[0].test.enabled is False
    assert back.datasets[0].test_row["plat"].enabled is False


def test_test_config_defaults_to_enabled(tmp_path):
    """An existing config written before the toggle existed must read back as ON, not off."""
    d = tmp_path / "p"
    d.mkdir()
    save_profile(d, GameProfile(name="g", windows=[WindowDef(
        id="w", fields=[FieldDef(id="f1")],
        readouts=[ReadoutDef(id="ro1", field="f1", box={"x": 0, "y": 0, "w": 0.1, "h": 0.1},
                             test=TestFeedDef(mode="countup", max="9"))])]))
    text = (d / "g.yaml").read_text(encoding="utf-8")
    # simulate a profile authored before `enabled` existed
    text = "\n".join(ln for ln in text.splitlines() if ln.strip() != "enabled: true")
    (d / "g.yaml").write_text(text, encoding="utf-8")
    ro = load_profile(d, "g").windows[0].readouts[0]
    assert ro.test.enabled is True and ro.test.mode == "countup"
