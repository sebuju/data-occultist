r"""Auto-find a game's log/config file across generic OS locations.

Games scatter their files: ``%LOCALAPPDATA%`` (Warframe's EE.log/EE.cfg), ``Documents\My
Games``, ``Saved Games``, a Steam library, ``%ProgramData%``, the install dir. This scans
those **generic** roots for the profile's ``filename`` glob — the only game-specific bit, and
it is profile data, so Python stays game-agnostic. Off Windows the env roots are simply absent;
the function still works on whatever roots resolve (plus any ``roots`` the user added).
"""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

_MAX_DEPTH = 4       # how deep below each root to descend
_MAX_HITS = 60       # stop after this many matches (the UI shows a pick list, not a census)


def expand(p: str) -> str:
    """Expand ``%VAR%``/``$VAR`` env vars and a leading ``~`` in a user-supplied path/root.
    On Windows ``os.environ`` is case-insensitive, so ``%LocalAppData%`` resolves like
    ``%LOCALAPPDATA%``. Unset vars are left verbatim (expandvars' own behaviour)."""
    return os.path.expanduser(os.path.expandvars(p)) if p else p


def _env_dir(*names) -> list[str]:
    out = []
    for n in names:
        v = os.environ.get(n)
        if v:
            out.append(v)
    return out


def _steam_libraries() -> list[str]:
    """Steam install + every extra library folder, parsed loosely from libraryfolders.vdf.
    Best-effort: any failure just yields fewer roots."""
    roots: list[str] = []
    bases = _env_dir("ProgramFiles(x86)", "ProgramFiles")
    try:   # registry holds the real Steam path when installed elsewhere
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            bases.insert(0, winreg.QueryValueEx(k, "SteamPath")[0])
    except (OSError, ImportError, IndexError):
        pass
    for base in bases:
        steam = Path(base) / ("Steam" if not str(base).lower().endswith("steam") else "")
        vdf = steam / "steamapps" / "libraryfolders.vdf"
        common = steam / "steamapps" / "common"
        if common.exists():
            roots.append(str(common))
        try:
            for line in vdf.read_text(encoding="utf-8", errors="replace").splitlines():
                # lines look like:  "path"   "D:\\SteamLibrary"
                if '"path"' in line.lower():
                    p = line.split('"')[-2].replace("\\\\", "\\")
                    lib = Path(p) / "steamapps" / "common"
                    if lib.exists():
                        roots.append(str(lib))
        except OSError:
            continue
    return roots


def default_roots() -> list[str]:
    """Generic places a game file might live, de-duplicated to existing directories."""
    home = os.path.expanduser("~")
    cand = (
        _env_dir("LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)")
        + [os.path.join(home, "Documents"),
           os.path.join(home, "Documents", "My Games"),
           os.path.join(home, "Saved Games")]
        + _steam_libraries()
    )
    seen, out = set(), []
    for c in cand:
        ap = os.path.abspath(c)
        if ap not in seen and os.path.isdir(ap):
            seen.add(ap)
            out.append(ap)
    return out


def find_candidates(filename_glob: str, roots=None, *, limit: int = _MAX_HITS) -> list[dict]:
    """Files under the roots whose basename matches ``filename_glob`` (e.g. ``EE.log``,
    ``*.cfg``), newest first. Each: ``{path, mtime, size}``."""
    if not filename_glob:
        return []
    search = [expand(str(r)) for r in (roots or [])] + default_roots()
    glob = filename_glob.lower()
    hits: list[dict] = []
    seen_paths: set[str] = set()
    for root in search:
        root = os.path.abspath(root)
        base_depth = root.rstrip(os.sep).count(os.sep)
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath.count(os.sep) - base_depth >= _MAX_DEPTH:
                dirnames[:] = []   # prune deeper descent
            for fn in filenames:
                if fnmatch.fnmatch(fn.lower(), glob):
                    full = os.path.join(dirpath, fn)
                    if full in seen_paths:
                        continue
                    seen_paths.add(full)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    hits.append({"path": full, "mtime": st.st_mtime, "size": st.st_size})
                    if len(hits) >= limit:
                        break
            if len(hits) >= limit:
                break
        if len(hits) >= limit:
            break
    hits.sort(key=lambda h: h["mtime"], reverse=True)
    return hits


def resolve_path(source) -> str | None:
    """The concrete file a source reads: its explicit ``path`` if set, else the newest
    auto-find hit for ``filename`` (+ the source's extra ``roots``). ``None`` if neither finds one."""
    if getattr(source, "path", ""):
        return expand(source.path)
    cands = find_candidates(getattr(source, "filename", ""), getattr(source, "roots", None))
    return cands[0]["path"] if cands else None
