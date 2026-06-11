"""Mimic a page reload's OCR burst (detect + preview per bound window) N times and
sample GPU memory between rounds, to see whether the server's arena plateaus or grows.

Usage: python scripts/gpu_reload_probe.py [rounds]
"""
import json
import subprocess
import sys
import urllib.request

BASE = "http://127.0.0.1:8000"


def gpu_used() -> int:
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True)
    return int(out.strip().splitlines()[0])


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.loads(r.read())


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def main() -> None:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    profile = get("/api/profiles/warframe")
    bindings = get("/api/captures/warframe/bindings")
    wins = [w for w in profile["windows"] if w["id"] in bindings]
    print(f"windows: {[w['id'] for w in wins]}")
    print(f"baseline: {gpu_used()} MiB")
    for i in range(1, rounds + 1):
        for w in wins:
            single = {**profile, "windows": [w]}
            cap = bindings[w["id"]]
            q = f"?game=warframe&capture={cap}"
            post(f"/api/detect{q}", single)
            r = post(f"/api/preview{q}", single)
            print(f"  round {i} {w['id']}: cells={len(r.get('cells', []))} gpu={gpu_used()} MiB")
        print(f"after round {i}: {gpu_used()} MiB")


if __name__ == "__main__":
    main()
