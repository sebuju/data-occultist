"""Offline repro: run the item-template read over a stashed capture and dump
what happens around Cassowar + general cell alignment."""
import sys
sys.path.insert(0, "src")

import cv2

from oc.engine import Engine
from oc.profile.loader import load_profile
from oc.collect.reader import RegionReader
from oc.learn.dictionary import Dictionary
from oc.learn.lexicon import Lexicon
from oc.learn.resolver import FieldResolver
from oc.types import Frame, PixelBox

CAP = sys.argv[1] if len(sys.argv) > 1 else "captures/warframe/20260611-115824-916521.jpg"

engine = Engine.build()
profile = load_profile("config/games", "warframe")
window = profile.windows[0]
fields = {f.id: f for f in profile.fields_for(window)}

cutouts = {}
for it in window.items or []:
    if it.cutout:
        ci = cv2.imread(f"captures/warframe/items/{it.cutout}")
        if ci is not None:
            cutouts[it.id] = ci

img = cv2.imread(CAP)
h, w = img.shape[:2]
frame = Frame(image=img, client=PixelBox(0, 0, w, h))

lex = Lexicon.for_game("data", profile.name)
dictionary = Dictionary(profile.dictionary_terms(), engine.corrector)
resolver = FieldResolver(lex, engine.corrector, engine.settings.tuning.accept_confidence,
                         dictionary=dictionary, learn_enabled=False)
reader = RegionReader(engine.ocr, resolver, cutouts=cutouts)
result = reader.read_preview(frame, window, fields)

print(f"=== capture {CAP}  client {w}x{h}")
print(f"=== anchors calibrated: {reader._anchor_cache}")
print(f"\n=== detections in/near data area (text conf y x)")
da = window.data_area.to_fraction()
for d in result["detections"]:
    b = d["box"]
    cy = b["y"] + b["h"] / 2
    cx = b["x"] + b["w"] / 2
    if da.y - 0.02 <= cy <= da.y + da.h + 0.02 and da.x - 0.02 <= cx <= da.x + da.w + 0.02:
        print(f"  {d['confidence']:.2f}  y={b['y']:.4f} h={b['h']:.4f} x={b['x']:.4f}  {d['text']!r}")

print(f"\n=== cells ({len(result['cells'])})")
for c in result["cells"]:
    nm = c["fields"].get("name", {})
    cnt = c["fields"].get("count", {})
    box = c.get("box", {})
    print(f"  r{c['row']}c{c['col']} item={c.get('item')} valid={c.get('valid')} "
          f"y={box.get('y', 0):.4f} name={nm.get('raw')!r}->{nm.get('value')!r}({nm.get('confidence')}) "
          f"count={cnt.get('raw')!r}->{cnt.get('value')!r} reason={c.get('reason', '')}")
