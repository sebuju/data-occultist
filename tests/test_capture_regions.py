"""Strip planning (capture/regions.py) + sparse-frame equivalence for the classify cache."""

import numpy as np

from oc.capture.regions import strip_spans
from oc.collect import detsig
from oc.types import Frame, FractionBox, PixelBox


def test_no_boxes_is_none():
    assert strip_spans([], 2160) is None


def test_single_box_pads_by_own_height():
    spans = strip_spans([PixelBox(100, 1000, 300, 60)], 2160)
    assert spans == [(940, 1120)]   # 60px pad both sides


def test_min_pad_for_tiny_boxes():
    spans = strip_spans([PixelBox(0, 500, 300, 4)], 2160)
    assert spans == [(484, 520)]    # 16px floor, not 4


def test_pad_clamps_to_window():
    spans = strip_spans([PixelBox(0, 5, 100, 30), PixelBox(0, 2140, 100, 30)], 2160,
                        gap=100)
    assert spans == [(0, 65), (2110, 2160)]


def test_near_boxes_merge_into_one_strip():
    spans = strip_spans([PixelBox(0, 100, 50, 40), PixelBox(0, 300, 50, 40)], 2160)
    assert len(spans) == 1
    y0, y1 = spans[0]
    assert y0 == 60 and y1 == 380


def test_far_boxes_stay_separate_strips():
    spans = strip_spans([PixelBox(0, 100, 50, 40), PixelBox(0, 1800, 50, 40)], 2160)
    assert len(spans) == 2


def test_strip_count_capped_by_merging_smallest_gap():
    boxes = [PixelBox(0, y, 50, 20) for y in (100, 600, 700, 1400, 2000)]
    spans = strip_spans(boxes, 2160, gap=10, max_strips=3)
    assert len(spans) == 3
    # 600/700 pair had the smallest gap -> merged together
    assert any(y0 <= 580 and y1 >= 740 for y0, y1 in spans)


def test_excessive_coverage_falls_back_to_full():
    boxes = [PixelBox(0, y, 50, 200) for y in (0, 500, 1000, 1500)]
    assert strip_spans(boxes, 2160, max_cover=0.4) is None


def test_spans_sorted_and_disjoint():
    boxes = [PixelBox(0, 1900, 50, 40), PixelBox(0, 80, 50, 40), PixelBox(0, 1000, 50, 40)]
    spans = strip_spans(boxes, 2160)
    assert spans == sorted(spans)
    for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
        assert a1 < b0


def test_detsig_features_equal_on_sparse_canvas():
    # A canvas holding only the strip rows must produce the SAME detector features as the
    # full frame — the classify cache compare must not notice the difference.
    rng = np.random.default_rng(7)
    full = rng.integers(0, 255, (400, 600, 3), dtype=np.uint8)
    client = PixelBox(0, 0, 600, 400)
    fracs = [FractionBox(0.1, 0.05, 0.3, 0.1), FractionBox(0.5, 0.8, 0.4, 0.1)]
    boxes = [fb.to_pixels(600, 400) for fb in fracs]
    spans = strip_spans(boxes, 400, gap=40)
    assert spans is not None and len(spans) == 2
    canvas = np.zeros_like(full)
    for y0, y1 in spans:
        canvas[y0:y1] = full[y0:y1]
    fa = detsig.features(Frame(image=full, client=client), fracs)
    fb = detsig.features(Frame(image=canvas, client=client), fracs)
    assert detsig.changed(fa, fb, detsig.TOL) == 0
