"""Profile schema: how a game's windows, states, and readable regions are described.

A profile is pure data (YAML on disk, validated by these pydantic models). The
teaching UI writes it; the collector reads it. Nothing about a specific game is
hard-coded in Python — it all lives here.

Coordinate convention: every box is a :class:`FractionBox` (0..1 of the window
client area), so a profile authored at one resolution still works at another.
"""

from __future__ import annotations

from enum import Enum

from pydantic import (
    BaseModel, ConfigDict, Field, computed_field, field_validator, model_serializer, model_validator,
)

from ..store.keys import KeyMap, KeySpec
from ..types import FractionBox

# Single source of truth for a detector's match-score floor. The UI seeds new
# detect nodes with this so the value lives in exactly one place per layer (web
# mirror: DEFAULT_DETECT_THRESHOLD in static/js/defaults.js) — no bare 0.8 literals.
DEFAULT_DETECT_THRESHOLD = 0.8


class Box(BaseModel):
    """Fraction rectangle relative to the window client area (or, for an item's
    fields/tells, relative to the cell). Coordinates are CLAMPED to sane bounds
    rather than rejected — a box drawn a hair past an edge shouldn't 422 a save."""

    x: float
    y: float
    w: float
    h: float

    @field_validator("x", "y")
    @classmethod
    def _clamp_pos(cls, v: float) -> float:
        return min(1.0, max(0.0, v))

    @field_validator("w", "h")
    @classmethod
    def _clamp_size(cls, v: float) -> float:
        return min(1.0, max(1e-6, v))

    def to_fraction(self) -> FractionBox:
        return FractionBox(self.x, self.y, self.w, self.h)


class FieldType(str, Enum):
    text = "text"
    number = "number"
    pips = "pips"          # value = count of glowing dots/pips in the region (e.g. mod rank)
    diamonds = "diamonds"  # value = count of FILLED diamonds in a rank strip (e.g. arcane level)


class Extract(str, Enum):
    """How to pull the value out of a region's raw OCR text. No regex in the UI —
    these are friendly, declarative strategies. ``separator`` applies to the
    *_before / *_after variants (e.g. a mod rank "7 / 10" -> number_before with "/").
    """

    whole = "whole"                  # use all the text
    number = "number"                # the first number anywhere
    number_before = "number_before"  # the first number left of the separator
    number_after = "number_after"    # the first number right of the separator
    text_before = "text_before"      # the text left of the separator
    text_after = "text_after"        # the text right of the separator


class DictMode(str, Enum):
    """How a text field uses the game dictionary.

    * ``off`` — the dictionary is not consulted; the read passes through verbatim.
    * ``correct`` — word-per-word correction; an unmatched word passes through.
    * ``drop`` — validation only: every word must already be a dictionary word or
      the read resolves to None. Nothing is rewritten.
    * ``correct_drop`` — correct what it can, drop a read with an unmatchable word.
    """

    off = "off"
    correct = "correct"
    drop = "drop"
    correct_drop = "correct_drop"


class RuleWhen(str, Enum):
    """A condition tested against the field's CURRENT running value when the rule pipeline
    reaches it. Rules run top-to-bottom, so a transform ahead of this rule may already have
    changed the value the condition sees. Shape predicates look at the text; ``below`` /
    ``above`` compare it numerically to ``arg``; ``equal`` / ``not_equal`` / ``contains``
    compare it to ``arg`` (case-insensitive)."""

    always = "always"          # unconditional — the form a transform rule takes
    empty = "empty"            # nothing at all (no characters)
    no_digit = "no_digit"      # no digit anywhere (empty, symbol-only, or pure text)
    all_digit = "all_digit"    # has a digit and NO letter (a clean number)
    has_digit = "has_digit"    # at least one digit present
    no_letter = "no_letter"    # no letter anywhere
    all_letter = "all_letter"  # has a letter and NO digit (pure text)
    has_letter = "has_letter"  # at least one letter present
    below = "below"            # numeric value < arg
    above = "above"            # numeric value > arg
    equal = "equal"            # value == arg
    not_equal = "not_equal"    # value != arg
    contains = "contains"      # arg is a substring of value


class RuleThen(str, Enum):
    """What a matched :class:`FieldRule` does. ``drop`` early-returns (the whole record is
    dropped for that cell); every other action rewrites the running value and the pipeline
    CONTINUES to the next rule."""

    drop = "drop"              # early-return: drop the record for this cell
    set = "set"                # substitute ``value`` (authored, not OCR), continue
    lowercase = "lowercase"    # value.lower()
    uppercase = "uppercase"    # value.upper()
    fold = "fold"              # fold accents to plain ASCII (ö -> o)
    round = "round"            # round to nearest integer (number)
    floor = "floor"            # round down (number)
    ceil = "ceil"              # round up (number)
    extract = "extract"        # pull a value out via ``strategy`` + ``sep``
    dictionary = "dictionary"  # correct/validate against a game dictionary


class FieldRule(BaseModel):
    """One step in a field's value pipeline. Rules run in authored order, top-to-bottom, and
    the running value flows through each. A rule fires when ``when`` holds (``always`` for an
    unconditional transform); ``then`` is the action. ``drop`` stops the pipeline and drops
    the record; any other action rewrites the value and flow continues. Only the operand
    field(s) relevant to the chosen ``when`` / ``then`` are used; the rest keep defaults."""

    when: RuleWhen = RuleWhen.always
    arg: str = ""                            # operand for below/above/equal/not_equal/contains
    then: RuleThen = RuleThen.set
    value: str = ""                          # for ``set``: the substituted text
    strategy: Extract = Extract.number       # for ``extract``: which piece to pull
    sep: str = "/"                           # for ``extract``: the *_before/_after split token
    dict_mode: DictMode = DictMode.correct   # for ``dictionary``: how the vocabulary participates
    dict_id: str = ""                        # for ``dictionary``: which DictionaryDef (blank = pooled)
    fuzzy: float = 0.82                      # for ``dictionary``: fuzzy-snap similarity threshold

    _ARG_WHENS = (RuleWhen.below, RuleWhen.above, RuleWhen.equal, RuleWhen.not_equal, RuleWhen.contains)

    @model_serializer
    def _ser(self) -> dict:
        """Emit only the operand(s) the chosen ``when`` / ``then`` actually use, so a rule
        stays terse on disk and over the wire (a bare ``fold`` is ``{when, then}``, not all
        nine fields). Absent keys re-validate back to their defaults."""
        out: dict = {"when": self.when.value, "then": self.then.value}
        if self.when in self._ARG_WHENS:
            out["arg"] = self.arg
        if self.then is RuleThen.set:
            out["value"] = self.value
        elif self.then is RuleThen.extract:
            out["strategy"] = self.strategy.value
            out["sep"] = self.sep
        elif self.then is RuleThen.dictionary:
            out["dict_mode"] = self.dict_mode.value
            if self.dict_id:
                out["dict_id"] = self.dict_id
            out["fuzzy"] = self.fuzzy
        return out


class FieldDef(BaseModel):
    """One column in a game's data schema, read from a region. ALL value processing —
    extraction, dictionary correction, range checks, case, rounding — lives in the ordered
    ``rules`` pipeline (authored in the node UI), not in per-field scalars. Only the
    capture / confidence knobs, which act before or around OCR rather than on the value
    stream, sit on the field itself."""

    id: str
    type: FieldType = FieldType.text
    # The value pipeline: an ordered list of rules the raw read flows through, top-to-bottom
    # (see FieldRule). Empty -> the read passes through and is typed to ``type`` at the end.
    rules: list[FieldRule] = Field(default_factory=list)
    # Per-field minimum OCR confidence (0..1). A GENUINE read below this drops the whole
    # record for that cell — a per-area floor on top of the global ``tuning.min_confidence``.
    # 0 = no per-field floor (rely on the global one). A capture-quality gate, not a value rule.
    min_confidence: float = 0.0
    # Read this box in ISOLATION: OCR only its own crop instead of picking tokens out of the
    # window-wide pass. The shared pass can fuse a digit and an adjacent glyph into ONE token
    # ("8" + polarity -> "81"); isolate crops just the box (upscaled) so it sees only those
    # pixels. A capture-time choice, so it stays a field toggle rather than a value rule.
    isolate: bool = False
    # Post-OCR GLYPH refinement: match each cleanly-separated glyph against the game's taught
    # atlas (GameProfile.glyphs) and substitute a character only when a *different* taught
    # glyph out-scores the OCR's own. Fixes systematic single-glyph confusions the dictionary
    # cannot (e.g. "Q3" vs "G3"). Runs BEFORE the rule pipeline; a capture-time toggle.
    glyph_check: bool = False


