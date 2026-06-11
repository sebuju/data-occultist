"""Isolate which endpoint grows the arena: N rounds of detect-only, then preview-only."""
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
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    profile = get("/api/profiles/warframe")
    bindings = get("/api/captures/warframe/bindings")
    w = next(w for w in profile["windows"] if w["id"] in bindings)
    single = {**profile, "windows": [w]}
    q = f"?game=warframe&capture={bindings[w['id']]}"
    print(f"baseline: {gpu_used()} MiB")
    for i in range(1, n + 1):
        post(f"/api/detect{q}", single)
        print(f"  detect  {i}: {gpu_used()} MiB")
    for i in range(1, n + 1):
        post(f"/api/preview{q}", single)
        print(f"  preview {i}: {gpu_used()} MiB")


if __name__ == "__main__":
    main()
