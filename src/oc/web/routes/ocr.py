"""Switch the OCR engine between CPU and GPU at runtime, plus the GPU pacing knobs
(downscale + per-burst yield), all persisted across restarts."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ...ocr.cuda import cuda_available
from ...ocr.gpu_mem import process_gpu_mem
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/ocr", tags=["ocr"])


# Each runtime OCR knob is one scalar persisted to data/.ocr_<name>: a parse() that turns the
# stored text into a validated value (raising ValueError to fall back) and a default (a value
# or a zero-arg callable, e.g. to read a settings default). Three knobs ride this one helper
# instead of three hand-rolled file pairs (CLAUDE.md rule 7).
def _persisted(name: str, parse, default):
    def _path() -> Path:
        return Path(get_settings().data_dir) / f".ocr_{name}"

    def _default():
        return default() if callable(default) else default

    def read():
        try:
            return parse(_path().read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return _default()

    def write(value) -> None:
        try:
            p = _path()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(str(value), encoding="utf-8")
        except OSError:
            pass

    return read, write


# The OCR device MODE: "cpu" / "gpu" / "auto". GPU is the primary device — CPU is the
# emergency fallback for machines without CUDA. "auto" baselines on CPU for sparse
# interactive reads and bursts to GPU for batch work (precapture/live), for users who
# want the GPU freed between batches. Default = "gpu" whenever CUDA is present.
_MODES = ("cpu", "gpu", "auto")


def default_mode() -> str:
    return "gpu" if cuda_available() else "cpu"


def _parse_mode(v: str) -> str:
    if v in _MODES:
        return v
    raise ValueError(v)   # legacy/garbage -> default


def _yield_default() -> float:
    """Settings-file default for the per-burst yield, so an unset dotfile falls back to the
    value shipped in config/settings.yaml (ocr.options.yield_ms) rather than a bare 0."""
    try:
        return float(get_settings().ocr.options.get("yield_ms", 0.0) or 0.0)
    except (AttributeError, TypeError, ValueError):
        return 0.0


def _option_default(key: str, cast, fallback):
    """Settings-file default for an OCR engine option (same intent as _yield_default,
    generalized: the dotfile overrides config/settings.yaml which overrides a constant)."""
    def default():
        try:
            v = get_settings().ocr.options.get(key)
            return cast(v) if v is not None else fallback
        except (AttributeError, TypeError, ValueError):
            return fallback
    return default


read_mode, _write_mode = _persisted("device", _parse_mode, default_mode)
_read_scale, _write_scale = _persisted("scale", lambda v: max(1, int(v)), 1)
_read_yield, _write_yield = _persisted("yield", lambda v: max(0.0, float(v)), _yield_default)
_read_threads, _write_threads = _persisted(
    "threads", lambda v: max(0, int(v)), _option_default("intra_op_num_threads", int, 0))
_read_engine, _write_engine = _persisted(
    "engine", lambda v: v.strip().lower(), _option_default("engine_type", str, "onnxruntime"))
_read_gpumem, _write_gpumem = _persisted("gpumem", lambda v: float(v), 3.0)


def apply_persisted() -> None:
    """Apply the persisted device MODE, downscale factor, AND per-burst yield to the engine —
    called at startup so the selections survive reloads and restarts. ``auto``/``cpu`` baseline
    the engine on CPU (auto bursts to GPU per precapture batch); ``gpu`` pins it to GPU."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_device"):
        ocr.set_device(read_mode() == "gpu")
    if hasattr(ocr, "set_scale"):
        ocr.set_scale(_read_scale())
    if hasattr(ocr, "set_yield_ms"):
        ocr.set_yield_ms(_read_yield())
    if hasattr(ocr, "set_intra_threads"):
        ocr.set_intra_threads(_read_threads())
    if hasattr(ocr, "set_gpu_mem_gb"):
        ocr.set_gpu_mem_gb(_read_gpumem())
    if hasattr(ocr, "set_engine_type"):
        try:
            ocr.set_engine_type(_read_engine())
        except ValueError:
            pass   # persisted engine no longer installed -> keep the settings default