class RegionDef(BaseModel):
    """A rectangle to OCR, mapped to a schema field.

    For grid windows, a region describes the *cell-relative* box and the grid
    expands it across rows/columns (see :class:`ScrollDef`/grid below).
    """

    id: str
    box: Box
    field: str  # FieldDef.id this region feeds
    # For item fields: also act as a text tell — the cell is only valid when this
    # field read something. Saves drawing a separate tell over the same box.
    tell: bool = False
    tell_conf: float = 0.0  # when ``tell``: min OCR confidence the read must reach (0 = any non-empty)
    # when ``tell`` on a NUMBER field: pass on ANY read (even one with text, e.g. a polarity
    # glyph next to the drain), not only a clean numeric value. Off = strict number required.
    tell_allow_text: bool = False
    # Use this field to LOCATE rows (anchor the grid), independently of ``tell``. Lets a
    # reliable text field (e.g. an item name spanning the cell) find rows without also being
    # a validation tell. Takes priority over the tell-field locator fallback (see locator_of).
    locate: bool = False
    # When this field locates rows (a tell-field used as the locator): which line of a
    # wrapped name to anchor on — "top"/"center"/"bottom". Empty -> item's ``align``.
    align: str = ""
    # Horizontal twin of ``align``: which edge of the located text fixes the COLUMN — the
    # text's "left"/"center"/"right". Lets columns be found from content (immune to blank
    # margins in the data area) instead of tiled geometrically. Empty -> item's ``align_x``.
    align_x: str = ""
    enabled: bool = True  # disabled regions are skipped during reads


class ReadoutDef(BaseModel):
    """A definable area that reads a LIVE, EPHEMERAL scalar off a window box — health, a
    buff counter — into an in-memory value that is never stored in a dataset nor written to
    disk. Its own graph node (``ro:<win>:<id>``) so triggers can watch it.

    Like a region, ``box`` is a window-fraction rectangle and ``field`` names the
    :class:`FieldDef` (in the window's ``fields``) that carries the read config — so the
    readout reuses all the existing field machinery inline.
    """

    id: str                              # the readout's identity (its authored name), like every
                                         # other node; a trigger watches it and toasts token {{id}}
    box: Box                             # window-fraction area
    field: str = ""                      # FieldDef.id carrying the read config
    enabled: bool = True                 # disabled readouts are skipped during reads


class MatchMode(str, Enum):
    """How a text detector/tell compares its ``text`` against the OCR read.

    ``partial`` aligns the shorter string *anywhere inside* the longer one — loose,
    so a read that merely contains (or is contained by) the target scores ~1.0; the
    length guards in :func:`text_match_score` are what keep it honest. The stricter
    modes compare the strings as wholes and so reject near-substring false matches
    (e.g. 'WARDSI' vs 'rewards') that ``partial`` waves through.
    """

    partial = "partial"  # substring alignment (loose) — historical default
    full = "full"        # whole-string similarity (rejects extra/missing chars)
    exact = "exact"      # normalised equality: 1.0 or 0.0
    prefix = "prefix"    # read must begin with the target


class StripMode(str, Enum):
    """What ``_norm`` removes before comparing detector/tell text to the OCR read."""

    alnum = "alnum"    # keep only letters/digits (ignore spaces + punctuation)
    spaces = "spaces"  # drop only whitespace (punctuation is significant)
    none = "none"      # compare raw (whitespace + punctuation significant)


class TellKind(str, Enum):
    """A way to recognise that a cell really is an item (not a gap/popup/empty slot)."""

    filled = "filled"      # the region has visual content (variance/edges above floor)
    text = "text"          # OCR finds non-empty text in the region
    color = "color"        # a taught colour is present in the region
    border = "border"      # a taught colour rides the box's PERIMETER band (not its fill) — e.g. a rarity frame
    template = "template"  # a saved sub-image matches in the region
    diamonds = "diamonds"  # a rank-diamond strip is present (◇/◆), e.g. only arcanes have one


class Tell(BaseModel):
    """One identification signal for an item, tested in a cell-relative region.

    All of an item's tells must pass for a detected cell to count as a real item.
    A visual tell (``filled``/``color``/``template``) can also *locate* rows cheaply
    without OCR-ing the whole data area.
    """

    id: str
    box: Box                       # cell-relative (0..1 within the item cell)
    kind: TellKind = TellKind.filled
    field: str | None = None       # for ``text``: which field's read this tell validates
    color: str | None = None       # for ``color``/``border``: hex, e.g. "#ffcc00"
    tolerance: int = 60            # for ``color``/``border``: colour distance (0..441)
    # for ``border``: thickness of the sampled perimeter band, as a fraction (0..1) of the
    # box's SHORTER side — so the ring scales with resolution. The score is the share of
    # near-colour pixels within that band only (the fill is ignored).
    width: float = 0.2
    template: str | None = None    # for ``template``: PNG path relative to the profile dir
    # for ``template``: how far the live crop is grown beyond the tell box (per side, as a
    # fraction of the box) before matching, so ``matchTemplate`` can SLIDE to find the saved
    # sub-image even when the OCR-located cell drifts a few px. 0 = match in the exact box only.
    margin: float = 0.25
    threshold: float = 0.5         # score a tell must reach to pass (per-kind meaning)
    locate: bool = False           # use this tell to find row positions
    # When this tell locates rows: which line of a wrapped name to anchor on, so the
    # anchor is line-count-invariant — "top"/"center"/"bottom". Empty -> inherit the
    # item's ``align`` (legacy). Lives on the tell so each locator sets its own.
    align: str = ""
    # Horizontal twin of ``align`` (see RegionDef.align_x): which edge of the located text
    # fixes the COLUMN — "left"/"center"/"right". Empty -> item's ``align_x``.
    align_x: str = ""
    # ``text`` tell, optional target: when set, the ``field``'s read must MATCH this literal
    # (scored like a detector, must clear ``threshold``) — not merely be non-empty. So a tell
    # can require e.g. the name reads "Forma" specifically. Empty -> the legacy "field read
    # something" check. The match knobs mirror DetectDef and apply only when ``text`` is set.
    text: str | None = None
    match: MatchMode = MatchMode.partial
    case_sensitive: bool = False
    min_chars: int = 0
    strip: StripMode = StripMode.alnum


class KeyDef(BaseModel):
    """How a record's identity (dedup key) is built: ordered field ids joined with
    ``sep``. Most data keys on one field (a name); some needs more — "Arcane Aegis"
    level 5 vs level 3 are different records, so arcanes key on ``name`` + ``level``.
    A record with any key part unread is dropped (never guessed). Authored per item
    template in the teaching UI, with a live preview from the frozen cutout."""

    fields: list[str] = Field(default_factory=lambda: ["name"])
    sep: str = "|"
    case_sensitive: bool = False

    def spec(self) -> KeySpec:
        return KeySpec(tuple(self.fields) or ("name",), self.sep, self.case_sensitive)


