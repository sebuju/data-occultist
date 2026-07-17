"""RegionReader.read() record assembly — pure logic, OCR stubbed."""

import cv2
import numpy as np

from oc.collect.atlas_match import AtlasMatcher
from oc.collect.reader import RegionReader
from oc.interfaces import OcrEngine
from oc.profile.models import (
    Box, FieldDef, FieldRule, FieldType, Preprocess, PreprocessMode, ReadoutDef, RegionDef,
    RuleThen, RuleWhen, WindowDef,
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


def test_readout_stuttered_boundary_letter_is_dropped():
    # THE confirmed live bug (caught via debug logging on a real capture, 09/07/26):
    # two CLEAN, non-overlapping fragment boxes -- "Augur" and, from the recogniser
    # itself, the literal text "r Reach" for the second box. No duplicate box exists
    # here for _dedup_fragments to catch; the recogniser stuttered "Reach"'s own
    # leading letter into its own token INSIDE that one fragment's text. Real boxes:
    # Augur (92,12,134,62), "r Reach" (195,11,146,59) -- 21% x-overlap, well under the
    # dedup threshold (both boxes are genuine, only the second's TEXT is corrupt).
    ocr = StubOcr([
        OcrLine("Augur", PixelBox(92, 12, 134, 62), 0.9999),
        OcrLine("r Reach", PixelBox(195, 11, 146, 59), 0.9979),
    ])
    window = WindowDef(
        id="w",
        fields=[FieldDef(id="rof_8")],
        readouts=[ReadoutDef(id="slot_5", box=Box(x=0.0, y=0.0, w=1.0, h=1.0), field="rof_8")],
    )
    fields = {f.id: f for f in window.fields}
    frame = Frame(image=np.zeros((100, 400, 3), np.uint8), client=PixelBox(0, 0, 400, 100))
    out = RegionReader(ocr).read_readouts(frame, window, fields)
    assert out["slot_5"] == "Augur Reach"


def test_readout_unrelated_single_letter_word_survives():
    # A genuine single-letter word must NOT be dropped just because it's short -- only
    # a 1-letter word touching an adjacent word's MATCHING boundary letter is a stutter.
    # Here "V" neighbours "Gauss", which starts with a different letter, so it survives.
    ocr = StubOcr([
        OcrLine("V", PixelBox(10, 10, 20, 20), 0.95),
        OcrLine("Gauss", PixelBox(35, 10, 90, 20), 0.95),
    ])
    window = WindowDef(
        id="w",
        fields=[FieldDef(id="rof_8")],
        readouts=[ReadoutDef(id="slot_5", box=Box(x=0.0, y=0.0, w=1.0, h=1.0), field="rof_8")],
    )
    fields = {f.id: f for f in window.fields}
    frame = Frame(image=np.zeros((100, 200, 3), np.uint8), client=PixelBox(0, 0, 200, 100))
    out = RegionReader(ocr).read_readouts(frame, window, fields)
    assert out["slot_5"] == "V Gauss"


def test_readout_duplicate_fragment_is_deduped():
    # Defensive layer for a RELATED but distinct failure mode -- a genuine duplicate
    # detection box (the same glyph detected twice as separate fragments), which
    # reading-order alone can only reorder, never remove. Not the confirmed live bug
    # (that turned out to be the stutter case above), but a real class of OCR
    # over-segmentation the join must not re-introduce either.
    ocr = StubOcr([
        OcrLine("augur", PixelBox(40, 45, 70, 20), 0.90),
        OcrLine("reach", PixelBox(120, 38, 100, 20), 0.90),
        OcrLine("r", PixelBox(125, 38, 15, 20), 0.55),   # fully inside "reach"'s box
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


def test_readout_adjacent_words_are_not_deduped():
    # Two REAL neighbouring words' boxes routinely clip each other's corners (~13% of
    # the smaller box's area, measured on an actual "Augur"+"Reach" detection pair) --
    # that overlap must NOT trip the duplicate-fragment dedup, or two genuinely
    # different words would collapse into one.
    ocr = StubOcr([
        OcrLine("Augur", PixelBox(6, 9, 139, 72), 0.9998),
        OcrLine("Reach", PixelBox(127, 9, 136, 64), 0.9999),
    ])
    window = WindowDef(
        id="w",
        fields=[FieldDef(id="rof_8")],
        readouts=[ReadoutDef(id="slot_5", box=Box(x=0.0, y=0.0, w=1.0, h=1.0), field="rof_8")],
    )
    fields = {f.id: f for f in window.fields}
    frame = Frame(image=np.zeros((100, 300, 3), np.uint8), client=PixelBox(0, 0, 300, 100))
    out = RegionReader(ocr).read_readouts(frame, window, fields)
    assert out["slot_5"] == "Augur Reach"


class SequencedOcr(OcrEngine):
    """Returns each configured response in CALL ORDER (not content-keyed) -- exactly
    matches how ``_readout_text_reads`` drives OCR: one isolated ``read_image`` per
    pending box (via ``_detect_reads``), THEN, only if at least one box came back
    present, one more ``read_image`` for the wider union+margin pass (via
    ``_ocr_union``). Counting ``.calls`` after a run proves whether that second,
    wider call happened at all -- the cheapest way to assert "no wide pass when
    nothing is present" without inspecting crop geometry."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    def read_image(self, image):
        resp = self._responses[self.calls] if self.calls < len(self._responses) else []
        self.calls += 1
        return list(resp)


def test_readout_crosscheck_prefers_clean_wide_over_split_iso():
    # THE motivating case, confirmed on a real capture during Phase-0 probing
    # (09/07/26): a tight isolated crop doesn't just split text at a word boundary
    # (the older "Augur"/"r Reach" bug, already patched by _drop_stutter_words) -- it
    # can fuse a DOUBLED letter INSIDE one token ("Umbral" + "IIntensify"), which no
    # existing text-level cleanup catches because there's no lone 1-letter word and no
    # duplicate box. The wider cross-check pass reads the same text cleanly.
    box = Box(x=0.1, y=0.1, w=0.2, h=0.2)   # -> pixels (100, 40, 200, 80) on a 1000x400 frame
    window = WindowDef(
        id="w", fields=[FieldDef(id="rof_8")],
        readouts=[ReadoutDef(id="slot_8", box=box, field="rof_8")],
    )
    frame = Frame(image=np.zeros((400, 1000, 3), np.uint8), client=PixelBox(0, 0, 1000, 400))
    ocr = SequencedOcr([
        # call 1: isolated crop -- the corrupted read that ships today
        [OcrLine("Umbral", PixelBox(10, 10, 90, 50), 0.99),
         OcrLine("IIntensify", PixelBox(105, 10, 120, 50), 0.99)],
        # call 2: wider union+margin pass -- one clean detection
        [OcrLine("Umbral Intensify", PixelBox(30, 30, 220, 50), 0.99)],
    ])
    reader = RegionReader(ocr)
    pending = [("slot_8", box.to_fraction().to_pixels(1000, 400))]
    out = reader._readout_text_reads(frame, window, pending)
    assert out["slot_8"][0] == "Umbral Intensify"   # NOT "Umbral IIntensify"


def test_readout_crosscheck_absent_box_never_hallucinated():
    # Two readouts: one the isolated (presence-oracle) read finds EMPTY, one it finds
    # present. The wide pass geometrically covers both boxes (adjacent, inside the
    # grown union) and returns a stray line centred squarely inside the EMPTY box --
    # simulating exactly the hallucination a large OCR pass can produce on blank
    # space. It must never surface: absence is decided by the isolated read alone,
    # and the wide pass is never even consulted for a key that isn't already present.
    box_empty = Box(x=0.28, y=0.1, w=0.02, h=0.2)     # pixels (280, 40, 20, 80) -> center (290, 80)
    box_present = Box(x=0.3, y=0.1, w=0.2, h=0.2)     # pixels (300, 40, 200, 80)
    window = WindowDef(
        id="w", fields=[FieldDef(id="rof_e"), FieldDef(id="rof_p")],
        readouts=[
            ReadoutDef(id="empty_slot", box=box_empty, field="rof_e"),
            ReadoutDef(id="present_slot", box=box_present, field="rof_p"),
        ],
    )
    frame = Frame(image=np.zeros((400, 1000, 3), np.uint8), client=PixelBox(0, 0, 1000, 400))
    ocr = SequencedOcr([
        [],                                                              # call 1: empty_slot isolated -- nothing
        [OcrLine("Clean Text", PixelBox(10, 10, 150, 50), 0.9)],         # call 2: present_slot isolated
        [                                                                # call 3: wide union+margin pass
            OcrLine("Ghost", PixelBox(2, 57, 40, 30), 0.9),               # centres at frame (290, 80) -- inside box_empty
            OcrLine("Clean Text", PixelBox(57, 47, 150, 50), 0.95),       # centres inside box_present
        ],
    ])
    reader = RegionReader(ocr)
    pending = [
        ("empty_slot", box_empty.to_fraction().to_pixels(1000, 400)),
        ("present_slot", box_present.to_fraction().to_pixels(1000, 400)),
    ]
    out = reader._readout_text_reads(frame, window, pending)
    assert "empty_slot" not in out                 # never hallucinated, despite a covering wide line
    assert out["present_slot"][0] == "Clean Text"


def test_readout_crosscheck_rejects_overmerged_wide():
    # Two ADJACENT present boxes, each with its own clean isolated read. The wide
    # pass over-merges them into ONE line spanning both -- its own box only ~57%
    # contained within either readout box, well under the containment guard. Both
    # boxes must fall back to their (already correct) isolated reads rather than
    # accept a merged/ambiguous wide line.
    box_a = Box(x=0.1, y=0.1, w=0.2, h=0.2)   # pixels (100, 40, 200, 80)
    box_b = Box(x=0.3, y=0.1, w=0.2, h=0.2)   # pixels (300, 40, 200, 80), touching box_a
    window = WindowDef(
        id="w", fields=[FieldDef(id="rof_a"), FieldDef(id="rof_b")],
        readouts=[
            ReadoutDef(id="slot_a", box=box_a, field="rof_a"),
            ReadoutDef(id="slot_b", box=box_b, field="rof_b"),
        ],
    )
    frame = Frame(image=np.zeros((400, 1000, 3), np.uint8), client=PixelBox(0, 0, 1000, 400))
    ocr = SequencedOcr([
        [OcrLine("AaText", PixelBox(10, 10, 150, 50), 0.9)],    # call 1: slot_a isolated
        [OcrLine("BbText", PixelBox(10, 10, 150, 50), 0.9)],    # call 2: slot_b isolated
        [OcrLine("AaText BbText", PixelBox(62, 52, 300, 40), 0.99)],   # call 3: wide -- over-merged
    ])
    reader = RegionReader(ocr)
    pending = [
        ("slot_a", box_a.to_fraction().to_pixels(1000, 400)),
        ("slot_b", box_b.to_fraction().to_pixels(1000, 400)),
    ]
    out = reader._readout_text_reads(frame, window, pending)
    assert out["slot_a"][0] == "AaText"    # kept the isolated read, not the merged line
    assert out["slot_b"][0] == "BbText"


def test_readout_crosscheck_no_wide_pass_when_all_empty():
    # Nothing present -> zero added OCR cost: the wide pass must never even run.
    box = Box(x=0.1, y=0.1, w=0.2, h=0.2)
    window = WindowDef(
        id="w", fields=[FieldDef(id="rof_8")],
        readouts=[ReadoutDef(id="slot_5", box=box, field="rof_8")],
    )
    frame = Frame(image=np.zeros((400, 1000, 3), np.uint8), client=PixelBox(0, 0, 1000, 400))
    ocr = SequencedOcr([[]])   # call 1: isolated -- nothing detected
    reader = RegionReader(ocr)
    pending = [("slot_5", box.to_fraction().to_pixels(1000, 400))]
    out = reader._readout_text_reads(frame, window, pending)
    assert out == {}
    assert ocr.calls == 1   # only the isolated call -- no wide pass


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


class ShapeOcr(OcrEngine):
    """Records the (h, w) of every crop it is handed, so a test can prove which preprocess
    (hence which upscale) was applied to each box before OCR."""

    def __init__(self):
        self.shapes = []

    def read_image(self, image):
        self.shapes.append(tuple(image.shape[:2]))
        return [OcrLine("x", PixelBox(0, 0, 5, 5), 0.9)]


def test_readout_preprocess_override_beats_window_fallback_per_box():
    # A per-readout preprocess override applies to THAT box's isolated crop; a readout WITHOUT
    # one falls back to the window's preprocess. Proven via the upscale factor each crop got:
    # box "a" (own scale=2) doubles, box "b" (window scale=3 fallback) triples.
    box_a = Box(x=0.1, y=0.1, w=0.2, h=0.2)   # pixels (100, 40, 200, 80) -> crop (80, 200)
    box_b = Box(x=0.4, y=0.1, w=0.2, h=0.2)   # pixels (400, 40, 200, 80) -> crop (80, 200)
    window = WindowDef(
        id="w", preprocess=Preprocess(mode=PreprocessMode.none, scale=3),
        fields=[FieldDef(id="fa"), FieldDef(id="fb")],
        readouts=[ReadoutDef(id="a", box=box_a, field="fa"),
                  ReadoutDef(id="b", box=box_b, field="fb")],
    )
    frame = Frame(image=np.zeros((400, 1000, 3), np.uint8), client=PixelBox(0, 0, 1000, 400))
    ocr = ShapeOcr()
    pending = [("a", box_a.to_fraction().to_pixels(1000, 400)),
               ("b", box_b.to_fraction().to_pixels(1000, 400))]
    RegionReader(ocr)._detect_reads(frame, window, pending, {"a": Preprocess(scale=2)})
    assert ocr.shapes == [(160, 400), (240, 600)]   # a: 80*2/200*2 ; b: 80*3/200*3 (window fallback)


def test_readout_preprocess_override_skips_wide_clobber():
    # THE bug scenario, at the reader seam: an overridden readout's isolated (masked) crop reads
    # the true "4.00"; the window-preprocess wide cross-check would re-read the union as a fused
    # "400" and clobber it. With its own override the isolated read is authoritative and the wide
    # pass is skipped entirely (no clobber, and no wasted OCR call).
    box = Box(x=0.1, y=0.1, w=0.2, h=0.2)
    window = WindowDef(
        id="w", fields=[FieldDef(id="cd", type=FieldType.number)],
        readouts=[ReadoutDef(id="ability_4_cd", box=box, field="cd")],
    )
    frame = Frame(image=np.zeros((400, 1000, 3), np.uint8), client=PixelBox(0, 0, 1000, 400))
    ocr = SequencedOcr([
        [OcrLine("4.00", PixelBox(10, 10, 90, 50), 0.99)],   # call 1: isolated masked crop -- correct
        [OcrLine("400", PixelBox(10, 10, 90, 50), 0.99)],    # call 2 (would-be wide) -- must NOT run
    ])
    reader = RegionReader(ocr)
    pending = [("ability_4_cd", box.to_fraction().to_pixels(1000, 400))]
    out = reader._readout_text_reads(frame, window, pending, {"ability_4_cd": Preprocess(mode=PreprocessMode.color, colors=["#ffffff"], scale=2)})
    assert out["ability_4_cd"][0] == "4.00"   # not "400"
    assert ocr.calls == 1                     # wide pass skipped (box is overridden)


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
