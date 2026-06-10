from oc.types import FractionBox, PixelBox


def test_fraction_to_pixels_roundtrip():
    frac = FractionBox(0.1, 0.2, 0.3, 0.4)
    px = frac.to_pixels(1000, 500)
    assert px == PixelBox(100, 100, 300, 200)


def test_from_pixels():
    px = PixelBox(50, 25, 100, 50)
    frac = FractionBox.from_pixels(px, 200, 100)
    assert frac == FractionBox(0.25, 0.25, 0.5, 0.5)


def test_pixelbox_edges():
    b = PixelBox(10, 20, 30, 40)
    assert b.right == 40
    assert b.bottom == 60