class ItemDef(BaseModel):
    """A teachable *item template*: one cell of a repeating list, defined once and
    found across the data area.

    Unlike the old fixed grid (rows/cols/strides), an item is located by content and
    validated by its :class:`Tell` signals. Columns are an even tiling of the data
    area by the cell width; rows come from the locator tell. Each field is read at a
    position *relative to the item cell*, so one template reads every instance
    regardless of scroll, and anything without the item's tells (a floating tooltip,
    an empty slot) is discarded.

    Coordinates:
      * ``box`` is the cell's bounding box in WINDOW fractions — it sets the cell
        size and the authoring origin, and is the frozen ``cutout``'s source rect.
      * each field's and tell's ``box`` is 0..1 *within the item cell*.
    """

    id: str
    enabled: bool = True           # disabled item templates are skipped during detection
    box: Box                       # cell bounding box, window fractions (the tiling cell)
    cutout: str | None = None      # frozen PNG of the cell + context (authoring surface)
    cutout_box: Box | None = None  # where the cutout was grabbed (window fractions); UI maps in-node draws
    # How the locator's text sits in the cell, so rows anchor on a line-count-invariant
    # point: "top"/"center"/"bottom" line of a wrapped name. (Warframe names are bottom-
    # aligned; a centroid drifts with line count.)
    align: str = "center"
    # Horizontal twin of ``align``: which edge of the located text fixes the COLUMN —
    # "left"/"center"/"right". Default left (most names are left-aligned in their cell).
    align_x: str = "left"
    # When several templates claim the same tile, the higher ``priority`` wins (e.g. a
    # specific 'arcane' over a generic 'item'). Ties fall back to tell count.
    priority: int = 0
    # Field boxes (cell-relative 0..1). RUNTIME-nested for the reader, but NOT serialised
    # here: each item's fields are hoisted to the window's flat ``item_fields`` (with an
    # ``item`` backref) so every field is its own thing on disk + its own node in the UI.
    fields: list[RegionDef] = Field(default_factory=list, exclude=True)
    # Tells (cell-relative). Like fields: RUNTIME-nested for the reader, but NOT serialised
    # here — hoisted to the window's flat ``item_tells`` (with an ``item`` backref) so every
    # tell is its own thing on disk + its own node in the UI.
    tells: list[Tell] = Field(default_factory=list, exclude=True)   # what makes a cell an item
    # How this template's records are keyed/deduped. None -> the window's key, else
    # the default (``name``). Per-template because templates sharing a window can
    # need different identities (an arcane keys on name+level, a plain item on name).
    key: KeyDef | None = None
    # Occlusion guard: the fraction of the located CELL that must lie inside the data area on
    # each axis for the record to be SENT FORWARD (stored). Scrolling clips the top/bottom row
    # (and edge columns), so part of a cell falls outside the data area and reads unreliably —
    # a cell covered LESS than this on either axis is dismissed, never stored. It gates only the
    # forwarded output, NEVER grid location (so a partly-off row still anchors its neighbours).
    # 1.0 = require the whole cell inside; 0 = never dismiss on that axis.
    min_cover_x: float = 0.75
    min_cover_y: float = 0.75
    # Terminator/sentinel: when this template is detected, it marks the END of the real list —
    # every record positioned AFTER it is discarded (an unowned-relic placeholder, a "no more
    # results" row). Ordered scroll/mirror datasets only; the collector cuts the store to the
    # sentinel's row on each clean frame it's visible. Game-agnostic (any list with an end marker).
    terminator: bool = False


class DetectCombine(str, Enum):
    """How a window's detectors are combined into one match verdict.

    ``all`` (the historical behaviour) requires EVERY enabled detector to pass; ``any``
    accepts when at least one passes. A detector "passes" per its own polarity — a
    positive detector passes when present, a ``negate`` detector passes when ABSENT.
    """

    all = "all"  # AND — every enabled detector must pass (default)
    any = "any"  # OR  — at least one enabled detector passes


class DetectDef(BaseModel):
    """A visual landmark used to recognise a window or state.

    ``template`` is a PNG path (relative to the profile dir) matched within
    ``search`` via template matching. Alternatively ``text`` is OCR'd inside
    ``search`` and compared against ``text`` per the ``match`` knobs below.
    ``color`` is the cheapest kind — the fraction of pixels in ``search`` near a
    taught hex colour (``width>0`` restricts it to the box perimeter, for a frame/
    outline). ``template`` and ``color`` are *cheap* (no OCR), so they can gate the
    OCR-heavy ``text`` pass — see :meth:`is_cheap` and the live-mode worthiness gate.
    """

    id: str
    enabled: bool = True    # disabled detectors are skipped during detection
    search: Box
    template: str | None = None
    text: str | None = None
    # Cheap colour-presence kind (reuses the item-Tell colour primitives). ``color`` is
    # a hex string; ``tolerance`` the BGR distance that counts as "near"; ``width`` the
    # perimeter band as a fraction of the box's shorter side (0 = whole-fill colour).
    color: str | None = None
    tolerance: int = 32
    width: float = 0.0
    # 0..1 score required to match. REQUIRED — no baked-in default; the UI seeds new
    # nodes from DEFAULT_DETECT_THRESHOLD and the loader backfills older profiles
    # (_migrate_detect_thresholds), so the magic number lives in exactly one place.
    threshold: float
    match: MatchMode = MatchMode.partial  # how text is compared (see MatchMode)
    case_sensitive: bool = False  # False -> fold case before comparing
    min_chars: int = 0            # hard floor: reads shorter than this never match
    strip: StripMode = StripMode.none  # what to ignore before comparing (default: keep everything)
    # Polarity. False (default) -> a POSITIVE detector: passes when the landmark is
    # present (score >= threshold). True -> a NEGATIVE detector: passes when the landmark
    # is ABSENT, so the window fails if this landmark IS found (e.g. "not the shop tab").
    negate: bool = False

    @property
    def is_cheap(self) -> bool:
        """A detector that needs no OCR — a template or colour probe (a few ms). The
        classifier runs these first (so a failing cheap detector short-circuits the OCR
        text pass) and the live-mode gate uses ONLY these to decide whether OCR is worth
        running this frame. A detector with ``text`` set is never cheap."""
        return bool(self.template or self.color) and not self.text


class StateKind(str, Enum):
    ordering = "ordering"  # sort order of the list
    filter = "filter"      # search/filter applied
    scroll = "scroll"      # scroll position
    generic = "generic"


class StateDef(BaseModel):
    """A distinguishable mode of a window (e.g. a particular sort order).

    The collector only writes records while in a state with
    ``valid_for_save=True`` — this is how "don't save data at the wrong order"
    is enforced without dropping the rest of the pipeline.
    """

    id: str
    kind: StateKind = StateKind.generic
    detect: list[DetectDef] = Field(default_factory=list)
    valid_for_save: bool = True


class ScrollSample(BaseModel):
    """One scroll-calibration reference: a scrollbar crop at a known scroll position.

    ``img`` is the cutout as a data URL (PNG); ``rows`` is how many rows the viewport top has
    moved down from the top of the list at this scroll; ``pos`` is the thumb position (0..1)
    read from the crop by ``scroll_detail`` (filled server-side); ``conf`` its confidence.
    """

    img: str = ""
    rows: int = 0
    pos: float | None = None
    conf: float | None = None
    px: int | None = None     # thumb top offset within the crop, in cutout pixels (display only)


class ScrollDef(BaseModel):
    """Describes a scrollable grid so rows can be stitched across scrolls.

    Rows already seen (by the window's record key) are not re-emitted, which makes
    stitching robust to scroll overlap.
    """

    enabled: bool = True              # disabled -> scroll/stitching is ignored
    scrollbar: Box | None = None      # where the scrollbar thumb lives (optional)
    scrollbar_orientation: str = "vertical"  # "vertical" | "horizontal"
    rows: int = 1                      # visible rows per screen
    cols: int = 1                      # visible columns per screen
    cell: Box | None = None            # first cell's box; grid tiles from here
    row_stride: float = 0.0            # fractional y-gap between row origins
    col_stride: float = 0.0            # fractional x-gap between col origins
    # Dynamic row-lattice clamp (0..1): bound the pitch DERIVED from the live findings to
    # the authored pitch * [1 - tol, 1 + tol]. Set (not None) marks the window as a dynamic
    # lattice grid — rows are fitted/interpolated from findings, not taken at face value.
    pitch_tolerance: float | None = None
    # Scroll calibration, authored explicitly from cutouts (no live learning). Each cutout is a
    # crop of the scrollbar at a known scroll, tagged with how many rows the viewport has moved
    # from the top; ``pos`` is the thumb position read from that crop. Fitting the cutouts gives
    # ``calib_gain`` = rows of content per full thumb travel = slope of (rows_from_top vs pos) =
    # the scrollable row count. The collector maps a row to its scroll-invariant index as
    # ``pos*calib_gain + ypos*rows_on_screen``, where rows_on_screen is MEASURED live from the
    # frame's row spacing (a continuous list has no fixed pages, so it isn't authored).
    calib_samples: list[ScrollSample] = []
    calib_gain: float | None = None     # rows-per-thumb-travel, fit from the cutouts
    # Precapture auto-scroll, per window: whether recording this window's list auto-advances,
    # and how many wheel notches per nudge. Used when precapture classifies this window on
    # screen (replaces the old global panel controls).
    autoscroll: bool = False
    scroll_clicks: int = 1


class PreprocessMode(str, Enum):
    none = "none"
    color = "color"        # keep only pixels near the taught text colour(s)
    threshold = "threshold"  # Otsu binarisation
    invert = "invert"      # light-on-dark -> dark-on-light


