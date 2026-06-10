"""Open the graph, open a window's image, draw a region, screenshot. For self-testing."""
import os
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/"
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1700, "height": 950})
    page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_timeout(1500)

    btn = page.query_selector(".imgbtn")
    print("imgbtn found:", bool(btn))
    if btn:
        btn.click()
        page.wait_for_timeout(4000)  # capture + load image
    os.makedirs("captures", exist_ok=True)
    page.screenshot(path="captures/img_open.png")

    canvas = page.query_selector(".imgpanel canvas")
    if canvas:
        bb = canvas.bounding_box()
        print("canvas box:", bb)
        if bb:
            x0, y0 = bb["x"] + bb["width"] * 0.2, bb["y"] + bb["height"] * 0.3
            x1, y1 = bb["x"] + bb["width"] * 0.5, bb["y"] + bb["height"] * 0.4
            page.mouse.move(x0, y0); page.mouse.down(); page.mouse.move(x1, y1, steps=8); page.mouse.up()
            page.wait_for_timeout(1500)
            page.screenshot(path="captures/img_drawn.png")
    else:
        print("no canvas in imgpanel")

    b.close()

print(f"=== issues: {len(errors)} ===")
for e in errors:
    print(e)
