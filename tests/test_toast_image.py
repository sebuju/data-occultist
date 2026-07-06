"""Toast image renderer: box-model geometry (anchor, 9-point align, units) + the preview's
keep-missing token behaviour. Pure logic — needs PIL only, no game/GPU."""

from oc.notify.toast_image import render_png_boxes
from oc.profile.models import (
    ToastAnchor, ToastBorderSide, ToastImageDef, ToastImageTextDef,
)


def _img(**kw):
    return ToastImageDef(**kw)


def test_box_uses_explicit_size_not_text_bbox():
    img = _img(width=300, height=150,
               texts=[ToastImageTextDef(content="hi", x=20, y=20, width=120, height=40)])
    _, boxes = render_png_boxes(img, ctx=None)
    assert boxes[0] == {"i": 0, "x": 20, "y": 20, "w": 120, "h": 40}


def test_sibling_anchor_positions_below():
    img = _img(width=300, height=150, texts=[
        ToastImageTextDef(content="A", x=20, y=20, width=100, height=40),
        ToastImageTextDef(content="B", x=0, y=8, width=60, height=20,
                          anchor=ToastAnchor(to="0", corner="tl", target="bl")),
    ])
    _, boxes = render_png_boxes(img, ctx=None)
    # B's top-left sits on A's bottom-left (20, 60) + its (0, 8) offset
    assert boxes[1]["x"] == 20 and boxes[1]["y"] == 68


def test_disable_if_empty_collapses_gap_for_anchored_chain():
    # middle element resolves empty with disable_if_empty -> it takes zero size/offset, so the
    # element anchored below it shifts up to fill the gap instead of leaving a hole.
    img = _img(width=300, height=200, texts=[
        ToastImageTextDef(content="A", x=0, y=0, width=100, height=20),
        ToastImageTextDef(content="", disable_if_empty=True, x=0, y=8, width=100, height=20,
                          anchor=ToastAnchor(to="0", corner="tl", target="bl")),
        ToastImageTextDef(content="C", x=0, y=0, width=100, height=20,
                          anchor=ToastAnchor(to="1", corner="tl", target="bl")),
    ])
    _, boxes = render_png_boxes(img, ctx=None)
    # C collapses onto A's bottom-left (0, 20), not below the (would-be) empty middle box
    assert boxes[2]["x"] == 0 and boxes[2]["y"] == 20


def test_disable_if_empty_keeps_gap_when_content_present():
    # same layout, but the middle has content -> it occupies space and C sits below it as usual.
    img = _img(width=300, height=200, texts=[
        ToastImageTextDef(content="A", x=0, y=0, width=100, height=20),
        ToastImageTextDef(content="B", disable_if_empty=True, x=0, y=8, width=100, height=20,
                          anchor=ToastAnchor(to="0", corner="tl", target="bl")),
        ToastImageTextDef(content="C", x=0, y=0, width=100, height=20,
                          anchor=ToastAnchor(to="1", corner="tl", target="bl")),
    ])
    _, boxes = render_png_boxes(img, ctx=None)
    # B at (0, 28); C below B at (0, 48)
    assert boxes[1]["y"] == 28 and boxes[2]["y"] == 48


def test_anchor_cycle_falls_back_to_image():
    # a self/mutual cycle must not hang; the element just anchors to the image
    img = _img(width=200, height=100, texts=[
        ToastImageTextDef(content="A", x=5, y=5, width=30, height=10,
                          anchor=ToastAnchor(to="1", corner="tl", target="tl")),
        ToastImageTextDef(content="B", x=7, y=7, width=30, height=10,
                          anchor=ToastAnchor(to="0", corner="tl", target="tl")),
    ])
    _, boxes = render_png_boxes(img, ctx=None)
    assert len(boxes) == 2


def test_pct_unit_resolves_against_image():
    img = _img(width=200, height=100, unit="pct",
               texts=[ToastImageTextDef(content="P", x=50, y=50, width=25, height=20)])
    _, boxes = render_png_boxes(img, ctx=None)
    assert boxes[0] == {"i": 0, "x": 100, "y": 50, "w": 50, "h": 20}


