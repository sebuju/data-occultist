"""In-game overlay: a transparent, click-through window drawn over the game.

The overlay shows live readout/dataset values on top of a borderless game window. It is hosted in
a CHILD PROCESS (:mod:`oc.overlay._overlay_child`) driven by :mod:`oc.overlay.manager`; visibility
changes are announced on :mod:`oc.overlay.events`.

See ``docs/ARCHITECTURE.md`` and the module docstrings for why each piece is shaped the way it is —
in particular ``_overlay_child`` documents the three Windows quirks the design is built around
(pywebview leaves an opaque host form behind a transparent WebView2, the overlay is captured by the
``mss`` grab that feeds OCR unless excluded, and a transparent window steals the foreground on
navigation).
"""
