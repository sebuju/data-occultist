"""OCR-result cache: key stability + persisted get/put.

Boot serves detect/preview/item-read for unchanged stashed images straight from this
sidecar (no engine touch) — so the key MUST move when (and only when) the inputs that
shape a read change, and a put MUST survive a reload (next boot hits).
"""

from __future__ import annotations

import json

from oc.web import ocr_cache as ocr_cache_mod
from oc.web.ocr_cache import OcrCache, cache_key


def test_key_stable_for_same_inputs():
    cfg = {"window": {"regions": [1, 2]}, "fields": ["a"]}
    assert cache_key("cap.jpg", cfg) == cache_key("cap.jpg", cfg)
    # dict order doesn't matter — the dump is sorted
    assert cache_key("cap.jpg", {"a": 1, "b": 2}) == cache_key("cap.jpg", {"b": 2, "a": 1})


def test_key_moves_when_image_or_config_changes():
    cfg = {"window": {"regions": [1]}}
    base = cache_key("cap.jpg", cfg)
    assert cache_key("other.jpg", cfg) != base          # different image
    assert cache_key("cap.jpg", {"window": {"regions": [2]}}) != base   # edited boxes


def test_key_moves_with_engine_sig():
    """Swapping the OCR backend / inference engine must bust the cache — same image +
    config under a different engine fingerprint is a different key (else the swap
    silently serves the previous engine's reads and looks like a no-op)."""
    cfg = {"window": {"regions": [1]}}
    base = cache_key("cap.jpg", cfg, "ppocr5|{\"engine_type\": \"onnxruntime\"}")
    assert cache_key("cap.jpg", cfg, "ppocr5|{\"engine_type\": \"openvino\"}") != base
    assert cache_key("cap.jpg", cfg, "rapidocr|scale=1|{}") != base
    assert cache_key("cap.jpg", cfg, "ppocr5|{\"engine_type\": \"onnxruntime\"}") == base


def test_put_get_roundtrip_and_persist(tmp_path):
    p = tmp_path / "ocr_cache.json"
    c = OcrCache(p)
    assert c.get("k") is None
    c.put("k", {"detect": {"x": 1}})
    c.save()
    assert p.exists()                                    # write-through landed
    fresh = OcrCache(p)                                  # next boot reloads from disk
    assert fresh.get("k") == {"detect": {"x": 1}}


def test_clean_put_is_not_dirtied(tmp_path):
    p = tmp_path / "ocr_cache.json"
    c = OcrCache(p)
    c.put("k", {"v": 1})
    c.save()
    c.put("k", {"v": 1})                                 # identical -> no rewrite
    assert c._dirty is False


def test_corrupt_cache_self_heals(tmp_path):
    p = tmp_path / "ocr_cache.json"
    p.write_text("{ not json", encoding="utf-8")
    c = OcrCache(p)                                       # must not raise
    assert c.get("anything") is None


def test_concurrent_saves_dont_race(tmp_path):
    # The boot fires several OCR reads at once and FastAPI runs them on threads sharing ONE
    # cache instance — concurrent save() must not collide on the temp file (WinError 32) or 500.
    import threading
    c = OcrCache(tmp_path / "ocr_cache.json")
    errs: list = []

    def worker(i):
        try:
            for j in range(40):
                c.put(f"k{i}-{j}", {"v": i, "j": j})
                c.save()
        except Exception as e:   # noqa: BLE001 — the point is that NOTHING escapes
            errs.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errs == []
    assert len(OcrCache(tmp_path / "ocr_cache.json")._entries) == 12 * 40   # all persisted


def test_two_instances_dont_clobber_each_other(tmp_path):
    """The desktop app and `serve` (or a `--reload` worker overlapping its predecessor) are
    each a SEPARATE process/instance over the SAME sidecar. A `threading.Lock` inside one
    `OcrCache` does nothing for the other instance, so `save()` must re-read + merge rather
    than blindly overwrite with its own once-loaded snapshot — else the second save clobbers
    the first instance's key (the "doesn't stick when multiple running" bug)."""
    p = tmp_path / "ocr_cache.json"
    a = OcrCache(p)   # both load the same (empty) starting state
    b = OcrCache(p)
    a.put("ka", {"v": "a"})
    a.save()
    b.put("kb", {"v": "b"})
    b.save()          # must NOT clobber ka even though b never saw it in its own _entries
    fresh = OcrCache(p)
    assert fresh.get("ka") == {"v": "a"}
    assert fresh.get("kb") == {"v": "b"}


def test_code_sig_bust_wipes_and_notifies(tmp_path, monkeypatch):
    """A moved code sig must wipe prior entries (stale reads of the old code must
    never be served) and announce it once to the game's activity feed."""
    p = tmp_path / "ocr_cache.json"
    monkeypatch.setattr(ocr_cache_mod, "ocr_code_sig", lambda: "sig-a")
    c = OcrCache(p, game="warframe")
    c.put("k", {"v": 1})
    c.save()

    published = []
    monkeypatch.setattr(ocr_cache_mod, "ocr_code_sig", lambda: "sig-b")
    monkeypatch.setattr("oc.eventlog.publish",
                         lambda *a, **kw: published.append((a, kw)))
    reopened = OcrCache(p, game="warframe")
    assert reopened.get("k") is None                     # stale entry dropped
    assert len(published) == 1
    msg, kw = published[0][0][0], published[0][1]
    assert "busted" in msg
    assert kw["game"] == "warframe"

    reopened.save()
    on_disk = json.loads(p.read_text(encoding="utf-8"))
    assert on_disk["sig"] == "sig-b"
    assert on_disk["entries"] == {}


def test_code_sig_unchanged_keeps_entries_and_is_silent(tmp_path, monkeypatch):
    p = tmp_path / "ocr_cache.json"
    monkeypatch.setattr(ocr_cache_mod, "ocr_code_sig", lambda: "same-sig")
    c = OcrCache(p)
    c.put("k", {"v": 1})
    c.save()

    published = []
    monkeypatch.setattr("oc.eventlog.publish",
                         lambda *a, **kw: published.append((a, kw)))
    reopened = OcrCache(p)
    assert reopened.get("k") == {"v": 1}
    assert published == []


def test_old_flat_format_busts_on_upgrade(tmp_path, monkeypatch):
    """A cache written before the code-sig bust existed has no "entries" wrapper —
    treat it as sig-less so upgrading to this code always busts it once."""
    p = tmp_path / "ocr_cache.json"
    p.write_text(json.dumps({"k": {"v": 1}}), encoding="utf-8")
    monkeypatch.setattr(ocr_cache_mod, "ocr_code_sig", lambda: "sig-a")
    c = OcrCache(p)
    assert c.get("k") is None
