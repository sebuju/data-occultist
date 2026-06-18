"""Generate the built-in trigger sounds — a few short bobs and chirps.

Pure stdlib (``wave`` + ``math``), no deps. Writes small 16-bit mono WAVs into
``src/oc/web/static/sounds/`` where the web app serves and lists them. Re-run to
regenerate; the files are committed so the UI works out of the box. The user can
drop their own ``.wav/.mp3/.ogg/.m4a`` alongside these.

    python scripts/gen_sounds.py
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / "src" / "oc" / "web" / "static" / "sounds"


def _write(name: str, samples: list[float]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    frames = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples)
    with wave.open(str(OUT / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)


def _tone(freq: float, dur: float, *, fade: float = 0.012, gain: float = 0.6,
          f_end: float | None = None) -> list[float]:
    """A sine of ``freq`` -> ``f_end`` (a chirp if they differ) for ``dur`` seconds,
    with a short attack/decay envelope so it doesn't click."""
    n = int(RATE * dur)
    fade_n = max(1, int(RATE * fade))
    out: list[float] = []
    phase = 0.0
    for i in range(n):
        t = i / n
        f = freq if f_end is None else freq + (f_end - freq) * t
        phase += 2 * math.pi * f / RATE
        env = gain
        if i < fade_n:
            env *= i / fade_n
        elif i > n - fade_n:
            env *= (n - i) / fade_n
        out.append(math.sin(phase) * env)
    return out


def _seq(*segments: list[float]) -> list[float]:
    out: list[float] = []
    for s in segments:
        out.extend(s)
    return out


def main() -> None:
    _write("blip.wav", _tone(880, 0.08))                                   # short high blip
    _write("bob.wav", _tone(220, 0.16, fade=0.02))                         # low rounded bob
    _write("chirp.wav", _tone(600, 0.18, f_end=1400))                      # rising chirp
    _write("ding.wav", _tone(1320, 0.30, fade=0.006))                      # bright bell-ish ding
    _write("two-tone.wav", _seq(_tone(700, 0.09), _tone(1050, 0.12)))      # door-bell two-tone
    print(f"wrote 5 sounds to {OUT}")


if __name__ == "__main__":
    main()
