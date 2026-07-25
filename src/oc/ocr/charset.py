"""Constrain what the recogniser is ALLOWED to emit, at the decode itself.

PP-OCR's recogniser ends in a CTC layer over a fixed character list — 18710 classes for the
multilingual v6 models, spanning CJK, Cyrillic, Greek, Thai, accented Latin and emoji.
Reading an English game UI, nearly all of that is only a way to be wrong: a smudged ``o``
comes back as ``ö``, a ``3`` as a kana.

The list cannot simply be shortened. For an ONNX model rapidocr reads the character list
embedded in the model file (``session.have_key()`` is True, so ``Rec.rec_keys_path`` is
ignored entirely), and that list's length IS the network's output width — every class index
maps positionally into it. Drop one entry and every later index decodes to the wrong glyph.

So constrain the DECODE instead: keep the full list, and zero the disallowed classes in the
probability tensor before ``argmax`` picks a winner (see ``CTCLabelDecode.__call__``, which
is just ``preds.argmax(axis=2)`` / ``preds.max(axis=2)``). Forbidden classes become
unreachable and the model emits its best PERMITTED character.

That beats folding the text afterwards. Folding maps ``ö``->``o`` unconditionally; a
constrained decode lets the model pick whatever it actually ranked next, which may be ``e``.
It is also why this belongs here and not in a field rule: it changes what the recogniser can
say, rather than editing what it already said.

Confidence is deliberately NOT renormalised. If the model wanted ``ö`` at 0.99 and the best
allowed character scores 0.30, the read reports 0.30 — a struggling read stays visibly
uncertain and ``tuning.min_confidence`` can still drop it, instead of a rewrite silently
inheriting the banned character's certainty.

This constrains the output ALPHABET only. A confusion *within* the allowed set (the classic
``Q3``/``G3``) is untouched — that is what the taught glyph atlas is for.
"""

from __future__ import annotations

import string
from typing import Sequence

import numpy as np

# CTC needs its blank symbol (index 0) to separate repeated characters, and rapidocr appends
# a space as the final class. Masking either breaks decoding outright rather than narrowing
# it, so both are allowed no matter what the spec says.
_BLANK_INDEX = 0
_SPACE = " "

# Named specs. Anything not listed here is treated as a literal set of allowed characters,
# so settings.yaml can pin an exact alphabet without needing a code change.
NAMED: dict[str, str] = {
    "ascii": string.digits + string.ascii_letters + string.punctuation + _SPACE,
}


def resolve(spec: str) -> set[str]:
    """A charset spec -> the set of characters it permits.

    A name from :data:`NAMED` expands to its alphabet; any other value is taken literally
    (``"0123456789."`` for a numeric readout). Raises on an empty spec — silently allowing
    everything would look identical to a working restriction.
    """
    spec = str(spec)
    if not spec.strip():
        raise ValueError("charset spec is empty; use a name from NAMED or a literal alphabet")
    return set(NAMED.get(spec, spec))


def build_mask(character: Sequence[str], spec: str) -> np.ndarray:
    """Boolean allow-mask over ``character`` (the model's full class list, in order).

    ``mask[i]`` is True when class ``i`` may be emitted. Blank and space are always True.
    Raises when the spec would leave nothing readable — a mask that permits no letters or
    digits is a misconfiguration, and failing loudly beats every read coming back empty.
    """
    allowed = resolve(spec)
    mask = np.zeros(len(character), dtype=bool)
    for i, ch in enumerate(character):
        mask[i] = ch in allowed
    if len(mask):
        mask[_BLANK_INDEX] = True
    for i, ch in enumerate(character):
        if ch == _SPACE:
            mask[i] = True
    # The blank token is the literal word "blank" and space is whitespace — neither is a
    # readable glyph, so both must be excluded here or this guard can never fire.
    readable = [character[i] for i in np.flatnonzero(mask)
                if i != _BLANK_INDEX and character[i] != _SPACE]
    if not any(ch.isalnum() for ch in readable):
        raise ValueError(f"charset {spec!r} permits no letters or digits — nothing could be read")
    return mask


class MaskedDecode:
    """Wraps a ``CTCLabelDecode``, zeroing disallowed classes before it argmaxes.

    Delegates every other attribute to the wrapped object, since callers also read
    ``.character`` / ``.dict`` off it. Wrapping the INSTANCE (rather than patching the class)
    keeps the change local to one engine — a second engine built with a different charset,
    as the model bench does, is unaffected.
    """

    __slots__ = ("_inner", "_mask")

    def __init__(self, inner, mask: np.ndarray) -> None:
        self._inner = inner
        self._mask = mask

    def __call__(self, preds, *args, **kwargs):
        preds = np.asarray(preds)
        if preds.ndim and preds.shape[-1] == self._mask.size:
            preds = preds.copy()          # never mutate the session's own output buffer
            preds[..., ~self._mask] = 0.0
        return self._inner(preds, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def apply(engine, spec: str) -> int:
    """Constrain a built ``RapidOCR``'s recogniser to ``spec``. Returns the allowed count.

    Raises if the decode can't be reached or its class list doesn't match the model's output
    width. A charset that silently fails to apply is worse than no charset at all: reads look
    constrained but aren't, and the failure only surfaces later as unexplained characters.
    """
    try:
        rec = engine.text_rec
        decode = rec.postprocess_op
        character = decode.character
    except AttributeError as exc:
        raise RuntimeError(f"cannot reach the recogniser's CTC decode to apply charset: {exc}")
    if isinstance(decode, MaskedDecode):      # rebuilt engine, already constrained
        return int(decode._mask.sum())
    mask = build_mask(character, spec)
    rec.postprocess_op = MaskedDecode(decode, mask)
    return int(mask.sum())
