"""Windows OS toast notifier, backed by the ``windows-toasts`` WinRT library.

The ``find_spec`` check below is the registration gate: on a host without the
library (or off-Windows) this module fails to import and ``registry`` silently
skips it, so ``build_notifier`` falls back to the ``null`` no-op — exactly how the
win32/wgc capture backends behave. The specific wrapper imports live inside
:meth:`notify` so an API drift in one wrapper can't stop the backend registering.

The gate must NOT actually ``import windows_toasts`` at module load: that pulls in
the WinRT runtime DLLs, and if they load into the process before onnxruntime's
native extension does, onnxruntime's pybind init fails ("DLL initialization routine
failed") and every OCR read 500s. Registry discovery imports this module eagerly
(to register the name), long before the OCR engine loads — so the DLL claim would
lose the race. ``find_spec`` answers "is it installed?" without loading anything;
the real WinRT imports stay lazy in the methods, by which point OCR is up.

One ``WindowsToaster`` is cached per app name (its AppUserModelID / source label).
"""

from __future__ import annotations

from importlib.util import find_spec

if find_spec("windows_toasts") is None:   # registration gate: absent -> module skipped
    raise ImportError("windows-toasts is not installed")

from ..interfaces import Notifier, ToastSpec
from ..registry import register_notifier


@register_notifier("windows")
class WindowsToastNotifier(Notifier):
    def __init__(self) -> None:
        self._toasters: dict[str, object] = {}

    def _toaster(self, app_name: str):
        from windows_toasts import WindowsToaster

        name = app_name or "data-occultist"
        toaster = self._toasters.get(name)
        if toaster is None:
            toaster = WindowsToaster(name)
            self._toasters[name] = toaster
        return toaster

    def notify(self, spec: ToastSpec) -> None:
        # A failed toast must never crash a trigger fire (network of imports, a bad
        # image path, a WinRT hiccup) — swallow everything.
        try:
            from pathlib import Path

            from windows_toasts import (
                Toast,
                ToastDisplayImage,
                ToastDuration,
                ToastImagePosition,
            )
            from windows_toasts.toast_audio import ToastAudio

            text = [t for t in (spec.title, spec.message) if t] or [""]
            kwargs: dict = {"text_fields": text}
            kwargs["duration"] = (
                ToastDuration.Long if spec.duration == "long" else ToastDuration.Short
            )
            if spec.muted:
                kwargs["audio"] = ToastAudio(silent=True)
            if spec.attribution:
                kwargs["attribution_text"] = spec.attribution
            toast = Toast(**kwargs)
            if spec.icon:
                p = Path(spec.icon)
                if p.exists():
                    toast.AddImage(
                        ToastDisplayImage.fromPath(str(p), ToastImagePosition.AppLogo)
                    )
            self._toaster(spec.app_name).show_toast(toast)
        except Exception:  # noqa: BLE001 - a toast must never break a fire
            pass
