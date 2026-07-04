"""No-op notifier: the fallback when no OS-toast backend is available (non-Windows,
or ``windows-toasts`` not installed). A toast target simply raises nothing."""

from __future__ import annotations

from ..interfaces import Notifier, ToastSpec
from ..registry import register_notifier


@register_notifier("null")
class NullNotifier(Notifier):
    def notify(self, spec: ToastSpec) -> None:
        return None
