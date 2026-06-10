import numpy as np

from oc.collect.suggest import analyze
from oc.interfaces import OcrEngine
from oc.types import Frame, OcrLine, PixelBox


class FakeOcr(OcrEngine):
    def __init__(self, lines):
        self._lines = lines

    def read_image(self, image):
        return self._lines


def _line(text, x, y, w=200, h=40, conf=0.95):
    return OcrLine(text=text, box=PixelBox(x, y, w, h), confidence=conf)


def test_analyze_detects_grid():
    # 2 rows x 3 cols of names; row pitch 200, col pitch 300.
    names = []
    for r, y in enumerate((100, 300)):
        for c, x in enumerate((100, 400, 700)):
            names.append(_line(f"Item{r}{c}", x, y))
    names.append(_line("5", 280, 130, w=20))  # a numeric badge -> ignored as anchor
    frame = Frame(image=np.zeros((1000, 2000, 3), np.uint8), client=PixelBox(0, 0, 2000, 1000))

    s = analyze(frame, FakeOcr(names))
    assert s["ok"]
    assert s["grid"]["rows"] == 2
    assert s["grid"]["cols"] == 3
    assert abs(s["grid"]["row_stride"] - 200 / 1000) < 0.02
    assert abs(s["grid"]["col_stride"] - 300 / 2000) < 0.02
    assert s["samples"][0] == "Item00"


def test_analyze_excludes_header_and_suggests_count():
    lines = [_line("NAME", 100, 20, w=120)]  # lone header row, far above the grid
    for r, y in enumerate((200, 400)):
        for c, x in enumerate((100, 500, 900)):
            lines.append(_line(f"Item{r}{c}", x, y))
            lines.append(_line("12", x + 200, y, w=30))  # count badge at consistent offset
    frame = Frame(image=np.zeros((1000, 2000, 3), np.uint8), client=PixelBox(0, 0, 2000, 1000))

    s = analyze(frame, FakeOcr(lines))
    assert s["ok"]
    assert s["grid"]["rows"] == 2          # header row excluded
    assert s["grid"]["cols"] == 3
    assert any(p["field"] == "count" and p["type"] == "number" for p in s["parts"])


def test_analyze_handles_no_text():
    frame = Frame(image=np.zeros((100, 100, 3), np.uint8), client=PixelBox(0, 0, 100, 100))
    s = analyze(frame, FakeOcr([]))
    assert s["ok"] is False
