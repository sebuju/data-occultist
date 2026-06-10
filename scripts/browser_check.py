"""Headless browser smoke check: load a page, collect console/page errors, screenshot.

Usage: python scripts/browser_check.py [url] [out.png]
"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "captures/page.png"

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_timeout(2500)
    import os
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    page.screenshot(path=OUT)
    browser.close()

print(f"=== {URL} ===")
for e in errors:
    print(e)
print(f"total issues: {len(errors)}  screenshot: {OUT}")