def test_match_w_copies_sibling_width():
    # element 1's auto width is matched to element 0's explicit 120px box
    img = _img(width=300, height=150, texts=[
        ToastImageTextDef(content="A", x=0, y=0, width=120, height=40),
        ToastImageTextDef(content="B", x=0, y=50, height=20, match_w="0"),
    ])
    _, boxes = render_png_boxes(img, ctx=None)
    assert boxes[1]["w"] == 120


def test_match_w_pct_scales_sibling_width():
    # element 1 matches element 0's 120px box at 50% -> 60px; the match wins over its own explicit width
    img = _img(width=300, height=150, texts=[
        ToastImageTextDef(content="A", x=0, y=0, width=120, height=40),
        ToastImageTextDef(content="B", x=0, y=50, width=200, height=20, match_w="0", match_w_pct=50),
    ])
    _, boxes = render_png_boxes(img, ctx=None)
    assert boxes[1]["w"] == 60


def test_match_w_image_copies_canvas_width():
    # match_w="image" copies the image's own width (300), overriding the element's auto size
    img = _img(width=300, height=150, texts=[
        ToastImageTextDef(content="A", x=0, y=0, height=20, match_w="image")])
    _, boxes = render_png_boxes(img, ctx=None)
    assert boxes[0]["w"] == 300


def test_match_h_image_pct_scales_canvas_height():
    # match_h="image" at 50% of a 150px canvas -> 75px, winning over the explicit height
    img = _img(width=300, height=150, texts=[
        ToastImageTextDef(content="A", x=0, y=0, width=40, height=20, match_h="image", match_h_pct=50)])
    _, boxes = render_png_boxes(img, ctx=None)
    assert boxes[0]["h"] == 75


def test_match_cycle_falls_back_to_own_size():
    # a mutual width-match must not hang; each falls back to its own auto size
    img = _img(width=300, height=150, texts=[
        ToastImageTextDef(content="A", x=0, y=0, height=20, match_w="1"),
        ToastImageTextDef(content="B", x=0, y=50, height=20, match_w="0"),
    ])
    _, boxes = render_png_boxes(img, ctx=None)
    assert len(boxes) == 2


def test_overflow_ellipsizes_single_line():
    # no wrap, overflow off (clip): a long line is truncated to the box width, ending in …
    long = "supercalifragilistic expialidocious wording that will not fit"
    img = _img(width=300, height=150, texts=[
        ToastImageTextDef(content=long, x=0, y=0, width=60, height=20, wrap=False, overflow=False)]
    )
    png, boxes = render_png_boxes(img, ctx=None, keep_missing=True)
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and boxes[0]["w"] == 60


def test_legacy_align_migrates_to_nine_point():
    assert ToastImageTextDef(align="center").align == "tc"
    assert ToastImageTextDef(align="left").align == "tl"
    assert ToastImageTextDef(align="right").align == "tr"
    assert ToastImageTextDef(align="mr").align == "mr"   # already 9-point -> untouched


def test_border_and_font_fields_render_without_error():
    img = _img(width=120, height=60, texts=[ToastImageTextDef(
        content="X", x=5, y=5, width=100, height=40, bold=True, underline=True,
        font_family="arial", border=ToastBorderSide(w=3, color="#ff0000", style="dashed"))])
    png, boxes = render_png_boxes(img, ctx=None)
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and boxes[0]["w"] == 100


def test_preview_keeps_missing_token_literal_fire_renders_empty():
    from oc.collect.templating import render

    class Ctx:
        readouts = {}
        def subset_rows(self, r): return []
        def dataset_rows(self, r): return []

    c = Ctx()
    tok = "reward: {{subset:relic_rewards_with_price.name[2]}}"
    assert render(tok, c, keep_missing=True) == tok            # preview: literal stays
    assert render(tok, c, keep_missing=False) == "reward: "    # fire: empty
    assert render("rows: {{subset:x}}", c, keep_missing=True) == "rows: 0"   # count 0 is real data
