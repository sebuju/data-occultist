"""Draw a toast's hero / inline image on the fly (PIL).

A :class:`oc.profile.models.ToastImageDef` is a tiny design: a solid or 2-colour gradient
background with positioned, coloured, aligned text lines painted over it. Text lines interpolate
``{{token}}`` against a :class:`oc.collect.templating.TokenContext`, so the live readout / dataset
values land straight on the image — the whole point, since Windows toast popups won't style plain
text but WILL show a generated image (hero banner / inline body image).

``render_png(spec, ctx)`` returns PNG bytes; ``render_to_file`` writes them for the notifier to
hand ``toasted`` as a ``file://`` URI. Import is lazy at the call site (PIL/numpy) so importing
this module never drags them in.
"""

from __future__ import annotations

from pathlib import Path


def _rgb(hexstr: str, default=(0, 0, 0)):
    h = (hexstr or "").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return default
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return default


def _font(size: int):
    from PIL import ImageFont

    # Prefer a real TrueType so `size` is honoured (the PIL default bitmap font ignores size).
    for name in ("segoeui.ttf", "arial.ttf", "tahoma.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, max(6, int(size)))
        except OSError:
            continue
    return ImageFont.load_default()


def _background(width: int, height: int, spec):
    from PIL import Image

    c1 = _rgb(getattr(spec, "color1", "#0a3d62"), (10, 61, 98))
    if getattr(spec, "bg_type", "solid") != "gradient":
        return Image.new("RGB", (width, height), c1)
    c2 = _rgb(getattr(spec, "color2", "#061826"), (6, 24, 38))
    import math

    import numpy as np

    rad = math.radians(getattr(spec, "angle", 90) or 0)
    dx, dy = math.cos(rad), math.sin(rad)
    xs = np.arange(width, dtype="float32")
    ys = np.arange(height, dtype="float32")
    proj = np.add.outer(ys * dy, xs * dx)          # (h, w) distance along the gradient axis
    lo, hi = float(proj.min()), float(proj.max())
    t = (proj - lo) / (hi - lo) if hi > lo else np.zeros_like(proj)
    a = np.array(c1, dtype="float32")
    b = np.array(c2, dtype="float32")
    grad = (a[None, None, :] + (b - a)[None, None, :] * t[:, :, None]).astype("uint8")
    return Image.fromarray(grad, "RGB")


def _wrap(text: str, font, max_width: int, draw) -> str:
    """Greedy word-wrap ``text`` to ``max_width`` pixels at ``font`` (honouring existing newlines
    as hard breaks). A single word wider than the limit is kept on its own line rather than lost."""
    lines = []
    for para in str(text).split("\n"):
        line = ""
        for word in para.split(" "):
            trial = word if not line else f"{line} {word}"
            if not line or draw.textlength(trial, font=font) <= max_width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return "\n".join(lines)


def _ellipsize(text: str, font, max_width: int, draw) -> str:
    """Truncate ``text`` to one line fitting ``max_width`` pixels, ending in … when clipped
    (the no-wrap counterpart of :func:`_wrap`). Newlines collapse to spaces."""
    text = str(text).replace("\n", " ")
    if draw.textlength(text, font=font) <= max_width:
        return text
    ell = "…"
    lo, hi = 0, len(text)
    while lo < hi:                      # largest prefix that still fits with the ellipsis
        mid = (lo + hi + 1) // 2
        if draw.textlength(text[:mid] + ell, font=font) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    return (text[:lo] + ell) if lo > 0 else ell


def render_png(spec, ctx=None, *, keep_missing: bool = False, focus=None) -> bytes:
    """Render ``spec`` (a ToastImageDef) to PNG bytes, interpolating each text line's ``{{token}}``
    against ``ctx``. ``keep_missing`` (preview) keeps an unresolvable token as its literal text so
    the design stays visible without a live session. ``focus`` (a text-line index) outlines that
    line's bounding box — the editor draws it around the line being edited."""
    return render_png_boxes(spec, ctx, keep_missing=keep_missing, focus=focus)[0]


def render_png_boxes(spec, ctx=None, *, keep_missing: bool = False, focus=None):
    """Like :func:`render_png` but also returns the per-text-line pixel bounding boxes so the node
    editor can overlay a clickable box on each element (its mini-inspector selects from there).
    Returns ``(png_bytes, boxes)`` where ``boxes`` is ``[{"i", "x", "y", "w", "h"}]`` in image
    pixels, one per text line (empty lines get a small stub box so they stay selectable)."""
    import io

    from PIL import ImageDraw

    from ..collect.templating import render

    w = max(1, int(getattr(spec, "width", 364) or 364))
    h = max(1, int(getattr(spec, "height", 180) or 180))
    img = _background(w, h, spec)
    draw = ImageDraw.Draw(img)
    boxes = []
    for _idx, t in enumerate(getattr(spec, "texts", None) or []):
        content = render(getattr(t, "content", "") or "", ctx, keep_missing=keep_missing) if ctx is not None \
            else (getattr(t, "content", "") or "")
        font = _font(getattr(t, "size", 20) or 20)
        x, y = int(getattr(t, "x", 12) or 0), int(getattr(t, "y", 12) or 0)
        align = getattr(t, "align", "left") or "left"
        if align not in ("left", "center", "right"):
            align = "left"
        width = int(getattr(t, "width", 0) or 0)
        height = int(getattr(t, "height", 0) or 0)
        if content and width > 0:
            content = _wrap(content, font, width, draw) if getattr(t, "wrap", True) \
                else _ellipsize(content, font, width, draw)
        # anchor sets the x reference (left edge / centre / right edge); vertical "a" = top.
        anchor = {"left": "la", "center": "ma", "right": "ra"}[align]
        # bounding box for the editor overlay: the real text bbox when there's content, else a small
        # stub at the anchor so an empty line is still clickable in the preview.
        bb = None
        if content:
            try:
                bb = draw.multiline_textbbox((x, y), content, font=font, anchor=anchor, align=align)
            except Exception:   # noqa: BLE001 - geometry is a design aid, never fatal
                bb = None
        if bb is None:
            sz = int(getattr(t, "size", 20) or 20)
            left = x if align == "left" else x - 12 if align == "center" else x - 24
            bb = (left, y, left + 24, y + max(8, sz))
        boxes.append({"i": _idx, "x": int(bb[0]), "y": int(bb[1]),
                      "w": max(1, int(bb[2] - bb[0])), "h": max(1, int(bb[3] - bb[1]))})
        if not content:
            continue
        color = _rgb(getattr(t, "color", "#ffffff"), (255, 255, 255))
        # optional filled box behind the text — the box's left edge follows the same anchor as the
        # text so the fill stays under it. Drawn only when both dims and a colour are set.
        bg_color = getattr(t, "bg_color", "") or ""
        if width > 0 and height > 0 and bg_color:
            left = x if align == "left" else x - width // 2 if align == "center" else x - width
            draw.rectangle([left, y, left + width, y + height], fill=_rgb(bg_color))
        draw.multiline_text((x, y), content, font=font, fill=color, anchor=anchor, align=align)
        if focus is not None and _idx == focus:
            draw.rectangle([bb[0] - 2, bb[1] - 2, bb[2] + 2, bb[3] + 2], outline=(255, 96, 96), width=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), boxes


def render_to_file(spec, ctx, path: Path) -> Path | None:
    """Render ``spec`` to ``path`` (created parents). Returns the path, or ``None`` on any error —
    a bad image must never break a fire. The caller decides which images to render (by placement)."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(render_png(spec, ctx))
        return path
    except Exception:   # noqa: BLE001 - image generation is best-effort
        return None
