"""HTTP-route tests for the file-source endpoints (/api/sources/*) via FastAPI TestClient.

These lock the wire contract the teach UI depends on — preview/read/find request+response shapes
and the error codes — without a GPU, network, or browser. The app is built with create_app() but
NOT entered as a context manager, so the lifespan daemons (watcher, warm thread) never start; the
routes resolve settings through ``get_settings``, which the fixture points at a temp profiles/data
dir holding one throwaway profile.
"""

from __future__ import annotations

import time

import pytest

pytest.importorskip("httpx")   # TestClient needs httpx; skip cleanly where dev extras aren't installed

from fastapi.testclient import TestClient  # noqa: E402

from oc.profile import save_profile  # noqa: E402
from oc.profile.models import (  # noqa: E402
    DatasetDef,
    FileSourceDef,
    GameProfile,
    KeyDef,
    SourceField,
    SourceMatch,
)
from oc.settings import Settings  # noqa: E402
from oc.store import store_for  # noqa: E402
from oc.store.keys import KeyMap, KeySpec  # noqa: E402
from oc.web.app import create_app  # noqa: E402

GAME = "g"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A TestClient wired to a temp settings dir holding profile ``g`` with one file source."""
    profiles_dir = tmp_path / "profiles"
    data_dir = tmp_path / "data"
    profiles_dir.mkdir()
    data_dir.mkdir()

    log = tmp_path / "EE.log"
    log.write_text("12:00 LOOT item=Forma\nchatter\n12:01 LOOT item=Kuva\n", encoding="utf-8")

    profile = GameProfile(
        name=GAME,
        datasets=[DatasetDef(id="loot")],
        file_sources=[FileSourceDef(
            id="src1", format="log_lines", path=str(log), dataset="loot",
            key=KeyDef(fields=["name"]), tail=False,
            match=[SourceMatch(op="starts_with", text="12")],
            fields=[SourceField(id="name", method="after", anchor="item=")],
        )],
    )
    save_profile(profiles_dir, profile)

    settings = Settings(profiles_dir=profiles_dir, data_dir=data_dir, captures_dir=tmp_path / "caps")
    # routes bind get_settings into their own namespace at import — patch it THERE
    monkeypatch.setattr("oc.web.routes.sources.get_settings", lambda: settings)

    # create_app() guards routes behind a loopback-only middleware (rejects non-loopback peers
    # with 403); give the TestClient a loopback client host so requests reach the routes.
    client = TestClient(create_app(), client=("127.0.0.1", 50000))
    return client, log, data_dir


# ---- formats ---------------------------------------------------------------

def test_formats_lists_every_parser(env):
    client, *_ = env
    r = client.get("/api/sources/formats")
    assert r.status_code == 200
    assert set(r.json()["formats"]) == {"log_lines", "ini", "json", "xml", "yaml"}


# ---- preview ---------------------------------------------------------------

def test_preview_log_sample(env):
    client, *_ = env
    r = client.post(f"/api/sources/{GAME}/preview", json={
        "id": "s", "format": "log_lines", "watch": "manual",
        "sample": "LOOT item=Forma qty=3\nnope\nLOOT item=Kuva qty=1",
        "match": [{"op": "contains", "text": "LOOT"}],
        "fields": [{"id": "name", "method": "after", "anchor": "item=", "stop": " "},
                   {"id": "qty", "method": "after", "anchor": "qty=", "type": "number"}],
    })
    assert r.status_code == 200
    body = r.json()
    assert body["rows"] == [{"name": "Forma", "qty": 3}, {"name": "Kuva", "qty": 1}]
    assert body["matched"] == 2 and body["total"] == 3


def test_preview_reads_the_real_file_when_no_sample(env):
    client, *_ = env
    r = client.post(f"/api/sources/{GAME}/preview", json={
        "id": "src1", "format": "log_lines", "path": env[1].as_posix(),
        "match": [{"op": "starts_with", "text": "12"}],
        "fields": [{"id": "name", "method": "after", "anchor": "item="}],
    })
    assert r.status_code == 200
    body = r.json()
    assert body["rows"] == [{"name": "Forma"}, {"name": "Kuva"}]
    assert body["line_ending"] in {"LF", "CRLF", "CR"}   # detected from the real file's bytes


def test_preview_ini_sample(env):
    client, *_ = env
    r = client.post(f"/api/sources/{GAME}/preview", json={
        "id": "c", "format": "ini",
        "sample": "[Graphics]\nResolution=1920",
        "fields": [{"id": "res", "method": "path", "path": "Graphics.Resolution", "type": "number"}],
    })
    assert r.status_code == 200
    assert r.json()["rows"] == [{"res": 1920}]


def test_preview_unknown_format_400(env):
    client, *_ = env
    r = client.post(f"/api/sources/{GAME}/preview", json={"id": "x", "format": "nonsense"})
    assert r.status_code == 400


def test_preview_bad_body_422(env):
    client, *_ = env
    r = client.post(f"/api/sources/{GAME}/preview", json={"format": "log_lines"})   # missing required id
    assert r.status_code == 422


def test_preview_unknown_profile_404(env):
    client, *_ = env
    r = client.post("/api/sources/__nope__/preview", json={"id": "s", "format": "log_lines"})
    assert r.status_code == 404


# ---- find ------------------------------------------------------------------

def test_find_matches_filename_in_given_roots(env, tmp_path, monkeypatch):
    client, *_ = env
    monkeypatch.setattr("oc.source.locate.default_roots", lambda: [])   # search only the roots we pass
    found_dir = tmp_path / "look"
    found_dir.mkdir()
    (found_dir / "EE.log").write_text("x", encoding="utf-8")
    r = client.post(f"/api/sources/{GAME}/find", json={"filename": "EE.log", "roots": [str(found_dir)]})
    assert r.status_code == 200
    paths = [c["path"] for c in r.json()["candidates"]]
    assert str(found_dir / "EE.log") in paths


def test_find_unknown_profile_404(env):
    client, *_ = env
    r = client.post("/api/sources/__nope__/find", json={"filename": "EE.log"})
    assert r.status_code == 404


# ---- read ------------------------------------------------------------------

def test_read_writes_rows_to_dataset(env):
    client, _log, data_dir = env
    r = client.post(f"/api/sources/{GAME}/src1/read")
    assert r.status_code == 200
    body = r.json()
    # the read runs on a daemon thread now (so a big log can't time out the request)
    assert body["dataset"] == "loot" and body["started"] is True

    # wait for the background read's rows to land (fresh store each poll so it can't read a stale cache)
    names: set = set()
    for _ in range(100):
        names = {rec.get("name") for rec in store_for(data_dir, GAME, "loot", key=KeyMap(KeySpec(("name",)))).records()}
        if names == {"Forma", "Kuva"}:
            break
        time.sleep(0.02)
    assert names == {"Forma", "Kuva"}


def test_read_unknown_source_404(env):
    client, *_ = env
    r = client.post(f"/api/sources/{GAME}/nope/read")
    assert r.status_code == 404
