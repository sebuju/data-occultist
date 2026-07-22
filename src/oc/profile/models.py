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
    symbol = "symbol"      # value = label of the best-matching taught atlas cutout (colour-agnostic)


class Extract(str, Enum):
    """How to pull the value out of a region's raw OCR text. No regex in the UI —
    these are friendly, declarative strategies. ``separator`` applies to the
    *_before / *_after variants (e.g. a mod rank "7 / 10" -> number_before with "/").
    """

    whole = "whole"                  # use all the text
    number = "number"                # the first number anywhere
    number_before = "number_before"  # the first number left of the separator
    number_after = "number_after"    # the first number right of the separator
    text = "text"                    # all the text, stripped
    text_before = "text_before"      # the text left of the separator
    text_after = "text_after"        # the text right of the separator
    alphanum = "alphanum"                  # letters+digits only, symbols dropped, whitespace collapsed
    alphanum_before = "alphanum_before"    # alphanum left of the separator
    alphanum_after = "alphanum_after"      # alphanum right of the separator


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
    in_list = "in"             # value is one of arg's comma-separated members (case-insensitive)


class RuleThen(str, Enum):
    """What a matched :class:`FieldRule` does. ``drop`` early-returns (the whole record is
    dropped for that cell); ``blank`` early-returns with ``None`` — the value is FORWARDED
    downstream as an explicit null gap (a process emits ``key -> None``; a register's
    ``ignore_empty`` decides whether to record it), NOT a dropped record. Every other action
    rewrites the running value and the pipeline CONTINUES to the next rule."""

    drop = "drop"              # early-return: drop the record for this cell
    blank = "blank"            # early-return with value=None: forward a null gap (NOT a failure)
    set = "set"                # substitute ``value`` (authored, not OCR), continue
    lowercase = "lowercase"    # value.lower()
    uppercase = "uppercase"    # value.upper()
    fold = "fold"              # fold accents to plain ASCII (ö -> o)
    round = "round"            # round to nearest integer (number)
    floor = "floor"            # round down (number)
    ceil = "ceil"              # round up (number)
    decimal = "decimal"        # restore a decimal point OCR dropped from a "0.x" read ("05" -> "0.5")
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

    _ARG_WHENS = (RuleWhen.below, RuleWhen.above, RuleWhen.equal, RuleWhen.not_equal,
                  RuleWhen.contains, RuleWhen.in_list)

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


class PreprocessMode(str, Enum):
    none = "none"
    color = "color"          # keep only pixels near the taught text colour(s)
    threshold = "threshold"  # Otsu binarisation
    invert = "invert"        # light-on-dark -> dark-on-light


class Preprocess(BaseModel):
    """Teachable image cleanup applied to an OCR crop before reading.

    ``color`` masks glyphs matching the taught text colour(s) (sampled from the
    capture with the eyedropper) within ``tolerance``, yielding clean black-on-white
    that OCR reads far more reliably than stylised coloured game text. ``scale``
    upsamples small text. Used both per-window (WindowDef.preprocess) and per-readout
    (FieldDef.preprocess) — one primitive, two attach points.
    """

    mode: PreprocessMode = PreprocessMode.none
    colors: list[str] = Field(default_factory=list)  # hex, e.g. "#ffffff"
    tolerance: int = 60                                # colour distance (0..441)
    scale: float = 1.0                                 # upscale factor for small fonts
    min_frac: float = 0.0                              # denoise: drop near-colour blobs smaller
    #                                                    than this fraction of the largest (0 = off)
    det_unclip_ratio: float | None = None      # DB detector box dilation; lower splits two
    #                                            adjacent lines the detector fuses into one box
    det_box_thresh: float | None = None        # DB detector min box score; None = engine default


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
    # atlas (GameProfile.atlas, kind=glyph) and substitute a character only when a *different*
    # taught glyph out-scores the OCR's own. Fixes systematic single-glyph confusions the
    # dictionary cannot (e.g. "Q3" vs "G3"). Runs BEFORE the rule pipeline; a capture-time toggle.
    glyph_check: bool = False
    # LIVE-READOUT crop cleanup (opt-in) — a per-readout override of the window's preprocess,
    # applied to THIS readout's isolated crop before OCR. White/whitish HUD digits over an
    # animating coloured background OCR to confident garbage (a thin decimal in "4.00" gets
    # dropped -> "400"); a colour mask + upscale (the ``scale`` knob) cleans the crop so the
    # glyphs — and the decimal point — survive, and a blank box masks to truly empty (so the
    # confidence floor bites again). None -> fall back to the window's preprocess. A capture-time
    # knob like ``isolate`` / ``min_confidence``, NOT a value rule. Reuses Preprocess (one
    # primitive, two attach points: WindowDef.preprocess and here).
    preprocess: Preprocess | None = None
    # LIVE-READOUT phantom-precision gates (opt-in, per readout) — like ``preprocess`` /
    # ``min_confidence`` these act AROUND OCR, not on the value. ``corroborate``: re-read a masked
    # readout with a detection-gated second pass and suppress the value when the two disagree
    # (kills a mis-segmented recognition-only phantom digit). ``confirm``: an empty->present
    # readout must read present this many CONSECUTIVE ticks before it first surfaces (it clears on
    # the first absent tick) — kills a one-frame flicker; 1 = off. Both trade a little recall for
    # precision: the readout stays absent rather than show a phantom. Ignored for non-readout reads.
    corroborate: bool = False
    confirm: int = 1


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


class TestFeedDef(BaseModel):
    """How the testing inspector should synthesise a value for ONE feedable input — entirely
    optional scaffolding, absent from a profile that was never test-fed.

    Stored ON the thing it feeds (a :class:`ReadoutDef`'s ``test``, a :class:`DatasetDef`'s
    ``test_row``) rather than in a central keyed table, so renaming the readout/dataset carries
    the config with it instead of needing another repoint site.

    Numbers are held as STRINGS because they mirror the panel's text inputs verbatim (a blank
    means "unset", and a hand-authored ``min: 0`` coerces cleanly) — the generator parses them.
    """

    __test__ = False          # not a pytest test class despite the name (dunder: pydantic ignores it)

    # Off keeps the row's config but stops it being fed — send-all / the loop / its own send button
    # all skip it (a dataset column that's off is left out of the written row entirely). Same
    # `enabled` idiom every other def here uses, so a row can be muted without losing its tuning.
    enabled: bool = True
    # Everything but `mode`/`enabled` defaults to None rather than ""/False so `exclude_none` keeps
    # the unset knobs out of the file — a countdown row writes min/max/step and nothing else.
    mode: str = "fixed"           # fixed | random | countup | countdown
    # value type to roll for inputs with no FieldDef to read one off (dataset columns): text|number
    type: str | None = None
    value: str | None = None      # the `fixed` value
    pool: str | None = None       # `random` text pool, comma separated
    min: str | None = None        # `random` low bound / counter end
    max: str | None = None        # `random` high bound / counter end
    step: str | None = None       # counter increment
    integer: bool | None = None   # `random` number rolls whole, not fractional


