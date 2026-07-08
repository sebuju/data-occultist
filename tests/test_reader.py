"""RegionReader.read() record assembly — pure logic, OCR stubbed."""

import cv2
import numpy as np

from oc.collect.atlas_match import AtlasMatcher
from oc.collect.reader import RegionReader
from oc.interfaces import OcrEngine
from oc.profile.models import (
    Box, FieldDef, FieldRule, FieldType, ReadoutDef, RegionDef, RuleThen, RuleWhen, WindowDef,
)
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


def test_readout_multiword_read_stays_in_reading_order():
    # "augur" (left word) has a slightly LOWER box than "reach" (right word) -- e.g.
    # font kerning/OCR box jitter of a few px. A naive y-then-x sort (the prior bug)
    # would sort by y first and emit "reach augur", reordering the words. Row
    # clustering must recognise both fragments share one visual line and keep them
    # in left-to-right (x) order regardless of the y jitter.
    ocr = StubOcr([
        OcrLine("reach", PixelBox(120, 38, 100, 20), 0.90),
        OcrLine("augur", PixelBox(40, 45, 70, 20), 0.90),
    ])
    window = WindowDef(
        id="w",
        fields=[FieldDef(id="rof_8")],
        readouts=[ReadoutDef(id="slot_5", box=Box(x=0.0, y=0.0, w=1.0, h=0.1), field="rof_8")],
    )
    fields = {f.id: f for f in window.fields}
    frame = Frame(image=np.zeros((100, 300, 3), np.uint8), client=PixelBox(0, 0, 300, 100))
    out = RegionReader(ocr).read_readouts(frame, window, fields)
    assert out["slot_5"] == "augur reach"


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


def _symbol_marker(box, color):
    """A filled square drawn directly into ``img`` at ``box`` (a numpy slice is a VIEW, so
    the draw mutates the frame in place) — the taught template and the live crop use the
    SAME shape so classification is a trivial self-match."""
    marker = np.zeros((box.h, box.w, 3), np.uint8)
    cv2.rectangle(marker, (4, 4), (box.w - 5, box.h - 5), color, -1)
    return marker


def test_symbol_readout_reads_the_matching_label():
    # a readout on a `symbol` field is never OCR'd — it's classified against the taught atlas
    box = PixelBox(10, 10, 40, 40)
    img = np.zeros((100, 100, 3), np.uint8)
    img[box.y : box.y + box.h, box.x : box.x + box.w] = _symbol_marker(box, (0, 200, 0))
    atlas = AtlasMatcher.build(symbol_samples={"Madurai": [_symbol_marker(box, (0, 200, 0))]})
    frame = Frame(image=img, client=PixelBox(0, 0, 100, 100))
    window = WindowDef(
        id="w", fields=[FieldDef(id="school", type=FieldType.symbol)],
        readouts=[ReadoutDef(id="school_8", box=Box(x=0.10, y=0.10, w=0.40, h=0.40), field="school")],
    )
    fields = {f.id: f for f in window.fields}
    out = RegionReader(StubOcr([]), atlas=atlas).read_readouts(frame, window, fields)
    assert out["school_8"] == "Madurai"


def test_symbol_readout_omitted_when_nothing_matches():
    # an occluded/blank glyph must never fire a trigger on a guessed school
    img = np.zeros((100, 100, 3), np.uint8)   # nothing drawn -> no match to any taught template
    atlas = AtlasMatcher.build(symbol_samples={"Madurai": [_symbol_marker(PixelBox(0, 0, 40, 40), (0, 200, 0))]})
    frame = Frame(image=img, client=PixelBox(0, 0, 100, 100))
    window = WindowDef(
        id="w", fields=[FieldDef(id="school", type=FieldType.symbol)],
        readouts=[ReadoutDef(id="school_8", box=Box(x=0.10, y=0.10, w=0.40, h=0.40), field="school")],
    )
    fields = {f.id: f for f in window.fields}
    out = RegionReader(StubOcr([]), atlas=atlas).read_readouts(frame, window, fields)
    assert "school_8" not in out


def test_symbol_key_field_unmatched_drops_the_record():
    # a stored (non-readout) symbol field that fails to classify is never guessed: its value
    # is left unset, so a window keyed on it alone produces an empty (dropped) record
    box = PixelBox(10, 10, 40, 40)
    img = np.zeros((100, 100, 3), np.uint8)   # blank crop -> no match
    atlas = AtlasMatcher.build(symbol_samples={"Madurai": [_symbol_marker(box, (0, 200, 0))]})
    frame = Frame(image=img, client=PixelBox(0, 0, 100, 100))
    window = WindowDef(
        id="w", fields=[FieldDef(id="school", type=FieldType.symbol)],
        regions=[RegionDef(id="school", box=Box(x=0.10, y=0.10, w=0.40, h=0.40), field="school")],
    )
    fields = {f.id: f for f in window.fields}
    records, _sentinel = RegionReader(StubOcr([]), atlas=atlas).read(frame, window, fields)
    assert records == []
