"""Profile schema: how a game's windows, states, and readable regions are described.

A profile is pure data (YAML on disk, validated by these pydantic models). The
teaching UI writes it; the collector reads it. Nothing about a specific game is
hard-coded in Python — it all lives here.

Coordinate convention: every box is a :class:`FractionBox` (0..1 of the window
client area), so a profile authored at one resolution still works at another.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

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

    * ``off`` — the dictionary is not consulted (the self-learning lexicon still is).
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
    """A condition tested against a field's RAW read (before extraction) to fire a
    fallback. Each is a predicate on the read's shape (after a whitespace strip)."""

    empty = "empty"            # nothing at all (no characters)
    no_digit = "no_digit"      # no digit anywhere (empty, symbol-only, or pure text)
    all_digit = "all_digit"    # has a digit and NO letter (a clean number)
    has_digit = "has_digit"    # at least one digit present
    no_letter = "no_letter"    # no letter anywhere
    all_letter = "all_letter"  # has a letter and NO digit (pure text)
    has_letter = "has_letter"  # at least one letter present
    always = "always"          # unconditional catch-all (place last)


class RuleThen(str, Enum):
    """What a matched :class:`FieldRule` does to the read."""

    set = "set"    # substitute the rule's ``value`` (parsed to a number for number fields)
    drop = "drop"  # resolve the read to None -> the record is dropped for this cell


class FieldRule(BaseModel):
    """One conditional fallback for a field. When the raw read matches ``when``, the
    rule's ``then`` fires — substitute ``value`` or drop the read. Rules are evaluated
    in order and the FIRST match wins, stopping evaluation; they run BEFORE extraction
    so they react to the raw read's shape. Generalises the old fixed ``empty`` /
    ``if_number`` / ``if_text`` one-offs into an authored, ordered list."""

    when: RuleWhen = RuleWhen.empty
    then: RuleThen = RuleThen.set
    value: str = ""   # for ``set``: the substituted text; ignored for ``drop``


