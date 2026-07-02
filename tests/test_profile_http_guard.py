"""The save route must never silently strip a producer's authored http spec."""

from oc.profile.models import GameProfile, HttpRequest, HttpSpec, ProducerDef
from oc.web.routes.profiles import _preserve_producer_http


def _http_node():
    return ProducerDef(id="px", type="http", dataset="prices",
                       http=HttpSpec(request=HttpRequest(url="https://x/{key}")))


def test_stale_save_keeps_existing_http():
    existing = GameProfile(name="g", producers=[_http_node()])
    # a stale client sends the same node with NO http block
    incoming = GameProfile(name="g", producers=[ProducerDef(id="px", type="http", dataset="prices")])
    _preserve_producer_http(existing, incoming)
    assert incoming.producers[0].http is not None
    assert incoming.producers[0].http.request.url == "https://x/{key}"


def test_incoming_http_is_respected():
    existing = GameProfile(name="g", producers=[_http_node()])
    incoming = GameProfile(name="g", producers=[ProducerDef(
        id="px", type="http", dataset="prices",
        http=HttpSpec(request=HttpRequest(url="https://new/{key}")))])
    _preserve_producer_http(existing, incoming)
    assert incoming.producers[0].http.request.url == "https://new/{key}"   # not overwritten


def test_non_http_node_untouched():
    existing = GameProfile(name="g", producers=[_http_node()])
    incoming = GameProfile(name="g", producers=[ProducerDef(id="px", type="other", dataset="d")])
    _preserve_producer_http(existing, incoming)
    assert incoming.producers[0].http is None   # switching type away from http is honoured