class TestingDef(BaseModel):
    """Panel-level testing-inspector knobs (optional; absent until changed from the defaults)."""

    __test__ = False              # not a pytest test class despite the name

    loop_ms: int = 500            # repeat-send interval
    garble: bool = False          # inject the WRONG value type on some sends
    garble_pct: int = 20          # ...at this rate
    include_datasets: bool = False  # let send-all/loop also write dataset rows (persistent!)


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
    test: TestFeedDef | None = None      # optional testing-inspector feed config


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
    ``colors`` is the cheapest kind — the fraction of pixels in ``search`` near ANY of
    the taught hex colours (``width>0`` restricts it to the box perimeter, for a frame/
    outline). ``template`` and ``colors`` are *cheap* (no OCR), so they can gate the
    OCR-heavy ``text`` pass — see :meth:`is_cheap` and the live-mode worthiness gate.
    """

    id: str
    enabled: bool = True    # disabled detectors are skipped during detection
    search: Box
    template: str | None = None
    text: str | None = None
    # Cheap colour-presence kind (reuses the item-Tell colour primitives). ``colors`` is a
    # list of hex strings — a pixel counts if it's near ANY of them (union), so one landmark
    # can appear in several shades (gold/silver/bronze frame). ``tolerance`` is the shared BGR
    # distance that counts as "near"; ``width`` the perimeter band as a fraction of the box's
    # shorter side (0 = whole-fill colour). Old single-``color`` profiles migrate on load.
    colors: list[str] = Field(default_factory=list)
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
        return bool(self.template or self.colors) and not self.text


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

    ``file`` is the cutout PNG's bare filename under ``captures/<game>/scroll/`` (display-only
    — the thumb read happens once at capture time); ``rows`` is how many rows the viewport top
    has moved down from the top of the list at this scroll; ``pos`` is the thumb position (0..1)
    read from the crop by ``scroll_detail`` (filled server-side); ``conf`` its confidence.
    """

    file: str = ""
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
    # whether this window is active at all. Off = the collector never classifies, reads, or
    # saves it (and its readouts never surface) — the window node's disable toggle. Distinct
    # from ``live``, which only gates the graph UI's continuous re-read, not the collector.
    enabled: bool = True

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
    # Detection re-open grace (``batch_mode: detection`` only): how many OCR read-opportunities the
    # feeding window may go unread before the NEXT read counts as a fresh detection (new batch). 0
    # inherits the global ``tuning.confirm_frames`` (today's behaviour). Widen it so a brief OCR
    # dropout on a still-visible screen — an animation/glow forcing a settle-"moving" skip or a
    # classify miss — isn't misread as the screen closing and reopening (which would spuriously
    # re-batch and re-fire on_new_batch). Independent of the row-confirm threshold.
    reopen_grace: int = 0
    # Whether a run ever REMOVES keys to track the game emptying out:
    #   "accumulate" (default) — keys only ever add/update; a run never removes.
    #   "mirror" — keep the dataset == live game state. As the user scrolls, a key whose
    #              last-seen scroll position is in the CURRENT visible slice but is not read
    #              (over confirm_frames clean frames) is removed (soft). A partial/occluded
    #              frame contributes no evidence, so it can never cause a false removal.
    sync_mode: str = "accumulate"
    # Rolling batch-retention window: keep only the newest N batches, 0 (default) = unlimited.
    # Over the limit, the older batches are COMPACTED, not deleted: each key's old observations
    # fold into one base event under this dataset's own `aggregate`, and the surviving batches
    # replay on top of it. A key seen only long ago still exists and sum/mean/count still answer
    # over its whole history — only the per-observation detail of the folded batches is lost
    # (along with any revert down there, which folding makes permanent). Ignored when every
    # observation is already its own row (`dedup: false` / `aggregate: "all"`), where there is
    # no per-key 'many' side to collapse and folding could only delete.
    keep_batches: int = Field(default=0, ge=0)
    # Optional testing-inspector row template: {column: how to synthesise that cell}. Only the
    # columns the user configured appear; the rest fall back to the panel's defaults. None (not {})
    # by default so `exclude_none` keeps it out of a profile that was never test-fed.
    test_row: dict[str, TestFeedDef] | None = None


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
    string ``"{name} [{rank}]"`` or a market slug source ``"{name}"``. A math form
    (``={expr}`` or inline ``{=expr}``) may end with ``|round:N`` to fix its decimals."""

    name: str
    template: str = ""


class SortRule(BaseModel):
    """One sort key for a view. Multiple rules sort by the first as primary, the next as
    tie-breaker, and so on. Applied AFTER filter/derive and BEFORE limit."""

    field: str = ""
    desc: bool = False


class HttpFilter(BaseModel):
    """One predicate on a JSON element, ANDed with the others. ``path`` is a dotted lookup
    within the element (e.g. ``"type"`` or ``"user.status"``). Used BOTH to select elements of
    an array being reduced (:class:`HttpArraySpec`) and to keep/drop whole source rows
    (:attr:`HttpSpec.row_filter`) — one predicate primitive, two callers."""

    path: str
    op: str = "eq"                  # eq | ne | in | nin | gt | ge | lt | le | contains | ncontains
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
    # When set, the response is an HTML page, not bare JSON: the id of a
    # ``<script id="...">...</script>`` tag whose contents ARE the JSON to map (e.g. a
    # Next.js ``__NEXT_DATA__`` hydration blob) — for sites with no JSON API of their own.
    html_extract: str = ""


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
    # When non-empty, expand these nested array paths — each relative to the prior level's
    # element — into one row per leaf (ancestor fields merge in, so a leaf can reference any
    # level). e.g. ``[relics, rewards]`` on the WFCD relic table -> one row per (relic, reward).
    # With no ``sources`` wired, the URL is fetched ONCE (list mode). With ``sources`` wired,
    # the URL is fetched PER source item and EACH response is expanded (a builds-list-per-frame
    # feed: one fetch per frame, many build rows) — every row is tagged with the source item
    # under ``source_field``. Empty -> per-item mode (fetch per source, one row each).
    explode: list[str] = Field(default_factory=list)
    # Keep only SOURCE elements clearing every predicate (ANDed), evaluated BEFORE mapping — junk
    # in the feed never becomes a record. Tested against the raw element, so it may key off a field
    # the producer never emits as a column. The alternative (ingest everything, then paper over the
    # key collisions with a dataset ``aggregate``) picks a record by magnitude rather than identity.
    row_filter: list[HttpFilter] = Field(default_factory=list)
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
    # What to do when a fire arrives while this producer's sweep is still running (one sweep runs
    # at a time per game — the shared rate limit + price store are serialised):
    #   drop   — ignore the new fire (default; older behaviour).
    #   latest — remember only the NEWEST pending batch; run it once the current sweep finishes
    #            (coalesce — the display always catches up to the last state, no pile-up).
    #   queue  — FIFO: run every pending batch in order after the current one.
    queue_mode: str = "drop"
    # Which items to fetch: the names found in these source datasets/views (e.g. wire an
    # inventory dataset in to price just owned gear). Wired in the graph UI as input edges.
    sources: list[str] = Field(default_factory=list)
    # Which source column names the item (fed to the URL template / catalogue resolver).
    # When ``source_array`` is set, this is instead a field WITHIN each element of that
    # nested array (e.g. ``mod`` inside each ``slots[]`` entry), not a top-level column.
    source_field: str = "name"
    # When set, sources are read from a NESTED array column (e.g. a build row's ``slots``
    # list) rather than one scalar per row: every element of every row's ``source_array``
    # list contributes its ``source_field`` value, deduped across the whole source (a
    # build's mod loadout -> the distinct mod ids used across every fetched build).
    source_array: str = ""
    # Output column the fetched item's identity is written under (per-item, non-explode mode
    # only). "" -> ``source_field``. Needed when the source dataset hides the dataset's own key
    # field (e.g. a distinct-by view exposes only ``item`` while the priced dataset keys on
    # ``name``) — without this the write key silently mismatches the read key and every row is
    # dropped as unkeyable (see ``GameProfile.key_map_for``).
    identity_field: str = ""
    # The generic HTTP fetch+map spec (for ``type: http``). Authored in the UI.
    http: HttpSpec | None = None
    # How this producer's output rows are keyed/deduped in the dataset — its own
    # :class:`KeyDef` (e.g. relic rewards key on ``relic|item``). None -> ``name``. The
    # producer MUST feed :meth:`GameProfile.key_map_for` so the write key matches the read
    # key, else the ledger re-keys to NULL on open.
    key: KeyDef | None = None


class GateWhen(str, Enum):
    """How a :class:`GateCond` tests its source's current value. The op union that lets a gate
    express every predicate a trigger used to carry inline, plus the shape/text ops from the field
    pipeline. Three families (see :func:`oc.collect.triggers.TriggerRunner._cond_holds`):

    * shape/text (evaluated by :func:`oc.collect.fields._matches`): ``always`` / ``empty`` /
      ``no_digit`` / ``all_digit`` / ``has_digit`` / ``no_letter`` / ``all_letter`` / ``has_letter``
      / ``equal`` / ``not_equal`` / ``contains`` / ``in`` (comma-list membership) — ``arg`` is text;
    * numeric level: ``gte`` / ``lte`` / ``gt`` / ``lt`` / ``eq`` / ``ne`` — ``arg`` is a number;
    * numeric window / edge: ``between`` (``arg`` = ``"lo,hi"``), ``crosses_up`` / ``crosses_down``
      (compare against the previous reading), ``changed`` (source moved this tick).
    """

    always = "always"
    empty = "empty"
    no_digit = "no_digit"
    all_digit = "all_digit"
    has_digit = "has_digit"
    no_letter = "no_letter"
    all_letter = "all_letter"
    has_letter = "has_letter"
    equal = "equal"
    not_equal = "not_equal"
    contains = "contains"
    in_list = "in"
    gte = "gte"
    lte = "lte"
    gt = "gt"
    lt = "lt"
    eq = "eq"
    ne = "ne"
    between = "between"
    crosses_up = "crosses_up"
    crosses_down = "crosses_down"
    changed = "changed"


class GateCond(BaseModel):
    """One condition tested against a gate/router's source value. ``arg`` is the operand — a number
    for the numeric ops, ``"lo,hi"`` for ``between``, a comma-separated list for ``in``, text for the
    shape/text ops, unused for ``always`` / ``changed`` / the shape predicates."""

    when: GateWhen = GateWhen.always
    arg: str = ""


class GateDef(BaseModel):
    """A reusable boolean PREDICATE over one live value — the trigger's condition, lifted out of the
    trigger into its own node so the trigger carries only its event (see :class:`TriggerDef`). A
    trigger names gate ids in :attr:`TriggerDef.gates`; the trigger fires only when EVERY named gate
    passes (AND across gates), so a gate is an upstream allow/block on the fire.

    ``source`` is a ref to the live value the gate tests — ``readout:<id>`` or
    ``register:<id>#<key>`` (the same grammar registers/processes source from). ``conds`` are the
    conditions; ``logic`` (``or`` = any holds | ``and`` = all hold) combines them; ``negate`` flips
    the result (a block-list: pass when the conds do NOT hold), so a short list can exclude a few
    values rather than enumerate the rest. Evaluated server-side against the runner's live caches —
    game-dumb, no capture knowledge. Reusable: one gate can gate many triggers."""

    id: str
    source: str = ""                          # readout:<id> | register:<id>#<key>
    conds: list[GateCond] = Field(default_factory=list)
    logic: str = "or"                         # or (any holds) | and (all hold)
    negate: bool = False                      # flip the combined result (block-list)
    enabled: bool = True


class RouterBranch(BaseModel):
    """One branch of a :class:`RouterDef`: when its ``conds`` hold (combined by ``logic``), the
    router forwards the fire to ``targets``. A branch with no ``conds`` matches ALWAYS (the ``else``)
    — place it last. Empty ``targets`` = drop (match, forward nothing)."""

    conds: list[GateCond] = Field(default_factory=list)
    logic: str = "or"
    targets: list[str] = Field(default_factory=list)


class RouterDef(BaseModel):
    """A downstream fan-out node: a trigger fires it (named in ``targets``), and the router forwards
    the fire to a branch's targets chosen by a live value — ``octavia -> sound_A``, ``volt ->
    sound_B``, ``else -> drop``. ``source`` is the tested value (same grammar as :class:`GateDef`);
    ``branches`` are tried in order, FIRST match wins. Where a gate answers "fire at all?", a router
    answers "given a fire, which targets?" — so a router's targets may be any target kind (producer /
    file-source / toast / sound / action). Sound targets are still client-played (the fire cue names
    the chosen sound ids); the rest fire server-side exactly like a trigger's own targets."""

    id: str
    source: str = ""
    branches: list[RouterBranch] = Field(default_factory=list)
    enabled: bool = True


