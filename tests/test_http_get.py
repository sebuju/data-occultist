"""Offline tests for the raw HTTP transport (:mod:`oc.enrich.http_get`).

Monkeypatches ``curl_cffi``'s ``Session`` so no network is touched; asserts the
``html_extract`` mode correctly pulls JSON out of an embedded ``<script>`` tag.
"""

import json

import pytest

from oc.enrich import http_get


class _FakeResp:
    def __init__(self, status_code, content, reason=""):
        self.status_code = status_code
        self.content = content
        self.reason = reason


class _FakeSession:
    def __init__(self, body: bytes, status_code: int = 200):
        self._body = body
        self._status = status_code

    def request(self, method, url, **kw):
        return _FakeResp(self._status, self._body)


def _use_fake_session(monkeypatch, body: bytes, status_code: int = 200):
    monkeypatch.setattr(http_get, "_session", lambda: _FakeSession(body, status_code))


def test_html_extract_pulls_json_from_script_tag(monkeypatch):
    page = b"""<!doctype html><html><body>
    <script id="__NEXT_DATA__" type="application/json">{"props": {"pageProps": {"item": {"name": "Primed Flow"}}}}</script>
    </body></html>"""
    _use_fake_session(monkeypatch, page)
    out = http_get.http_get_json("https://x/items/arsenal/802/", html_extract="__NEXT_DATA__")
    assert out["props"]["pageProps"]["item"]["name"] == "Primed Flow"


def test_html_extract_missing_tag_raises(monkeypatch):
    _use_fake_session(monkeypatch, b"<html><body>no data here</body></html>")
    with pytest.raises(ValueError):
        http_get.http_get_json("https://x/items/arsenal/802/", html_extract="__NEXT_DATA__")


def test_no_html_extract_parses_bare_json(monkeypatch):
    _use_fake_session(monkeypatch, json.dumps({"a": 1}).encode("utf-8"))
    assert http_get.http_get_json("https://x/api/") == {"a": 1}


def test_status_ge_400_raises_http_error(monkeypatch):
    import urllib.error
    _use_fake_session(monkeypatch, b'{"detail": "not found"}', status_code=404)
    with pytest.raises(urllib.error.HTTPError):
        http_get.http_get_json("https://x/api/missing/")
