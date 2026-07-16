"""Shared source-fingerprint primitive (:mod:`oc.web.code_sig`) and its two wrappers."""

from __future__ import annotations

import os

from oc.web import code_sig as code_sig_mod
from oc.web import view_code_sig as view_mod
from oc.web.code_sig import code_sig, sig_files


def _tree(root):
    for d in ("ocr", "collect", "enrich"):
        (root / d).mkdir(parents=True)
    (root / "ocr" / "a.py").write_text("x = 1\n", encoding="utf-8")
    (root / "collect" / "reader.py").write_text("y = 1\n", encoding="utf-8")
    (root / "collect" / "live.py").write_text("z = 1\n", encoding="utf-8")
    (root / "enrich" / "subset.py").write_text("w = 1\n", encoding="utf-8")


def test_sig_files_scope_and_skip(tmp_path):
    _tree(tmp_path)
    names = {f.name for f in sig_files(tmp_path, ("ocr",), {"collect": frozenset({"live.py"})})}
    assert names == {"a.py", "reader.py"}          # ocr whole + collect minus skip; enrich absent


def test_code_sig_content_based_not_mtime(tmp_path):
    _tree(tmp_path)
    f = tmp_path / "ocr" / "a.py"
    base = code_sig(tmp_path, ("ocr",))
    os.utime(f, (10_000, 10_000))                  # mtime moves, bytes unchanged
    assert code_sig(tmp_path, ("ocr",)) == base
    f.write_text("x = 2\n", encoding="utf-8")       # real edit
    assert code_sig(tmp_path, ("ocr",)) != base


def test_code_sig_skipped_file_edit_does_not_move_sig(tmp_path):
    _tree(tmp_path)
    scoped = {"collect": frozenset({"live.py"})}
    base = code_sig(tmp_path, ("ocr",), scoped)
    (tmp_path / "collect" / "live.py").write_text("z = 999\n", encoding="utf-8")
    assert code_sig(tmp_path, ("ocr",), scoped) == base   # denylisted -> no bust
    (tmp_path / "collect" / "reader.py").write_text("y = 2\n", encoding="utf-8")
    assert code_sig(tmp_path, ("ocr",), scoped) != base   # in-scope -> bust


def test_view_code_sig_scopes_to_enrich(tmp_path, monkeypatch):
    _tree(tmp_path)
    monkeypatch.setattr(view_mod, "_OC_ROOT", tmp_path)
    base = view_mod.view_code_sig()
    (tmp_path / "ocr" / "a.py").write_text("x = 2\n", encoding="utf-8")   # outside enrich
    assert view_mod.view_code_sig() == base
    (tmp_path / "enrich" / "subset.py").write_text("w = 2\n", encoding="utf-8")
    assert view_mod.view_code_sig() != base


def test_missing_dir_is_skipped_not_raised(tmp_path):
    assert code_sig_mod.code_sig(tmp_path, ("nope",)) == code_sig_mod.code_sig(tmp_path, ())
