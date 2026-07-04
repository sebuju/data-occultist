"""RegionReader.read() record assembly — pure logic, OCR stubbed."""

import numpy as np

from oc.collect.reader import RegionReader
from oc.interfaces import OcrEngine
from oc.profile.models import Box, FieldDef, FieldRule, FieldType, RegionDef, RuleThen, RuleWhen, WindowDef
from oc.types import Frame, OcrLine, PixelBox


class StubOcr(OcrEngine):
    """Returns a fixed set of lines regardless of the image."""

    def __init__(self, lines):
        self._lines = lines

    def read_image(self, image) -> list[OcrLine]:
        return list(self._lines)


def _frame():
    return Frame(image=np.zeros((1000, 1000, 3), np.uint8), client=PixelBox(0, 0, 1000, 1000))


def _window():
    return WindowDef(
        id="w",
        fields=[
            FieldDef(id="name"),
            FieldDef(id="count", type=FieldType.number,
                     rules=[FieldRule(when=RuleWhen.no_digit, then=RuleThen.set, value="1")]),
        ],
        regions=[
            RegionDef(id="name", box=Box(x=0.0, y=0.0, w=0.5, h=0.1), field="name"),
            RegionDef(id="count", box=Box(x=0.5, y=0.0, w=0.5, h=0.1), field="count"),
        ],
    )


def test_substituted_read_does_not_sink_confidence():
    # OCR junk in the count box (icon art) trips the no_digit set-rule -> count = 1.
    # The substituted value is authored config, so the junk's low OCR confidence
    # must not drag the record below the save floor.
    ocr = StubOcr([
        OcrLine("Soma Prime", PixelBox(50, 40, 200, 30), 0.95),
        OcrLine("囧", PixelBox(600, 40, 100, 30), 0.30),
    ])
    window = _window()
    fields = {f.id: f for f in window.fields}
    records, _sentinel = RegionReader(ocr).read(_frame(), window, fields)
    assert len(records) == 1
    rec = records[0]
    assert rec.values == {"name": "Soma Prime", "count": 1}
    assert rec.confidence >= 0.9     # the name's confidence, not the junk's


def test_real_low_confidence_read_still_sinks_record():
    # an uncertain read that did NOT substitute (a real number) must still gate
    ocr = StubOcr([
        OcrLine("Soma Prime", PixelBox(50, 40, 200, 30), 0.95),
        OcrLine("3", PixelBox(600, 40, 100, 30), 0.30),
    ])
    window = _window()
    fields = {f.id: f for f in window.fields}
    records, _sentinel = RegionReader(ocr).read(_frame(), window, fields)
    assert len(records) == 1
    assert records[0].values["count"] == 3
    assert records[0].confidence == 0.30