class TriggerDef(BaseModel):
    """A generic *trigger*: it fires one or more targets on a condition, so work can run
    automatically instead of only on a manual button. Pure config — the runner that evaluates
    triggers lives in the collector / web app, never in the capture loop. Kinds:

    * ``interval``       — fire every ``interval_s`` seconds; reseeds its clock to "now" on
      restart/config edit (a fresh full wait each time).
    * ``true_interval``  — fire every ``interval_s`` seconds of REAL elapsed time, anchored to the
      PERSISTED last-fired timestamp, so the cadence continues across restarts and config edits
      (an overdue trigger fires immediately on start).
    * ``on_change``      — fire when a dataset/subset in ``watch`` gains new/changed records,
      pricing only those changed keys (real-time, e.g. relic-reward items the moment they're read).
      A watched subset only fires when its computed/visible output actually changes.
    * ``on_any_change``  — same ``watch`` mechanics as ``on_change``, but fires whenever data
      enters a watched dataset/subset regardless of whether the (subset's) visible output changed.
    * ``on_new_batch``   — fire once per NEW batch of a watched dataset, even when the row values
      are identical to the previous batch (a re-pushed screen is a fresh batch, so it re-fires
      where ``on_change`` — value-gated — would not). ``watch`` may be a dataset or a subset over
      it (a subset watch fires on its underlying dataset's batch).
    * ``on_app_start``   — fire once when the web app boots.
    * ``on_capture``     — fire when a capture session starts (live OR precapture).
    * ``on_live_start``  — fire when the server live-collection session starts (armed collection).
    * ``on_live_stop``   — fire when the server live-collection session stops.
    * ``on_readout``    — pulse when a watched live readout (``readout_watch``) is read this tick.
      The VALUE condition is not on the trigger any more — attach a :class:`GateDef` over that
      readout (``source: readout:<id>``). Fire = pulse AND every gate holds. See ReadoutDef.
    * ``on_register``   — pulse when a watched register's (``register_watch``) exposed key moves this
      tick. The per-key conditions moved to gates (``source: register:<id>#<key>``); ``crosses_*`` /
      ``changed`` / ``between`` and the level ops all live on the gate now. A register is fed every
      tick on the EXPOSED value (aggregate fold, or ring tail). See :class:`RegisterDef`.
    * ``on_ready``       — fire once when a watched PRODUCER's sweep FINISHES. ``watch`` holds the
      producer id(s); the trigger fires from the sweep's reap (its output is already written), so it
      is deterministic — the fire is CAUSED by completion and can never precede the data. Fires even
      when the sweep wrote nothing (the fetch still finished, e.g. all rewards unpriceable). No
      timers, no polling. Use for "notify when the fetch/pricing has finished" — the producer does
      the work and knows when it's done; a stateless subset never is.
    * ``on_input``       — pulse on a keyboard/mouse event (``input_event``) matching ``input_button``
      + ``input_mods`` (a held chord, e.g. ctrl+shift+w or shift+mouse:left). LIVE ONLY — the input
      hook runs only while a live session is collecting. Mouse events may be bound to a window
      (``input_window``) and optionally a client-relative rect within it (``input_rect``); a keyboard
      event may also be window-bound (fires only while that window is the recognized one). No window
      bound = fires regardless of what's on screen. See :class:`~oc.interfaces.InputSource`.
    * ``manual``         — never auto-fires; just declares the wiring (the sweep button drives it).

    A trigger's ``targets`` are producer ids (sweep/refresh), file-source ids (read), toast/sound
    ids (notify/play), ACTION ids (clear/clone/move a dataset — see :class:`ActionDef`), or ROUTER
    ids (fan-out by a live value — see :class:`RouterDef`). Each is its own node fired via
    ``targets``, exactly like a toast or sound.

    The trigger carries only its EVENT (``kind`` + the watch lists that declare what it watches). The
    VALUE predicate — "fire only when this reading meets this condition" — lives in :attr:`gates`
    (see :class:`GateDef`): the trigger fires when its event pulses this tick AND every gate holds.
    """

    id: str
    # interval | true_interval | on_change | on_any_change | on_new_batch | on_app_start |
    # on_capture | on_live_start | on_live_stop | on_readout | on_register | on_ready | on_input |
    # manual
    kind: str = "interval"
    interval_s: float = 300.0               # for kind="interval"/"true_interval": seconds between fires
    watch: list[str] = Field(default_factory=list)    # for kind="on_change"/"on_any_change"/"on_new_batch": datasets to watch
    # for kind="on_readout": the readout ids this trigger watches — a read of any of them pulses the
    # trigger this tick. The VALUE condition is a gate over the readout, not a field here.
    readout_watch: list[str] = Field(default_factory=list)
    # for kind="on_register": the register ids this trigger watches (chips + edges) — an exposed key
    # moving in any of them pulses the trigger this tick. The per-key conditions are gates now.
    register_watch: list[str] = Field(default_factory=list)
    # gate ids (see GateDef) — the trigger's value predicate. Fires only when EVERY named gate holds
    # (AND across gates). Empty = no predicate: the event alone fires it.
    gates: list[str] = Field(default_factory=list)
    targets: list[str] = Field(default_factory=list)  # producer / file-source / toast / sound / action / router ids this trigger fires
    enabled: bool = True
    # minimum time (milliseconds) between actual fires — a global rate limit across ALL kinds.
    # None = no throttle. A fire suppressed inside the window is recorded in the trigger's
    # (non-persisted) history as "throttled". Manual "fire now" bypasses it (explicit user action).
    # LEADING-edge: fires on the FIRST event, suppresses the rest inside the window.
    throttle_ms: float | None = None
    # TRAILING-edge debounce (the mirror of throttle_ms): after a justified auto-fire, wait this
    # many milliseconds for the watched output to go quiet; each further justified fire inside the
    # window re-arms it, so a burst (a price sweep dripping rows, several sequential sweeps as OCR
    # settles) coalesces into ONE fire carrying the FINAL state. None/0 = fire immediately (today's
    # behaviour). Manual "fire now" bypasses it. Complements throttle_ms — throttle caps rate from
    # the leading edge; settle waits for the trailing edge.
    settle_ms: float | None = None
    # hard cap (milliseconds) from the first armed fire of a settle window: if churn never quiets
    # (a fetch that's slow or never finishes), fire anyway once this elapses. None = no cap (fire
    # only on quiet). Meaningless without settle_ms. For kind="on_ready" this is the max-wait
    # fallback deadline (fire a partial once the view has been incomplete this long).
    settle_max_ms: float | None = None
    # legacy/unused: an earlier on_ready design watched a subset and gated on this column. on_ready
    # now watches a PRODUCER and fires on its sweep completion, so this is ignored. Kept so old
    # profiles that set it still load.
    ready_field: str = ""

    # ---- kind="on_input" -----------------------------------------------------------------
    # which stream transition pulses the trigger: "down" (key/button pressed, auto-repeat
    # suppressed) | "up" (released) | "press" (a down->up pair completed) | "double" (two
    # presses of the same button within input_double_ms).
    input_event: str = "down"
    # the watched button: "key:<name>" (e.g. "key:w") or "mouse:<left|right|middle|x1|x2>".
    # "" or "any" matches any button of either device.
    input_button: str = ""
    # modifiers that must ALL be held at the moment input_button transitions, e.g.
    # ["ctrl", "shift"] for ctrl+shift+w, or ["shift"] for shift+mouse:left. Values are bare
    # modifier names (ctrl/shift/alt/win) or another "mouse:<button>" held at the same time.
    input_mods: list[str] = Field(default_factory=list)
    # client-relative fraction rect [x, y, w, h] (0..1) within input_window's client area — a
    # mouse event only pulses when the pointer is inside it. Empty = no rect gate (whole
    # window, or unbound). Requires input_window (checked by the profile checker).
    input_rect: list[float] = Field(default_factory=list)
    # a window id: the trigger pulses only while that window is the currently recognized one
    # (mirrors a readout's window scoping). "" = no window gate (fires regardless of screen).
    input_window: str = ""
    # for input_event="double": max milliseconds between the two presses to count as a double.
    input_double_ms: float = 350.0


