"""OCR-result cache: key stability + persisted get/put.

Boot serves detect/preview/item-read for unchanged stashed images straight from this
sidecar (no engine touch) — so the key MUST move when (and only when) the inputs that
shape a read change, and a put MUST survive a reload (next boot hits).
"""

from __future__ import annotations

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
