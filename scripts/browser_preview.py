"""Click a window's preview button and screenshot the live preview node."""
import os
from playwright.sync_api import sync_playwright

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1700, "height": 950})
    page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.goto("http://127.0.0.1:8000/", wait_until="networkidle")
    page.wait_for_timeout(1500)
    btn = page.query_selector(".prevbtn")
    print("prevbtn found:", bool(btn))
    if btn:
        btn.click()
        page.wait_for_timeout(6000)  # OCR
    os.makedirs("captures", exist_ok=True)
    page.screenshot(path="captures/preview_node.png")
    b.close()
print(f"=== issues: {len(errors)} ===")
for e in errors:
    print(e)