class FieldDef(BaseModel):
    """One column in a game's data schema, read from a region."""

    id: str
    type: FieldType = FieldType.text
    # Declarative extraction strategy (replaces raw regex).
    extract: Extract = Extract.whole
    separator: str = "/"
    # Ordered conditional fallbacks applied to the raw read BEFORE extraction (see
    # FieldRule). Replaces the old fixed empty / if_number / if_text fields (migrated
    # in from legacy profiles below). The first matching rule wins.
    rules: list[FieldRule] = Field(default_factory=list)
    # How the game dictionary participates in this field's reads (see DictMode).
    dict_mode: DictMode = DictMode.correct
    # Which authored dictionary this field snaps to (a DictionaryDef.id). Empty ->
    # the pooled vocabulary (every enabled dictionary). Lets one field key off relic
    # names while another keys off arcane names, instead of one shared word soup.
    dictionary: str = ""
    # If true, high-confidence reads teach the game dictionary and low-confidence
    # reads are fuzzy-corrected against it. Suits identity text (item names).
    learn: bool = False
    # Similarity (0..1) an uncertain read must reach to be snapped to a known term.
    fuzzy: float = 0.82
    # Per-field minimum OCR confidence (0..1). A non-empty read below this drops the whole
    # record for that cell — a per-area floor on top of the global ``tuning.min_confidence``.
    # 0 = no per-field floor (rely on the global one).
    min_confidence: float = 0.0
    # Number fields only: plausible value range. A genuine read outside [min, max] is
    # implausible (e.g. a polarity glyph misread onto a drain digit -> "81" when the max is
    # 16) and drops the whole record for that cell, same as a sub-confidence read. Either
    # bound None -> that side unbounded. An authored ``set`` rule bypasses this.
    min: float | None = None
    max: float | None = None
    # Read this box in ISOLATION: OCR only its own crop instead of picking tokens out of the
    # window-wide pass. The shared pass can recognise a digit and an adjacent glyph as ONE
    # token ("8" + polarity -> "81"); a token is kept whole by where its CENTRE falls, so a
    # tight box can't split it. Isolate crops just the box (upscaled) so it sees only those
    # pixels — the fix for a number fused with a neighbouring symbol.
    isolate: bool = False

    @model_validator(mode="before")
    @classmethod
    def _migrate(cls, data):
        if not isinstance(data, dict):
            return data
        data = dict(data)
        # legacy bool: dict_only true meant "correct AND drop unmatched"
        if "dict_mode" not in data:
            legacy = data.pop("dict_only", None)
            if legacy is not None:
                data["dict_mode"] = "correct_drop" if legacy else "correct"
        # legacy fixed fallbacks (empty / if_number / if_text) -> the ordered rule list,
        # preserving their exact firing order/priority so old profiles read identically.
        empty = data.pop("empty", None)
        if_number = data.pop("if_number", None)
        if_number_any = bool(data.pop("if_number_any", False))
        if_text = data.pop("if_text", None)
        if_text_any = bool(data.pop("if_text_any", False))
        if "rules" not in data and any(v is not None for v in (empty, if_number, if_text)):
            ftype = data.get("type", "text")
            ftype = getattr(ftype, "value", ftype)
            rules: list[dict] = []
            if ftype == "number":
                # a number's ``empty`` value also covered the digitless case, but
                # ``if_text`` took priority on a digitless read when both were set.
                if empty is not None:
                    rules.append({"when": "empty", "then": "set", "value": empty})
                if if_text is not None:
                    rules.append({"when": "has_letter" if if_text_any else "no_digit",
                                  "then": "set", "value": if_text})
                if empty is not None:
                    rules.append({"when": "no_digit", "then": "set", "value": empty})
            else:
                if empty is not None:
                    rules.append({"when": "empty", "then": "set", "value": empty})
                if if_number is not None:
                    rules.append({"when": "has_digit" if if_number_any else "all_digit",
                                  "then": "set", "value": if_number})
            if rules:
                data["rules"] = rules
        return data


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
    prefix = "prefix"    # read must begin the target (or vice-versa if ``included``)


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
    color: str | None = None       # for ``color``: hex, e.g. "#ffcc00"
    tolerance: int = 60            # for ``color``: colour distance (0..441)
    template: str | None = None    # for ``template``: PNG path relative to the profile dir
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
    included: bool = False
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
    """

    id: str
    enabled: bool = True    # disabled detectors are skipped during detection
    search: Box
    template: str | None = None
    text: str | None = None
    # 0..1 score required to match. REQUIRED — no baked-in default; the UI seeds new
    # nodes from DEFAULT_DETECT_THRESHOLD and the loader backfills older profiles
    # (_migrate_detect_thresholds), so the magic number lives in exactly one place.
    threshold: float
    match: MatchMode = MatchMode.partial  # how text is compared (see MatchMode)
    # Match direction for ``partial``/``prefix``: False -> detect text must appear in
    # the OCR read; True -> accept when the OCR read is contained within the detect
    # text (looser). Ignored by ``full``/``exact``.
    included: bool = False
    case_sensitive: bool = False  # False -> fold case before comparing
    min_chars: int = 0            # hard floor: reads shorter than this never match
    strip: StripMode = StripMode.none  # what to ignore before comparing (default: keep everything)
    # Polarity. False (default) -> a POSITIVE detector: passes when the landmark is
    # present (score >= threshold). True -> a NEGATIVE detector: passes when the landmark
    # is ABSENT, so the window fails if this landmark IS found (e.g. "not the shop tab").
    negate: bool = False


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
        discarded). No implicit window-id fallback."""
        return self.dataset


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
    # False turns the 1->many collapse OFF entirely: every read is kept as its own record
    # (no dedup/merge). ``key_field`` is ignored when ``dedup`` is False.
    dedup: bool = True
    # How a live collection run splits into revertable batches:
    #   "run"       — one batch for the whole run (default; persistent inventory).
    #   "detection" — a NEW batch every time the feeding window is freshly detected after a
    #                 gap. For transient per-event screens (e.g. relic offerings) where each
    #                 appearance is a distinct set, not an update of the last one.
    batch_mode: str = "run"