class ToastTextDef(BaseModel):
    """One styled text block on a toast node (a Windows ``AdaptiveText`` line). ``content``
    supports ``{{token}}`` interpolation like the legacy title/message. ``style`` is a font
    preset (``""`` = default, else ``caption|body|base|subtitle|title|subheader|header`` +
    ``*subtle``/``*numeral`` variants); ``align`` is ``""|left|center|right``; ``max_lines``
    (0 = unset) truncates a long block instead of letting it grow."""

    content: str = ""
    style: str = ""
    align: str = ""
    max_lines: int = 0


class ToastBorderSide(BaseModel):
    """One border spec (a box's whole outline, or one overridden side). ``w`` 0 = no border."""

    w: int = 0
    color: str = "#ffffff"
    style: str = "solid"    # solid | dashed | dotted


class ToastAnchor(BaseModel):
    """Positions a text element relative to a reference: ``to`` ("" = the image, else a sibling
    element index as a string) resolves a reference box; the element's own ``corner`` 9-point sits on
    the target's ``target`` 9-point, then the element's ``x``/``y`` add a pixel offset. Nine-point
    codes are two chars: vertical ``t``/``m``/``b`` + horizontal ``l``/``c``/``r`` (e.g. ``tl``)."""

    to: str = ""            # "" = image canvas; else sibling text-element index (as a string)
    corner: str = "tl"      # which point of THIS element lands on the target point
    target: str = "tl"      # which point of the reference box the element anchors to


