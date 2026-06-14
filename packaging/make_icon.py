"""Generate the data-rig .ico from the favicon glyph (rounded panel + 3 wired nodes).

Re-renders the same design as src/oc/web/static/favicon.svg with Pillow at multiple
sizes and writes a multi-resolution .ico. Run: ``python packaging/make_icon.py``.

Writes two copies of the one design: assets/data-rig.ico (the desktop shortcut points
here) and src/oc/web/static/favicon.ico (ships in the package so the native window can
set its title-bar / taskbar icon at runtime).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

_ROOT = Path(__file__).resolve().parent.parent
_OUTS = [
    _ROOT / "assets" / "data-rig.ico",
    _ROOT / "src" / "oc" / "web" / "static" / "favicon.ico",
]

# Design in the 32-unit space of favicon.svg, rendered up to a big master bitmap.
BG = (0x15, 0x17, 0x1C, 255)
WIRE = (0x2C, 0x31, 0x3C, 255)
NODES = [((9, 16), (0x5A, 0xA9, 0xE6)), ((23, 9), (0x7D, 0xDC, 0x7D)), ((23, 23), (0xE6, 0xC2, 0x5A))]
WIRES = [((11.5, 14.5), (20.5, 10)), ((11.5, 17.5), (20.5, 22))]


def render(px: int) -> Image.Image:
    ss = 4  # supersample for smooth edges, then downscale
    n = px * ss
    s = n / 32.0
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=7 * s, fill=BG)
    for (x1, y1), (x2, y2) in WIRES:
        d.line([x1 * s, y1 * s, x2 * s, y2 * s], fill=WIRE, width=max(1, round(1.6 * s)))
    for (cx, cy), col in NODES:
        d.ellipse([(cx - 3.2) * s, (cy - 3.2) * s, (cx + 3.2) * s, (cy + 3.2) * s], fill=col + (255,))
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
