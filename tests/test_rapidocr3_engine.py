"""ppocr5 engine behavior tests (stubbed engine object — no models, but the module
import-guards on the optional ``rapidocr`` package, so skip when it's absent)."""

import numpy as np
import pytest

pytest.importorskip("rapidocr")

from oc.ocr.rapidocr3_engine import Rapid3OcrEngine


class _EmptyOut:
    boxes = None
    txts = None
    scores = None


def test_read_image_pins_all_stage_flags():
    """v3's per-call flags PERSIST on the shared engine (update_params skips None):
    after any rec-only read_line, a flagless full call would run rec-only and return a
    boxless TextRecOutput. read_image must therefore pass all three flags every time
    (regression: every preview/detect endpoint 500'd with 'TextRecOutput' has no
    attribute 'boxes')."""
    eng = Rapid3OcrEngine()
    calls = []

    def fake(img, **kw):
        calls.append(kw)
        return _EmptyOut()

    eng._engine = fake
    assert eng.read_image(np.zeros((10, 10, 3), np.uint8)) == []
    assert calls == [{"use_det": True, "use_cls": False, "use_rec": True}]


def test_thread_knob_mutates_options_and_forces_rebuild():
    eng = Rapid3OcrEngine(intra_op_num_threads=2)
    assert eng.intra_threads == 2
    eng._engine = object()   # pretend built
    eng.set_intra_threads(4)
    assert eng.intra_threads == 4
    assert eng._engine is None   # rebuilds lazily with the new cap
    eng.set_intra_threads(0)     # 0 = runtime default -> option removed
    assert "intra_op_num_threads" not in eng._options


def test_ocr_sig_tracks_output_knobs_only():
    """ocr_sig feeds the web OCR cache key: it must move on anything that changes WHAT
    is read (engine swap, model options) and hold still for perf-only knobs (threads,
    batch) and the device — else tuning speed would nuke the cache, and auto device
    mode (flips per batch) would too."""
    eng = Rapid3OcrEngine(engine_type="onnxruntime", intra_op_num_threads=2)
    base = eng.ocr_sig
    eng.set_intra_threads(8)
    assert eng.ocr_sig == base                    # perf knob -> same sig
    eng.set_device(True)
    assert eng.ocr_sig == base                    # device -> same sig
    eng._options["engine_type"] = "openvino"
    assert eng.ocr_sig != base                    # engine swap -> new sig
    assert Rapid3OcrEngine(ocr_version="PP-OCRv4").ocr_sig != Rapid3OcrEngine().ocr_sig


def test_engine_type_rejects_unavailable():
    eng = Rapid3OcrEngine()
    assert eng.engine_type == "onnxruntime"
    with pytest.raises(ValueError):
        eng.set_engine_type("tensorrt")   # runtime not installed -> never listed