class Preprocess(BaseModel):
    """Teachable image cleanup applied to a window's OCR crop before reading.

    ``color`` masks glyphs matching the taught text colour(s) (sampled from the
    capture with the eyedropper) within ``tolerance``, yielding clean black-on-white
    that OCR reads far more reliably than stylised coloured game text. ``scale``
    upsamples small text. Applied once to the batched crop, so OCR stays cheap.
    """

    mode: PreprocessMode = PreprocessMode.none
    colors: list[str] = Field(default_factory=list)  # hex, e.g. "#ffffff"
    tolerance: int = 60                                # colour distance (0..441)
    scale: float = 1.0                                 # upscale factor for small fonts


# Item children hoisted to FLAT window-level lists on disk (one record per child, with an
# ``item`` backref) so each is its own node + its own YAML entry. {flat key: ItemDef attr}.
_HOISTED_ITEM_CHILDREN = {"item_fields": "fields", "item_tells": "tells"}


class WindowDef(BaseModel):
    """One recognisable screen/panel within a game.

    ``dataset`` names the logical collection this window's records belong to.
    Several windows can share a dataset when they show overlapping data (e.g.
    arcanes appear in both the Equipment and Arcane windows) — records from all of
    them are merged and deduplicated together into one output. When unset the
    window has NO dataset: its records are discarded (never stored). Wire it to a
    dataset in the UI to give it one — no implicit window-id default is minted.
    """

    id: str
    dataset: str | None = None
    # Default record key for this window's records — used by the grid/regions read
    # path and by item templates that don't define their own ``key``.
    key: KeyDef | None = None
    fields: list[FieldDef] = Field(default_factory=list)  # window-specific schema
    # Optional bounding box (window fractions) that constrains OCR to the data area,
    # so stray UI text elsewhere is never read.
    data_area: Box | None = None
    detect: list[DetectDef] = Field(default_factory=list)
    # How this window's detectors combine: ``all`` (AND, default) or ``any`` (OR). Each
    # detector's own ``negate`` flips its sense before the combine. See DetectCombine.
    detect_mode: DetectCombine = DetectCombine.all
    states: list[StateDef] = Field(default_factory=list)
    regions: list[RegionDef] = Field(default_factory=list)
    # Preferred over ``regions``+``scroll``: item templates matched across the data
    # area. When non-empty, the collector reads items from these instead of the grid.
    # A window may define several (e.g. different item layouts in the same panel).
    items: list[ItemDef] = Field(default_factory=list)
    # Item row-finding for THIS window's grid (all its item templates share the data area):
    # STATIC (default) tiles the data area into a fixed grid from the cell size — no OCR for
    # location. Off -> locate rows by OCR (a tell/locate field), needed only for a
    # scroll-parked list at an arbitrary sub-row offset.
    static_grid: bool = True
    scroll: ScrollDef | None = None
    # Live, non-persisted scalars read off this window (health, buff counter, a bar's fill).
    # Read every tick, surfaced to the UI + triggers, NEVER stored in a dataset. See ReadoutDef.
    readouts: list[ReadoutDef] = Field(default_factory=list)
    preprocess: Preprocess = Field(default_factory=Preprocess)
    # whether this window is attempted in live view (the graph UI's continuous re-read).
    # Off = skipped by the live loop; pure UI control, the collector ignores it.
    live: bool = True

    @model_validator(mode="before")
    @classmethod
    def _distribute_item_children(cls, data):
        """On load, fan each flat ``item_fields``/``item_tells`` (window-level, every entry
        carrying an ``item`` backref) back onto its ItemDef's runtime ``fields``/``tells`` so
        the reader is unchanged. Legacy profiles (children nested under items) pass through
        untouched. One loop drives every hoisted child kind (see _HOISTED_ITEM_CHILDREN)."""
        if not isinstance(data, dict):
            return data
        spread = _HOISTED_ITEM_CHILDREN
        if not any(data.get(k) for k in spread):
            return data
        data = dict(data)
        # item id -> {attr: [child, ...]} gathered across every flat list
        by_item: dict[str, dict[str, list]] = {}
        for flat_key, attr in spread.items():
            for c in data.pop(flat_key, None) or []:
                if not isinstance(c, dict):
                    continue
                c = dict(c)
                by_item.setdefault(c.pop("item", "") or "", {}).setdefault(attr, []).append(c)
        items = []
        for it in data.get("items") or []:
            if isinstance(it, dict):
                it = dict(it)
                for attr, extra in by_item.get(it.get("id", ""), {}).items():
                    if extra:
                        it[attr] = (it.get(attr) or []) + extra
            items.append(it)
        if items:
            data["items"] = items
        return data

    def _hoist_item_children(self, attr: str) -> list[dict]:
        """Flat, on-disk form of every item template's ``attr`` children — one entry per child
        with an ``item`` backref (what makes each its own node + its own YAML record)."""
        out: list[dict] = []
        for it in self.items:
            for c in getattr(it, attr):
                out.append({**c.model_dump(mode="json"), "item": it.id})
        return out

    @computed_field
    @property
    def item_fields(self) -> list[dict]:
        return self._hoist_item_children("fields")

    @computed_field
    @property
    def item_tells(self) -> list[dict]:
        return self._hoist_item_children("tells")

    @property
    def dataset_id(self) -> str | None:
        """The dataset this window feeds, or ``None`` when it has none (records
        discarded). No implicit window-id fallback. A blank/empty ``dataset``
        (e.g. left after unwiring) counts as no dataset — matching the UI's
        ``datasetOf`` — so reads are discarded, never written to a ``""`` sink."""
        return self.dataset or None


class JoinNorm(BaseModel):
    """Teachable canonicalisation applied to a value BEFORE it is matched, so near-match keys
    (``"Axi A1 Relic"`` vs ``"AXI A1"``) collapse to one. Generic — any near-match join OR a
    dataset ``concat`` key configures it; game-specific words (e.g. ``relic``) live here in
    YAML, never in Python. The default (case-insensitive + collapse whitespace) equals the old
    ``.strip().lower()`` join, so existing exact joins are unaffected."""

    case_insensitive: bool = True   # fold case before matching
    strip_punct: bool = False       # drop punctuation (collapse to spaces)
    collapse_ws: bool = True        # runs of whitespace -> one space, trimmed
    strip_words: list[str] = Field(default_factory=list)   # whole words to remove (e.g. "relic")


class DatasetDef(BaseModel):
    """A logical collection of records. Datasets just receive, store, and serve
    rows — HOW a row is keyed/deduped is defined where the rows are read: the
    :class:`KeyDef` on the item template (or window) that produces them. Several
    windows can feed one dataset; their keys should agree.

    A key keeps ALL its observations (it accumulates a history rather than overwriting);
    ``aggregate`` chooses how that 'many' side collapses to the one displayed value:
    ``latest`` (default), ``first``, or per-numeric-field ``sum``/``mean``/``max``/``min``."""

    id: str
    aggregate: str = "latest"
    # Dataset-level key override for the 1->many collapse. "" = inherit the key taught on the
    # windows/items feeding it (the default). A field name = key on that single field instead.
    key_field: str = ""
    # "Concat" key override: several fields combined into ONE identity, so rows dedup only when
    # ALL of these agree (e.g. ``relic_contents`` keyed on name+item — the same item inside two
    # relics stays two records). Non-empty WINS over ``key_field``. ``key_norm`` canonicalises
    # each part (case/punct/spacing/word folding) exactly like a subset join.
    key_fields: list[str] = Field(default_factory=list)
    key_norm: JoinNorm | None = None
    # False turns the 1->many collapse OFF entirely: every read is kept as its own record
    # (no dedup/merge). ``key_field``/``key_fields`` are ignored when ``dedup`` is False.
    dedup: bool = True
    # How a live collection run splits into revertable batches:
    #   "run"       — one batch for the whole run (default; persistent inventory).
    #   "detection" — a NEW batch every time the feeding window is freshly detected after a
    #                 gap. For transient per-event screens (e.g. relic offerings) where each
    #                 appearance is a distinct set, not an update of the last one.
    batch_mode: str = "run"
    # Whether a run ever REMOVES keys to track the game emptying out:
    #   "accumulate" (default) — keys only ever add/update; a run never removes.
    #   "mirror" — keep the dataset == live game state. As the user scrolls, a key whose
    #              last-seen scroll position is in the CURRENT visible slice but is not read
    #              (over confirm_frames clean frames) is removed (soft). A partial/occluded
    #              frame contributes no evidence, so it can never cause a false removal.
    sync_mode: str = "accumulate"


