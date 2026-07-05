"""Windows OS toast notifier, backed by the ``toasted`` WinRT library.

The ``find_spec`` check below is the registration gate: on a host without the library (or
off-Windows) this module fails to import and ``registry`` silently skips it, so
``build_notifier`` falls back to the ``null`` no-op — exactly how the win32/wgc capture backends
behave. The real ``toasted`` imports live inside :meth:`_show` so an API drift can't stop the
backend registering.

The gate must NOT actually ``import toasted`` at module load: it pulls in the WinRT runtime
(``winsdk``) DLLs, and if they load into the process before onnxruntime's native extension does,
onnxruntime's pybind init fails ("DLL initialization routine failed") and every OCR read 500s.
Registry discovery imports this module eagerly (to register the name), long before the OCR engine
loads. ``find_spec`` answers "is it installed?" without loading anything; the real WinRT imports
stay lazy in the methods, by which point OCR is up.

``toasted`` builds a toast from a list of ``elements`` (styled ``Text`` blocks, an ``Image``) and
turns them into toast XML — that part we use. Its own ``Toast.show()`` coroutine we do NOT use:
it registers activated/dismissed/failed handlers and awaits one of them before returning, i.e. it
bundles "post the notification" with "wait for the user to click or dismiss it". We don't want
click/dismiss callbacks at all (fire-and-forget only), and an unpackaged venv process frequently
never gets that callback delivered by Windows anyway — so that wait can hang forever, and since
every toast used to be posted through it, one hung wait permanently jammed the whole pipeline
behind it. :meth:`_show` instead builds the XML with ``toasted`` and posts it with the raw
``winsdk`` ``ToastNotifier`` directly (no event registration, nothing to await, nothing to hang
on). Every toast still runs on its own throwaway thread, joined with a bound (see :meth:`_run`) —
belt-and-suspenders against the native post call or a remote-icon download stalling.
"""

from __future__ import annotations

import queue
import threading
from importlib.util import find_spec

if find_spec("toasted") is None:   # registration gate: absent -> module skipped
    raise ImportError("toasted is not installed")

from ..interfaces import Notifier, ToastSpec, ToastText
from ..registry import register_notifier

# Outer bound on one toast's whole post (build XML + hand it to the OS). Posting a toast is
# normally near-instant; this is just a backstop in case a remote icon:// / http(s):// image
# download stalls. If a call ever exceeds this, _run abandons it (leaked daemon thread, nobody
# waits on it) and moves straight to the next queued toast instead of stalling the pipeline.
_JOIN_TIMEOUT = 15.0