class ToastImageTextDef(BaseModel):
    """One positioned text element drawn onto a generated toast image. ``content`` supports
    ``{{token}}`` interpolation. The element is a box of ``width``×``height`` px (0 = auto to the
    text). Its position comes from ``anchor`` + the ``x``/``y`` offset. ``align`` is a 9-point code
    (vertical ``t``/``m``/``b`` + horizontal ``l``/``c``/``r``) placing the text WITHIN the box."""

    content: str = ""
    x: int = 12
    y: int = 12
    size: int = 20
    color: str = "#ffffff"
    align: str = "tl"       # 9-point text placement within the box (vertical+horizontal)
    width: int = 0          # box width in px the text is fit to (0 = auto to the text)
    height: int = 0         # box height in px (0 = auto to the text)
    bg_color: str = ""      # box fill colour (hex); drawn when set and width & height > 0
    wrap: bool = True       # word-wrap within the box width: True = break onto more lines; False = one line
    overflow: bool = False  # allow text to spill past the box; False = clip to it and end with … (overflow: hidden + text-overflow: ellipsis)
    # when the resolved content is empty (a missing/blank {{token}}), drop this element AND collapse
    # the gap it left: it renders nothing and occupies zero size, so any element anchored to it (a
    # chain) shifts up to fill the space instead of leaving a hole.
    disable_if_empty: bool = False
    # when the element this one is ANCHORED to is itself disabled (off), drop this element too and
    # collapse it the same way — cascades along the anchor chain, so a hidden anchor takes every
    # dependant with it. No effect when anchored to the image canvas (which is never disabled).
    disable_if_anchor_disabled: bool = False
    # optional dimension matching: copy another element's resolved width/height. "" = own size, "image"
    # = the image canvas size, else a sibling element index (as a string), mirroring `anchor.to`. A set
    # match WINS over the element's
    # own width/height, scaled by match_w_pct/match_h_pct (percent, 100 = the sibling's full size, 50 =
    # half). The percent is ignored when no sibling is matched on that axis.
    match_w: str = ""
    match_h: str = ""
    match_w_pct: int = 100
    match_h_pct: int = 100
    # typography
    font_family: str = ""   # "" = the platform default face (Segoe UI); else a known family name
    bold: bool = False
    italic: bool = False
    underline: bool = False
    # borders: a base outline + optional per-side overrides keyed "t"/"r"/"b"/"l"
    border: ToastBorderSide = Field(default_factory=ToastBorderSide)
    border_sides: dict[str, ToastBorderSide] = Field(default_factory=dict)
    # placement relative to the image / a sibling element
    anchor: ToastAnchor = Field(default_factory=ToastAnchor)
    # paint/stacking order: elements are drawn low z_index first, so a higher z_index sits ON TOP of a
    # lower one where they overlap. Ties keep list order. Independent of the anchor chain.
    z_index: int = 0

    @field_validator("align", mode="before")
    @classmethod
    def _migrate_align(cls, v):
        # legacy horizontal-only values (top vertical): left/center/right -> tl/tc/tr
        return {"left": "tl", "center": "tc", "right": "tr"}.get(v, v) or "tl"


class ToastImageDef(BaseModel):
    """A generated toast image, drawn server-side with PIL: a solid or 2-colour gradient background
    with positioned text lines painted over it. ``placement`` picks where it lands — ``hero`` (the
    toast's top banner), ``inline`` (in the body), or ``none`` (temporarily off, not drawn).
    ``angle`` is the gradient direction in degrees (0 = left→right, 90 = top→bottom). ``unit`` picks
    how every element's x/y/width/height read: ``px`` (absolute) or ``pct`` (% of image w/h)."""

    placement: str = "inline"       # hero | inline | none
    width: int = 364
    height: int = 180
    bg_type: str = "solid"          # solid | gradient | transparent (toast surface shows through)
    color1: str = "#0a3d62"
    color2: str = "#061826"
    angle: int = 90
    unit: str = "px"                # px | pct — how element coords are interpreted
    texts: list[ToastImageTextDef] = Field(default_factory=list)


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
    # ordered rich-text blocks (each styled). When non-empty these REPLACE title/message as the
    # toast body; title/message are kept only as the legacy seed (the UI migrates them into texts).
    texts: list[ToastTextDef] = Field(default_factory=list)
    # generated images drawn on the fly at fire time (message text painted onto a banner / body
    # image). Each carries its own `placement` (hero | inline | none); several may share a toast.
    images: list[ToastImageDef] = Field(default_factory=list)
    app_name: str = "data-occultist"
    duration: str = "short"                 # short | long
    icon: str = ""                          # optional app-logo image path
    show_icon: bool = True                  # draw the app-logo icon (off = no logo on the toast)
    attribution: str = ""                   # small attribution line under the body
    muted: bool = False                     # silence the toast sound
    enabled: bool = True
    # Wired data sources whose live values the text can interpolate as {{tokens}} — prefixed refs
    # ("readout:<id>" | "dataset:<id>" | "subset:<id>"), one per connected node. Only these drive
    # the node's token-suggestion chips; the toast still resolves any token typed by hand.
    sources: list[str] = Field(default_factory=list)
    # Replace-by-tag identity. When set (supports {{tokens}}), the toast posts under a stable
    # Windows tag derived from this key, so a later fire with the SAME key REPLACES the visible
    # notification in place instead of stacking a new one. Empty = each fire is its own toast.
    replace_key: str = ""
    # Accumulating body: each fire APPENDS its rendered text blocks to a persisted, deduped,
    # capped tally (keyed by replace_key) and the toast shows the whole tally — so a relic toast
    # grows with each screen seen rather than wiping to the latest. Needs replace_key set (the
    # tally is keyed by it) to be visible as one updating notification. Cleared on live-session
    # start. ``accumulate_cap`` bounds retained entries (0 = no accumulation → plain replace).
    accumulate: bool = False
    accumulate_cap: int = 10

    @model_validator(mode="before")
    @classmethod
    def _migrate_images(cls, data):
        """Fold the legacy fixed ``hero``/``inline`` image objects into the ``images`` list (each an
        image with a ``placement``). A disabled legacy image becomes ``placement: none``. Runs only
        when ``images`` isn't already present, so a new-style profile passes straight through."""
        if isinstance(data, dict) and "images" not in data:
            imgs = []
            for which in ("hero", "inline"):
                im = data.get(which)
                if isinstance(im, dict):
                    im = dict(im)
                    enabled = im.pop("enabled", False)
                    im["placement"] = which if enabled else "none"
                    imgs.append(im)
            if imgs:
                data["images"] = imgs
            data.pop("hero", None)
            data.pop("inline", None)
        return data


class SynthPoint(BaseModel):
    """One node on a synth cue's pitch-over-time envelope. Both are 0..1 fractions
    (resolution-independent, like every box): ``t`` = position along the cue's length,
    ``p`` = pitch (0 = lowest, 1 = highest — the forge maps it to a note)."""

    t: float = Field(ge=0.0, le=1.0)
    p: float = Field(ge=0.0, le=1.0)


