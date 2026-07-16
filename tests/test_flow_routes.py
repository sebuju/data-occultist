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
from oc.profile.loader import load_profile  # noqa: E402
from oc.profile.models import (  # noqa: E402
    DatasetDef, FilterRule, GameProfile, JoinSource, SubsetDef,
)
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


def test_details_ships_dataset_windows(env):
    client = env
    # boot batch now ships a WINDOW (+ total + columns + the ledger for the batches tab), not every row.
    batch = client.post(f"/api/flow/{GAME}/details",
                        json={"datasets": ["loot", "prices"], "subsets": []}).json()
    d = batch["datasets"]["loot"]
    assert d["total"] == 2 and "name" in d["columns"]
    assert {r["name"] for r in d["rows"]} == {"Forma", "Kuva"}   # small dataset -> whole first window
    assert "batches" in d and "has_removed" in d                 # ledger rides along; toggle hint present


def test_details_ships_subset_windows(env):
    client = env
    batch = client.post(f"/api/flow/{GAME}/details",
                        json={"datasets": [], "subsets": ["joined"]}).json()
    s = batch["subsets"]["joined"]
    assert s["subset"] == "joined" and s["total"] == 2
    assert "columns" in s and len(s["rows"]) <= 2


def test_details_skips_unknown_ids(env):
    client = env
    r = client.post(f"/api/flow/{GAME}/details",
                    json={"datasets": ["loot", "ghost"], "subsets": ["nope"]})
    assert r.status_code == 200
    body = r.json()
    # an unknown DATASET yields an empty window (phantom prevention), never an error; an unknown
    # SUBSET (no def to compute) is dropped entirely.
    assert body["datasets"]["loot"]["rows"]               # real data
    assert body["datasets"]["ghost"]["rows"] == []        # empty, but present + consistent
    assert body["subsets"] == {}


def test_details_404_for_unknown_game(env):
    client = env
    r = client.post("/api/flow/nope/details", json={"datasets": [], "subsets": []})
    assert r.status_code == 404


# ---- POST /{game}/resolve : pretty {{token}} scalars resolved server-side --------------------
# The pretty layer folds these server-side (templating.py) instead of fetching whole row tables to
# the browser, so a bound label/condition ships a scalar, not the dataset. These lock that the
# endpoint returns the same values templating.resolve_token produces.

def test_resolve_aggregates_and_counts(env):
    client = env
    tokens = ["dataset:loot", "dataset:prices.plat|sum", "subset:joined|count",
              "subset:joined.plat|sum"]
    values = client.post(f"/api/flow/{GAME}/resolve", json={"tokens": tokens}).json()["values"]
    assert values["dataset:loot"] == 2                # bare collection -> row count (Forma, Kuva)
    assert values["dataset:prices.plat|sum"] == 5     # one plat=5 row
    assert values["subset:joined|count"] == 2         # outer join on name -> Forma, Kuva
    assert values["subset:joined.plat|sum"] == 5      # only Forma carries a price


def test_resolve_slice_and_join(env):
    client = env
    # slice trails the token body (grammar: dataset:id.field[slice]); [0] vs [-1] must pick the two
    # different ends, proving the python row-slice runs server-side.
    tokens = ["dataset:loot.name[0]", "dataset:loot.name[-1]", 'dataset:loot.name|join:", "']
    values = client.post(f"/api/flow/{GAME}/resolve", json={"tokens": tokens}).json()["values"]
    first, last = values["dataset:loot.name[0]"], values["dataset:loot.name[-1]"]
    assert {first, last} == {"Forma", "Kuva"} and first != last
    assert set(values['dataset:loot.name|join:", "'].split(", ")) == {"Forma", "Kuva"}


def test_resolve_matches_templating_directly(env):
    """The route is a thin wrapper over templating.resolve_token — same context, same values."""
    from oc.collect.templating import TokenContext, resolve_token
    from oc.web.routes.flow import get_settings

    client = env
    settings = get_settings()
    from oc.runtime import load_live_profile
    profile = load_live_profile(settings.profiles_dir, GAME)
    ctx = TokenContext(data_dir=settings.data_dir, profile=profile, game=GAME)

    tokens = ["dataset:prices.plat|sum", "subset:joined|count", "dataset:loot[0].name"]
    values = client.post(f"/api/flow/{GAME}/resolve", json={"tokens": tokens}).json()["values"]
    for t in tokens:
        assert values[t] == resolve_token(ctx, t)


def test_resolve_bad_token_is_null_not_error(env):
    client = env
    r = client.post(f"/api/flow/{GAME}/resolve",
                    json={"tokens": ["dataset:ghost.x|max", "garbage"]})
    assert r.status_code == 200
    values = r.json()["values"]
    assert values["dataset:ghost.x|max"] is None   # missing dataset -> empty aggregate -> null
    assert values["garbage"] is None               # unknown token shape -> null, never a crash


def test_resolve_404_for_unknown_game(env):
    client = env
    r = client.post("/api/flow/nope/resolve", json={"tokens": ["dataset:loot"]})
    assert r.status_code == 404


