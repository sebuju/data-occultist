"""WindowsToastNotifier host-process protocol tests.

The real ``_toast_child.py --serve`` talks WinRT; these tests swap it for a stub script
(monkeypatched ``_CHILD``) speaking the same line protocol (``ready`` / spec-JSON per stdin
line / ``ok`` ack), so the worker's plumbing — ordering, backlog coalescing, the per-post
watchdog, kill+respawn+retry-once, drop-after-retry — is exercised without Windows posting
anything. Pure subprocess + pipes, no WinRT; only the module IMPORT needs ``toasted``
installed (its registration gate), hence the importorskip.
"""

from __future__ import annotations

import time

import pytest

pytest.importorskip("toasted")

from oc import eventlog  # noqa: E402
from oc.interfaces import ToastSpec  # noqa: E402
from oc.notify import windows_toast  # noqa: E402


def _wait_for(cond, timeout=10.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


@pytest.fixture()
def events():
    """Capture every eventlog line published during the test."""
    seen: list[dict] = []
    off = eventlog.subscribe(seen.append)
    yield seen
    off()


@pytest.fixture()
def make_notifier(tmp_path, monkeypatch):
    """Build a notifier against a stub child script. ``body`` is the stub's source with
    ``{receipt}`` / ``{count}`` placeholders filled in (receipt = where the stub records what
    it posted, count = a spawn counter file so a stub can act differently per respawn)."""
    receipt = tmp_path / "receipt.txt"
    count = tmp_path / "spawns.txt"
    made: list[windows_toast.WindowsToastNotifier] = []

    def _make(body: str, ack_timeout: float | None = None):
        stub = tmp_path / "stub.py"
        stub.write_text(
            "import json, sys, time\n"
            f"RECEIPT = {str(receipt)!r}\n"
            f"COUNT = {str(count)!r}\n"
            "try:\n"
            "    n = int(open(COUNT).read()) + 1\n"
            "except OSError:\n"
            "    n = 1\n"
            "open(COUNT, 'w').write(str(n))\n"
            + body,
            encoding="utf-8",
        )
        monkeypatch.setattr(windows_toast, "_CHILD", stub)
        if ack_timeout is not None:
            monkeypatch.setattr(windows_toast, "_ACK_TIMEOUT", ack_timeout)
        n = windows_toast.WindowsToastNotifier()
        made.append(n)
        return n, receipt

    yield _make
    for n in made:
        n._job.terminate()   # kill any stub still alive so tests never leak children


_ECHO = """
print('ready', flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    spec = json.loads(line)
    open(RECEIPT, 'a', encoding='utf-8').write(f"{n}:{spec['title']}\\n")
    print('ok', flush=True)
"""


def _lines(receipt):
    return receipt.read_text(encoding="utf-8").splitlines() if receipt.exists() else []


def test_posts_ack_in_order(make_notifier):
    notifier, receipt = make_notifier(_ECHO)
    for title in ("one", "two", "three"):
        notifier.notify(ToastSpec(title=title))
    assert _wait_for(lambda: len(_lines(receipt)) == 3)
    assert _lines(receipt) == ["1:one", "1:two", "1:three"]   # one host, original order


def test_backlog_coalesces_same_tag(make_notifier, events):
    # Host delays `ready`, so every notify below lands in the queue and drains as ONE batch:
    # three same-tag specs collapse to the newest, the tagless one always survives.
    stub = """
time.sleep(0.7)
""" + _ECHO
    notifier, receipt = make_notifier(stub)
    for title in ("a1", "a2", "a3"):
        notifier.notify(ToastSpec(title=title, tag="t", group="g"))
    notifier.notify(ToastSpec(title="plain"))
    assert _wait_for(lambda: len(_lines(receipt)) == 2)
    assert _lines(receipt) == ["1:a3", "1:plain"]
    assert any("coalesced" in e["msg"] for e in events)


def test_stalled_post_respawns_and_retries(make_notifier, events):
    # Spawn 1 swallows the spec and never acks (a wedged WinRT post); the watchdog must kill
    # it, respawn, and the retried spec lands on spawn 2. A follow-up toast proves the fresh
    # host stays healthy.
    stub = """
print('ready', flush=True)
if n == 1:
    sys.stdin.readline()
    time.sleep(60)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    spec = json.loads(line)
    open(RECEIPT, 'a', encoding='utf-8').write(f"{n}:{spec['title']}\\n")
    print('ok', flush=True)
"""
    notifier, receipt = make_notifier(stub, ack_timeout=0.5)
    notifier.notify(ToastSpec(title="wedged"))
    assert _wait_for(lambda: "2:wedged" in _lines(receipt))
    notifier.notify(ToastSpec(title="after"))
    assert _wait_for(lambda: "2:after" in _lines(receipt))
    assert any("stalled" in e["msg"] for e in events)
    assert not any("dropped" in e["msg"] for e in events)


def test_dead_host_respawns_and_retries(make_notifier):
    # Spawn 1 exits mid-post without acking (host crash): the reader's EOF sentinel must
    # trigger the same respawn+retry — no watchdog wait involved, so no timeout shrink needed.
    stub = """
print('ready', flush=True)
if n == 1:
    sys.stdin.readline()
    sys.exit(0)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    spec = json.loads(line)
    open(RECEIPT, 'a', encoding='utf-8').write(f"{n}:{spec['title']}\\n")
    print('ok', flush=True)
"""
    notifier, receipt = make_notifier(stub)
    notifier.notify(ToastSpec(title="crashed"))
    assert _wait_for(lambda: "2:crashed" in _lines(receipt))


def test_drop_after_second_stall(make_notifier, events):
    # Every spawn wedges: retry-once means exactly two stall warns then a drop — and the worker
    # survives to try the next toast (spawn count keeps growing).
    stub = """
print('ready', flush=True)
sys.stdin.readline()
time.sleep(60)
"""
    notifier, _ = make_notifier(stub, ack_timeout=0.3)
    notifier.notify(ToastSpec(title="doomed"))
    assert _wait_for(lambda: any("dropped after retry" in e["msg"] for e in events))
    assert sum("stalled" in e["msg"] for e in events) == 2


def test_err_ack_is_not_a_stall(make_notifier, events):
    # A bad spec acks `err`: the host is healthy, nothing to kill or retry.
    stub = """
print('ready', flush=True)
for line in sys.stdin:
    if not line.strip():
        continue
    print('err', flush=True)
    open(RECEIPT, 'a', encoding='utf-8').write(f"{n}:err\\n")
"""
    notifier, receipt = make_notifier(stub)
    notifier.notify(ToastSpec(title="bad"))
    assert _wait_for(lambda: _lines(receipt) == ["1:err"])
    assert not any("stalled" in e["msg"] or "dropped" in e["msg"] for e in events)
