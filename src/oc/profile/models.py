"""Profile schema: how a game's windows, states, and readable regions are described.

A profile is pure data (YAML on disk, validated by these pydantic models). The
teaching UI writes it; the collector reads it. Nothing about a specific game is
hard-coded in Python — it all lives here.

Coordinate convention: every box is a :class:`FractionBox` (0..1 of the window
client area), so a profile authored at one resolution still works at another.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field, field_validator, model_validator

from ..store.keys import KeyMap, KeySpec
from ..types import FractionBox


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


class FieldDef(BaseModel):
    """One column in a game's data schema, read from a region."""

    id: str
    type: FieldType = FieldType.text
    # Declarative extraction strategy (replaces raw regex).
    extract: Extract = Extract.whole
    separator: str = "/"
    # Value to use when the read is TRULY empty — no text and no numbers detected
    # (after whitespace strip). None -> leave empty.
    empty: str | None = None
    # text fields: value substituted when the read is numeric. With ``if_number_any``
    # it fires on a read merely CONTAINING a digit; otherwise only when the read is
    # all-number (digits, no letters). None -> off.
    if_number: str | None = None
    if_number_any: bool = False
    # number fields: value substituted when the read is text. With ``if_text_any``
    # it fires on a read merely CONTAINING a letter; otherwise only when the read is
    # all-text (letters, no digits). None -> off.
    if_text: str | None = None
    if_text_any: bool = False
    # How the game dictionary participates in this field's reads (see DictMode).
    dict_mode: DictMode = DictMode.correct
    # If true, high-confidence reads teach the game dictionary and low-confidence
    # reads are fuzzy-corrected against it. Suits identity text (item names).
    learn: bool = False
    # Similarity (0..1) an uncertain read must reach to be snapped to a known term.
    fuzzy: float = 0.82

    @model_validator(mode="before")
    @classmethod
    def _migrate_dict_only(cls, data):
        # legacy bool: dict_only true meant "correct AND drop unmatched"
        if isinstance(data, dict) and "dict_mode" not in data:
            legacy = data.pop("dict_only", None)
            if legacy is not None:
                data["dict_mode"] = "correct_drop" if legacy else "correct"
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
    # When this field locates rows (a tell-field used as the locator): which line of a
    # wrapped name to anchor on — "top"/"center"/"bottom". Empty -> item's ``align``.
    align: str = ""
    enabled: bool = True  # disabled regions are skipped during reads


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
    field: str | None = None       # for ``text``: the field whose read must be non-empty
    color: str | None = None       # for ``color``: hex, e.g. "#ffcc00"
    tolerance: int = 60            # for ``color``: colour distance (0..441)
    template: str | None = None    # for ``template``: PNG path relative to the profile dir
    threshold: float = 0.5         # score a tell must reach to pass (per-kind meaning)
    locate: bool = False           # use this tell to find row positions
    # When this tell locates rows: which line of a wrapped name to anchor on, so the
    # anchor is line-count-invariant — "top"/"center"/"bottom". Empty -> inherit the
    # item's ``align`` (legacy). Lives on the tell so each locator sets its own.
    align: str = ""


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
    # When several templates claim the same tile, the higher ``priority`` wins (e.g. a
    # specific 'arcane' over a generic 'item'). Ties fall back to tell count.
    priority: int = 0
    fields: list[RegionDef] = Field(default_factory=list)  # boxes are cell-relative (0..1)
    tells: list[Tell] = Field(default_factory=list)        # what makes a cell an item
    # How this template's records are keyed/deduped. None -> the window's key, else
    # the default (``name``). Per-template because templates sharing a window can
    # need different identities (an arcane keys on name+level, a plain item on name).
    key: KeyDef | None = None


class DetectDef(BaseModel):
    """A visual landmark used to recognise a window or state.

    ``template`` is a PNG path (relative to the profile dir) matched within
    ``search`` via template matching. Alternatively ``text`` is OCR'd inside
    ``search`` and compared (case-insensitive substring).
    """

    id: str
    enabled: bool = True    # disabled detectors are skipped during detection
    search: Box
    template: str | None = None
    text: str | None = None
    threshold: float = 0.8  # template-match confidence required
    # Match direction for text: False -> detect text must appear in the OCR read;
    # True -> accept when the OCR read is contained within the detect text (looser).
    included: bool = False


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


