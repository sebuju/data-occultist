"""Build a Warframe word-list dictionary from public data and load it into a game
profile's `dictionaries` (the OCR dictionary feature).

It pulls EVERY item name from the community WarframeStatus API (https://warframestat.us
— aggregates DE's official Public Export + the wiki): warframes, every weapon class,
archwing/arch-gun/arch-melee, sentinels/pets, mods, arcanes, relics (full names like
"Neo V11"), resources, gear, quests, etc. Thousands of entries. Adds a handful of
factions the item list doesn't cover. De-duplicated.

Run it yourself (needs network):

    # write the words into config/games/warframe.yaml as a dictionary named "wiki"
    python scripts/build_warframe_dictionary.py --profile warframe --name wiki

    # or just dump a newline list to paste into a dictionary node in the UI
    python scripts/build_warframe_dictionary.py --out warframe_terms.txt

Re-running replaces a dictionary of the same name. The server picks it up on its next
profile load (reopen the game in the UI, or restart).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # repo root (parent of scripts/)

# /items is the UNION of every category (warframes, weapons, mods, relics, …) — one call
# covers everything. We pull name+category and DROP the cosmetic / non-readable categories
# (skins, glyphs, sigils, captura, mission nodes, enemies, misc promo junk like login
# music), which are ~10k of the 17k and only add OCR false-match noise. Pass
# --include-cosmetic to keep them.
ITEMS_URL = "https://api.warframestat.us/items/?only=name,category"
EXCLUDE_CATEGORIES = {"Skins", "Glyphs", "Sigils", "Captura", "Misc", "Enemy", "Node"}

# the item list has no faction entries — add the well-known ones by hand
FACTIONS = [
    "Grineer", "Corpus", "Infested", "Infestation", "Orokin", "Sentient", "Narmer",
    "Tenno", "Corrupted", "Crossfire", "Murmur", "Scaldra", "Techrot", "Wally",
]

# refinement / component suffixes to also store as a base name, so a relic OCR'd as
# "Neo V11" matches even when the data lists "Neo V11 Relic".
STRIP_SUFFIX = re.compile(
    r"\s+(Relic|Intact|Exceptional|Flawless|Radiant|Blueprint|\(Component\))$",
    re.IGNORECASE,
)


def fetch(url: str) -> list:
    # a browser-like UA: the API's edge 403s obvious bots
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def collect(include_cosmetic: bool = False) -> list[str]:
    from collections import Counter

    names: set[str] = set()
    kept: Counter = Counter()
    for it in fetch(ITEMS_URL):
        if not isinstance(it, dict):
            continue
        cat = it.get("category", "")
        if not include_cosmetic and cat in EXCLUDE_CATEGORIES:
            continue
        n = (it.get("name") or "").strip()
        if not n or n.startswith("/"):   # skip blanks and internal manifest paths
            continue
        names.add(n)
        kept[cat or "?"] += 1
        base = STRIP_SUFFIX.sub("", n).strip()   # also store the bare relic name ("Neo V11")
        if base and base != n:
            names.add(base)
    for cat, c in kept.most_common():
        print(f"  {c:6}  {cat}")
    names.update(FACTIONS)
    return sorted(names, key=str.lower)


def write_profile(path: Path, dict_id: str, terms: list[str]) -> None:
    import yaml

    prof = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    dicts = [d for d in prof.get("dictionaries", []) if d.get("id") != dict_id]
    dicts.append({"id": dict_id, "name": dict_id, "enabled": True, "terms": terms})
    prof["dictionaries"] = dicts
    path.write_text(yaml.safe_dump(prof, sort_keys=False, allow_unicode=True), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--profile", help="game id (e.g. warframe) -> writes config/games/<id>.yaml")
    ap.add_argument("--name", default="wiki", help="dictionary id/name to write (default: wiki)")
    ap.add_argument("--out", help="instead, write a newline-separated word list to this file")
    ap.add_argument("--profiles-dir", default=None,
                    help="where the profile YAMLs live (default: <repo>/config/games, regardless of cwd)")
    ap.add_argument("--include-cosmetic", action="store_true",
                    help="also keep skins/glyphs/sigils/captura/misc/enemy/node (much noisier)")
    args = ap.parse_args()

    print("fetching Warframe data…")
    terms = collect(include_cosmetic=args.include_cosmetic)
    print(f"collected {len(terms)} unique terms")

    if args.out:
        Path(args.out).write_text("\n".join(terms) + "\n", encoding="utf-8")
        print(f"wrote {args.out} — paste it into a dictionary node")
        return
    if args.profile:
        base = Path(args.profiles_dir) if args.profiles_dir else (ROOT / "config" / "games")
        path = base / f"{args.profile}.yaml"
        if not path.exists():
            sys.exit(f"no profile at {path}")
        write_profile(path, args.name, terms)
        print(f"wrote dictionary '{args.name}' ({len(terms)} terms) into {path}")
        print("reopen the game in the UI (or restart the server) to load it")
        return
    sys.exit("pass --profile <id> to inject, or --out <file> to dump a list")


if __name__ == "__main__":
    main()