class DictFeed(BaseModel):
    """One dataset pushing its column values INTO a dictionary. The chosen ``columns``'
    values (across every stored row) become dictionary terms — so a collected dataset can
    author the vocabulary its own field reads snap to. Multiple columns pool together (e.g.
    pull both relic names and item names from ``relic_contents``). Always deduped on pull."""

    dataset: str = ""
    columns: list[str] = Field(default_factory=list)


class DictionaryDef(BaseModel):
    """A named, game-level word list. OCR reads of text fields snap to the closest
    entry — exact match first, then fuzzy — the authored vocabulary for games with a
    known term set: item/weapon/relic/arcane names, factions, etc. A game can have
    several; they're pooled.

    The term list lives in its own file under ``config/dictionaries/`` (named by
    ``source``) so the profile YAML stays small — a 7000-word dictionary doesn't
    belong inline. ``terms`` is RUNTIME-ONLY: the loader fills it from the ``source``
    file on load and writes it back on save, but it is never serialised into the
    profile YAML. A missing ``source`` file resolves to zero terms and the node
    survives (it is just a reference).

    ``feeds`` make the list DERIVED: when any dataset feed is wired, ``terms`` are pulled
    from those datasets' columns (deduped) and REPLACE the hand-typed list — refreshed
    whenever the fed data changes or the feed config is saved (see ``oc.learn.dict_feed``)."""

    id: str                              # identity (its authored id), like every other node;
                                         # a field pins it via ``FieldDef.dictionary``
    enabled: bool = True
    # Filename under config/dictionaries/ holding the term list (newline-delimited).
    source: str = ""
    # Resolved at load time from ``source`` and returned to the teach UI; the loader
    # strips it from the on-disk profile YAML (it persists to the ``source`` file).
    terms: list[str] = Field(default_factory=list)
    # Datasets feeding terms in. Non-empty => ``terms`` is derived (pulled + deduped), not hand-typed.
    feeds: list[DictFeed] = Field(default_factory=list)


class FilterRule(BaseModel):
    """One row-filter on a subset's source dataset. All of a subset's rules must pass
    (AND) for a row to be included."""

    field: str = ""
    # eq, ne, contains, icontains, empty, nonempty, gt, lt, gte, lte, regex
    op: str = "contains"
    value: str = ""


class DerivedColumn(BaseModel):
    """A column computed from other columns of a row. ``template`` is plain text with
    ``{column}`` placeholders substituted from the row's values, e.g. an arcane's display
    string ``"{name} [{rank}]"`` or a market slug source ``"{name}"``."""

    name: str
    template: str = ""


class SortRule(BaseModel):
    """One sort key for a view. Multiple rules sort by the first as primary, the next as
    tie-breaker, and so on. Applied AFTER filter/derive and BEFORE limit."""

    field: str = ""
    desc: bool = False


class HttpFilter(BaseModel):
    """One predicate on an array element, ANDed with the others. ``path`` is a dotted
    lookup within the element (e.g. ``"type"`` or ``"user.status"``)."""

    path: str
    op: str = "eq"                  # eq | ne | in | nin | gt | ge | lt | le | contains
    value: object = None            # scalar, or a list for in/nin


class HttpArraySpec(BaseModel):
    """Reduce a JSON array to one value: select -> filter -> pluck -> aggregate. The
    field's ``path`` must resolve to a list; each element is kept when every
    :class:`HttpFilter` passes, ``pluck`` reads a value out of it, and ``agg`` folds
    the plucked values to a single number."""

    filter: list[HttpFilter] = Field(default_factory=list)
    pluck: str = ""                 # dotted path within each kept element to the value
    agg: str = "min"               # min|max|sum|count|median|median_low|first
    depth: int = 5                 # median_low: median of the lowest ``depth`` values


class HttpField(BaseModel):
    """One output dataset column pulled from the fetched JSON response."""

    out_field: str                  # dataset column name (e.g. "price_min")
    path: str = ""                 # dotted/[i] path to the value ("" = response root)
    # When set, the value is this text with ``{path}`` placeholders filled from the object
    # (e.g. ``"{tier} {relicName}"`` -> ``"Axi A1"``) instead of a single ``path`` — one
    # column composed from several JSON fields. Takes precedence over ``path``/``array``.
    template: str = ""
    array: HttpArraySpec | None = None   # when set, ``path`` must resolve to a list
    type: str = "text"            # text | number  (number coerces / drops non-numeric)
    required: bool = False         # drop the whole row if this yields nothing


class HttpRequest(BaseModel):
    """The HTTP call made per source item. ``url`` templates ``{name}`` (raw source
    value) and ``{key}`` (``key_transform`` applied, percent-encoded when ``key_encode``).
    Header + query values may template the same placeholders."""

    method: str = "GET"
    url: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    query: dict[str, str] = Field(default_factory=dict)
    timeout: float = 30.0


class CatalogueSpec(BaseModel):
    """Teachable name -> key resolver (a generic re-expression of a slug catalogue).
    The producer fetches ``url`` once per sweep, reads the array at ``items_path``,
    builds ``{name_path -> key_path}``, and resolves each source name through it (exact
    -> slugify -> fuzzy at ``fuzzy``). Cached on disk for ``ttl_days``."""

    url: str                        # list endpoint returning all items
    items_path: str = "data"       # path to the array of catalogue entries
    name_path: str = ""            # path within an entry to its display name
    key_path: str = ""             # path within an entry to its key
    fuzzy: float = 0.9             # corrector cutoff for a fuzzy name match
    ttl_days: float = 7            # disk-cache freshness
    # Extra key framings to try after a direct slugify miss (before fuzzy): each hint is
    # appended to slugify(name), e.g. ``_set`` resolves "Soma Prime" -> ``soma_prime_set``.
    suffix_hints: list[str] = Field(default_factory=list)


class HttpSpec(BaseModel):
    """Everything the generic ``http`` producer needs to fetch + map one item -> one row.
    All of it is authored in the teach UI — zero API knowledge lives in Python."""

    request: HttpRequest = Field(default_factory=HttpRequest)
    key_transform: str = "slugify"  # none | lowercase | slugify | catalogue
    key_encode: bool = True         # percent-encode the substituted {key}
    catalogue: CatalogueSpec | None = None   # required when key_transform == "catalogue"
    root: str = ""                 # path applied to the response before every field path
    # When non-empty, LIST mode: fetch the URL once (no sources) and expand these nested array
    # paths — each relative to the prior level's element — into one row per leaf (ancestor
    # fields merge in, so a leaf can reference any level). e.g. ``[relics, rewards]`` on the
    # WFCD relic table -> one row per (relic, reward). Empty -> per-item mode (fetch per source).
    explode: list[str] = Field(default_factory=list)
    fields: list[HttpField] = Field(default_factory=list)


class ProducerDef(BaseModel):
    """A standalone *producer*: fired on a schedule/trigger, it fetches external data and
    pushes current records into its output ``dataset`` (so the data lives in a dataset like
    any other, joinable by a view). The pluggable kind is chosen by ``type`` (registry
    ._PRODUCER): ``http`` fetches a taught URL and maps JSON paths -> columns — per source
    item (warframe.market pricing), or, with ``HttpSpec.explode`` set, one fetch expanded into
    many rows (the WFCD relic table -> one row per (relic, reward)). Nothing here is
    game-specific — the URL, headers, and response mapping are all taught."""

    id: str
    type: str = "http"              # registered producer backend (registry._PRODUCER)
    mode: str = ""                  # free-text status label only (shown in the node UI)
    dataset: str = "prices"         # output dataset the records are written to
    throttle: float = 0.4           # seconds between requests during a sweep
    enabled: bool = True
    # Which items to fetch: the names found in these source datasets/views (e.g. wire an
    # inventory dataset in to price just owned gear). Wired in the graph UI as input edges.
    sources: list[str] = Field(default_factory=list)
    # Which source column names the item (fed to the URL template / catalogue resolver).
    source_field: str = "name"
    # The generic HTTP fetch+map spec (for ``type: http``). Authored in the UI.
    http: HttpSpec | None = None
    # How this producer's output rows are keyed/deduped in the dataset — its own
    # :class:`KeyDef` (e.g. relic rewards key on ``relic|item``). None -> ``name``. The
    # producer MUST feed :meth:`GameProfile.key_map_for` so the write key matches the read
    # key, else the ledger re-keys to NULL on open.
    key: KeyDef | None = None