class WindowDef(BaseModel):
    """One recognisable screen/panel within a game.

    ``dataset`` names the logical collection this window's records belong to.
    Several windows can share a dataset when they show overlapping data (e.g.
    arcanes appear in both the Equipment and Arcane windows) — records from all of
    them are merged and deduplicated together into one output. Defaults to the
    window id, so each window has its own dataset unless told otherwise.
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
    states: list[StateDef] = Field(default_factory=list)
    regions: list[RegionDef] = Field(default_factory=list)
    # Preferred over ``regions``+``scroll``: item templates matched across the data
    # area. When non-empty, the collector reads items from these instead of the grid.
    # A window may define several (e.g. different item layouts in the same panel).
    items: list[ItemDef] = Field(default_factory=list)
    scroll: ScrollDef | None = None
    preprocess: Preprocess = Field(default_factory=Preprocess)

    @property
    def dataset_id(self) -> str:
        return self.dataset or self.id


class DatasetDef(BaseModel):
    """A logical collection of records. Datasets just receive, store, and serve
    rows — HOW a row is keyed/deduped is defined where the rows are read: the
    :class:`KeyDef` on the item template (or window) that produces them. Several
    windows can feed one dataset; their keys should agree."""

    id: str


class DictionaryDef(BaseModel):
    """A named, game-level word list. OCR reads of text fields snap to the closest
    entry — exact match first, then fuzzy — an authored alternative to the (flaky)
    self-learning lexicon for games with a known vocabulary: item/weapon/relic/arcane
    names, factions, etc. A game can have several; they're pooled."""

    id: str
    name: str = ""
    enabled: bool = True
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


class EnrichRule(BaseModel):
    """Attach external data to each row via a registered :class:`Enricher` (e.g.
    warframe.market prices, relic contents). The enricher reads ``source_field`` (a base
    OR derived column) as its lookup key. Network enrichers run only on an explicit
    enrich pass, never in the live filter/derive refresh."""

    type: str                       # registered enricher name (registry._ENRICHER)
    source_field: str = "name"      # which column feeds the enricher's lookup
    enabled: bool = True


class SubsetDef(BaseModel):
    """A derived view over a dataset: filter its rows, add computed columns, and
    optionally attach external data. Recomputed from the dataset on demand, so it always
    reflects the latest stored records. A dataset can have several subsets."""

    id: str
    dataset: str                    # source dataset id
    filters: list[FilterRule] = Field(default_factory=list)
    derived: list[DerivedColumn] = Field(default_factory=list)
    enrich: list[EnrichRule] = Field(default_factory=list)
    sort_by: str = ""
    sort_desc: bool = False
    limit: int = 0                  # 0 = no limit


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
    dictionaries: list[DictionaryDef] = Field(default_factory=list)

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

    def window(self, window_id: str) -> WindowDef | None:
        return next((w for w in self.windows if w.id == window_id), None)

    def subset_def(self, subset_id: str) -> SubsetDef | None:
        return next((s for s in self.subsets if s.id == subset_id), None)

    def dataset_def(self, dataset_id: str) -> DatasetDef | None:
        return next((d for d in self.datasets if d.id == dataset_id), None)

    def _key_defaults(self, dataset_id: str) -> list[KeySpec]:
        """Candidate DEFAULT specs (for records not tagged with an item template), one
        per window feeding the dataset that expresses a key, in window order: the
        window's own ``key``, else its single item template's ``key``. Multi-template
        windows tag every record, so their item keys never act as defaults."""
        out: list[KeySpec] = []
        for w in self.windows:
            if w.dataset_id != dataset_id:
                continue
            if w.key is not None:
                out.append(w.key.spec())
            elif len(w.items) == 1 and w.items[0].key is not None:
                out.append(w.items[0].key.spec())
        return out

    def key_map_for(self, dataset_id: str) -> KeyMap:
        """How records of a dataset are keyed: each item template's own spec (records
        carry ``_item`` when a window has several templates), with the first window
        default as fallback. Falls back to keying on ``name`` when nothing is taught."""
        by_item: dict[str, KeySpec] = {}
        for w in self.windows:
            if w.dataset_id != dataset_id:
                continue
            for it in w.items:
                if it.key is not None:
                    by_item.setdefault(it.id, it.key.spec())
                elif w.key is not None:
                    by_item.setdefault(it.id, w.key.spec())
        defaults = self._key_defaults(dataset_id)
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
