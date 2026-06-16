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
    # Field boxes (cell-relative 0..1). RUNTIME-nested for the reader, but NOT serialised
    # here: each item's fields are hoisted to the window's flat ``item_fields`` (with an
    # ``item`` backref) so every field is its own thing on disk + its own node in the UI.
    fields: list[RegionDef] = Field(default_factory=list, exclude=True)
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
    def _distribute_item_fields(cls, data):
        """On load, fan the flat ``item_fields`` (window-level, each carrying an ``item``
        backref) back onto each ItemDef's runtime ``fields`` so the reader is unchanged.
        Legacy profiles (fields nested under items) pass through untouched."""
        if not isinstance(data, dict) or not data.get("item_fields"):
            return data
        data = dict(data)
        raw = data.pop("item_fields") or []
        by_item: dict[str, list] = {}
        for f in raw:
            if not isinstance(f, dict):
                continue
            f = dict(f)
            by_item.setdefault(f.pop("item", "") or "", []).append(f)
        items = []
        for it in data.get("items") or []:
            if isinstance(it, dict):
                it = dict(it)
                extra = by_item.get(it.get("id", ""), [])
                if extra:
                    it["fields"] = (it.get("fields") or []) + extra
            items.append(it)
        if items:
            data["items"] = items
        return data

    @computed_field
    @property
    def item_fields(self) -> list[dict]:
        """Flat, on-disk form of every item template's fields — one entry per field with an
        ``item`` backref. This is what makes each field its own node + its own YAML record."""
        out: list[dict] = []
        for it in self.items:
            for f in it.fields:
                out.append({**f.model_dump(mode="json"), "item": it.id})
        return out

    @property
    def dataset_id(self) -> str:
        return self.dataset or self.id


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


class SubsetDef(BaseModel):
    """A derived VIEW over one or more datasets: outer-join them on a shared key, filter
    rows, add computed columns, sort, limit. Recomputed on demand, so it always reflects
    the latest stored records."""

    id: str
    dataset: str = ""               # legacy single source (kept; folds into ``datasets``)
    datasets: list[str] = Field(default_factory=list)   # sources to join (on ``join_field``)
    join_field: str = "name"        # field the datasets are joined on
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

    def dataset_def(self, dataset_id: str) -> DatasetDef | None:
        return next((d for d in self.datasets if d.id == dataset_id), None)

    def aggregate_for(self, dataset_id: str) -> str:
        """How the dataset collapses each key's many observations (``latest`` default)."""
        d = self.dataset_def(dataset_id)
        return (d.aggregate if d and d.aggregate else "latest")

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