class TriggerDef(BaseModel):
    """A generic *trigger*: it fires one or more targets on a condition, so work can run
    automatically instead of only on a manual button. Pure config — the runner that evaluates
    triggers lives in the collector / web app, never in the capture loop. Kinds:

    * ``interval``       — fire every ``interval_s`` seconds (periodic refresh).
    * ``on_change``      — fire when a dataset/subset in ``watch`` gains new/changed records,
      pricing only those changed keys (real-time, e.g. relic-reward items the moment they're read).
      A watched subset only fires when its computed/visible output actually changes.
    * ``on_any_change``  — same ``watch`` mechanics as ``on_change``, but fires whenever data
      enters a watched dataset/subset regardless of whether the (subset's) visible output changed.
    * ``on_app_start``   — fire once when the web app boots.
    * ``on_capture``     — fire when a capture session starts (live OR precapture).
    * ``on_live_start``  — fire when the server live-collection session starts (armed collection).
    * ``on_live_stop``   — fire when the server live-collection session stops.
    * ``on_readout``    — fire when a watched live readout (``readout_watch``) meets ``readout_op``
      ``readout_value`` — edge-triggered (fires once on entering the condition). See ReadoutDef.
    * ``manual``         — never auto-fires; just declares the wiring (the sweep button drives it).

    A trigger's ``targets`` are producer ids (sweep/refresh) or file-source ids (read). It can
    ALSO act on datasets: ``dataset_targets`` names datasets and ``dataset_action`` says what to
    do to them when it fires (clear, or clone/move their data into ``dataset_dest``).
    """

    id: str
    # interval | on_change | on_any_change | on_app_start | on_capture | on_live_start |
    # on_live_stop | on_readout | manual
    kind: str = "interval"
    interval_s: float = 300.0               # for kind="interval": seconds between fires
    watch: list[str] = Field(default_factory=list)    # for kind="on_change"/"on_any_change": datasets to watch
    # for kind="on_readout": the readout ids this trigger watches, and the condition its value
    # must meet to fire. readout_op ∈ gte|lte|gt|lt|eq|ne|crosses_up|crosses_down (crosses_* compare
    # against the previous reading). Edge-triggered — fires once when the condition becomes true.
    readout_watch: list[str] = Field(default_factory=list)
    readout_op: str = "gte"
    readout_value: float = 0.0
    targets: list[str] = Field(default_factory=list)  # producer / file-source / toast / sound ids this trigger fires
    enabled: bool = True
    # datasets this trigger acts on, and what it does to them. dataset_action is one of
    # "" (none) | clear | clone_batches | clone_resolved | move_batches | move_resolved.
    # clone/move copy each dataset_target's data into dataset_dest (batches = preserve batch
    # grouping; resolved = collapse current records into one new batch). move also clears source.
    dataset_targets: list[str] = Field(default_factory=list)
    dataset_action: str = ""
    dataset_dest: str = ""                  # destination dataset for clone/move actions


class ToastDef(BaseModel):
    """A *toast node*: raises an OS desktop notification when fired. A trigger names its
    ``id`` in ``targets`` (like a producer/file-source), so any trigger condition can pop a
    Windows toast — or the node's own test button fires it on demand. Pure config; the OS
    call is a :class:`oc.interfaces.Notifier` backend, never in the capture loop.

    Every field maps to a :class:`oc.interfaces.ToastSpec` the notifier renders. ``duration``
    is ``"short"`` or ``"long"``; ``app_name`` is the notification's source label (its
    AppUserModelID); ``icon`` is an optional app-logo image path; ``muted`` silences its sound.
    """

    id: str
    title: str = ""
    message: str = ""
    app_name: str = "data-occultist"
    duration: str = "short"                 # short | long
    icon: str = ""                          # optional app-logo image path
    attribution: str = ""                   # small attribution line under the body
    muted: bool = False                     # silence the toast sound
    enabled: bool = True


class SoundDef(BaseModel):
    """A *sound node*: plays an audio file **in the browser** when fired. A trigger names its
    ``id`` in ``targets`` (like a toast/producer), so any trigger condition can play a sound —
    or the node's own test button auditions it. Purely a client-side effect: the web UI's
    fire-detector plays it, so it never touches the collector loop or the server-side scheduler
    (which simply skips a sound id among a trigger's targets).

    ``file`` is a filename in the web ``static/sounds/`` folder (served at ``/sounds/<file>``);
    ``volume`` is 0..1 playback gain.
    """

    id: str
    file: str = ""                          # sound filename in the web sounds/ folder ("" = silent)
    volume: float = 1.0                     # playback volume (0..1)
    enabled: bool = True


class SourceMatch(BaseModel):
    """One line-filter clause for a ``log_lines`` source: keep a line only when its text
    relates to ``text`` per ``op``. Several clauses on a field all-must-hold (AND). No regex
    — friendly, declarative ops authored in the UI, mirroring :class:`Detect`'s match modes."""

    op: str = "contains"            # contains | starts_with | ends_with | equals
    text: str = ""
    case_sensitive: bool = False


class SourceField(BaseModel):
    """How ONE output column is pulled from a parsed source. No regex — declarative methods:

    * ``after``   — value is the text AFTER ``anchor``, up to ``stop`` (or end of line).
    * ``between`` — value is the text between ``anchor`` and ``end``.
    * ``column``  — split the line by ``delim`` and take token ``index`` (negative = from end).
    * ``whole``   — the whole (stripped) line.
    * ``path``    — for document formats (ini/json/xml/yaml): a dotted/slashed path to the value
      (e.g. ``Graphics.Resolution`` for ini ``[Graphics] Resolution=…``; ``a.b.c`` for json/yaml;
      ``root/child/@attr`` for xml).
    """

    id: str
    method: str = "after"           # after | between | column | whole | path
    anchor: str = ""                # after: prefix to cut past;  between: start delimiter
    end: str = ""                   # between: end delimiter
    stop: str = ""                  # after: stop delimiter ("" -> end of line)
    delim: str = " "                # column: token separator
    index: int = 0                  # column: which token (negative counts from the end)
    path: str = ""                  # path: dotted/slashed lookup for document formats
    type: str = "text"              # text | number  (number casts the extracted value)
    strip: bool = True              # trim surrounding whitespace from the extracted value
    required: bool = True           # the field MUST yield a valid value, else the whole row is
                                    # dropped (number: a clean number, decimals ok, nothing else;
                                    # text: non-empty — numbers count as text). Off = optional.


class FileSourceDef(BaseModel):
    """A *file-source producer*: locate a game file (log/config), parse it with a registered
    format backend, and push one current record per parsed row into its output ``dataset`` — so
    file data stores/dedups/joins/serves exactly like OCR data. The pluggable producer parallel to
    :class:`ProducerDef`. Zero game knowledge: ``filename``/``path`` are profile data the UI teaches.

    Reading is driven by: the node's own ``watch`` (manual button, or ``on_change`` file-watch with a
    trailing ``throttle_s`` so the latest state always wins) AND by trigger nodes that name this id as
    a target. Multiple sources on the same path share one internal read (see ``oc.source.reader``)."""

    id: str
    format: str = "log_lines"       # registered parser name (registry._PARSER)
    # WHERE the file is. ``path`` (explicit) wins; else the auto-finder scans generic OS roots for
    # ``filename`` (a glob, e.g. "EE.log" or "*.cfg") + any extra ``roots``. The glob is the only
    # game-specific bit and it is profile data, so Python stays game-agnostic.
    path: str = ""
    filename: str = ""
    roots: list[str] = Field(default_factory=list)
    dataset: str = ""               # output dataset the parsed rows are written to
    watch: str = "manual"           # manual | on_change (live file-watch)
    throttle_s: float = 1.0         # on_change: trailing quiet window before a read fires
    tail: bool = True               # log_lines: read only the last ``tail_lines`` lines (off = whole file)
    tail_lines: int = 200           # log_lines + tail: how many lines from the END of the file to read
    # log_lines: feed each row's source line number as its dataset POSITION (so rows order by file
    # position). With tail on, the absolute line number of each kept line is still its TRUE file
    # position (the reader reports where the tail window starts), not a 1-based offset into the tail.
    line_position: bool = False
    match: list[SourceMatch] = Field(default_factory=list)   # log_lines: which lines to keep
    fields: list[SourceField] = Field(default_factory=list)  # how each output column is extracted
    # How output rows are keyed/deduped in the dataset. None -> the dataset's own key (or ``name``).
    key: KeyDef | None = None
    enabled: bool = True


