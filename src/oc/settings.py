"""Runtime settings: which backend implementation to use for each kind.

Loaded from ``config/settings.yaml`` (falling back to the defaults below). Swapping
a backend is a one-line change here or in that file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class BackendChoice:
    name: str
    options: dict = field(default_factory=dict)


@dataclass
class Tuning:
    """Robustness knobs for the collection pipeline.

    ``accept_confidence`` — at/above this, a read is trusted and taught to the
    game dictionary. ``min_confidence`` — below this (on the *worst* field of a
    record), the record is dropped as unreliable (e.g. partially occluded).
    ``confirm_frames`` — how many consecutive stable observations a record needs
    before it is written; defeats transient floating windows / popups.

    ``collect_interval`` — the OCR throttle: the OCR-heavy path runs at most once per
    this many seconds. 1.0 suits static catalogue screens; lower it to read
    faster-changing views. Callers that don't pass an explicit interval fall back to
    this. 0 = no throttle (OCR every gate poll the pipeline allows).

    ``gate_interval`` — the fast poll rate: how often the loop wakes to fire triggers and
    re-check the OCR throttle. Much smaller than ``collect_interval`` so a worthy screen is
    caught promptly; cheapness on idle frames comes from priority-order classify (the
    top-priority gate window early-returns on one cheap check — see the classifier).
    """

    accept_confidence: float = 0.88
    min_confidence: float = 0.50
    confirm_frames: int = 2
    collect_interval: float = 1.0
    gate_interval: float = 0.25
    # Only collect while the game window is focused. False suits window-targeted
    # capture (printwindow), which reads the window even when backgrounded.
    require_foreground: bool = False
    # Log removals (items missing vs stored state) when a run ends. Only safe if a
    # run reliably sees the WHOLE dataset; off by default to avoid false removals.
    detect_removals: bool = False


@dataclass
class Settings:
    capture: BackendChoice = field(default_factory=lambda: BackendChoice("mss"))
    window: BackendChoice = field(default_factory=lambda: BackendChoice("win32"))
    process: BackendChoice = field(default_factory=lambda: BackendChoice("psutil"))
    ocr: BackendChoice = field(default_factory=lambda: BackendChoice("ppocr5"))
    classifier: BackendChoice = field(default_factory=lambda: BackendChoice("detect"))
    corrector: BackendChoice = field(default_factory=lambda: BackendChoice("rapidfuzz"))
    notifier: BackendChoice = field(default_factory=lambda: BackendChoice("windows"))

    tuning: Tuning = field(default_factory=Tuning)
    profiles_dir: Path = Path("config/games")
    data_dir: Path = Path("data")
    captures_dir: Path = Path("captures")

    @classmethod
    def load(cls, path: str | Path = "config/settings.yaml") -> Settings:
        path = Path(path)
        if not path.exists():
            return cls()
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        s = cls()

        def choice(key: str, default: BackendChoice) -> BackendChoice:
            node = raw.get(key)
            if node is None:
                return default
            if isinstance(node, str):
                return BackendChoice(node)
            return BackendChoice(node["name"], node.get("options", {}))

        s.capture = choice("capture", s.capture)
        s.window = choice("window", s.window)
        s.process = choice("process", s.process)
        s.ocr = choice("ocr", s.ocr)
        s.classifier = choice("classifier", s.classifier)
        s.corrector = choice("corrector", s.corrector)
        s.notifier = choice("notifier", s.notifier)
        if isinstance(raw.get("tuning"), dict):
            t = raw["tuning"]
            s.tuning = Tuning(
                accept_confidence=t.get("accept_confidence", s.tuning.accept_confidence),
                min_confidence=t.get("min_confidence", s.tuning.min_confidence),
                confirm_frames=t.get("confirm_frames", s.tuning.confirm_frames),
                collect_interval=t.get("collect_interval", s.tuning.collect_interval),
                gate_interval=t.get("gate_interval", s.tuning.gate_interval),
                require_foreground=t.get("require_foreground", s.tuning.require_foreground),
                detect_removals=t.get("detect_removals", s.tuning.detect_removals),
            )
        if "profiles_dir" in raw:
            s.profiles_dir = Path(raw["profiles_dir"])
        if "data_dir" in raw:
            s.data_dir = Path(raw["data_dir"])
        if "captures_dir" in raw:
            s.captures_dir = Path(raw["captures_dir"])
        return s
