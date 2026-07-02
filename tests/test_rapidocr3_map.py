"""Pure-logic tests for the ppocr5 (rapidocr v3) option/output translation.

These run without the optional ``rapidocr`` package — the map module is dep-free
by design (the engine module is the one that import-guards on the package).
"""

import pytest

from oc.ocr.rapidocr3_map import join_rec, to_lines, to_params


def test_to_params_always_disables_cls():
    assert to_params({}) == {"Global.use_cls": False}


def test_to_params_fans_flat_options_to_every_stage():
    p = to_params({"engine_type": "openvino", "rec_batch_num": 16})
    assert p["Det.engine_type"] == "openvino"
    assert p["Rec.engine_type"] == "openvino"
    assert p["Rec.rec_batch_num"] == 16
    assert "Det.rec_batch_num" not in p


def test_to_params_thread_caps_cover_both_engines():
    p = to_params({"intra_op_num_threads": 2, "inter_op_num_threads": 1})
    assert p["EngineConfig.onnxruntime.intra_op_num_threads"] == 2
    assert p["EngineConfig.openvino.inference_num_threads"] == 2
    assert p["EngineConfig.onnxruntime.inter_op_num_threads"] == 1


def test_to_params_dotted_keys_pass_through():
    p = to_params({"Det.thresh": 0.4})
    assert p["Det.thresh"] == 0.4


def test_to_params_unknown_flat_key_raises():
    with pytest.raises(KeyError):
        to_params({"rec_chunk": 8})   # old-backend knob: must fail loudly, not no-op


def test_to_params_gpu_enables_cuda_with_heuristic_conv_search():
    p = to_params({}, gpu=True)
    assert p["EngineConfig.onnxruntime.use_cuda"] is True
    assert (
        p["EngineConfig.onnxruntime.cuda_ep_cfg.cudnn_conv_algo_search"] == "HEURISTIC"
    )
    assert "EngineConfig.onnxruntime.use_cuda" not in to_params({})


def test_to_params_gpu_tames_the_cuda_arena():
    # v3's default (kNextPowerOfTwo, no limit) doubles the arena per extension and
    # never returns VRAM — observed filling the whole card. Both overrides must ride
    # every GPU build.
    p = to_params({}, gpu=True)
    cfg = "EngineConfig.onnxruntime.cuda_ep_cfg."
    assert p[cfg + "arena_extend_strategy"] == "kSameAsRequested"
    assert p[cfg + "gpu_mem_limit"] == 3 * 1024**3
    assert cfg + "gpu_mem_limit" not in to_params({})


def test_to_lines_reduces_quads_to_axis_aligned_boxes():
    boxes = [[(10, 20), (110, 22), (108, 50), (12, 48)]]
    lines = to_lines(boxes, ("Lith G3 Relic",), (0.97,))
    assert len(lines) == 1
    ln = lines[0]
    assert (ln.text, ln.confidence) == ("Lith G3 Relic", 0.97)
    assert (ln.box.x, ln.box.y, ln.box.w, ln.box.h) == (10, 20, 100, 30)


def test_to_lines_none_detection_is_empty():
    assert to_lines(None, None, None) == []


def test_to_lines_drops_empty_text():
    boxes = [[(0, 0), (5, 0), (5, 5), (0, 5)], [(9, 9), (20, 9), (20, 20), (9, 20)]]
    lines = to_lines(boxes, ("  ", "ok"), (0.9, 0.8))
    assert [ln.text for ln in lines] == ["ok"]


def test_join_rec_joins_pieces_and_averages():
    assert join_rec(("Alad", "V"), (0.9, 0.7)) == ("Alad V", pytest.approx(0.8))


def test_join_rec_empty_is_zero():
    assert join_rec((), ()) == ("", 0.0)
    assert join_rec(None, None) == ("", 0.0)