class JoinSource(BaseModel):
    """One input to a subset view: a source dataset (or upstream subset) PLUS how that source
    joins. Per-source so heterogeneous sources combine cleanly — each names its OWN join
    column, canonicalises its OWN value, collapses its OWN many->one, and declares whether it
    is required. The canonical join key is the canonicalised ``join_field`` value, so two
    sources keying different columns (``name`` vs ``item_name``) still match when their
    normalised values agree."""

    dataset: str = ""               # source dataset id (or an upstream subset id)
    # THIS source's column whose canonicalised value is the shared join key. ``""`` -> this
    # source does NOT join (its rows stack in standalone).
    join_field: str = "name"
    # how THIS source's join value is canonicalised before matching (bridges near-match keys)
    join_norm: JoinNorm = Field(default_factory=JoinNorm)
    # How THIS source's MANY observations per key collapse to one value when the view reads it —
    # the view's call, not the dataset's. ``latest|first|sum|mean|max|min``, or ``all`` to NOT
    # collapse (emit every observation as its own row). Moot for a subset input (it computes its own).
    aggregate: str = "latest"
    # Required => the join key MUST be present in this source for an output row (inner-style).
    # When NO source is required the join is a full outer (every key kept, gaps filled); marking
    # sources required narrows to keys present in all of them (the old ``inner`` = all required).
    required: bool = False


class SubsetDef(BaseModel):
    """A derived VIEW over one or more sources: join them on each source's own key, filter
    rows, add computed columns, sort, limit. Recomputed on demand, so it always reflects
    the latest stored records."""

    id: str
    # The sources to join, in order. Each carries its OWN join field / norm / aggregate /
    # required flag (see :class:`JoinSource`) — join is source-specific, not one global rule.
    # Earlier sources win column collisions.
    sources: list[JoinSource] = Field(default_factory=list)
    filters: list[FilterRule] = Field(default_factory=list)
    derived: list[DerivedColumn] = Field(default_factory=list)
    hidden_columns: list[str] = Field(default_factory=list)  # result columns to omit from the view
    sort: list[SortRule] = Field(default_factory=list)   # multi-column sort (primary first)
    sort_by: str = ""               # legacy single-column sort (folded into ``sort``)
    sort_desc: bool = False
    # Keep only rows from each source's most recent collection batch, applied FIRST (before
    # join/filter/derive/sort/limit) — so the view shows just the latest pass, not the
    # accumulated history.
    latest_batch: bool = False
    limit: int = 0                  # 0 = no limit
    config_collapsed: bool = False  # UI: the view's config block is folded away (persists per game)

    def inputs(self) -> list[str]:
        """Source dataset/subset ids to join, de-duplicated in order."""
        out: list[str] = []
        for src in self.sources:
            if src.dataset and src.dataset not in out:
                out.append(src.dataset)
        return out


class NodeLayout(BaseModel):
    """Where one graph node sits on the teach-UI canvas. Pure UI data that rides in
    the profile so node layout travels with the game (no browser localStorage).
    ``extra="allow"`` so any new UI-only field the front-end adds round-trips
    untouched — UI state must never 422 a save NOR be silently dropped."""

    model_config = ConfigDict(extra="allow")

    x: float = 0.0
    y: float = 0.0
    w: float | None = None
    h: float | None = None
    collapsed: bool = False


class GroupLayout(BaseModel):
    """A titled box drawn around a set of nodes on the teach-UI canvas. Pure UI
    arrangement, opaque to the backend (the collector ignores it). ``extra="allow"``
    so the front-end is the single source of truth for a group's look: every field it
    sends (colours, alignment, and anything added later) persists without a model
    edit. The fields below are declared only for defaults/documentation."""

    model_config = ConfigDict(extra="allow")

    id: str
    title: str = ""
    members: list[str] = Field(default_factory=list)
    outline: dict = Field(default_factory=dict)   # {color, style, width}, opaque to the backend
    bg: str = ""
    titleBg: str = ""        # title band background ("" = UI theme default)
    titleColor: str = ""     # title text colour ("" = UI theme default)
    titleAlign: str = "left" # title text alignment: left | center | right
    titlePos: str = "tl"     # legacy; front-end maps it onto titleAlign for old profiles


class GraphLayout(BaseModel):
    """Teach-UI graph layout for a profile: per-node positions/sizes/collapse, table
    column state, and which window nodes show their capture. Node *configuration*
    that belongs with the profile; the per-device viewport (zoom/pan) and minimap
    live in a separate gitignored local file instead. ``extra="allow"`` — this is all
    UI-authored state, so any new layout field round-trips instead of being dropped."""

    model_config = ConfigDict(extra="allow")

    nodes: dict[str, NodeLayout] = Field(default_factory=dict)
    tables: dict[str, dict] = Field(default_factory=dict)   # per-table widths/sort, opaque
    open_images: list[str] = Field(default_factory=list)    # window ids showing their capture
    groups: list[GroupLayout] = Field(default_factory=list)  # titled boxes around node sets
    # Floating panels (nodemap / activity / precapture): per-window {visible,x,y,w,h,…},
    # opaque to the backend. Persisted here (not the per-device local file) so panel
    # placement travels with the profile.
    float_windows: dict[str, dict] = Field(default_factory=dict)


class GlyphDef(BaseModel):
    """One taught reference glyph: a single character plus the saved crop of how that
    character looks in this game's font. Several samples of the same character are several
    ``GlyphDef`` entries (same ``char``, different ``image``) — more samples make the match
    sturdier. ``image`` is a bare filename under ``captures/<game>/glyphs/`` (mirrors item
    cutouts). Post-OCR glyph refinement (``FieldDef.glyph_check``) matches ambiguous glyphs
    against this atlas. This is game DATA authored in the UI — no glyph knowledge in Python."""

    char: str
    image: str
    # Disabled glyphs stay in the atlas (and the UI) but are skipped when building the matcher, so
    # a bad sample can be muted without deleting it. Default on (older profiles have no flag).
    enabled: bool = True


