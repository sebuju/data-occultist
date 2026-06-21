"""HTTP-route tests for the flow batch endpoint (POST /api/flow/{game}/details).

The boot fetches every node's data in ONE /details call instead of one request per node.
These lock that the batch returns byte-for-byte what the per-node endpoints return (so the
client can render from it identically), and that an unknown id is skipped, not fatal.
"""

from __future__ import annotations

import pytest

pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from oc.profile import save_profile  # noqa: E402
from oc.profile.models import DatasetDef, GameProfile, JoinSource, SubsetDef  # noqa: E402
from oc.settings import Settings  # noqa: E402
from oc.store import store_for  # noqa: E402
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
        datasets=[DatasetDef(id="loot"), DatasetDef(id="prices")],
        subsets=[SubsetDef(id="joined", sources=[JoinSource(dataset="loot"),
                                                 JoinSource(dataset="prices")])],
    )
    save_profile(profiles_dir, profile)

    for ds, rows in {"loot": [{"name": "Forma"}, {"name": "Kuva"}],
                     "prices": [{"name": "Forma", "plat": 5}]}.items():
        store = store_for(data_dir, GAME, ds, profile=profile)
        store.begin_batch()
        for r in rows:
            store.record_seen(r)
        store.save()

    settings = Settings(profiles_dir=profiles_dir, data_dir=data_dir, captures_dir=tmp_path / "caps")
    monkeypatch.setattr("oc.web.routes.flow.get_settings", lambda: settings)
    return TestClient(create_app(), client=("127.0.0.1", 50000))


def test_details_matches_single_dataset_calls(env):
    client = env
    batch = client.post(f"/api/flow/{GAME}/details",
                        json={"datasets": ["loot", "prices"], "subsets": []}).json()
    for ds in ("loot", "prices"):
        single = client.get(f"/api/flow/{GAME}/dataset/{ds}").json()
        assert batch["datasets"][ds] == single   # identical payload -> client renders the same


def test_details_matches_single_subset_call(env):
    client = env
    batch = client.post(f"/api/flow/{GAME}/details",
                        json={"datasets": [], "subsets": ["joined"]}).json()
    single = client.get(f"/api/flow/{GAME}/subset/joined").json()
    assert batch["subsets"]["joined"] == single


def test_details_skips_unknown_ids(env):
    client = env
    r = client.post(f"/api/flow/{GAME}/details",
                    json={"datasets": ["loot", "ghost"], "subsets": ["nope"]})
    assert r.status_code == 200
    body = r.json()
    # an unknown DATASET yields an empty detail (same as a single GET — phantom prevention),
    # never an error; an unknown SUBSET (no def to compute) is dropped entirely.
    assert body["datasets"]["loot"]["records"]            # real data
    assert body["datasets"]["ghost"]["records"] == []     # empty, but present + consistent
    assert body["subsets"] == {}


def test_details_404_for_unknown_game(env):
    client = env
    r = client.post("/api/flow/nope/details", json={"datasets": [], "subsets": []})
    assert r.status_code == 404