@register_notifier("windows")
class WindowsToastNotifier(Notifier):
    def __init__(self) -> None:
        # registered AppUserModelIDs, keyed by source label (registration writes HKCU once).
        self._app_ids: dict[str, str] = {}
        # Toasts are queued and drained by _run, never posted on the caller's (FastAPI request)
        # thread — notify() always returns instantly, and a slow/stuck post only ever delays
        # OTHER queued toasts, never a request.
        self._queue: queue.Queue = queue.Queue()
        threading.Thread(target=self._run, daemon=True).start()

    def notify(self, spec: ToastSpec) -> None:
        # Hand off to the worker thread and return immediately — see __init__.
        self._queue.put(spec)

    def _run(self) -> None:
        while True:
            spec = self._queue.get()
            # Each toast gets its OWN throwaway thread, joined with a bound, rather than calling
            # _show inline on this loop's thread. _show no longer awaits anything (see module
            # docstring), so this is just a backstop: if the native post call or a remote-icon
            # download ever stalls past _JOIN_TIMEOUT, _run abandons that thread and moves on to
            # the next queued toast instead of the whole pipeline waiting on it.
            t = threading.Thread(target=self._show, args=(spec,), daemon=True)
            t.start()
            t.join(_JOIN_TIMEOUT)

    def _app_id(self, app_name: str) -> str:
        """Register (once) and return the AppUserModelID for this source label. A venv/non-UWP
        process has no system-registered id, so a toast would otherwise show under a generic
        'Python' name — registering writes the label + our logo into HKCU so the toast is ours."""
        from pathlib import Path

        from toasted import Toast

        name = app_name or "data-occultist"
        handle = self._app_ids.get(name)
        if handle is None:
            try:
                logo = Path(__file__).resolve().parents[1] / "web" / "static" / "toast-logo.png"
                handle = Toast.register_app_id(
                    name, name, icon_uri=str(logo) if logo.exists() else None
                )
            except Exception:   # noqa: BLE001 - registration is best-effort; fall back to the raw id
                handle = name
            self._app_ids[name] = handle
        return handle

    def _show(self, spec: ToastSpec) -> None:
        # A failed toast must never crash a trigger fire (a bad image path, a WinRT hiccup) —
        # swallow everything.
        try:
            from pathlib import Path

            from toasted import (
                Image,
                Text,
                Toast,
                ToastDuration,
                ToastImagePlacement,
                ToastTextAlign,
                ToastTextStyle,
            )

            def _style(name: str):
                try:
                    return ToastTextStyle[name.upper()] if name else None
                except KeyError:
                    return None

            def _align(name: str):
                try:
                    return ToastTextAlign[name.upper()] if name else None
                except KeyError:
                    return None

            # rich body: the styled block list, or the legacy title/message pair when empty.
            blocks = spec.texts or [ToastText(content=spec.title), ToastText(content=spec.message)]
            elements: list = []
            # icon: an explicit path/URL, else the app's own logo PNG (svg/ico favicons don't
            # render on toasts). A remote URL / icon:// scheme passes through (toasted downloads a
            # URL itself); a local path must be a file:// URI (toasted rejects a raw Windows path);
            # a missing local path is silently skipped (no image, no error).
            icon = spec.icon or str(
                Path(__file__).resolve().parents[1] / "web" / "static" / "toast-logo.png"
            )
            if not spec.show_icon:
                icon = ""   # the toast opts out of the app-logo entirely
            if not icon:
                pass
            elif icon.startswith(("http://", "https://", "icon://", "file://")):
                elements.append(Image(icon, alt="data-occultist", placement=ToastImagePlacement.LOGO))
            elif Path(icon).exists():
                elements.append(Image(Path(icon).as_uri(), alt="data-occultist", placement=ToastImagePlacement.LOGO))
            # generated top banner (hero) — a pre-rendered PNG on disk. resolve() first: as_uri()
            # rejects a relative path (and would throw, dropping the whole toast).
            if spec.hero_image and Path(spec.hero_image).exists():
                elements.append(Image(Path(spec.hero_image).resolve().as_uri(), alt="", placement=ToastImagePlacement.HERO))
            text_count = 0
            for b in blocks:
                if not b.content:
                    continue
                elements.append(Text(
                    b.content, style=_style(b.style), align=_align(b.align),
                    max_lines=b.max_lines or None,
                ))
                text_count += 1
            # generated inline body images (no placement = inline), in order
            for inl in spec.inline_images:
                if inl and Path(inl).exists():
                    elements.append(Image(Path(inl).resolve().as_uri(), alt=""))
            if spec.attribution:
                elements.append(Text(spec.attribution, is_attribution=True))
                text_count += 1
            # Windows injects a "New notification" placeholder title when a toast carries NO text
            # element (e.g. an image-only toast). A blank text element suppresses that, BUT Windows
            # trims WHITESPACE-only content (space, and the non-breaking space U+00A0 — both are
            # Unicode category Zs) and still counts the toast as textless, so neither works. A
            # zero-width space (U+200B) is category Cf (format), NOT whitespace: Windows keeps it,
            # so the toast has content and shows no placeholder, while rendering nothing visible.
            if text_count == 0:
                elements.append(Text("\u200b"))
            toast = Toast(
                app_id=self._app_id(spec.app_name),
                duration=ToastDuration.LONG if spec.duration == "long" else ToastDuration.SHORT,
            )
            toast.elements = elements
            toast._xml_mute_sound = spec.muted   # read by to_xml_string()'s <audio silent=...>
            # Build the XML with toasted (rich elements), then post it with the raw WinRT
            # notifier ourselves -- see the module docstring for why we don't call toasted's own
            # Toast.show(). download_media defaults False: a local file:// image URI resolves
            # to a path either way (no network involved), and a remote http(s)/icon:// source is
            # just left as a URL in the XML for Windows itself to fetch asynchronously -- we never
            # do a synchronous download in this process at all.
            import winsdk.windows.data.xml.dom as dom
            from winsdk.windows.ui.notifications import ToastNotification, ToastNotificationManager

            xml_doc = dom.XmlDocument()
            xml_doc.load_xml(toast.to_xml_string())
            ToastNotificationManager.create_toast_notifier(toast.app_id).show(ToastNotification(xml_doc))
        except Exception:  # noqa: BLE001 - a toast must never break a fire
            pass
