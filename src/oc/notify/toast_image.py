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


# Per-family TrueType files as (regular, bold, italic, bold-italic). Missing variants fall back to
# the nearest available in _font(). "" / "segoe" is the default face (matches the toast's own text).
_FONT_FILES = {
    "": ("segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"),
    "segoe": ("segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"),
    "arial": ("arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"),
    "tahoma": ("tahoma.ttf", "tahomabd.ttf", "tahoma.ttf", "tahomabd.ttf"),
    "verdana": ("verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf"),
    "calibri": ("calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf"),
    "consolas": ("consola.ttf", "consolab.ttf", "consolai.ttf", "consolaz.ttf"),
    "georgia": ("georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf"),
    "times": ("times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"),
    "impact": ("impact.ttf", "impact.ttf", "impact.ttf", "impact.ttf"),
}


from functools import lru_cache


@lru_cache(maxsize=256)
def _font(size: int, family: str = "", bold: bool = False, italic: bool = False):
    from PIL import ImageFont

    # Prefer a real TrueType so `size` is honoured (the PIL default bitmap font ignores size). Pick
    # the family's (bold, italic) variant, then degrade: exact -> bold -> italic -> regular -> the
    # default face's chain -> PIL's built-in bitmap font.
    # Cached: ImageFont.truetype hits the disk every call, and a preview re-renders on every keystroke
    # /WASD nudge — reloading the same faces each time. Fonts are immutable once loaded, so one shared
    # instance per (size, family, bold, italic) is reused across renders. `size` is coerced to int by
    # the callers, keeping the cache key hashable + small.
    fam = _FONT_FILES.get((family or "").strip().lower(), _FONT_FILES[""])
    idx = (2 if italic else 0) + (1 if bold else 0)
    order = [fam[idx], fam[1], fam[2], fam[0], "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]
    for name in order:
        try:
            return ImageFont.truetype(name, max(6, int(size)))
        except OSError:
            continue
    return ImageFont.load_default()


# Nine-point code ("tl".."br": vertical t/m/b + horizontal l/c/r) -> (fx, fy) fractions of a box.
_VFRAC = {"t": 0.0, "m": 0.5, "b": 1.0}
_HFRAC = {"l": 0.0, "c": 0.5, "r": 1.0}


def _frac(code: str):
    c = (code or "tl").strip().lower()
    v = _VFRAC.get(c[0], 0.0) if len(c) > 0 else 0.0
    hh = _HFRAC.get(c[1], 0.0) if len(c) > 1 else 0.0
    return hh, v          # (horizontal, vertical)


def _len_px(val, ref: int, unit: str) -> int:
    """Resolve a stored length to pixels: ``pct`` = percent of ``ref`` (the image dimension)."""
    n = int(val or 0)
    return round(n / 100.0 * ref) if unit == "pct" else n


def _background(width: int, height: int, spec):
    from PIL import Image

    bg_type = getattr(spec, "bg_type", "solid")
    # transparent: the Windows toast surface (a system-drawn dark acrylic, uneven + theme-tinted —
    # not a flat colour you can match) shows straight through. RGBA with alpha 0; text + per-element
    # bg boxes paint opaque over it, so the banner blends into the toast instead of a solid slab.
    if bg_type == "transparent":
        return Image.new("RGBA", (width, height), (0, 0, 0, 0))
    c1 = _rgb(getattr(spec, "color1", "#0a3d62"), (10, 61, 98))
    if bg_type != "gradient":
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


def _clip_height(content: str, font, max_width: int, max_height: int, draw) -> str:
    """Drop wrapped lines that overflow ``max_height`` and ellipsize the last kept one — the vertical
    counterpart of :func:`_ellipsize` for wrapped, overflow-clipped text."""
    asc, desc = font.getmetrics()
    lh, spacing = asc + desc, 4                 # 4 = PIL multiline_text's default line spacing
    lines = str(content).split("\n")
    n = max(1, int((max_height + spacing) // (lh + spacing)))
    if len(lines) <= n:
        return content
    kept = lines[:n]
    kept[-1] = _ellipsize(kept[-1], font, max_width, draw)
    return "\n".join(kept)


def render_png(spec, ctx=None, *, keep_missing: bool = False, focus=None) -> bytes:
    """Render ``spec`` (a ToastImageDef) to PNG bytes, interpolating each text line's ``{{token}}``
    against ``ctx``. ``keep_missing`` (preview) keeps an unresolvable token as its literal text so
    the design stays visible without a live session. ``focus`` (a text-line index) outlines that
    line's bounding box — the editor draws it around the line being edited."""
    return render_png_boxes(spec, ctx, keep_missing=keep_missing, focus=focus)[0]


def _measure(draw, content, font):
    """(w, h) pixel size of ``content`` at ``font`` — the auto box size when width/height is 0."""
    if not content:
        return 0, 0
    try:
        bb = draw.multiline_textbbox((0, 0), content, font=font)
        return int(bb[2] - bb[0]), int(bb[3] - bb[1])
    except Exception:   # noqa: BLE001 - geometry is a design aid, never fatal
        return 0, 0


def _dash_line(draw, p0, p1, width, fill, style):
    """Draw a straight segment solid / dashed / dotted (PIL has no dashed strokes)."""
    import math

    width = max(1, int(width))
    if style not in ("dashed", "dotted"):
        draw.line([p0, p1], fill=fill, width=width)
        return
    seg, gap = (width, width) if style == "dotted" else (width * 3, width * 2)
    x0, y0 = p0
    x1, y1 = p1
    length = math.hypot(x1 - x0, y1 - y0)
    if length <= 0:
        return
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    d = 0.0
    while d < length:
        s = min(seg, length - d)
        draw.line([(x0 + ux * d, y0 + uy * d), (x0 + ux * (d + s), y0 + uy * (d + s))],
                  fill=fill, width=width)
        d += seg + gap


def _border_for(t, side):
    """Resolved (w, color, style) for one side: a per-side override, else the base border."""
    sides = getattr(t, "border_sides", None) or {}
    b = sides.get(side) or getattr(t, "border", None)
    if b is None:
        return 0, (255, 255, 255), "solid"
    return (int(getattr(b, "w", 0) or 0),
            _rgb(getattr(b, "color", "#ffffff"), (255, 255, 255)),
            getattr(b, "style", "solid") or "solid")


def _draw_borders(draw, box, t):
    bx, by, bw, bh = box
    edges = {"t": ((bx, by), (bx + bw, by)), "b": ((bx, by + bh), (bx + bw, by + bh)),
             "l": ((bx, by), (bx, by + bh)), "r": ((bx + bw, by), (bx + bw, by + bh))}
    for side, (p0, p1) in edges.items():
        wpx, color, style = _border_for(t, side)
        if wpx > 0:
            _dash_line(draw, p0, p1, wpx, color, style)


def _draw_underline(draw, content, font, xy, anchor, ah, color):
    """Underline each rendered line (PIL fonts have no underline flag)."""
    try:
        bb = draw.multiline_textbbox(xy, content, font=font, anchor=anchor)
    except Exception:   # noqa: BLE001
        return
    asc, desc = font.getmetrics()
    lh, spacing = asc + desc, 4
    left, top, blockw = bb[0], bb[1], bb[2] - bb[0]
    thick = max(1, round(int(getattr(font, "size", 14) or 14) / 14))
    for k, ln in enumerate(str(content).split("\n")):
        wln = draw.textlength(ln, font=font)
        x0 = left if ah == "l" else left + (blockw - wln) / 2 if ah == "m" else left + blockw - wln
        y = top + k * (lh + spacing) + asc + 1
        draw.line([(x0, y), (x0 + wln, y)], fill=color, width=thick)


def render_png_boxes(spec, ctx=None, *, keep_missing: bool = False, focus=None):
    """Like :func:`render_png` but also returns the per-element pixel boxes so the node editor can
    overlay a draggable box on each element (clicking one selects it; dragging moves/resizes it).
    Returns ``(png_bytes, boxes)`` where ``boxes`` is ``[{"i", "x", "y", "w", "h"}]`` in image
    pixels — the resolved element box (its own width×height, or the text bbox when auto)."""
    import io

    from PIL import ImageDraw

    from ..collect.templating import render

    w = max(1, int(getattr(spec, "width", 364) or 364))
    h = max(1, int(getattr(spec, "height", 180) or 180))
    unit = getattr(spec, "unit", "px") or "px"
    img = _background(w, h, spec)
    draw = ImageDraw.Draw(img)
    texts = list(getattr(spec, "texts", None) or [])

    # 1) per-element content/font + explicit box lengths (width/height 0 => auto, measured later).
    metas = []
    for t in texts:
        content = render(getattr(t, "content", "") or "", ctx, keep_missing=keep_missing) if ctx is not None \
            else (getattr(t, "content", "") or "")
        font = _font(int(getattr(t, "size", 20) or 20), (getattr(t, "font_family", "") or "").strip().lower(),
                     bool(getattr(t, "bold", False)), bool(getattr(t, "italic", False)))
        metas.append({"t": t, "content": content, "font": font,
                      "wpx": _len_px(getattr(t, "width", 0), w, unit),
                      "hpx": _len_px(getattr(t, "height", 0), h, unit),
                      "xpx": _len_px(getattr(t, "x", 12), w, unit),
                      "ypx": _len_px(getattr(t, "y", 12), h, unit)})

    # 1b) fixed length on one axis: a match_w/match_h ("image", or a sibling index) WINS — it copies the
    # image canvas size, or that sibling's fixed-or-auto size, scaled by match_w_pct/match_h_pct (percent;
    # cycle-guarded, mirroring the pretty
    # canvas). With no match on the axis, an explicit width/height is used. None = auto to the text.
    def _raw(i, axis):
        mw, mh = _measure(draw, metas[i]["content"], metas[i]["font"])
        return mw if axis == "w" else mh

    def _fixed(i, axis, stack):
        m = metas[i]
        ref = (getattr(m["t"], "match_w" if axis == "w" else "match_h", "") or "").strip()
        if ref == "image":   # match the image canvas size on this axis, scaled by the percent
            base = w if axis == "w" else h
            pct = int(getattr(m["t"], "match_w_pct" if axis == "w" else "match_h_pct", 100) or 100)
            return max(1, round(base * pct / 100.0))
        if ref.lstrip("-").isdigit():
            j = int(ref)
            if 0 <= j < len(metas) and j != i and j not in stack:
                base = _fixed(j, axis, stack | {i}) or _raw(j, axis)
                if base:
                    pct = int(getattr(m["t"], "match_w_pct" if axis == "w" else "match_h_pct", 100) or 100)
                    return max(1, round(base * pct / 100.0))
        explicit = m["wpx"] if axis == "w" else m["hpx"]
        return explicit if explicit > 0 else None

    # 1c) fit each element's text to its fixed width, then measure the final box. The two toggles are
    # independent: `wrap` controls line-breaking only (on = word-wrap onto more lines, off = one line);
    # `overflow` controls whether text may spill past the box (on = allowed to overflow, off = clipped
    # to the box and ended with … , i.e. overflow: hidden + text-overflow: ellipsis).
    # 1c-pre) decide which elements are OFF (drawn as nothing, collapsed to zero size/offset). Two
    # causes, both collapsing the same way so a chain anchored to a hidden element shifts up to fill
    # the gap instead of leaving a hole:
    #  - disable_if_empty: the resolved content is blank (a missing/blank {{token}}).
    #  - disable_if_anchor_disabled: the element this one is anchored to is itself off — cascades along
    #    the anchor chain (cycle-guarded); no effect when anchored to the image canvas.
    def _empty_off(i):
        t = metas[i]["t"]
        return bool(getattr(t, "disable_if_empty", False)) and not str(metas[i]["content"]).strip()

    _off_cache: dict[int, bool] = {}

    def _is_off(i, stack=()):
        if i in _off_cache:
            return _off_cache[i]
        if i in stack:
            return False                       # anchor cycle -> unresolvable, treat as not-off
        res = _empty_off(i)
        if not res and bool(getattr(metas[i]["t"], "disable_if_anchor_disabled", False)):
            a = getattr(metas[i]["t"], "anchor", None)
            to = ((getattr(a, "to", "") or "").strip()) if a else ""
            if to.lstrip("-").isdigit():
                j = int(to)
                if 0 <= j < len(metas) and j != i:
                    res = _is_off(j, stack + (i,))
        _off_cache[i] = res
        return res

    for i, m in enumerate(metas):
        t = m["t"]
        if _is_off(i):
            m["off"] = True
            m["content"] = ""
            m["wpx"] = m["hpx"] = m["sw"] = m["sh"] = 0
            m["xpx"] = m["ypx"] = 0
            continue
        fw, fh = _fixed(i, "w", set()), _fixed(i, "h", set())
        clip = not bool(getattr(t, "overflow", False))      # overflow off -> clip to the box
        if m["content"] and fw:
            if getattr(t, "wrap", True):
                m["content"] = _wrap(m["content"], m["font"], fw, draw)
                if clip and fh:
                    m["content"] = _clip_height(m["content"], m["font"], fw, fh, draw)
            else:
                m["content"] = str(m["content"]).replace("\n", " ")
                if clip:
                    m["content"] = _ellipsize(m["content"], m["font"], fw, draw)
        mw, mh = _measure(draw, m["content"], m["font"])
        m["wpx"], m["hpx"] = fw or 0, fh or 0
        m["sw"] = fw if fw else max(1, mw)
        m["sh"] = fh if fh else max(1, mh)

    # 2) resolve each element's top-left from its anchor chain ("" = the image, else a sibling
    # index). The element's `corner` 9-point sits on the target's `target` 9-point, then x/y offset.
    pos = {}

    def resolve(i, stack):
        if i in pos:
            return pos[i]
        m = metas[i]
        a = getattr(m["t"], "anchor", None)
        to = ((getattr(a, "to", "") or "").strip()) if a else ""
        if to == "" or not to.lstrip("-").isdigit() or int(to) in stack \
                or not (0 <= int(to) < len(metas)) or int(to) == i:
            tb = (0.0, 0.0, w, h)                    # anchor to the image canvas
        else:
            j = int(to)
            tp = resolve(j, stack | {i})
            tb = (tp[0], tp[1], metas[j]["sw"], metas[j]["sh"])
        thf, tvf = _frac(getattr(a, "target", "tl") if a else "tl")
        chf, cvf = _frac(getattr(a, "corner", "tl") if a else "tl")
        px = tb[0] + thf * tb[2] - chf * m["sw"] + m["xpx"]
        py = tb[1] + tvf * tb[3] - cvf * m["sh"] + m["ypx"]
        pos[i] = (round(px), round(py))
        return pos[i]

    for i in range(len(metas)):
        resolve(i, set())

    # 3) paint: background fill, borders, text (9-point aligned within the box), underline. Painted in
    # z_index order (low first) so a higher z_index element sits on top where boxes overlap; ties keep
    # list order. `boxes` is keyed by the ORIGINAL index (`i`), so the editor overlay is order-agnostic.
    boxes = []
    order = sorted(range(len(metas)), key=lambda k: (int(getattr(metas[k]["t"], "z_index", 0) or 0), k))
    for i in order:
        m = metas[i]
        t = m["t"]
        bx, by = pos[i]
        sw, sh = m["sw"], m["sh"]
        boxes.append({"i": i, "x": int(bx), "y": int(by), "w": max(1, int(sw)), "h": max(1, int(sh))})
        boxed = m["wpx"] > 0 and m["hpx"] > 0
        bg_color = getattr(t, "bg_color", "") or ""
        if boxed and bg_color and not m.get("off"):
            draw.rectangle([bx, by, bx + sw, by + sh], fill=_rgb(bg_color))
        if boxed and not m.get("off"):
            _draw_borders(draw, (bx, by, sw, sh), t)
        content = m["content"]
        if content and not m.get("off"):
            color = _rgb(getattr(t, "color", "#ffffff"), (255, 255, 255))
            hf, vf = _frac(getattr(t, "align", "tl"))
            ah = "l" if not m["wpx"] or hf == 0.0 else ("m" if hf == 0.5 else "r")
            av = "a" if not m["hpx"] or vf == 0.0 else ("m" if vf == 0.5 else "d")
            tx = bx + (hf * sw if m["wpx"] else 0)
            ty = by + (vf * sh if m["hpx"] else 0)
            draw.multiline_text((tx, ty), content, font=m["font"], fill=color, anchor=ah + av,
                                align={"l": "left", "m": "center", "r": "right"}[ah])
            if getattr(t, "underline", False):
                _draw_underline(draw, content, m["font"], (tx, ty), ah + av, ah, color)
        if focus is not None and i == focus:
            draw.rectangle([bx - 2, by - 2, bx + max(2, sw) + 2, by + max(2, sh) + 2],
                           outline=(255, 96, 96), width=2)
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
