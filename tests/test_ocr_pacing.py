"""GPU pacing knobs on the RapidOCR engine: option parsing + chunked/yielded recognition.

One OCR read is a single big CUDA burst; ``rec_chunk`` + ``yield_ms`` split the recognition
into shorter submissions with a sleep between so a game can present a frame in each gap. These
tests exercise the splitting/ordering with a stub recogniser — no models, no GPU.
"""

from __future__ import annotations

from oc.ocr.rapidocr_engine import RapidOcrEngine


class _StubEngine:
    """Stands in for a built RapidOCR: records each text_rec batch size and echoes the crops
    back as scores so input order can be asserted. Returns (rec_res, elapse) like the real one."""

    def __init__(self) -> None:
        self.batch_sizes: list[int] = []

    def text_rec(self, crops):
        self.batch_sizes.append(len(crops))
        return ([("t", x) for x in crops], 0.0)


def test_pacing_options_popped_and_not_forwarded():
    e = RapidOcrEngine(yield_ms=5, rec_chunk=4, rec_batch_num=8)
    assert e.yield_ms == 5.0
    assert e._rec_chunk == 4
    # popped so they never reach RapidOCR(**opts); unrelated options pass through untouched
    assert "yield_ms" not in e._options
    assert "rec_chunk" not in e._options
    assert e._options.get("rec_batch_num") == 8


def test_set_yield_ms_updates_and_rejects_garbage():
    e = RapidOcrEngine()
    assert e.yield_ms == 0.0          # default off
    e.set_yield_ms(2.5)
    assert e.yield_ms == 2.5
    e.set_yield_ms("nope")            # invalid -> keep prior value
    assert e.yield_ms == 2.5
    e.set_yield_ms(-3)               # clamped to >= 0
    assert e.yield_ms == 0.0


def test_text_rec_single_batch_when_pacing_off():
    e = RapidOcrEngine()              # yield_ms=0, rec_chunk=0 -> one call
    stub = _StubEngine()
    out = e._text_rec(stub, list(range(5)))
    assert stub.batch_sizes == [5]
    assert [score for _, score in out] == list(range(5))


def test_text_rec_chunks_and_preserves_order():
    e = RapidOcrEngine(yield_ms=1, rec_chunk=3)   # 1ms sleep keeps the test fast
    stub = _StubEngine()
    out = e._text_rec(stub, list(range(7)))
    assert stub.batch_sizes == [3, 3, 1]          # ceil(7/3) submissions
    assert [score for _, score in out] == list(range(7))   # concatenated in input order


def test_text_rec_no_split_when_at_or_below_chunk():
    e = RapidOcrEngine(yield_ms=1, rec_chunk=8)
    stub = _StubEngine()
    e._text_rec(stub, list(range(8)))
    assert stub.batch_sizes == [8]                # <= chunk -> single call, no yield


def test_text_rec_empty_is_noop():
    e = RapidOcrEngine(yield_ms=5, rec_chunk=2)
    stub = _StubEngine()
    assert e._text_rec(stub, []) == []
    assert stub.batch_sizes == []
