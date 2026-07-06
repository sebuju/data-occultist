"""Generate the data-occultist .ico from the favicon glyph (bubbling cauldron).

Re-renders the same design as src/oc/web/static/favicon.svg with Pillow at multiple
sizes and writes a multi-resolution .ico. Run: ``python packaging/make_icon.py``.

Keep this in sync with favicon.svg: whenever that design changes, update the shapes
below and re-run, or the shortcut icon drifts stale (that is exactly how it went wrong
before — the svg became a cauldron but this stayed the old wired-nodes glyph).

Writes two copies of the one design: assets/data-occultist.ico (the desktop shortcut points
here) and src/oc/web/static/favicon.ico (ships in the package so the native window can
set its title-bar / taskbar icon at runtime).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

_ROOT = Path(__file__).resolve().parent.parent
_OUTS = [
    _ROOT / "assets" / "data-occultist.ico",
    _ROOT / "src" / "oc" / "web" / "static" / "favicon.ico",
]

# Design in the 100-unit space of favicon.svg (viewBox 0 0 100 100), drawn back-to-front.
BG = (0x06, 0x18, 0x26, 255)      # rounded panel
POT = (0x0A, 0x3D, 0x62, 255)     # cauldron body + legs
LIQUID = (0x38, 0xAD, 0xA9, 255)  # brew surface
BUBBLE = (0xF7, 0xD7, 0x94, 255)  # rising bubbles
# cauldron body outline (trapezoid, rounded bottom corners flattened to a polygon at icon size)
POT_BODY = [(26, 50), (74, 50), (68, 78), (63, 83), (37, 83), (32, 78)]
LEGS = [((37, 83), (34, 92)), ((63, 83), (66, 92))]
BUBBLES = [((42, 38), 5), ((54, 30), 7), ((62, 41), 4.5), ((46, 47), 3.5), ((58, 48), 3.5)]


def render(px: int) -> Image.Image:
    ss = 4  # supersample for smooth edges, then downscale
    n = px * ss
    s = n / 100.0

    def S(v: float) -> float:
        return v * s

    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=16 * s, fill=BG)
    d.polygon([(S(x), S(y)) for x, y in POT_BODY], fill=POT)
    d.ellipse([S(26), S(44), S(74), S(56)], fill=LIQUID)   # rx24 ry6 about (50,50)
    for (x1, y1), (x2, y2) in LEGS:
        d.line([S(x1), S(y1), S(x2), S(y2)], fill=POT, width=max(1, round(3 * s)))
    for (cx, cy), r in BUBBLES:
        d.ellipse([S(cx - r), S(cy - r), S(cx + r), S(cy + r)], fill=BUBBLE)
    return img.resize((px, px), Image.LANCZOS)


def main() -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    master = render(256)
    for out in _OUTS:
        out.parent.mkdir(parents=True, exist_ok=True)
        master.save(out, format="ICO", sizes=[(s, s) for s in sizes])
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