# ---- GET /{game}/dataset|subset/{id}/page : server-backed windowed node tables -----------------
# VTable no longer holds every row: it fetches windows (filter q + sort + offset/limit) and the
# server reports the true total so the scrollbar spans the full result. These lock the window shape.

def test_dataset_page_window_and_total(env):
    client = env
    # loot has Forma, Kuva. Sort by name, page size 1.
    p0 = client.get(f"/api/flow/{GAME}/dataset/loot/page",
                    params={"sort": "name", "offset": 0, "limit": 1}).json()
    assert [r["name"] for r in p0["rows"]] == ["Forma"]
    assert p0["total"] == 2                       # true total, not the page size
    assert "name" in p0["columns"]                # server-authoritative columns
    p1 = client.get(f"/api/flow/{GAME}/dataset/loot/page",
                    params={"sort": "name", "offset": 1, "limit": 1}).json()
    assert [r["name"] for r in p1["rows"]] == ["Kuva"]
    assert p1["total"] == 2
    assert p1["columns"] == p0["columns"]         # columns stable across pages


def test_dataset_page_query_filters(env):
    client = env
    p = client.get(f"/api/flow/{GAME}/dataset/loot/page", params={"q": "forma"}).json()
    assert [r["name"] for r in p["rows"]] == ["Forma"]
    assert p["total"] == 1
    none = client.get(f"/api/flow/{GAME}/dataset/loot/page", params={"q": "zzz"}).json()
    assert none["rows"] == [] and none["total"] == 0


def test_dataset_page_sort_desc(env):
    client = env
    p = client.get(f"/api/flow/{GAME}/dataset/loot/page",
                   params={"sort": "name", "desc": "true"}).json()
    assert [r["name"] for r in p["rows"]] == ["Kuva", "Forma"]


def test_subset_page_window(env):
    client = env
    p = client.get(f"/api/flow/{GAME}/subset/joined/page",
                   params={"sort": "name", "limit": 1}).json()
    assert p["total"] == 2                         # outer join -> Forma, Kuva
    assert len(p["rows"]) == 1
    assert "name" in p["columns"]


def test_dataset_distinct(env):
    client = env
    d = client.get(f"/api/flow/{GAME}/dataset/loot/distinct", params={"field": "name"}).json()
    assert set(d["values"]) == {"Forma", "Kuva"}
    lim = client.get(f"/api/flow/{GAME}/dataset/loot/distinct",
                     params={"field": "name", "limit": 1}).json()
    assert len(lim["values"]) == 1


def test_subset_page_404_for_unknown(env):
    client = env
    assert client.get(f"/api/flow/{GAME}/subset/nope/page").status_code == 404
    assert client.get("/api/flow/nope/subset/joined/page").status_code == 404


def test_subset_page_reflects_def_edit_without_data_write(env):
    """A subset settings edit (here: a new filter) must change the served view even when NO
    dataset was written — the view cache is keyed on the def fingerprint, not only source revs.
    Regression: it was keyed on dataset `rev` alone, so a settings edit that touched no data
    returned the stale cached rows."""
    from oc.web.routes import flow as flow_routes
    flow_routes._VIEW_CACHE.clear()   # module-global; isolate from sibling tests' entries
    client = env

    base = client.get(f"/api/flow/{GAME}/subset/joined/page").json()
    assert base["total"] == 2                                # outer join -> Forma, Kuva

    # Edit the subset def on disk: drop everything but Forma. No dataset write -> no rev bump.
    settings = flow_routes.get_settings()
    profile = load_profile(settings.profiles_dir, GAME)
    profile.subset_def("joined").filters.append(FilterRule(field="name", op="eq", value="Forma"))
    save_profile(settings.profiles_dir, profile)

    after = client.get(f"/api/flow/{GAME}/subset/joined/page").json()
    assert after["total"] == 1                               # the new filter is now honoured
    assert {r["name"] for r in after["rows"]} == {"Forma"}


def test_subset_page_reflects_upstream_view_edit(env):
    """A downstream view must invalidate when an UPSTREAM view's def changes — the fingerprint
    walk covers transitive source views, not just the target subset."""
    from oc.web.routes import flow as flow_routes
    flow_routes._VIEW_CACHE.clear()
    client = env

    # Add a downstream view reading the existing "joined" view; prime its cache.
    settings = flow_routes.get_settings()
    profile = load_profile(settings.profiles_dir, GAME)
    profile.subsets.append(SubsetDef(id="down", sources=[JoinSource(dataset="joined")]))
    save_profile(settings.profiles_dir, profile)
    assert client.get(f"/api/flow/{GAME}/subset/down/page").json()["total"] == 2

    # Edit the UPSTREAM view only; the downstream must reflect it.
    profile = load_profile(settings.profiles_dir, GAME)
    profile.subset_def("joined").filters.append(FilterRule(field="name", op="eq", value="Forma"))
    save_profile(settings.profiles_dir, profile)
    assert client.get(f"/api/flow/{GAME}/subset/down/page").json()["total"] == 1
