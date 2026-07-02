"""Offline end-to-end tests for the generic http producer.

Injects a fake ``http_get_json`` (no network), runs ``HttpProducer.run`` against a real
:class:`DatasetStore`, and asserts the mapped rows land keyed by ``name`` — plus the
catalogue name->key resolve and the sweep-engine cancel/partial-flush guarantee.
"""

from oc.enrich import http_producer
from oc.enrich.http_producer import HttpProducer, probe_item, resolved_inputs
from oc.interfaces import ProducerCtx
from oc.profile.models import GameProfile
from oc.store import store_for
from oc.profile.models import (
    CatalogueSpec, HttpArraySpec, HttpField, HttpFilter, HttpRequest, HttpSpec, ProducerDef,
)
from oc.store import DatasetStore, KeySpec


def _orders(*plats):
    return {"data": [{"type": "sell", "user": {"status": "online"}, "platinum": p} for p in plats]}


def _sell_spec(url="https://api.warframe.market/v2/orders/item/{key}", key_transform="slugify",
               catalogue=None):
    flt = [HttpFilter(path="type", op="eq", value="sell"),
           HttpFilter(path="user.status", op="in", value=["online", "ingame"])]
    return HttpSpec(
        request=HttpRequest(method="GET", url=url, timeout=10),
        key_transform=key_transform, key_encode=True, catalogue=catalogue, root="data",
        fields=[
            HttpField(out_field="price_min", type="number",
                      array=HttpArraySpec(filter=flt, pluck="platinum", agg="min")),
            HttpField(out_field="volume", type="number",
                      array=HttpArraySpec(filter=flt, pluck="platinum", agg="count")),
        ])


def _ctx(tmp_path, node, items):
    return ProducerCtx(data_dir=str(tmp_path), game="g", node=node, dataset=node.dataset,
                       key=KeySpec(fields=("name",)), profile=None, items=items, workers=1)


def test_http_producer_maps_rows_by_name(tmp_path, monkeypatch):
    prices = {"serration": _orders(40, 20, 60), "vitality": _orders(15, 30)}

    def fake_get(url, **kw):
        slug = url.rsplit("/", 1)[-1]
        return prices[slug]
    monkeypatch.setattr(http_producer, "http_get_json", fake_get)

    node = ProducerDef(id="live", dataset="prices_live", type="http", sources=["master"],
                       http=_sell_spec())
    res = HttpProducer().run(_ctx(tmp_path, node, ["Serration", "Vitality"]))
    assert res == {"total": 2, "fetched": 2, "failed": 0}

    out = DatasetStore(tmp_path, "g", "prices_live", key=KeySpec(fields=("name",)))
    rows = {r["name"]: r for r in out.records()}
    assert rows["Serration"]["price_min"] == 20
    assert rows["Serration"]["volume"] == 3
    assert rows["Vitality"]["price_min"] == 15


def test_http_producer_catalogue_resolves_set_name(tmp_path, monkeypatch):
    catalogue = {"data": [
        {"i18n": {"en": {"name": "Acceltra Prime Set"}}, "slug": "acceltra_prime_set"},
        {"i18n": {"en": {"name": "Serration"}}, "slug": "serration"},
    ]}
    orders = {"acceltra_prime_set": _orders(120, 130)}

    def fake_get(url, **kw):
        if url.endswith("/v2/items"):
            return catalogue
        return orders[url.rsplit("/", 1)[-1]]
    monkeypatch.setattr(http_producer, "http_get_json", fake_get)

    cat = CatalogueSpec(url="https://api.warframe.market/v2/items", items_path="data",
                        name_path="i18n.en.name", key_path="slug", fuzzy=0.8)
    node = ProducerDef(id="live", dataset="prices_live", type="http", sources=["master"],
                       http=_sell_spec(key_transform="catalogue", catalogue=cat))
    # "Acceltra Prime" (no "Set") must resolve to acceltra_prime_set via the fuzzy tier
    res = HttpProducer().run(_ctx(tmp_path, node, ["Acceltra Prime"]))
    assert res["fetched"] == 1

    out = DatasetStore(tmp_path, "g", "prices_live", key=KeySpec(fields=("name",)))
    rows = {r["name"]: r for r in out.records()}
    assert rows["Acceltra Prime"]["price_min"] == 120


def test_probe_item_returns_sample_and_mapped(tmp_path, monkeypatch):
    monkeypatch.setattr(http_producer, "http_get_json", lambda url, **kw: _orders(40, 20, 60))
    node = ProducerDef(id="live", dataset="prices_live", type="http", http=_sell_spec())
    out = probe_item(str(tmp_path), "g", None, node, item="Serration")
    assert out["name"] == "Serration" and out["key"] == "serration"
    assert out["mapped"] == {"price_min": 20, "volume": 3}
    assert isinstance(out["sample"], list) and len(out["sample"]) == 3   # rooted array returned


