"""Process name is authoritative: no matching process -> no window."""

from types import SimpleNamespace

from oc.locate import _scan, WindowLocator
from oc.profile.models import GameProfile
from oc.types import ProcessInfo, WindowInfo


def _engine(running_pid=None, title_win=None):
    process = SimpleNamespace(
        find_by_names=lambda names: ProcessInfo(pid=running_pid, name="Warframe.x64.exe") if running_pid else None,
    )
    window = SimpleNamespace(
        find_for_pid=lambda pid: WindowInfo(handle=42, title="Warframe", pid=pid, client=None),
        find_by_title=lambda hint: title_win,
        from_handle=lambda h: WindowInfo(handle=h, title="Warframe", pid=1, client=None),
    )
    return SimpleNamespace(process=process, window=window)


def test_no_process_no_window_even_with_title_match():
    # Warframe not running, but a File Explorer window titled "Warframe" exists
    explorer = WindowInfo(handle=99, title="Warframe - File Explorer", pid=7, client=None)
    eng = _engine(running_pid=None, title_win=explorer)
    profile = GameProfile(name="warframe", process_names=["Warframe.x64.exe"], window_title_hint="Warframe")
    assert _scan(eng, profile) is None        # title fallback must NOT fire


def test_process_running_returns_its_window():
    eng = _engine(running_pid=123)
    profile = GameProfile(name="warframe", process_names=["Warframe.x64.exe"], window_title_hint="Warframe")
    win = _scan(eng, profile)
    assert win is not None and win.pid == 123


def test_title_hint_only_when_no_process_names():
    target = WindowInfo(handle=5, title="SomeGame", pid=3, client=None)
    eng = _engine(running_pid=None, title_win=target)
    profile = GameProfile(name="g", process_names=[], window_title_hint="SomeGame")
    assert _scan(eng, profile) is target


def test_locator_does_not_cache_a_miss():
    eng = _engine(running_pid=None, title_win=None)
    profile = GameProfile(name="warframe", process_names=["Warframe.x64.exe"])
    loc = WindowLocator(eng)
    assert loc.locate(profile) is None
    assert "warframe" not in loc._cache
