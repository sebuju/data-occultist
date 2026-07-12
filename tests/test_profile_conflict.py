"""Stale-tab save guard (GET ETag / PUT If-Match on /api/profiles/{name}).

Two browser tabs (or a tab + an external edit) can both hold a profile loaded, then both
save — without a guard the later PUT silently clobbers whatever the other one wrote (lost
update). These lock the optimistic-concurrency contract added to
src/oc/web/routes/profiles.py + profile_signature/structural_yaml (src/oc/profile/loader.py):
GET tags the response with a structural ETag; PUT rejects a mismatched If-Match with 409 and
both YAMLs + a timestamp for the conflict modal; a save with no If-Match (first-ever save, or
the modal's own "overwrite") always goes through unconditionally; and a save that only touches
non-structural fields (layout/geometry) never changes the token, so a foreign layout-only save
never trips a false conflict.
"""

from __future__ import annotations

import pytest

pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from oc.profile.models import GameProfile  # noqa: E402
from oc.settings import Settings  # noqa: E402
from oc.web.app import create_app  # noqa: E402

GAME = "g"


@pytest.fixture
def env(tmp_path, monkeypatch):
    profiles_dir = tmp_path / "profiles"
    data_dir = tmp_path / "data"
    profiles_dir.mkdir()
    data_dir.mkdir()
    settings = Settings(profiles_dir=profiles_dir, data_dir=data_dir, captures_dir=tmp_path / "caps")
    monkeypatch.setattr("oc.web.routes.profiles.get_settings", lambda: settings)
    return TestClient(create_app(), client=("127.0.0.1", 50000))


def _etag(resp) -> str:
    tag = resp.headers["ETag"]
    assert tag.startswith('"') and tag.endswith('"')   # RFC 7232: opaque-tag must be quoted
    return tag


def test_first_save_needs_no_if_match(env):
    r = env.put(f"/api/profiles/{GAME}?merge=false", json=GameProfile(name=GAME).model_dump(mode="json"))
    assert r.status_code == 200
    assert "ETag" in r.headers


def test_get_returns_etag_matching_put(env):
    put = env.put(f"/api/profiles/{GAME}?merge=false", json=GameProfile(name=GAME).model_dump(mode="json"))
    got = env.get(f"/api/profiles/{GAME}")
    assert _etag(put) == _etag(got)
    assert "X-Profile-Modified" in got.headers


def test_stale_if_match_is_rejected_with_conflict_payload(env):
    env.put(f"/api/profiles/{GAME}?merge=false", json=GameProfile(name=GAME).model_dump(mode="json"))
    tab_tag = _etag(env.get(f"/api/profiles/{GAME}"))

    # another writer lands a STRUCTURAL change (unconditional — no If-Match)
    other = GameProfile(name=GAME, process_names=["other.exe"]).model_dump(mode="json")
    env.put(f"/api/profiles/{GAME}?merge=false", json=other)

    # the stale tab tries to save its own edit with the token it loaded
    mine = GameProfile(name=GAME, process_names=["mine.exe"]).model_dump(mode="json")
    r = env.put(f"/api/profiles/{GAME}?merge=false", json=mine, headers={"If-Match": tab_tag})
    assert r.status_code == 409
    body = r.json()
    assert body["conflict"] is True
    assert "other.exe" in body["server_yaml"]
    assert "mine.exe" in body["incoming_yaml"]
    assert "server_modified" in body and "server_version" in body


def test_matching_if_match_saves_and_rotates_etag(env):
    env.put(f"/api/profiles/{GAME}?merge=false", json=GameProfile(name=GAME).model_dump(mode="json"))
    tag = _etag(env.get(f"/api/profiles/{GAME}"))
    body = GameProfile(name=GAME, process_names=["mine.exe"]).model_dump(mode="json")
    r = env.put(f"/api/profiles/{GAME}?merge=false", json=body, headers={"If-Match": tag})
    assert r.status_code == 200
    assert _etag(r) != tag


def test_layout_only_change_never_trips_a_false_conflict(env):
    env.put(f"/api/profiles/{GAME}?merge=false", json=GameProfile(name=GAME).model_dump(mode="json"))
    my_tag = _etag(env.get(f"/api/profiles/{GAME}"))

    # a foreign tab saves ONLY layout (positions) — non-structural, so the token must not move
    layout_body = GameProfile(name=GAME, layout={"nodes": {"win:foo": {"x": 1, "y": 2, "w": 3, "h": 4}}})
    other = env.put(f"/api/profiles/{GAME}?merge=false&layout=true",
                     json=layout_body.model_dump(mode="json"))
    assert _etag(other) == my_tag

    # my tab, still holding the ORIGINAL token, saves real content -- must succeed, not 409
    mine = GameProfile(name=GAME, process_names=["mine.exe"]).model_dump(mode="json")
    r = env.put(f"/api/profiles/{GAME}?merge=false", json=mine, headers={"If-Match": my_tag})
    assert r.status_code == 200


def test_force_overwrite_skips_if_match_entirely(env):
    env.put(f"/api/profiles/{GAME}?merge=false", json=GameProfile(name=GAME).model_dump(mode="json"))
    env.put(f"/api/profiles/{GAME}?merge=false",
            json=GameProfile(name=GAME, process_names=["other.exe"]).model_dump(mode="json"))
    # the conflict modal's "overwrite server" action: no If-Match header at all
    r = env.put(f"/api/profiles/{GAME}?merge=false",
                json=GameProfile(name=GAME, process_names=["mine.exe"]).model_dump(mode="json"))
    assert r.status_code == 200