class GameProfile(BaseModel):
    """Everything needed to detect a game and read its windows."""

    name: str
    # Process executable names to match (case-insensitive), e.g. "Warframe.x64.exe".
    process_names: list[str] = Field(default_factory=list)
    window_title_hint: str | None = None
    fields: list[FieldDef] = Field(default_factory=list)
    windows: list[WindowDef] = Field(default_factory=list)
    # Window recognition PRIORITY order (ordered window ids, highest-priority first). When
    # non-empty the classifier tries these windows in this order and EARLY-RETURNS on the first
    # that matches — cheaper than scoring every window, and it lands on the most important live
    # screen (e.g. relic rewards) first. Ids not listed are tried afterwards in profile order.
    # Empty = the historical best-fit classify (score every window, pick the highest). Authored
    # in the teach UI over the live-toggled windows (see ``WindowDef.live``).
    window_priority: list[str] = Field(default_factory=list)
    datasets: list[DatasetDef] = Field(default_factory=list)
    subsets: list[SubsetDef] = Field(default_factory=list)
    producers: list[ProducerDef] = Field(default_factory=list)
    file_sources: list[FileSourceDef] = Field(default_factory=list)
    triggers: list[TriggerDef] = Field(default_factory=list)
    toasts: list[ToastDef] = Field(default_factory=list)
    sounds: list[SoundDef] = Field(default_factory=list)
    dictionaries: list[DictionaryDef] = Field(default_factory=list)
    # Taught glyph atlas for post-OCR glyph refinement (see GlyphDef / FieldDef.glyph_check).
    glyphs: list[GlyphDef] = Field(default_factory=list)
    # Teach-UI node layout (positions/sizes/collapse/tables/open-images). Pure UI
    # data; the collector ignores it. Lives here so layout travels with the profile.
    layout: GraphLayout = Field(default_factory=GraphLayout)

    def dictionary_terms(self) -> list[str]:
        """Every term from every ENABLED dictionary, de-duplicated (case-insensitive),
        order preserved — the pooled vocabulary OCR text reads snap to."""
        seen: set[str] = set()
        out: list[str] = []
        for d in self.dictionaries:
            if not d.enabled:
                continue
            for t in d.terms:
                t = t.strip()
                if t and t.lower() not in seen:
                    seen.add(t.lower())
                    out.append(t)
        return out

    def dictionary_terms_for(self, dict_id: str) -> list[str]:
        """Terms of ONE dictionary by id, de-duplicated (case-insensitive), order
        preserved — the vocabulary a field that pins ``dict_id`` snaps to. Empty id
        -> the pooled vocabulary (:meth:`dictionary_terms`). Unknown id -> empty."""
        if not dict_id:
            return self.dictionary_terms()
        d = next((x for x in self.dictionaries if x.id == dict_id), None)
        if d is None:
            return []
        seen: set[str] = set()
        out: list[str] = []
        for t in d.terms:
            t = t.strip()
            if t and t.lower() not in seen:
                seen.add(t.lower())
                out.append(t)
        return out

    def stat_node_ids(self) -> set[str]:
        """Every graph-node id that can emit an execution-timing sample — the live set the
        stats store is pruned against (:func:`oc.store.stats_store.prune_stale`). Mirrors the
        ``record_timing`` node ids exactly: ``win:<window>`` (incl. the HUD ``game`` window),
        ``ds:<dataset>`` (declared datasets AND every window's fed dataset), ``sub:<subset>``,
        ``producer:<producer>``, plus the constant ``precap``. A file whose node isn't here is
        an orphan; keep this complete so a live node is never mistaken for one."""
        ids: set[str] = {"precap"}
        ids.update(f"win:{w.id}" for w in self.windows)
        ids.update(f"ds:{d.id}" for d in self.datasets)
        ids.update(f"ds:{w.dataset_id}" for w in self.windows if w.dataset_id)
        ids.update(f"sub:{s.id}" for s in self.subsets)
        ids.update(f"producer:{p.id}" for p in self.producers)
        return ids

    def window(self, window_id: str) -> WindowDef | None:
        return next((w for w in self.windows if w.id == window_id), None)

    def subset_def(self, subset_id: str) -> SubsetDef | None:
        return next((s for s in self.subsets if s.id == subset_id), None)

    def file_source(self, source_id: str) -> FileSourceDef | None:
        return next((s for s in self.file_sources if s.id == source_id), None)

    def producer(self, producer_id: str) -> ProducerDef | None:
        return next((p for p in self.producers if p.id == producer_id), None)

    def dataset_def(self, dataset_id: str) -> DatasetDef | None:
        return next((d for d in self.datasets if d.id == dataset_id), None)

    def aggregate_for(self, dataset_id: str) -> str:
        """How the dataset collapses each key's many observations (``latest`` default)."""
        d = self.dataset_def(dataset_id)
        return (d.aggregate if d and d.aggregate else "latest")

    def batch_per_detection(self, dataset_id: str) -> bool:
        """True when the dataset starts a NEW batch on each fresh window detection
        (``batch_mode: detection``) rather than one batch per run."""
        d = self.dataset_def(dataset_id)
        return bool(d and d.batch_mode == "detection")

    def sync_mode_for(self, dataset_id: str) -> str:
        """``"mirror"`` when the dataset tracks removals (keys absent from the visible
        scroll slice are removed), else ``"accumulate"`` (add/update only)."""
        d = self.dataset_def(dataset_id)
        return "mirror" if (d and d.sync_mode == "mirror") else "accumulate"

    @staticmethod
    def _item_default_spec(it: ItemDef, w: WindowDef | None) -> KeySpec:
        """The spec keying an item template's records: its own ``key``, else the
        window's ``key``, else its FIRST field. Never an imaginary ``name`` — a
        template with no fields is unkeyable (empty spec) and its records drop."""
        if it.key is not None:
            return it.key.spec()
        if w is not None and w.key is not None:
            return w.key.spec()
        if it.fields:
            return KeySpec((it.fields[0].field,))
        return KeySpec(())

    def _window_default_spec(self, w: WindowDef) -> KeySpec:
        """The DEFAULT spec for records a window produces that carry no item tag:
        the window's ``key``, else its first region's field, else (single-template
        window) the item default, else an empty/unkeyable spec."""
        if w.key is not None:
            return w.key.spec()
        if w.regions:
            return KeySpec((w.regions[0].field,))
        if len(w.items) == 1:
            return self._item_default_spec(w.items[0], w)
        return KeySpec(())

    @staticmethod
    def _source_default_spec(s: FileSourceDef) -> KeySpec:
        """The spec keying a file source's rows: its own ``key``, else its FIRST output
        field, else empty/unkeyable. Mirrors the window/item defaults so a dataset fed by
        a file source resolves the SAME key whether opened to write (source key) or read
        (``key_map_for``) — otherwise the two fight and re-key the ledger to NULL on open."""
        if s.key is not None:
            return s.key.spec()
        if s.fields:
            return KeySpec((s.fields[0].id,))
        return KeySpec(())

    @staticmethod
    def _producer_default_spec(p: ProducerDef) -> KeySpec:
        """The spec keying a producer's output rows: its own ``key``, else ``name`` (the
        market-snapshot default — a warframe_market node keys by item name). Like the file
        source, a producer is a writer of the dataset, so its key must agree with
        ``key_map_for`` or the ledger re-keys to NULL when next opened to read."""
        return p.key.spec() if p.key is not None else KeySpec()

    def _key_defaults(self, dataset_id: str) -> list[KeySpec]:
        """Default specs (for records not tagged with an item template), one per PRODUCER
        feeding the dataset — each window's effective default (its ``key``, first region
        field, or single-item default), each file source's (its ``key`` or first field), and
        each producer's (its ``key`` or ``name``). Producers/sources are writers too, so their
        key must count or a producer-only dataset falls back to ``name`` and disagrees with
        what was written."""
        out: list[KeySpec] = []
        for w in self.windows:
            if w.dataset_id != dataset_id:
                continue
            out.append(self._window_default_spec(w))
        for s in self.file_sources:
            if s.dataset != dataset_id:
                continue
            out.append(self._source_default_spec(s))
        for p in self.producers:
            if p.dataset != dataset_id:
                continue
            out.append(self._producer_default_spec(p))
        return out

    def key_map_for(self, dataset_id: str) -> KeyMap:
        """How records of a dataset are keyed: each item template's own spec (records
        carry ``_item`` when a window has several templates), with the first window
        default as fallback. With nothing taught, keys on the FIRST field (never an
        imaginary ``name``); a producer with no fields yields unkeyable records."""
        # Dataset-level override wins: no-dedup (every read its own record), or a single-field
        # key chosen on the dataset node — both bypass the window/item keys.
        d = self.dataset_def(dataset_id)
        if d is not None and d.dedup is False:
            return KeyMap(KeySpec(), {}, dedup=False)
        if d is not None and d.key_fields:
            # Concat key: combine several fields, each canonicalised like a subset join.
            n = d.key_norm or JoinNorm()
            return KeyMap(KeySpec(fields=tuple(d.key_fields), case_sensitive=not n.case_insensitive,
                                  strip_punct=n.strip_punct, collapse_ws=n.collapse_ws,
                                  strip_words=tuple(n.strip_words)), {})
        if d is not None and d.key_field:
            return KeyMap(KeySpec(fields=(d.key_field,)), {})
        by_item: dict[str, KeySpec] = {}
        for w in self.windows:
            if w.dataset_id != dataset_id:
                continue
            for it in w.items:
                by_item.setdefault(it.id, self._item_default_spec(it, w))
        defaults = self._key_defaults(dataset_id)
        # No window feeds this dataset (e.g. data only on disk, or a price-only dataset):
        # nothing to derive a key from, so fall back to ``name`` as a last resort. When a
        # window DOES feed it, its first-field default is used (never an imaginary name).
        return KeyMap(defaults[0] if defaults else KeySpec(), by_item)

    def key_conflict(self, dataset_id: str) -> bool:
        """True when windows feeding the dataset disagree on the default key — their
        records would dedup inconsistently; the collector warns once per dataset."""
        return len(set(self._key_defaults(dataset_id))) > 1

    def fields_for(self, window: WindowDef) -> list[FieldDef]:
        """A window's schema: its own fields, or the game-level fields as fallback
        (keeps older profiles that defined fields at the game level working).
        Duplicate ids (stale merge leftovers in a saved profile) resolve to the
        FIRST definition; consumers index these by id, and without the dedup a
        later stale shadow silently wins over the def the user actually edits."""
        out, seen = [], set()
        for f in window.fields or self.fields:
            if f.id not in seen:
                seen.add(f.id)
                out.append(f)
        return out