class SynthDef(BaseModel):
    """A *generated* sound cue: instead of a file, the sound node synthesises the cue in the
    browser (Web Audio) from this tiny param set. Authored in the node's inline "forge". The
    pitch sweeps through ``points`` over ``length_ms``; ``wave`` picks the oscillator; the rest
    shape the amp envelope, the timbre (vibrato, bit-crush, lowpass filter, noise/sub mix) and
    the arrangement (glide between points, echo, transpose, repeat). Rendered once to a buffer
    and cached — never re-synthesised per play. ``volume`` is NOT here: it stays on
    :class:`SoundDef` as a playback-time gain so changing it doesn't invalidate the cached render.

    Every knob defaults to the NEUTRAL value (filter bypassed, full glide, one repeat), so a cue
    authored before a knob existed keeps sounding exactly as it did. The front-end mirrors these
    in ``static/js/defaults.js`` (``SYNTH_DEFAULTS``) — keep the two in step."""

    wave: str = "square"                    # square | sine | sawtooth | triangle
    points: list[SynthPoint] = []           # pitch-over-time envelope (empty = silent)
    length_ms: int = Field(default=220, ge=10, le=5000)
    attack: int = Field(default=4, ge=0, le=100)     # amp-envelope shape (forge knobs, 0..100)
    decay: int = Field(default=55, ge=0, le=100)
    release: int = Field(default=0, ge=0, le=100)    # tail fade past the decay (extends the render)
    vibrato: int = Field(default=0, ge=0, le=100)
    crush: int = Field(default=0, ge=0, le=100)
    cutoff: int = Field(default=100, ge=0, le=100)   # lowpass (100 = bypassed)
    reso: int = Field(default=0, ge=0, le=100)       # that filter's resonance (Q)
    noise: int = Field(default=0, ge=0, le=100)      # white noise blended in pre-filter
    sub: int = Field(default=0, ge=0, le=100)        # octave-down oscillator blended in pre-filter
    glide: int = Field(default=100, ge=0, le=100)    # 0 = stepped jumps between points, 100 = full ramp
    echo: int = Field(default=0, ge=0, le=100)       # feedback-delay amount (0 = dry)
    echo_ms: int = Field(default=90, ge=20, le=400)  # that delay's time
    transpose: int = Field(default=0, ge=-24, le=24)  # semitone shift of the whole envelope
    repeat: int = Field(default=1, ge=1, le=8)       # retrigger the envelope N times inside length_ms


class SoundDef(BaseModel):
    """A *sound node*: plays a cue **in the browser** when fired. A trigger names its ``id`` in
    ``targets`` (like a toast/producer), so any trigger condition can play a sound — or the
    node's own test button auditions it. Purely a client-side effect: the web UI's fire-detector
    plays it, so it never touches the collector loop or the server-side scheduler (which simply
    skips a sound id among a trigger's targets).

    The cue is EITHER a file or a generated synth: ``file`` is a filename in the web
    ``static/sounds/`` folder (served at ``/sounds/<file>``), OR ``synth`` holds a generated
    cue (and ``file`` stays ``""``). ``volume`` is 0..1 playback gain for both.
    """

    id: str
    file: str = ""                          # sound filename in the web sounds/ folder ("" = silent)
    synth: SynthDef | None = None           # a generated cue (set INSTEAD of file) — see SynthDef
    volume: float = 1.0                     # playback volume (0..1)
    enabled: bool = True


class ActionDef(BaseModel):
    """An *action node*: does something to everything wired into ``sources`` when fired — a dataset
    operation (clear, or clone/move data into ``dest``), a browser sound cue, and/or a downstream
    action node. A trigger names its ``id`` in ``targets`` (like a toast/sound/producer), so any
    trigger condition can act on datasets — the shared :func:`oc.store.dataset_ops.fire_dataset_target`
    funnel does the work, both from the collector dispatch and the web fire-now route.

    ``action`` ∈ "" (none) | clear | clone_batches | clone_resolved | move_batches | move_resolved.

    ``sources`` are prefixed refs — ``"dataset:<id>"`` or ``"register:<id>"`` (the ToastDef.sources
    shape) — so one action can act on datasets AND registers. For a DATASET source: clear wipes it;
    clone/move copy it into ``dest`` (batches = preserve batch grouping; resolved = collapse current
    records into one new batch; move also clears the source). For a REGISTER source: clear wipes the
    targeted keys; clone/move write the targeted keys' LATEST held values into ``dest`` as
    ``{name:<readout id>, value:<latest>}`` rows (move then clears those keys) — a register has no
    batch grouping, so clone_batches / clone_resolved behave identically for it.

    ``slots`` narrows a register source to a subset of its wired-readout keys — ``{register id ->
    [readout key, ...]}``. An absent / empty list means ALL of that register's keys.

    ``sources`` also holds two NON-dataset kinds, which the dataset-op fields (``action`` / ``slots``
    / ``dest``) simply don't apply to:

    * ``"sound:<id>"`` — a sound node cued to the browser when this node runs, ``repeat`` times
      ``repeat_ms`` apart. The cue rides the same :func:`oc.store.fire_events.publish_fire` bus a
      trigger's own sound targets use, so the browser only ever plays a cue that JUST arrived.
    * ``"action:<id>"`` — another action node, fired downstream once this one has run (chaining).
      The chained node's own ``delay_ms`` applies to its fire, so chain delays accumulate naturally.

    ``delay_ms`` waits that long after being fired before doing ANY of the above. All scheduling is
    server-side on purpose: a backgrounded browser tab throttles its timers (~1s clamp) but not its
    SSE delivery, so client-side spacing would silently stretch whenever the game has focus.
    """

    id: str
    action: str = ""                        # "" | clear | clone_batches | clone_resolved | move_batches | move_resolved
    # prefixed refs "dataset:<id>" / "register:<id>" / "sound:<id>" / "action:<id>" — everything this
    # node operates on when fired (dataset ops, browser sound cues, and chained action nodes)
    sources: list[str] = Field(default_factory=list)
    # register id -> targeted readout keys (absent/empty = all of that register's keys)
    slots: dict[str, list[str]] = Field(default_factory=dict)
    dest: str = ""                          # destination dataset for clone/move actions
    delay_ms: int = Field(default=0, ge=0, le=600_000)      # wait before running (0 = run now)
    repeat: int = Field(default=1, ge=1, le=99)             # how many times to cue the sound sources
    repeat_ms: int = Field(default=300, ge=10, le=10_000)   # gap between those cues
    enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def _migrate_sources(cls, data):
        """Fold the legacy dataset-only ``datasets: [<id>, ...]`` list into the prefixed
        ``sources: ["dataset:<id>", ...]`` shape. Runs only when ``sources`` isn't already present,
        so a new-style profile passes straight through (no shipped migration — see field-rule
        pipeline precedent)."""
        if isinstance(data, dict) and "sources" not in data and "datasets" in data:
            data["sources"] = [f"dataset:{d}" for d in (data.get("datasets") or [])]
        if isinstance(data, dict):
            data.pop("datasets", None)
        return data