class DictionaryDef(BaseModel):
    """A named, game-level word list. OCR reads of text fields snap to the closest
    entry — exact match first, then fuzzy — an authored alternative to the (flaky)
    self-learning lexicon for games with a known vocabulary: item/weapon/relic/arcane
    names, factions, etc. A game can have several; they're pooled.

    The term list lives in its own file under ``config/dictionaries/`` (named by
    ``source``) so the profile YAML stays small — a 7000-word dictionary doesn't
    belong inline. ``terms`` is RUNTIME-ONLY: the loader fills it from the ``source``
    file on load and writes it back on save, but it is never serialised into the
    profile YAML. A missing ``source`` file resolves to zero terms and the node
    survives (it is just a reference)."""

    id: str
    name: str = ""
    enabled: bool = True
    # Filename under config/dictionaries/ holding the term list (newline-delimited).
    source: str = ""
    # Resolved at load time from ``source`` and returned to the teach UI; the loader
    # strips it from the on-disk profile YAML (it persists to the ``source`` file).
    terms: list[str] = Field(default_factory=list)


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


class EnrichRule(BaseModel):
    """Attach external data to each row via a registered :class:`Enricher` (e.g.
    warframe.market prices, relic contents). The enricher reads ``source_field`` (a base
    OR derived column) as its lookup key. Network enrichers run only on an explicit
    enrich pass, never in the live filter/derive refresh."""

    id: str = ""                    # stable id so the teach UI can node-ify each rule
    type: str                       # registered enricher name (registry._ENRICHER)
    source_field: str = "name"      # which column feeds the enricher's lookup
    enabled: bool = True


class PriceNodeDef(BaseModel):
    """A standalone price *producer*: it sweeps a market source and pushes one current
    snapshot record per item into its output ``dataset`` (so prices live in a dataset
    like any other data, joinable by a view). Time-series history stays in the price
    store. The only game-specific, pluggable producer — Warframe's allowed exception."""

    id: str
    type: str = "warframe_market"   # registered price source
    # What this producer fetches per item: ``statistics`` (daily candles -> history,
    # movers, 48h live median) or ``orders`` (live lowest online SELL right now, no
    # history). Pick per node; run two nodes (two datasets) for both, joined in a view.
    mode: str = "statistics"        # "statistics" | "orders"
    dataset: str = "prices"         # output dataset the snapshots are written to
    throttle: float = 0.4           # seconds between requests during a sweep
    enabled: bool = True
    # Which items to price. EMPTY = the whole market catalogue (the original producer
    # behaviour). When set, the node prices only the names found in these source
    # datasets/views (e.g. wire an inventory dataset in to price just owned gear, or a
    # relic-reward dataset to price just this run's rewards). Wired in the graph UI as
    # input edges; resolved to slugs via the catalogue resolver before a sweep.
    sources: list[str] = Field(default_factory=list)
    # Which column on the source rows names the item to price (resolved to a market
    # slug). Default ``name``; selectable in the UI when a source's item names live
    # under a different column.
    source_field: str = "name"


class TriggerDef(BaseModel):
    """A generic *trigger*: it fires one or more price nodes' sweeps on a condition,
    so pricing can run automatically instead of only on a manual button. Pure config —
    the runner that evaluates triggers lives in the collector / web app, never in the
    capture loop. Three kinds:

    * ``interval``   — fire every ``interval_s`` seconds (periodic refresh).
    * ``on_change``  — fire when a dataset in ``watch`` gains new/changed records, pricing
      only those changed keys (real-time, e.g. relic-reward items the moment they're read).
    * ``manual``     — never auto-fires; just declares the wiring (the sweep button drives it).
    """

    id: str
    kind: str = "interval"                  # interval | on_change | manual
    interval_s: float = 300.0               # for kind="interval": seconds between fires
    watch: list[str] = Field(default_factory=list)    # for kind="on_change": datasets to watch
    targets: list[str] = Field(default_factory=list)  # price-node ids this trigger fires
    enabled: bool = True
    sound: str = ""                         # optional sound file (in the web sounds folder) the UI plays on fire
    volume: float = 1.0                     # playback volume for ``sound`` (0..1)


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


