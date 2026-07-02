"""Tests for the sweep supervisor's cross-process locks + the generic item-list helper.

The fetch/map logic lives in test_http_mapping.py and test_http_producer.py; this file
covers the type-agnostic orchestration (stale-lock reclaim) and ``unique_items``.
"""

from oc.enrich.sweep_engine import unique_items


# ---- unique_items -----------------------------------------------------------

def test_unique_items_dedups_and_skips_unresolved():
    records = [{"name": "Soma Prime"}, {"name": "Soma Prime"}, {"name": ""}, {"other": 1},
               {"name": "Skip"}]
    def resolve(n):
        return None if n == "Skip" else n.lower().replace(" ", "_")
    pairs = unique_items(records, resolve=resolve)
    assert pairs == [("soma_prime", "Soma Prime")]   # deduped by key, unresolved dropped


def test_unique_items_identity_default():
    assert unique_items([{"name": "Mag Prime"}]) == [("Mag Prime", "Mag Prime")]


def test_unique_items_custom_field():
    pairs = unique_items([{"item": "Forma"}, {"item": "Forma"}], name_field="item")
    assert pairs == [("Forma", "Forma")]


# ---- clear_stale_locks (type-agnostic supervisor) ---------------------------

def test_clear_stale_locks_removes_orphaned_sweep_locks(tmp_path):
    # A sweep killed mid-run strands its per-game lock; startup must clear it (else every
    # later sweep is blocked for ~30 min). Plant locks for two games and one stray dir.
    from oc.enrich.price_runner import _lock_path, clear_stale_locks

    for game in ("warframe", "other"):
        p = _lock_path(tmp_path, game)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("999 0")
    (tmp_path / "nolock").mkdir()

    cleared = clear_stale_locks(tmp_path)
    assert sorted(cleared) == ["other", "warframe"]
    assert not _lock_path(tmp_path, "warframe").exists()
    assert not _lock_path(tmp_path, "other").exists()
    # idempotent + safe on a clean tree
    assert clear_stale_locks(tmp_path) == []
    assert clear_stale_locks(tmp_path / "missing") == []


def test_clear_stale_locks_removes_orphaned_cancel_flags(tmp_path):
    # A cancel flag stranded by a killed sweep would insta-cancel the NEXT sweep; startup must
    # clear it alongside the lock. (Cancel files don't count toward the returned "cleared" list.)
    from oc.enrich.price_runner import _cancel_path, clear_stale_locks

    for game in ("warframe", "other"):
        p = _cancel_path(tmp_path, game)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("0")

    clear_stale_locks(tmp_path)
    assert not _cancel_path(tmp_path, "warframe").exists()
    assert not _cancel_path(tmp_path, "other").exists()