class RegisterDef(BaseModel):
    """A *register node*: an in-memory keyed map that HOLDS the latest live value of the
    readouts wired into it — fast O(1) lookup, no batching / one-to-many features (the
    lightweight counterpart to a :class:`DatasetDef`). By default the map is NEVER persisted;
    setting ``persist`` also mirrors it into a dataset (see below) so it becomes joinable.

    ``sources`` are prefixed readout refs ("readout:<id>"), one per connected readout node —
    the same token shape :class:`ToastDef` uses. Each collector tick, every source readout's
    current value overwrites its entry in the map (key = readout id), keeping first/last-seen.
    The map lives only in the running :class:`oc.collect.live.LiveSession` (server memory):
    it survives page reloads and collector start/stop, but is dropped when the session/server
    ends or the node's *clear* button is hit. Only this definition (id + wired sources +
    ``persist``) is saved to the profile YAML; the held values themselves are never written to
    disk UNLESS ``persist`` names a dataset — a register alone can't be joined/excluded by a
    subset (subsets only read datasets), so that's the one way a register's state reaches one.
    """

    id: str
    # Wired readout sources whose live value this register holds — prefixed refs ("readout:<id>"),
    # one per connected readout node (mirrors ToastDef.sources).
    sources: list[str] = Field(default_factory=list)
    title: str = ""                         # optional display label (unused by the collector)
    enabled: bool = True
    # How many most-recent values to hold per key (a rolling ring of depth N). Pulls, the persist
    # flush, and the membank always expose the LATEST (ring tail); the extra depth is retained
    # history. Lowering N truncates to the newest N on the next tick; raising it lets the ring regrow.
    capacity: int = Field(default=1, ge=1)
    # How a key's ring of recent values collapses to the ONE value the register EXPOSES (persist
    # flush, register_latest, the membank's summary line). "" / "latest" -> expose the ring tail
    # (latest) unchanged. A numeric fold over the ring — min | max | sum | avg | median | midrange |
    # wma | range | delta | stdev | mad. A DENOISER — the point of this roster, algorithms that
    # filter OCR noise out of the exposed value: stable (newest value within k*MAD of the ring
    # median — skips lone misread spikes) | quality (the restored per-readout consensus gate: newest
    # expected-TYPE read, held while >=K of the last M reads matched the field's type — a fast-
    # changing number never lags, only a burst of wrong-type reads suppresses it) | cluster (newest
    # member of the ring's largest value-within-tolerance bucket — kills a non-repeating misread
    # even when it's the latest read) | trimmed (mean with the N highest/lowest dropped) | winsor
    # (mean with the N highest/lowest clamped in, not dropped) | ema (exponential moving average) |
    # track (the TIME-aware one: fits the ring's own trend line against the per-sample clock and
    # exposes the newest read that fits it — a countdown read as 4 and then 1 a quarter-second later
    # is rejected because the elapsed time couldn't produce it, which `quality` misses since a bare
    # 1 is a perfectly valid NUMBER. Needs >=4 numeric samples; capacity 6-8+ fits robustly).
    # A count over the ring — distinct | changes | nonblank. Plus first (the ring HEAD, oldest
    # retained — unrounded, works on any ring). "common" is the one NON-numeric fold: expose the
    # most frequent ring member as text (ties -> newest tied) — the categorical-noise denoiser.
    # Only meaningful when capacity > 1 (the UI only offers it then); a numeric fold over a
    # non-numeric ring, or one with no numeric members, falls back to the tail. Raw ring always kept.
    aggregate: str = ""
    # Generic per-mode tuning knob for `aggregate` — 0 (default) means "use the mode's own
    # default". Meaning depends on the mode: stable -> MAD multiplier k (def 3.0); quality -> min
    # good reads K within the ring (def ceil(capacity/2)); cluster -> value tolerance epsilon (def
    # 0, exact match); trimmed/winsor -> how many extremes to drop/clamp per end (def 1); ema ->
    # smoothing alpha 0..1 (def 0.5); track -> how far a read may miss the predicted value (def
    # 3*MAD of the trend residuals, floored at half the ring's typical step). Ignored by every
    # other mode.
    aggregate_arg: float = 0.0
    # Ignore null / None / empty ("") reads instead of writing them to a keyslot, so a momentary
    # blank read can't displace a good held value. Off (default) appends every read, blanks included.
    ignore_empty: bool = False
    # "" (default) -> the held map stays in-memory only, as documented above. A dataset id ->
    # every held entry is ALSO flushed to that dataset (one row per readout: ``{name, value}``,
    # ``name`` = the readout id) whenever a value changes, so state that only ever existed as a
    # live readout (e.g. loadout slot contents) becomes queryable by a subset like any other
    # dataset. The flush is a generic, game-agnostic mirror of the held map — no readout/slot
    # semantics live in Python; only the wired sources (profile data) determine what's written.
    persist: str = ""


class ProcessInput(BaseModel):
    """One wired input of a :class:`ProcessDef` — a SINGLE key plus its output-key rename (the
    "key mangler" unit). ``ref`` is a single-key prefixed ref:

    * ``readout:<id>``        — the readout's live value, under key = the readout id.
    * ``register:<id>#<key>`` — one slot of a register, under key = that slot key.

    ``out`` renames the emitted key: blank keeps the input key (the collector emits the value under
    the input key), a value re-keys it to ``out`` downstream. Value still flows through the rules
    pipeline; only the KEY is mangled here."""

    ref: str
    out: str = ""

    @model_serializer
    def _ser(self) -> dict:
        """Drop ``out`` when blank so an un-renamed input stays a bare ``{ref}`` on disk."""
        return {"ref": self.ref, "out": self.out} if self.out else {"ref": self.ref}


class ProcessDef(BaseModel):
    """A *process node*: a standalone holder of ONE value :class:`FieldRule` pipeline AND a per-input
    KEY MANGLER. It applies the pipeline to every wired input's value while renaming each input's key
    (see :class:`ProcessInput`). It exists to consolidate the identical rules section otherwise
    copy-pasted across many readouts' fields — wire N single-key inputs into one process, author the
    correction pipeline once, and optionally re-key each on the way out.

    ``sources`` are :class:`ProcessInput` rows, each a SINGLE key: a ``readout:<id>`` or a register
    slot ``register:<id>#<key>`` (no whole-register / process inputs — every input maps exactly one
    key). Each collector tick the process resolves each input to its ``{key: value}``, runs the
    pipeline on the value (see :func:`oc.collect.fields.run_rule_pipeline`), and emits it under the
    input's ``out`` key (or the input key when ``out`` is blank). Only key + value ever flow in —
    never confidence — and no consensus/gate logic lives here. Like a register, the output lives only
    in the running :class:`oc.collect.live.LiveSession`; only id + type + inputs + rules hit the YAML.
    """

    id: str
    # Value type carried into the pipeline: gates which rules apply (a number-only rule is
    # ignored for a text process) and coerces the final value, exactly as FieldDef.type does.
    type: FieldType = FieldType.text
    # Wired single-key inputs, each with its output-key rename (see ProcessInput).
    sources: list[ProcessInput] = Field(default_factory=list)
    # The shared value pipeline every input flows through, top-to-bottom (see FieldRule). The
    # SAME rule model readouts' fields use — a process just carries it standalone.
    rules: list[FieldRule] = Field(default_factory=list)
    enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def _migrate_sources(cls, data):
        """Coerce the legacy ``sources: ["readout:x", …]`` string form (before the key mangler) into
        ``[{ref: "readout:x"}, …]`` ProcessInput rows, so an older profile loads unchanged."""
        if isinstance(data, dict) and isinstance(data.get("sources"), list):
            data = {**data, "sources": [{"ref": s} if isinstance(s, str) else s for s in data["sources"]]}
        return data


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
    # How THIS source's MANY observations per key collapse to one value when the view reads it.
    # ``latest|first|sum|mean|max|min``, or ``all`` to NOT collapse (emit every observation as its
    # own row). ``""`` (the DEFAULT) means INHERIT the source dataset's own ``aggregate`` — a
    # dataset that sets ``max`` to defeat a duplicate must not have that policy silently overridden
    # by every consumer. Set an explicit value only to deliberately read it differently from how the
    # dataset collapses itself. Moot for a subset input (it computes its own).
    aggregate: str = ""
    # Required => the join key MUST be present in this source for an output row (inner-style).
    # When NO source is required the join is a full outer (every key kept, gaps filled); marking
    # sources required narrows to keys present in all of them (the old ``inner`` = all required).
    required: bool = False
    # How this source combines into the join, beyond a plain key-matched merge:
    #   join      - the default: matches on ``join_field`` and merges its columns in (subject
    #               to ``required``).
    #   exclude   - anti-join: DROP any key this source contains instead of contributing its
    #               columns (e.g. drop already-equipped/already-priced names from an inventory
    #               view). Never appears in the output row (no columns, no standalone rows) and
    #               is independent of ``required``.
    #   mark      - semi-join annotate: for each output row whose key matches, merge this
    #               source's columns in (earlier-still-wins on collisions) WITHOUT multiplying
    #               rows — a key matching several of this source's rows still contributes only
    #               the first. Use to flag/annotate ("does this row's key appear in that set")
    #               without exploding one row into several.
    #   broadcast - this source's row(s) merge into EVERY output row (no key match at all) —
    #               e.g. a single scalar reading applied to every row of a view. Multiple rows
    #               collapse into one merged dict first (first-wins), then fill only missing/
    #               empty cells of each output row so real join columns are never overwritten.
    mode: str = "join"