def _state() -> dict:
    # Knobs a backend doesn't have report None so the UI hides their controls
    # (e.g. ppocr5 has engine_type but no scale/yield; the old backend the reverse).
    ocr = get_engine().ocr
    return {"device": getattr(ocr, "device", "cpu"), "mode": read_mode(),
            "gpu_available": cuda_available(),
            "gpu_active": bool(getattr(ocr, "gpu_active", False)),
            # This process's dedicated VRAM (bytes; None = unreadable). With a GPU
            # session loaded that is effectively the OCR's footprint.
            "gpu_mem": process_gpu_mem(),
            # None when the live engine lacks the knob, so the UI hides its control
            # (ppocr5 exposes set_scale but neither downscale nor yield).
            "scale": getattr(ocr, "scale", None) if hasattr(ocr, "set_scale") else None,
            "yield_ms": getattr(ocr, "yield_ms", None) if hasattr(ocr, "set_yield_ms") else None,
            "threads": getattr(ocr, "intra_threads", None),
            "gpu_mem_gb": getattr(ocr, "gpu_mem_gb", None) if hasattr(ocr, "set_gpu_mem_gb") else None,
            "engine_type": getattr(ocr, "engine_type", None),
            "engine_types": getattr(ocr, "engine_types", None)}


def ocr_state() -> dict:
    """Public OCR device snapshot for the activity heartbeat (one poll feeds everything)."""
    return _state()


@router.get("/device")
def get_device():
    return _state()


@router.post("/device")
def set_device(device: str):
    """Set the device MODE (``cpu`` / ``gpu`` / ``auto``). ``gpu`` pins the engine to GPU;
    ``cpu`` and ``auto`` baseline it on CPU (auto bursts to GPU per precapture batch)."""
    mode = device if device in _MODES else default_mode()
    ocr = get_engine().ocr
    if hasattr(ocr, "set_device"):
        ocr.set_device(mode == "gpu")
    _write_mode(mode)
    return _state()


@router.post("/release")
def release_gpu():
    """Kill the GPU OCR session to release VRAM. The model is dropped and rebuilt lazily
    on the next read; the device selection is left as-is."""
    ocr = get_engine().ocr
    if hasattr(ocr, "release"):
        ocr.release()
    return _state()


@router.post("/scale")
def set_scale(scale: int):
    ocr = get_engine().ocr
    if hasattr(ocr, "set_scale"):
        ocr.set_scale(scale)
    _write_scale(getattr(ocr, "scale", 1))
    return _state()


@router.post("/threads")
def set_threads(n: int):
    """Cap the CPU threads each inference may use (0 = runtime default: one per core).
    Fewer threads = slower reads but less CPU stolen from a game on the same machine."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_intra_threads"):
        ocr.set_intra_threads(n)
    _write_threads(getattr(ocr, "intra_threads", 0))
    return _state()


@router.post("/gpumem")
def set_gpu_mem(gb: float):
    """Cap the CUDA memory arena (GB) — the most VRAM the GPU OCR session may hold.
    Applies on the next GPU session build (a loaded session rebuilds lazily)."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_gpu_mem_gb"):
        ocr.set_gpu_mem_gb(gb)
    _write_gpumem(getattr(ocr, "gpu_mem_gb", 3.0))
    return _state()


@router.post("/engine")
def set_engine_type(name: str):
    """Pick the inference engine for the ppocr5 backend (onnxruntime / openvino). Only
    engines whose runtime is installed are accepted; a bad name keeps the current one."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_engine_type"):
        try:
            ocr.set_engine_type(name)
        except ValueError:
            pass
    if getattr(ocr, "engine_type", None):
        _write_engine(ocr.engine_type)
    return _state()


@router.post("/yield")
def set_yield(ms: float):
    """Set the per-burst GPU yield (ms slept between OCR submissions). Higher = the read is
    split into more, shorter GPU bursts with gaps a game can present in -> smoother frame
    pacing, slightly slower reads. 0 = off (one continuous burst)."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_yield_ms"):
        ocr.set_yield_ms(ms)
    _write_yield(getattr(ocr, "yield_ms", 0.0))
    return _state()