class FileSourceDef(BaseModel):
    """A *file-source producer*: locate a game file (log/config), parse it with a registered
    format backend, and push one current record per parsed row into its output ``dataset`` — so
    file data stores/dedups/joins/serves exactly like OCR data. The pluggable producer parallel to
    :class:`PriceNodeDef`. Zero game knowledge: ``filename``/``path`` are profile data the UI teaches.

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
    tail: bool = True               # log_lines: read only appended bytes since the last read
    match: list[SourceMatch] = Field(default_factory=list)   # log_lines: which lines to keep
    fields: list[SourceField] = Field(default_factory=list)  # how each output column is extracted
    # How output rows are keyed/deduped in the dataset. None -> the dataset's own key (or ``name``).
    key: KeyDef | None = None
    enabled: bool = True


class SubsetDef(BaseModel):
    """A derived VIEW over one or more datasets: outer-join them on a shared key, filter
    rows, add computed columns, sort, limit. Recomputed on demand, so it always reflects
    the latest stored records."""

    id: str
    dataset: str = ""               # legacy single source (kept; folds into ``datasets``)
    datasets: list[str] = Field(default_factory=list)   # sources to join (on ``join_field``)
    join_field: str = "name"        # field the datasets are joined on
    # ``outer`` keeps every key (gaps filled from later inputs); ``inner`` keeps only keys
    # present in EVERY joined source (intersection). Ignored for a single source.
    join_mode: str = "outer"
    # How each dataset input's MANY observations per key collapse to one value when this
    # view reads them — the view's call, not the dataset's (one dataset can feed two views
    # that want latest vs sum). ``latest|first|sum|mean|max|min``.
    aggregate: str = "latest"
    filters: list[FilterRule] = Field(default_factory=list)
    derived: list[DerivedColumn] = Field(default_factory=list)
    hidden_columns: list[str] = Field(default_factory=list)  # result columns to omit from the view
    enrich: list[EnrichRule] = Field(default_factory=list)   # legacy; price is a producer now
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
        """Source datasets to join, de-duplicated in order. Folds the legacy single
        ``dataset`` in so old profiles keep working."""
        out: list[str] = []
        for d in ([self.dataset] if self.dataset else []) + list(self.datasets):
            if d and d not in out:
                out.append(d)
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


class GameProfile(BaseModel):
    """Everything needed to detect a game and read its windows."""

    name: str
    # Process executable names to match (case-insensitive), e.g. "Warframe.x64.exe".
    process_names: list[str] = Field(default_factory=list)
    window_title_hint: str | None = None
    fields: list[FieldDef] = Field(default_factory=list)
    windows: list[WindowDef] = Field(default_factory=list)
    datasets: list[DatasetDef] = Field(default_factory=list)
    subsets: list[SubsetDef] = Field(default_factory=list)
    price_nodes: list[PriceNodeDef] = Field(default_factory=list)
    file_sources: list[FileSourceDef] = Field(default_factory=list)
    triggers: list[TriggerDef] = Field(default_factory=list)
    dictionaries: list[DictionaryDef] = Field(default_factory=list)
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

    def window(self, window_id: str) -> WindowDef | None:
        return next((w for w in self.windows if w.id == window_id), None)

    def subset_def(self, subset_id: str) -> SubsetDef | None:
        return next((s for s in self.subsets if s.id == subset_id), None)

    def file_source(self, source_id: str) -> FileSourceDef | None:
        return next((s for s in self.file_sources if s.id == source_id), None)

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

    def _key_defaults(self, dataset_id: str) -> list[KeySpec]:
        """Default specs (for records not tagged with an item template), one per
        window feeding the dataset, in window order — each window's effective default
        (its ``key``, first region field, or single-item default)."""
        out: list[KeySpec] = []
        for w in self.windows:
            if w.dataset_id != dataset_id:
                continue
            out.append(self._window_default_spec(w))
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
