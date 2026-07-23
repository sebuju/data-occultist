"""Out-of-process toast poster — the ONE place a toast is actually handed to Windows.

Run as a throwaway script (``python _toast_child.py <spec.json>``), never imported by the
server: :class:`oc.notify.windows_toast.WindowsToastNotifier` spawns one of these per toast and
waits on it with a hard timeout, OS-killing it if it stalls. That process boundary is the whole
point — see the ``windows_toast`` module docstring.

Why a separate PROCESS and not (as before) a throwaway thread: posting a toast means a synchronous
WinRT/COM call into the Windows notification service (WpnUserService). That call occasionally
stalls indefinitely, and the ``winsdk`` (pywinrt 1.0.0b10) projection does NOT release the GIL
around it — so a stuck post freezes the *entire* interpreter, and a ``thread.join(timeout)`` can
never preempt it (the join needs the GIL the stuck thread is holding). A Python thread can't be
force-killed; a child process can. Isolating the post in a child means a hang costs one abandoned
child (SIGKILLed on timeout) instead of the whole server. It also keeps ``winsdk``/``toasted`` —
and the WinRT runtime DLLs they pull in — out of the server process entirely, so they can never
load ahead of onnxruntime's native extension and break OCR.

This script is deliberately self-contained: it imports only stdlib + toasted + winsdk, never the
``oc`` package, so a spawn is cheap and can't drag in the OCR/capture stack.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _post(spec: dict) -> None:
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

    logo = Path(__file__).resolve().parents[1] / "web" / "static" / "toast-logo.png"

    # AppUserModelID: a venv/non-UWP process has no system-registered id, so a toast would show
    # under a generic 'Python' name — registering writes the label + our logo into HKCU (idempotent,
    # cheap; one toast per child so it runs at most once) so the toast is ours.
    app_name = spec.get("app_name") or "data-occultist"
    try:
        app_id = Toast.register_app_id(
            app_name, app_name, icon_uri=str(logo) if logo.exists() else None
        )
    except Exception:   # noqa: BLE001 - registration is best-effort; fall back to the raw id
        app_id = app_name

    # rich body: the styled block list, or the legacy title/message pair when empty.
    texts = spec.get("texts") or []
    blocks = texts or [{"content": spec.get("title", "")}, {"content": spec.get("message", "")}]
    elements: list = []

    # icon: an explicit path/URL, else the app's own logo PNG (svg/ico favicons don't render on
    # toasts). A remote URL / icon:// scheme passes through (toasted downloads a URL itself); a
    # local path must be a file:// URI (toasted rejects a raw Windows path); a missing local path
    # is silently skipped (no image, no error).
    icon = spec.get("icon") or str(logo)
    if not spec.get("show_icon", True):
        icon = ""   # the toast opts out of the app-logo entirely
    if not icon:
        pass
    elif icon.startswith(("http://", "https://", "icon://", "file://")):
        elements.append(Image(icon, alt="data-occultist", placement=ToastImagePlacement.LOGO))
    elif Path(icon).exists():
        elements.append(Image(Path(icon).as_uri(), alt="data-occultist", placement=ToastImagePlacement.LOGO))

    # generated top banner (hero) — a pre-rendered PNG on disk. resolve() first: as_uri() rejects a
    # relative path (and would throw, dropping the whole toast).
    hero = spec.get("hero_image") or ""
    if hero and Path(hero).exists():
        elements.append(Image(Path(hero).resolve().as_uri(), alt="", placement=ToastImagePlacement.HERO))

    # Windows always binds the first TWO surviving text elements to the toast's own built-in
    # title + subtitle lines (top-level AdaptiveText) — those two ignore hint-style/hint-align no
    # matter what, so pass them through plain and reserve the styled group for anything after them
    # (mirrors the node editor: AUTO_ROLE in toast_node.js disables style/align on blocks 0/1).
    # Blanket, not opt-in: an opt-out toggle was tried, but with no top-level text at all Windows
    # shows its own default title ("New notification"/the app name) AND still reserves that line's
    # full height even with a blank placeholder — there's no way to have every block keep its own
    # style AND avoid both the default text and the wasted row. Real top-level content is the only
    # thing that satisfies Windows without a gap, so blocks 0/1 always pay that price.
    survivors = [b for b in blocks if b.get("content")]
    head_survivors, rest_survivors = survivors[:2], survivors[2:]
    elements.extend(Text(b["content"]) for b in head_survivors)   # Windows' own title/subtitle binding
    rest_texts = [Text(b.get("content"), style=_style(b.get("style", "")), align=_align(b.get("align", "")))
                  for b in rest_survivors]
    if rest_texts:
        # toasted groups elements by NESTING PYTHON LISTS in `self.elements` (Toast._walk_elements)
        # — one list level = <group>, a list nested inside it = <subgroup> — rather than a
        # dedicated element class. hint-style/hint-align are honored ONLY on Text inside a
        # subgroup, so wrap these blocks in one full-width group/subgroup to make each block's
        # style+align actually reach the rendered toast (matches the node editor's preview).
        elements.append([rest_texts])

    # generated inline body images (no placement = inline), in order
    for inl in spec.get("inline_images") or []:
        if inl and Path(inl).exists():
            elements.append(Image(Path(inl).resolve().as_uri(), alt=""))

    attribution = spec.get("attribution")
    if attribution:
        elements.append(Text(attribution, is_attribution=True))

    # Windows injects a "New notification" placeholder title when a toast carries NO text element
    # at all (e.g. an image-only toast). A blank text element suppresses that, BUT Windows trims
    # WHITESPACE-only content (space, and the non-breaking space U+00A0 — both Unicode category Zs)
    # and still counts the toast as textless, so neither works. A zero-width space (U+200B) is
    # category Cf (format), NOT whitespace: Windows keeps it, so the toast has content and shows no
    # placeholder, while rendering nothing visible.
    if not head_survivors and not rest_texts and not attribution:
        elements.append(Text("​"))

    toast = Toast(
        app_id=app_id,
        duration=ToastDuration.LONG if spec.get("duration") == "long" else ToastDuration.SHORT,
    )
    toast.elements = elements
    toast._xml_mute_sound = bool(spec.get("muted"))   # read by to_xml_string()'s <audio silent=...>

    # Build the XML with toasted (rich elements), then post it with the raw WinRT notifier — we do
    # NOT call toasted's own Toast.show() (it registers activated/dismissed handlers and awaits one,
    # bundling "post" with "wait for the user"; in an unpackaged venv that callback often never
    # arrives, so it hangs). download_media defaults False: a local file:// image resolves to a path
    # (no network), a remote http(s)/icon:// source is left as a URL in the XML for Windows to fetch
    # asynchronously — we never do a synchronous download here.
    import winsdk.windows.data.xml.dom as dom
    from winsdk.windows.ui.notifications import ToastNotification, ToastNotificationManager

    xml_doc = dom.XmlDocument()
    xml_doc.load_xml(toast.to_xml_string())
    notification = ToastNotification(xml_doc)
    # Replace-by-tag: a spec that carries a tag posts under (app_id, tag, group), so a later toast
    # with the SAME tag replaces this one in place instead of stacking (the accumulating relic
    # toast). Just two string properties on a fire-and-forget notification — no handle is retained,
    # so this can't reintroduce the in-process WinRT lock-up the child process exists to avoid.
    tag = spec.get("tag") or ""
    if tag:
        try:
            notification.tag = tag
            notification.group = spec.get("group") or app_id
        except Exception:   # noqa: BLE001 - a projection quirk must never drop the toast
            pass
    ToastNotificationManager.create_toast_notifier(app_id).show(notification)


def main() -> int:
    # argv[1] is a JSON file holding the serialized ToastSpec. A failed toast must never matter —
    # this whole process is fire-and-forget; swallow everything and exit 0.
    try:
        spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        _post(spec)
    except Exception:   # noqa: BLE001 - a bad spec / WinRT hiccup must not surface anywhere
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
