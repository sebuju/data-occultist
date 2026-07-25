"""Charset mask + constrained CTC decode (pure logic — no models, no GPU)."""

from __future__ import annotations

import numpy as np
import pytest

from oc.ocr.charset import MaskedDecode, apply, build_mask, resolve

# A miniature stand-in for a real class list: blank at 0, space last, as rapidocr builds it.
CHARS = ["blank", "a", "b", "o", "ö", "3", "中", "\U0001f6c1", " "]


def test_named_ascii_spec_covers_alnum_and_punctuation():
    allowed = resolve("ascii")
    assert {"a", "Z", "0", "9", ".", "-", " "} <= allowed
    assert "ö" not in allowed and "中" not in allowed


def test_literal_spec_is_taken_verbatim():
    assert resolve("0123456789.") == set("0123456789.")


def test_empty_spec_raises_rather_than_allowing_everything():
    with pytest.raises(ValueError):
        resolve("   ")


def test_mask_blocks_non_ascii_keeps_blank_and_space():
    mask = build_mask(CHARS, "ascii")
    assert mask[0]                      # blank always survives — CTC needs it
    assert mask[CHARS.index(" ")]
    assert mask[CHARS.index("a")] and mask[CHARS.index("3")]
    assert not mask[CHARS.index("ö")]
    assert not mask[CHARS.index("中")]
    assert not mask[CHARS.index("\U0001f6c1")]


def test_mask_keeps_blank_even_for_a_literal_spec_that_omits_it():
    mask = build_mask(CHARS, "ab")
    assert mask[0] and mask[CHARS.index(" ")]
    assert mask[CHARS.index("a")] and not mask[CHARS.index("3")]


def test_mask_rejects_a_spec_that_would_read_nothing():
    with pytest.raises(ValueError, match="permits no letters or digits"):
        build_mask(CHARS, ",.")


def _probs(rows):
    """(1, T, C) probability tensor from per-timestep class scores."""
    return np.asarray([rows], dtype=np.float32)


def test_masked_decode_picks_best_allowed_class_not_the_banned_argmax():
    """The whole point: a banned winner yields the runner-up the model actually ranked,
    rather than a downstream rewrite of the banned character."""
    seen = {}

    def inner(preds, *a, **kw):
        seen["idx"] = preds.argmax(axis=2)
        seen["prob"] = preds.max(axis=2)
        return [("", 0.0)], []

    #                       blank   a     b     o     ö     3    中   emoji  space
    preds = _probs([[0.01, 0.02, 0.03, 0.30, 0.99, 0.01, 0.02, 0.01, 0.01]])
    MaskedDecode(inner, build_mask(CHARS, "ascii"))(preds)
    assert seen["idx"][0][0] == CHARS.index("o")      # ö was argmax; o is best allowed
    assert seen["prob"][0][0] == pytest.approx(0.30)


def test_masked_decode_does_not_renormalise_confidence():
    """A struggling read must stay visibly uncertain — the min_confidence floor depends on
    it, and a rewrite must never inherit the banned character's certainty."""
    seen = {}

    def inner(preds, *a, **kw):
        seen["prob"] = preds.max(axis=2)
        return [("", 0.0)], []

    preds = _probs([[0.0, 0.0, 0.0, 0.05, 0.95, 0.0, 0.0, 0.0, 0.0]])
    MaskedDecode(inner, build_mask(CHARS, "ascii"))(preds)
    assert seen["prob"][0][0] == pytest.approx(0.05)   # not rescaled to ~1.0


def test_masked_decode_leaves_the_callers_array_untouched():
    preds = _probs([[0.01, 0.02, 0.03, 0.30, 0.99, 0.01, 0.02, 0.01, 0.01]])
    before = preds.copy()
    MaskedDecode(lambda p, *a, **kw: ([], []), build_mask(CHARS, "ascii"))(preds)
    assert np.array_equal(preds, before)


def test_masked_decode_passes_through_a_foreign_class_width():
    """A tensor whose width isn't this model's class count is left alone rather than
    silently mangled by a mismatched mask."""
    got = {}

    def inner(preds, *a, **kw):
        got["p"] = preds
        return [], []

    preds = np.zeros((1, 2, 5), dtype=np.float32)
    preds[0, 0, 4] = 1.0
    MaskedDecode(inner, build_mask(CHARS, "ascii"))(preds)
    assert got["p"][0, 0, 4] == 1.0


def test_masked_decode_delegates_unknown_attributes():
    class Inner:
        character = CHARS
        dict = {c: i for i, c in enumerate(CHARS)}

        def __call__(self, preds, *a, **kw):
            return [], []

    wrapped = MaskedDecode(Inner(), build_mask(CHARS, "ascii"))
    assert wrapped.character == CHARS
    assert wrapped.dict["a"] == 1


def test_apply_wraps_the_decode_and_is_idempotent():
    class Decode:
        character = CHARS

        def __call__(self, preds, *a, **kw):
            return [], []

    class Rec:
        postprocess_op = Decode()

    class Engine:
        text_rec = Rec()

    engine = Engine()
    n = apply(engine, "ascii")
    assert isinstance(engine.text_rec.postprocess_op, MaskedDecode)
    assert n == int(build_mask(CHARS, "ascii").sum())
    first = engine.text_rec.postprocess_op
    assert apply(engine, "ascii") == n          # rebuild must not double-wrap
    assert engine.text_rec.postprocess_op is first


def test_apply_raises_when_the_decode_is_unreachable():
    class Engine:
        pass

    with pytest.raises(RuntimeError, match="cannot reach"):
        apply(Engine(), "ascii")