def test_catalogue_suffix_hint_resolves_set_items():
    from oc.enrich.http_producer import _Catalogue
    cat = _Catalogue([{"name": "Soma Prime Set", "key": "soma_prime_set"},
                      {"name": "Serration", "key": "serration"}],
                     corrector=None, fuzzy=0.9, suffix_hints=["_set"])
    assert cat.resolve("Soma Prime") == "soma_prime_set"   # slugify + hint, no fuzzy needed
    assert cat.resolve("Serration") == "serration"          # exact still wins
    assert cat.resolve("Nope") is None


def test_probe_item_reports_errors(tmp_path):
    # no request url yet -> friendly error, never raises
    bare = ProducerDef(id="x", dataset="d", type="http")
    assert "error" in probe_item(str(tmp_path), "g", None, bare, item="A")


def test_resolved_inputs_previews_names_keys_columns(tmp_path):
    inv = store_for(tmp_path, "g", "master", key=KeySpec(fields=("name",)))
    inv.begin_batch()
    for nm in ("Soma Prime", "Mag Prime"):
        inv.record_seen({"name": nm})
    inv.save()
    node = ProducerDef(id="live", dataset="prices_live", type="http", sources=["master"],
                       http=_sell_spec())   # slugify transform
    profile = GameProfile(name="g", datasets=[{"id": "master"}, {"id": "prices_live"}], producers=[node])
    out = resolved_inputs(str(tmp_path), "g", profile, node)
    assert out["total"] == 2
    assert {"name": "Soma Prime", "key": "soma_prime"} in out["inputs"]
    assert out["columns"] == ["name", "price_min", "volume"]


def _relic_raw():
    return {"relics": [
        {"tier": "Axi", "relicName": "A1", "state": "Intact", "rewards": [
            {"itemName": "Braton Prime", "rarity": "Common"},
            {"itemName": "Nikana Prime", "rarity": "Rare"}]},
        {"tier": "Axi", "relicName": "A1", "state": "Radiant", "rewards": [
            {"itemName": "Nikana Prime", "rarity": "Rare"}]},   # dup (name,item) across states
        {"tier": "Requiem", "relicName": "I", "state": "Intact", "rewards": []}]}


def _relic_spec():
    return HttpSpec(
        request=HttpRequest(url="https://x/relics.json", timeout=60),
        key_transform="none", key_encode=False, root="", explode=["relics", "rewards"],
        fields=[HttpField(out_field="name", template="{tier} {relicName}", required=True),
                HttpField(out_field="item", path="itemName", required=True),
                HttpField(out_field="rarity", path="rarity")])


def test_http_producer_list_mode_writes_expanded_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(http_producer, "http_get_json", lambda url, **kw: _relic_raw())
    node = ProducerDef(id="relics", dataset="relic_contents", type="http", http=_relic_spec())
    # list mode needs no sources; the one fetch yields every row
    key = KeySpec(fields=("name", "item"))
    ctx = ProducerCtx(data_dir=str(tmp_path), game="g", node=node, dataset="relic_contents",
                      key=key, profile=None)
    res = HttpProducer().run(ctx)
    assert res["fetched"] == 3                              # 3 mapped rows (empty relic dropped)

    out = DatasetStore(tmp_path, "g", "relic_contents", key=key)
    rows = {(r["name"], r["item"]): r for r in out.records()}
    assert len(rows) == 2                                   # the two Nikana states dedup on name|item
    assert rows[("Axi A1", "Braton Prime")]["rarity"] == "Common"
    assert ("Axi A1", "Nikana Prime") in rows


def test_probe_item_list_mode_shows_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(http_producer, "http_get_json", lambda url, **kw: _relic_raw())
    node = ProducerDef(id="relics", dataset="relic_contents", type="http", http=_relic_spec())
    out = probe_item(str(tmp_path), "g", None, node)
    assert out["name"] == "(list)"
    assert {"name": "Axi A1", "item": "Braton Prime", "rarity": "Common"} in out["mapped"]


def test_http_producer_cancel_flushes_partial(tmp_path, monkeypatch):
    monkeypatch.setattr(http_producer, "http_get_json", lambda url, **kw: _orders(10))

    node = ProducerDef(id="live", dataset="prices_live", type="http", sources=["master"],
                       http=_sell_spec())
    stop = [False]
    ctx = _ctx(tmp_path, node, ["A", "B", "C", "D"])
    ctx.should_stop = lambda: stop[0]
    ctx.on_item = lambda *a: stop.__setitem__(0, True)   # cancel after the first completes

    res = HttpProducer().run(ctx)
    assert res["fetched"] < res["total"]                 # cancelled early
    out = DatasetStore(tmp_path, "g", "prices_live", key=KeySpec(fields=("name",)))
    assert len(list(out.records())) == res["fetched"]    # what was fetched WAS flushed