class PivotSpec(BaseModel):
    """Pivot flat ``{name, value}`` rows (e.g. a register's readout mirror) into WIDE rows,
    grouped by a shared id-PREFIX. Each row's ``name_field`` is matched against ``attributes``
    (longest suffix wins) to split it into ``(prefix, attribute)``; rows sharing a prefix merge
    into one output row ``{key_column: prefix, <attribute>: value, ...}``. A row whose name
    matches no taught suffix is dropped (it belongs to no group). ``attributes`` is authored
    data (taught in the UI), never hardcoded — e.g. a warframe loadout register writes
    ``slot_1_name``/``slot_1_drain``/``slot_1_school``; with ``attributes: [_name, _drain,
    _school]`` these fold into one row ``{slot: slot_1, name: ..., drain: ..., school: ...}``."""

    name_field: str = "name"    # column holding the flat row's id (e.g. "slot_1_school")
    value_field: str = "value"  # column holding the flat row's value
    key_column: str = "slot"    # output column name for the shared prefix
    attributes: list[str] = Field(default_factory=list)  # taught suffixes, longest-match wins


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
    # Reshape the joined rows from flat name/value pairs into wide rows BEFORE filter/derive —
    # see :class:`PivotSpec`. ``None`` (default) = no reshape.
    pivot: PivotSpec | None = None
    limit: int = 0                  # 0 = no limit
    # Collapse duplicate result rows, applied AFTER sort (so sort decides which duplicate
    # survives) and BEFORE limit (so limit counts distinct rows). ``distinct_by`` empty = key on
    # the whole visible row; non-empty = key on just those columns, first (sort-order) wins.
    distinct: bool = False
    distinct_by: list[str] = Field(default_factory=list)
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


class CutoutKind(str, Enum):
    """What a taught :class:`CutoutDef` is used for — the two kinds share teaching, storage
    and the NCC match kernel, but never compete against each other in a match."""

    glyph = "glyph"    # a single character; matched per-glyph to refine an OCR text field
    symbol = "symbol"  # an icon (e.g. a mod school glyph); the WHOLE box is classified against it


class CutoutDef(BaseModel):
    """One taught reference cutout: a label plus the saved crop of how it looks in this game.
    Several samples of the same label are several ``CutoutDef`` entries (same ``label``,
    different ``image``) — more samples make the match sturdier. ``image`` is a bare filename
    under ``captures/<game>/atlas/`` (mirrors item cutouts).

    ``kind=glyph``: ``label`` is a single character; post-OCR refinement
    (``FieldDef.glyph_check``) matches ambiguous glyphs against the glyph-kind entries.
    ``kind=symbol``: ``label`` is a category name (e.g. a mod school); a ``FieldDef`` of
    ``type: symbol`` classifies its whole box against the symbol-kind entries.

    This is game DATA authored in the UI — no glyph/symbol knowledge in Python."""

    label: str
    image: str
    # Disabled cutouts stay in the atlas (and the UI) but are skipped when building the matcher,
    # so a bad sample can be muted without deleting it. Default on (older profiles have no flag).
    enabled: bool = True
    kind: CutoutKind = CutoutKind.glyph


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
    # Reusable value predicates a trigger references by id (see GateDef) — the trigger's condition,
    # lifted out of the trigger. And downstream fan-out nodes (see RouterDef).
    gates: list[GateDef] = Field(default_factory=list)
    routers: list[RouterDef] = Field(default_factory=list)
    toasts: list[ToastDef] = Field(default_factory=list)
    sounds: list[SoundDef] = Field(default_factory=list)
    actions: list[ActionDef] = Field(default_factory=list)
    # In-memory keyed maps fed by readouts (never persisted; see RegisterDef). Only the node
    # definitions live here — the held values stay in the live session's server memory.
    registers: list[RegisterDef] = Field(default_factory=list)
    # Standalone rules-pipeline nodes fed by readouts/registers/other processes (never persisted;
    # see ProcessDef). Only the node definitions live here — the keyed output stays in the live
    # session's server memory, exactly like a register's held map.
    processes: list[ProcessDef] = Field(default_factory=list)
    dictionaries: list[DictionaryDef] = Field(default_factory=list)
    # Taught cutout atlas: glyph-kind entries feed post-OCR refinement (FieldDef.glyph_check),
    # symbol-kind entries feed whole-box classification (FieldDef.type == symbol). See CutoutDef.
    atlas: list[CutoutDef] = Field(default_factory=list)
    # Teach-UI node layout (positions/sizes/collapse/tables/open-images). Pure UI
    # data; the collector ignores it. Lives here so layout travels with the profile.
    layout: GraphLayout = Field(default_factory=GraphLayout)
    # Testing-inspector panel knobs. None until the user changes one, so a profile that was
    # never test-fed carries no `testing:` block at all. Per-input feed configs do NOT live
    # here — they ride the readout/dataset they feed (see TestFeedDef).
    testing: TestingDef | None = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_glyphs(cls, data):
        """Fold the legacy game-level ``glyphs: [{char,image,enabled}]`` atlas into the unified
        ``atlas: [{label,image,enabled,kind}]`` list (kind=glyph). Runs only when ``atlas`` isn't
        already present, so a new-style profile passes straight through."""
        if isinstance(data, dict) and "atlas" not in data:
            legacy = data.get("glyphs")
            if legacy:
                data["atlas"] = [
                    {"label": g.get("char", ""), "image": g.get("image", ""),
                     "enabled": g.get("enabled", True), "kind": "glyph"}
                    for g in legacy
                ]
            data.pop("glyphs", None)
        return data

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

    def reopen_grace_for(self, dataset_id: str) -> int:
        """Per-dataset detection re-open grace (``DatasetDef.reopen_grace``), or 0 when unset —
        the collector then falls back to the global ``tuning.confirm_frames``. Only meaningful
        for a ``batch_mode: detection`` dataset (see :meth:`batch_per_detection`)."""
        d = self.dataset_def(dataset_id)
        return int(d.reopen_grace) if d and d.reopen_grace else 0

    def keep_batches_for(self, dataset_id: str) -> int:
        """Per-dataset rolling batch-retention window (``DatasetDef.keep_batches``), 0 = keep
        everything. Batches past the window are compacted into a per-key base event rather than
        deleted — see :meth:`DatasetStore.fold_batches`."""
        d = self.dataset_def(dataset_id)
        return int(d.keep_batches) if d and d.keep_batches else 0

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
