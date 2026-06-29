// Node body builders: the pure functions that turn a node's model into its header/body/ports
// DOM. No events, no rendering -- wiring lives in main.js, which calls nodeParts() then attaches
// handlers. Everything is built through dom.js's h()/frag()/svg() (rule 7: one element builder,
// no innerHTML). Extracted from main.js. (Subset builders stay in main -- they tangle with the
// live vtable column set -- so nodeParts imports subsetParts back.)
//
// Return shape of nodeParts() and every *Parts builder: { title, head?, body, ports?, pulse? }
//   title -> a Node (the header's id input / label)
//   head  -> a Node or null (default null)
//   body  -> a Node or DocumentFragment
//   ports -> a Node/frag or null (default null)
//   pulse -> a className fragment STRING (stays a string -- used in class="gn-h ${pulse}")
import { h, frag, svg, TRASH } from "../dom.js";
import { buildKey } from "../keys.js";
import { model, itemReads } from "./state.js";
import { ITEM_KINDS } from "./imaging.js";
import { producerParts } from "./producer_node.js";
import { sourceParts } from "./source_node.js";
import { triggerParts } from "./trigger_node.js";
import { subsetParts } from "./main.js";

// Header toggle button that shows/hides a node's opt-in satellite (preview / vt-table).
// `.gn-sat-tog` carries the satellite id; main.js wires every one through model.toggleSatellite.
const SAT_EYE = () => svg("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" },
    svg("path", { fill: "currentColor", d: "M8 3.5C4.5 3.5 1.7 5.7.5 8c1.2 2.3 4 4.5 7.5 4.5S14.3 10.3 15.5 8C14.3 5.7 11.5 3.5 8 3.5zm0 7.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z" }));
const SAT_GRID = () => svg("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" },
    svg("path", { fill: "none", stroke: "currentColor", "stroke-width": "1.3", d: "M2.5 2.5h11v11h-11zM2.5 6.5h11M2.5 10h11M6.5 2.5v11" }));
export function satToggleBtn(satId, kind) {
    const on = model.satelliteOn(satId);
    const title = `${on ? "hide" : "show"} ${kind === "preview" ? "preview" : "data table"}`;
    return h("button", {
        class: `gn-sat-tog gn-cog${on ? " on" : ""}`, dataset: { sat: satId },
        title, "aria-label": title, "aria-pressed": on,
    }, kind === "preview" ? SAT_EYE() : SAT_GRID());
}

// SVG track+thumb shared by every header slide toggle (enable switch, vt-table "show removed").
// The off/on look (--line vs --accent, thumb slides right) is driven by the `.gn-slide` CSS.
const SLIDE_THUMB = () => svg("svg", { viewBox: "0 0 28 16", width: "28", height: "16", "aria-hidden": "true" },
    svg("rect", { class: "gt-track", x: "1", y: "1", width: "26", height: "14", rx: "7" }),
    svg("circle", { class: "gt-thumb", cx: "8", cy: "8", r: "5" }));
// A header slide toggle (role=switch). `cls` = caller class for positioning/wiring; optional
// `label`; `hidden` starts it display:none (revealed later, e.g. once data shows it's relevant).
export function slideToggle({ on, title, cls = "", label = "", hidden = false }) {
    return h("button", {
        type: "button", class: `gn-slide ${cls}${on ? " on" : ""}`.trim(), role: "switch",
        "aria-checked": String(on), title, hidden,
    }, label ? h("span", { class: "gn-slide-lbl" }, label) : null, SLIDE_THUMB());
}

// per-dataset "show removed (no-longer-present) rows" flag for the vt-table satellite (default
// off). Toggle lives in the satellite header; datanodes reads this to filter present===false rows.
export const vtShowRemoved = new Map();

export const TYPES = [["text", "text"], ["number", "number"], ["pips", "pips"], ["diamonds", "diamonds (rank)"]];
export const EXTRACTS = ["whole", "number", "number_before", "number_after", "text_before", "text_after"];
export const NEEDS_SEP = new Set(["number_before", "number_after", "text_before", "text_after"]);
// how the game dictionary participates in a text field's reads (FieldDef.dict_mode)
export const DICT_MODES = [
    ["off", "off"],
    ["correct", "correct"],
    ["drop", "drop"],
    ["correct_drop", "correct + drop"],
];

// Conditional fallback rules (FieldRule). `when` is a predicate on the RAW read's
// shape; `then` substitutes a value or drops the record. Rules run in order, first
// match wins. Generalises the old empty / if_number / if_text one-offs.
export const RULE_WHEN = [
    ["empty", "is empty"],
    ["no_digit", "has no digit"],
    ["all_digit", "is all digits"],
    ["has_digit", "has a digit"],
    ["no_letter", "has no letter"],
    ["all_letter", "is all letters"],
    ["has_letter", "has a letter"],
    ["always", "always"],
];
export const RULE_THEN = [["set", "set value"], ["drop", "drop record"]];

// <option> nodes for a field's dictionary picker: "all" (every enabled dictionary pooled)
// + each named dictionary. `sel` is the field's pinned DictionaryDef.id ("" = pooled).
// Returns an ARRAY of <option> nodes, consumed as h("select", {...}, dictOptions(sel)).
export function dictOptions(sel) {
    const dicts = model.profile.dictionaries || [];
    const opts = [h("option", { value: "", selected: !sel }, "all")];
    for (const d of dicts)
        opts.push(h("option", { value: d.id, selected: sel === d.id }, d.name || d.id));
    // pin a referenced dictionary the profile no longer lists, so the field keeps pointing at it
    // (shown by bare id) instead of silently snapping to "all" on the next edit.
    if (sel && !dicts.some((d) => d.id === sel))
        opts.push(h("option", { value: sel, selected: true }, sel));
    return opts;
}

export function windowControls(w) {
    // The record key is taught per item template (key section in the item node; the teach
    // page covers grid windows). Where records flow is shown by the wire to the dataset node.
    // The toggles are slide-toggle flabs; the image selector / recapture / page nav live
    // below the canvas (built in openImage). "clicks" only shows when auto-scroll is on.
    const sc = w.scroll || {};
    return frag(
        h("label", { class: "flab", title: "item rows: static tiles the data area into a fixed grid from the cell size (no OCR for location); off locates rows by OCR (a tell/locate field) — only needed for a scroll-parked list" },
            "static grid ", h("input", { type: "checkbox", class: "winstatic", checked: w.static_grid !== false })),
        h("label", { class: "flab", title: "precapture auto-scrolls this window's list while recording it" },
            "auto-scroll ", h("input", { type: "checkbox", class: "winscroll", dataset: { k: "autoscroll" }, checked: !!sc.autoscroll })),
        sc.autoscroll && h("label", { class: "flab", title: "wheel notches sent per auto-scroll nudge" },
            "auto-scroll clicks ", h("input", { type: "number", class: "winscroll", dataset: { k: "clicks" }, value: sc.scroll_clicks ?? 1, min: "1" })),
        h("label", { class: "flab", title: "attempt this window in live view" },
            "live ", h("input", { type: "checkbox", class: "winlive", checked: w.live !== false })),
        windowItemOrder(w),
        (w.items || []).length && h("div", { class: "wi-drift muted", title: "how far located cells sit from the content they should bracket, split by axis — x and y as avg/max % of a CELL (25% = a quarter-cell off). 0 = dead-on; high = cells drift off their columns (x) or rows (y). Filled by the read." },
            "grid drift: ", h("span", { class: "wd-drift" }, "—")),
        windowDetects(w));
}

// Scrollbar node: orientation + the cutout-based scroll-calibration tool. Each cutout is a
// crop of the scrollbar at a known scroll, tagged with rows-from-top; "auto learn" fits the
// gain from them. The calculated total/visible/gain stack is static (from the profile), not
// live. Handlers (capture/remove/reorder/learn) live in main.js wireScrollbar.
function scrollbarParts(n) {
    const sc = n.ref;                                  // the window's scroll object
    const o = sc.scrollbar_orientation || "vertical";
    const samples = sc.calib_samples || [];
    const gain = sc.calib_gain;
    const usable = samples.filter((s) => s.pos != null).length;
    const cut = (s, i) => h("div", { class: "sb-cut", draggable: "true", dataset: { i } },
        h("img", { class: "sb-cut-img", src: s.img || "", alt: "" }),
        h("div", { class: "sb-cut-body" },
            h("div", { class: "sb-cut-top" },
                h("label", { class: "flab" }, "rows from top ",
                    h("input", { type: "number", class: "sbcut", dataset: { k: "rows", i }, value: s.rows ?? 0, min: "0" })),
                h("button", { class: "sbcut-rm danger", dataset: { i }, title: "remove cutout" }, TRASH())),
            h("div", { class: "sb-cut-pos muted" }, s.pos != null ? `thumb ${(s.pos * 100).toFixed(2)}% · ${s.px ?? "?"}px` : "thumb —")));
    return frag(
        h("label", { class: "flab" }, "orientation ",
            h("select", { class: "sbset", dataset: { k: "orient" } },
                h("option", { selected: o === "vertical" }, "vertical"),
                h("option", { selected: o === "horizontal" }, "horizontal"))),
        h("div", { class: "sb-h muted", title: "capture the scrollbar at known scroll offsets, tag each with how many rows it has moved down from the top — the gain is fit automatically. Drag to reorder." }, "cutouts"),
        h("div", { class: "sb-cuts" }, samples.length
            ? samples.map(cut)
            : h("p", { class: "muted", style: "margin:2px 0" }, "no cutouts — open the window image, scroll, capture")),
        h("div", { class: "sb-cut-acts" },
            h("button", { class: "sb-capture", title: "crop the scrollbar from the open window image into a new cutout" }, "capture cutout")),
        h("div", { class: "detect-status muted" }, "position: —"),
        h("div", { class: "sb-calib" },
            h("div", { class: "sbc-row", title: "scrollable rows = rows of content per full thumb travel, fit from the cutouts" },
                "rows ", h("span", { class: "sbc-gain" }, gain != null ? `${gain}` : "—")),
            h("div", { class: "sbc-row" }, "cutouts ", h("span", {}, `${usable}/${samples.length}`))),
        h("div", { class: "gn-foot" }));
}

// One <select> built from [value,label] option pairs, marking `val` selected.
const optSel = (val, opts, cls, props = {}) =>
    h("select", { class: cls, ...props }, opts.map(([v, t]) => h("option", { value: v, selected: val === v }, t)));

// The window's detectors as rows below templates: how they combine (all/any) + each
// detector's polarity (require present / require absent), with a LIVE per-row verdict and
// an overall pass/fail for the current image. The detect NODE still edits each detector's
// text/threshold; this section edits only the window-level match POLICY. Statuses
// (`.wd-status`, `.wd-verdict`, `.wd-collide`) are filled live by setWindowDetectStatus
// (reconciled in place, never rebuilt per tick) and hold blank until the first detect pass
// returns. `.wd-collide` is the cross-window verdict (does this window WIN classify, or does a
// sibling also match / steal the tie-break) — sourced from the whole-profile collision check.
export function windowDetects(w) {
    const dets = w.detect || [];
    if (!dets.length) return null;
    const mode = w.detect_mode || "all";
    const modeSel = optSel(mode, [["all", "all"], ["any", "any"]], "wd-mode",
        { title: "all = every detector must pass (AND); any = at least one passes (OR)" });
    // Three columns: col1 = detector name, col2 = its live status, col3 = the polarity select
    // bound to that detector. The select is width:100% (min-width:0), so it can never overflow
    // (the window body clips overflow). The header row labels all three columns.
    const rows = dets.map((d) => {
        const off = d.enabled === false;   // disabled detectors are greyed + their control locked
        return h("div", { class: `wd-row${off ? " wd-disabled" : ""}`, dataset: { id: d.id } },
            h("span", { class: "wd-name", title: `${d.id} — open this detector's node` }, d.id),
            h("span", { class: "wd-status muted", dataset: { id: d.id }, title: "live: does this detector pass its requirement on the current image" }, off ? "disabled" : ""),
            optSel(d.negate ? "absent" : "present", [["present", "present"], ["absent", "absent"]], "wd-neg",
                { dataset: { id: d.id }, title: "require this landmark PRESENT (positive), or ABSENT (negative — the window fails if it IS found)", disabled: off }));
    });
    return frag(
        h("div", { class: "muted il-h wi-h", title: "how this window's detectors decide a match" }, "detects"),
        h("label", { class: "wd-mode-line muted" }, "window matches if ", modeSel),
        h("div", { class: "wd-row wd-head muted" },
            h("span", { class: "wd-name" }, "detector"),
            h("span", { class: "wd-status" }, "pass"),
            h("span", { class: "wd-req-h" }, "require")),
        rows,
        h("div", { class: "wd-verdict muted", title: "whether the current capture would be recognised as this window with the settings above" }),
        h("div", { class: "wd-collide", title: "cross-window: detection picks ONE winner across all windows — does this window actually win, or does a sibling also match / steal it" }));
}

// Item templates listed in PRIORITY order, HIGHEST first — the top row wins when cells
// overlap a tile; the BOTTOM row is priority 0 (the static grid's base cell, which sets the
// grid pitch). Reordering IS how priority is set; the number itself is never shown. Click a
// name to jump to that item's node.
export function windowItemOrder(w) {
    const items = [...(w.items || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    if (!items.length) return null;
    const rows = items.map((it, i) => h("div", { class: "wi-row", dataset: { id: it.id } },
        h("span", { class: "wi-name", title: "select this item's node" }, it.id),
        h("button", { class: "wimv", dataset: { id: it.id, d: "-1" }, disabled: i === 0, title: "move up — higher priority (wins tile overlaps)" }, "▲"),
        h("button", { class: "wimv", dataset: { id: it.id, d: "1" }, disabled: i === items.length - 1, title: "move down — lower priority (bottom = base cell, sets the grid pitch)" }, "▼")));
    return frag(
        h("div", { class: "muted il-h wi-h", title: "template priority order — highest on top (wins tile overlaps); the bottom template is the base cell that sets the grid pitch" }, "templates"),
        rows);
}

// The cell size (item.box w/h, window fractions) shown as editable inputs below the cutout
// canvas. Under static grid this IS the grid pitch (column/row spacing); the cell's position
// is unused. Editing reuses setItemCellKeepingChildren so fields/tells stay visually put.
export function cellSizeControls(it) {
    const b = it.box || { w: 0, h: 0 };
    const v = (n) => +(+n || 0).toFixed(4);
    return frag(
        h("label", { class: "flab", title: "cell width as a window fraction — the static grid's column pitch" },
            "width ", h("input", { type: "number", class: "csize", dataset: { k: "w" }, step: "0.001", min: "0.001", value: v(b.w) })),
        h("label", { class: "flab", title: "cell height as a window fraction — the static grid's row pitch" },
            "height ", h("input", { type: "number", class: "csize", dataset: { k: "h" }, step: "0.001", min: "0.001", value: v(b.h) })));
}

// One field's fallback-rule rows (FieldRule list). `cls` is the change-class the node
// wiring listens on; `fid` (item fields) tags each control so the wiring resolves the
// field. The value input shows only for a `set` rule (a `drop` needs none).
export function ruleRows(fd, cls, fid) {
    const da = fid ? { fid } : {};
    const rules = fd.rules || [];
    if (!rules.length) return h("div", { class: "muted frule-empty" }, "no rules — the read is used as-is");
    return rules.map((r, i) => {
        const showVal = (r.then || "set") === "set";
        return h("div", { class: "frule", dataset: { ri: i } },
            h("select", { class: "rule-when", dataset: { ri: i, ...da }, title: "condition tested on the raw read" },
                RULE_WHEN.map(([v, t]) => h("option", { value: v, selected: (r.when || "empty") === v }, t))),
            h("select", { class: "rule-then", dataset: { ri: i, ...da }, title: "what to do when it matches" },
                RULE_THEN.map(([v, t]) => h("option", { value: v, selected: (r.then || "set") === v }, t))),
            showVal && h("input", { class: "rule-val", dataset: { ri: i, ...da }, value: r.value || "", placeholder: "value", title: "value substituted into the field" }),
            h("button", { class: "rule-del danger", dataset: { ri: i, ...da }, title: "remove this rule" }, TRASH()));
    });
}

// The per-field config body, SHARED by the region node and the item-field node (one
// renderer, not two copies). Inputs are grouped under .fgrp sub-headings and only the
// ones that DO something for the current type/mode are shown. `cls` is the wiring's
// change-class ("fset" | "ffset"); `fid` (item fields) tags each control.
export function fieldConfigBody(fd, cls, fid) {
    const da = fid ? { fid } : {};
    const pips = fd.type === "pips" || fd.type === "diamonds";
    const isText = fd.type === "text";
    const isNum = fd.type === "number";
    const dictOn = (fd.dict_mode || "correct") !== "off";   // dictionary actually consulted
    const hasDicts = (model.profile.dictionaries || []).length;
    return frag(
        h("div", { class: "fgrp" }, "read"),
        h("label", { class: "flab", title: "read this box in isolation: OCR only its own crop instead of picking tokens from the window-wide pass — use when a digit fuses with a neighbouring glyph (e.g. an '8' read as '81')" },
            "isolate ", h("input", { type: "checkbox", class: cls, dataset: { k: "isolate", ...da }, checked: !!fd.isolate })),
        h("label", { class: "flab" }, "type ",
            h("select", { class: cls, dataset: { k: "type", ...da } }, TYPES.map(([v, t]) => h("option", { value: v, selected: fd.type === v }, t)))),
        !pips && h("label", { class: "flab" }, "extract ",
            h("select", { class: cls, dataset: { k: "extract", ...da } }, EXTRACTS.map((v) => h("option", { selected: (fd.extract || "whole") === v }, v)))),
        (!pips && NEEDS_SEP.has(fd.extract)) && h("label", { class: "flab" }, "separator ",
            h("input", { class: cls, type: "text", dataset: { k: "sep", ...da }, value: fd.separator || "/" })),
        h("label", { class: "flab", title: "minimum OCR confidence this field must reach — a weaker read drops the whole record (0 = use the global floor)" },
            "conf ", h("input", { type: "number", class: cls, dataset: { k: "minconf", ...da }, step: "0.05", min: "0", max: "1", value: fd.min_confidence ?? 0 })),
        isNum && frag(
            h("label", { class: "flab", title: "lowest plausible value — a read below this is a misread and drops the record (blank = no minimum)" },
                "min ", h("input", { type: "number", class: cls, dataset: { k: "min", ...da }, value: fd.min ?? "", placeholder: "(none)" })),
            h("label", { class: "flab", title: "highest plausible value — a read above this is a misread and drops the record (blank = no maximum)" },
                "max ", h("input", { type: "number", class: cls, dataset: { k: "max", ...da }, value: fd.max ?? "", placeholder: "(none)" }))),
        isText && frag(
            h("div", { class: "fgrp" }, "dictionary"),
            h("label", { class: "flab", title: "off = dictionary not consulted; correct = fix words, keep unmatched; drop = no fixes, unmatched read dropped; correct + drop = fix words, unmatchable read dropped" },
                "dict ", h("select", { class: cls, dataset: { k: "dictmode", ...da } },
                    DICT_MODES.map(([v, t]) => h("option", { value: v, selected: (fd.dict_mode || "correct") === v }, t)))),
            (hasDicts && dictOn) && h("label", { class: "flab", title: "which authored dictionary this field snaps to (all = every enabled one pooled)" },
                "use dict ", h("select", { class: cls, dataset: { k: "usedict", ...da } }, dictOptions(fd.dictionary))),
            h("label", { class: "flab", title: "learn the dictionary from confident reads, fuzzy-correct uncertain ones" },
                "learn ", h("input", { type: "checkbox", class: cls, dataset: { k: "learn", ...da }, checked: !!fd.learn })),
            (fd.learn || dictOn) && h("label", { class: "flab", title: "similarity (0-1) an uncertain read must reach to snap to a known word; higher = stricter" },
                "fuzzy ", h("input", { type: "number", class: cls, dataset: { k: "fuzzy", ...da }, step: "0.05", min: "0", max: "1", value: fd.fuzzy ?? 0.82 }))),
        h("div", { class: "fgrp" }, "rules ",
            h("button", { class: "ruleadd", dataset: { ...da }, title: "add a fallback rule" }, "+ rule")),
        ruleRows(fd, cls, fid));
}

// One item field is its OWN node (a child of its item node). It renders the shared
// per-field config (against the window's FieldDef) plus the row-role controls (tell /
// locate / align) that only make sense for a field inside an item template.
export function itemFieldParts(n) {
    const f = n.ref, fd = n.field || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
    const alignSel = (cls, vals, cur) => h("select", { class: cls, dataset: { fid: f.id } },
        vals.map((v) => h("option", { selected: cur === v }, v)));
    const body = frag(
        fieldConfigBody(fd, "ffset", f.id),
        h("div", { class: "fgrp" }, "row role"),
        h("label", { class: "flab", title: "require this field to read something — it doubles as a tell" },
            "tell ", h("input", { type: "checkbox", class: "itell", dataset: { fid: f.id }, checked: !!f.tell })),
        f.tell && h("label", { class: "flab", title: "minimum OCR confidence the read must reach (0 = any)" },
            "tell conf ", h("input", { type: "number", class: "itellconf", dataset: { fid: f.id }, step: "0.05", min: "0", max: "1", value: f.tell_conf ?? 0 })),
        (f.tell && fd.type === "number") && h("label", { class: "flab", title: "pass the tell even when the read carries text (e.g. a unit symbol or glyph), not only a clean number" },
            "allow text ", h("input", { type: "checkbox", class: "itelltext", dataset: { fid: f.id }, checked: !!f.tell_allow_text })),
        h("label", { class: "flab", title: "use this field to LOCATE rows (anchor the grid) — independent of tell; a reliable text field (e.g. the name) can locate without being a tell" },
            "locate ", h("input", { type: "checkbox", class: "iloc", dataset: { fid: f.id }, checked: !!f.locate })),
        (f.tell || f.locate) && frag(
            h("label", { class: "flab", title: "vertical anchor: which line of a wrapped name fixes the ROW" },
                "align y ", alignSel("itellalign", ["none", "top", "center", "bottom"], f.align || n.item.align || "center")),
            h("label", { class: "flab", title: "horizontal anchor: which edge of the text fixes the COLUMN — pick the side the text is aligned to in the cell (e.g. left for a left-aligned name). Lets columns be found from content, immune to blank data-area margins." },
                "align x ", alignSel("itellalignx", ["left", "center", "right"], f.align_x || n.item.align_x || "left"))),
        h("div", { class: "gn-foot" }));
    return { title: h("input", { class: "gi gi-id", dataset: { k: "fldid" }, value: f.id, title: "field id" }), body };
}

// One tell is its OWN node (a child of its item node). It renders the per-tell controls that
// used to live inline in the item node: kind, the kind-specific input (field for text, colour
// for color), threshold, and — only when the window locates rows by OCR (static grid off) —
// the locate toggle + its align. Mirrors itemFieldParts.
export function itemTellParts(n) {
    const t = n.ref, it = n.item, w = n.win;
    const staticOn = w.static_grid !== false;   // static grid tiles rows from the cell — locate is unused
    const tset = (k, opts, cur, def) => h("select", { class: "tset", dataset: { k } },
        opts.map((v) => h("option", { value: v, selected: (cur ?? def) === v }, v)));
    const body = frag(
        t.kind === "text" && frag(
            h("label", { class: "flab", title: "which field's read this tell checks. Leave blank (—) to check ANY column's read — the tell isn't tied to one field." },
                "checks ", h("select", { class: "tset", dataset: { k: "field" } }, _colOpts((it.fields || []).map((f) => f.field), t.field))),
            h("label", { class: "flab", title: "optional: require the read to MATCH this text (scored like a detector). Empty = just needs to read SOMETHING (the chosen field, or any column when blank). NOTE: an empty-text tell bound to a field is identical to flagging that field 'tell' — use the field's own tell flag instead." },
                "text ", h("input", { class: "tset", dataset: { k: "text" }, value: t.text || "", placeholder: "(any)" })),
            (t.text || "").trim() && frag(
                h("label", { class: "flab", title: "how text is compared: partial=substring (loose); full=whole-string; exact=equal; prefix=starts-with" },
                    "mode ", tset("match", ["partial", "full", "exact", "prefix"], t.match, "partial")),
                h("label", { class: "flab", title: "hard floor: reads shorter than this never match (kills tiny-blob false hits)" },
                    "min chars ", h("input", { type: "number", class: "tset", dataset: { k: "minchars" }, step: "1", min: "0", value: t.min_chars ?? 0 })),
                h("label", { class: "flab", title: "what to ignore before comparing" },
                    "strip ", tset("strip", ["alnum", "spaces", "none"], t.strip, "alnum")),
                h("label", { class: "flab", title: "off = fold case before comparing" },
                    "case sensitive ", h("input", { type: "checkbox", class: "tset", dataset: { k: "case" }, checked: !!t.case_sensitive })))),
        (t.kind === "color" || t.kind === "border") && h("label", { class: "flab", title: t.kind === "border" ? "the colour that must ride the box's perimeter band" : "the colour that must be present in the tell box" },
            "colour ", h("input", { type: "color", class: "tset", dataset: { k: "color" }, value: t.color || "#ffcc00" })),
        t.kind === "border" && h("label", { class: "flab", title: "thickness of the sampled perimeter band, as a fraction (0..1) of the box's shorter side. Only this ring is checked for the colour; the fill is ignored." },
            "width ", h("input", { type: "number", class: "tset", dataset: { k: "width" }, step: "0.02", min: "0", max: "0.5", value: t.width ?? 0.2 })),
        t.kind === "template" && h("div", { class: "tt-ref", title: "the saved sub-image this tell matches — the tell box cropped from the item's frozen cutout" },
            it.cutout ? h("canvas", { class: "tt-ref-canvas" }) : h("div", { class: "muted" }, "no cutout yet")),
        t.kind === "template" && h("label", { class: "flab", title: "search margin: how far the live crop grows beyond the box (per side, as a fraction of the box) so the saved image is found even when the located cell drifts a few px. 0 = match the exact box only." },
            "margin ", h("input", { type: "number", class: "tset", dataset: { k: "margin" }, step: "0.05", min: "0", max: "1", value: t.margin ?? 0.25 })),
        h("label", { class: "flab", title: t.kind === "text" ? "pass score (0..1) the read-vs-text match must reach (when text is set)" : "pass score (0..1) the tell must reach" },
            "threshold ", h("input", { type: "number", class: "tset", dataset: { k: "threshold" }, step: "0.05", min: "0", max: "1", value: t.threshold ?? 0.5 })),
        !staticOn && h("label", { class: "flab", title: "use this tell to LOCATE rows (anchor the grid) — only one tell per item locates" },
            "locate ", h("input", { type: "checkbox", class: "tloc", checked: !!t.locate })),
        (t.locate && !staticOn) && frag(
            h("label", { class: "flab", title: "vertical anchor: which line of a wrapped name fixes the ROW" },
                "align y ", tset("align", ["none", "top", "center", "bottom"], t.align || it.align, "center")),
            h("label", { class: "flab", title: "horizontal anchor: which edge of the text fixes the COLUMN — pick the side the text is aligned to in the cell. Lets columns be found from content, immune to blank data-area margins." },
                "align x ", tset("align_x", ["left", "center", "right"], t.align_x || it.align_x, "left"))),
        h("div", { class: "gn-foot" }));
    return { title: h("input", { class: "gi gi-id", dataset: { k: "tellid" }, value: t.id, title: "tell id" }), body };
}

export function itemLists(it, w) {
    // tells are their OWN nodes now — the item lists only a compact summary (id + kind + remove);
    // the full per-tell editor lives on each tell node (itemTellParts). Mirrors fieldsSummary below.
    const tellsSummary = (it.tells || []).map((t) => h("div", { class: "ti-sum", dataset: { tid: t.id }, title: "select this tell's node" },
        h("span", { class: "ti-sum-name" }, t.id),
        h("span", { class: "ti-sum-kind muted" }, t.kind),
        h("button", { class: "ti-del danger", dataset: { tid: t.id }, title: "remove" }, TRASH())));
    // fields flagged as tells (f.tell) show here too, read-only — they're edited in the fields
    // list below; the only action is remove, which just unchecks the field's tell flag.
    const fieldTells = (it.fields || []).filter((f) => f.tell).map((f) => h("div", { class: "ti-row ti-fieldtell", dataset: { fid: f.id } },
        h("span", { class: "ti-kind" }, "field"),
        h("span", { class: "ti-name" }, f.id),
        h("span", { class: "ti-ro muted" }, `tell · conf ${f.tell_conf ?? 0}`),
        h("button", { class: "ti-untell danger", dataset: { fid: f.id }, title: "stop using this field as a tell" }, TRASH())));
    // fields are their OWN nodes now — the item lists only a compact summary (name + remove);
    // the full per-field editor lives on each field node (itemFieldParts).
    const fieldsSummary = (it.fields || []).map((f) => h("div", { class: "if-sum", dataset: { fid: f.id }, title: "select this field's node" },
        h("span", { class: "if-sum-name" }, f.id),
        h("button", { class: "if-del danger", dataset: { fid: f.id }, title: "remove" }, TRASH())));
    // the cutout draw-mode buttons, split by what they draw: cell under "cell", field under
    // "fields", every tell kind under "tells". Selecting one sets the active draw kind.
    const drawBtn = ([v, label, icon, tip]) => h("button", { class: "tool", dataset: { kind: v }, title: tip || `draw ${label}` }, icon, " ", label);
    // copy w/h from the priority-0 base cell — sits next to the cell draw button (non-base only)
    const matchBtn = (it.priority || 0) === 0 ? null
        : h("button", { class: "csize-match", title: "copy width & height from the base cell (priority 0 — the bottom template, the static grid's base pitch)" }, "match base");
    const cellBtns = [ITEM_KINDS.filter(([v]) => v === "bbox").map(drawBtn), matchBtn];
    const fieldBtns = ITEM_KINDS.filter(([v]) => v === "field").map(drawBtn);
    const tellBtns = ITEM_KINDS.filter(([v]) => v !== "bbox" && v !== "field").map(drawBtn);
    return frag(
        h("div", { class: "muted il-h" }, "cell"),
        h("div", { class: "il-tools" }, cellBtns),
        cellSizeControls(it),
        h("div", { class: "muted il-h" }, "tells"),
        h("div", { class: "il-tools" }, tellBtns),
        (tellsSummary.length || fieldTells.length) ? [tellsSummary, fieldTells] : h("div", { class: "muted" }, "draw a tell on the cutout"),
        h("div", { class: "muted il-h" }, "fields"),
        h("div", { class: "il-tools" }, fieldBtns),
        fieldsSummary.length ? fieldsSummary : h("div", { class: "muted" }, "draw a field on the cutout"),
        keySection(it, w));
}

// The item's record key (dedup identity): which fields identify a record, in what
// order, joined how. Live preview = the key the LAST cutout read would store under,
// recomputed instantly on every config edit (client mirror of the server's KeySpec);
// the server's own key shows in the read-out after the next read.
export function keySection(it, w) {
    const eff = model.effectiveItemKey(w.id, it.id);
    const used = eff.fields && eff.fields.length ? eff.fields : [];
    const fids = [...new Set((it.fields || []).map((f) => f.field))];
    const rows = used.length
        ? used.map((fid, i) => h("div", { class: "key-row", dataset: { i } },
            h("select", { class: "kfield", dataset: { i } },
                (fids.includes(fid) ? fids : [fid, ...fids]).map((f) => h("option", { selected: f === fid }, f))),
            h("button", { class: "kmv", dataset: { i, d: "-1" }, disabled: i === 0, title: "earlier in the key" }, "▲"),
            h("button", { class: "kmv", dataset: { i, d: "1" }, disabled: i === used.length - 1, title: "later in the key" }, "▼"),
            h("button", { class: "kdel danger", dataset: { i }, disabled: used.length <= 1, title: "remove from the key" }, TRASH())))
        : h("div", { class: "key-row muted", title: "no fields yet — draw a field on the cutout to key on it" }, "—");
    const addable = fids.filter((f) => !used.includes(f));
    return frag(
        h("div", { class: "muted il-h", title: "which fields identify a record — reads with the same key merge; a different key (e.g. another level) is its own record. A record missing any key part is dropped." }, "key"),
        h("label", { class: "flab", title: "joins the parts in the stored key" },
            "separator ", h("input", { class: "ksep", value: eff.sep ?? "|", size: "2" })),
        addable.length && h("label", { class: "flab", title: "add a field to the key" },
            "+ field ", h("select", { class: "kadd" }, h("option", { value: "" }, "field…"), addable.map((f) => h("option", f)))),
        h("label", { class: "flab", title: "treat keys differing only in case as distinct" },
            "is case-sensitive ", h("input", { type: "checkbox", class: "kcase", checked: !!eff.case_sensitive })),
        rows);
}

// The key the LAST cutout read would store under — recomputed instantly from the
// cached read on every key-config edit (client mirror of the server's KeySpec),
// refreshed again when the automatic cutout read lands. Returns a node, or null when no read.
export function keyPrevNode(winId, itemId) {
    const it = model.item(winId, itemId), w = model.window(winId);
    const rd = itemReads.get(`${winId}:${itemId}`);
    if (!it || !w || !rd) return null;
    const eff = model.effectiveItemKey(winId, itemId);
    const vals = {};
    for (const [k, v] of Object.entries(rd.fields || {})) vals[k] = v.value;
    const key = buildKey(vals, eff);
    if (key !== null) return h("b", { class: "conf-ok" }, key);   // label ("key:") is the readout grid's job now
    const used = eff.fields && eff.fields.length ? eff.fields : [];
    const miss = used.find((f) => vals[f] === null || vals[f] === undefined || vals[f] === "");
    return frag(
        h("span", { class: "tc-bad" }, `∅ no key${miss ? ` — ${miss} read empty` : ""}`),
        " ",
        h("span", { class: "muted" }, "(record dropped)"));
}

export function nodeParts(n) {
    if (n.type === "game") {
        const g = n.ref;
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "name" }, value: g.name, title: "game name" }),
            body: frag(
                h("label", { class: "flab" }, "process ",
                    h("input", { class: "gi", dataset: { k: "proc" }, value: (g.process_names || []).join(", "), placeholder: "Warframe.x64.exe" })),
                h("label", { class: "flab" }, "title hint ",
                    h("input", { class: "gi", dataset: { k: "title" }, value: g.window_title_hint || "", placeholder: "Warframe" }))),
        };
    }
    if (n.type === "window") {
        const w = n.ref;
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "winid" }, value: w.id }),
            head: satToggleBtn(`prev:${w.id}`, "preview"),
            body: frag(
                h("div", { class: "win-controls" }, windowControls(w)),
                h("div", { class: "win-img" })),
            ports: h("span", { class: "port out", title: "drag to a dataset to send this window's rows there" }),
        };
    }
    if (n.type === "region") {
        const f = n.field || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "regid" }, value: n.ref.id, title: "region / field id" }),
            body: frag(fieldConfigBody(f, "fset"), h("div", { class: "gn-foot" })),
        };
    }
    if (n.type === "detect") {
        const a = n.ref;
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "detid" }, value: a.id, title: "detector: all must match to capture" }),
            body: frag(
                h("label", { class: "flab" }, "text ",
                    h("input", { class: "aset", dataset: { k: "text" }, value: a.text || "", placeholder: "EQUIPMENT" })),
                h("label", { class: "flab", title: "how text is compared: partial=substring (loose); full=whole-string; exact=equal; prefix=starts-with" },
                    "mode ", h("select", { class: "aset", dataset: { k: "match" } },
                        h("option", { value: "partial", selected: (a.match ?? "partial") === "partial" }, "partial"),
                        h("option", { value: "full", selected: a.match === "full" }, "full"),
                        h("option", { value: "exact", selected: a.match === "exact" }, "exact"),
                        h("option", { value: "prefix", selected: a.match === "prefix" }, "prefix"))),
                h("label", { class: "flab" }, "threshold ",
                    h("input", { type: "number", class: "aset", dataset: { k: "thr" }, step: "0.05", min: "0", max: "1", value: a.threshold ?? 0.8 })),
                h("label", { class: "flab", title: "hard floor: reads shorter than this never match (kills tiny-blob false hits)" },
                    "min chars ", h("input", { type: "number", class: "aset", dataset: { k: "minchars" }, step: "1", min: "0", value: a.min_chars ?? 0 })),
                h("label", { class: "flab", title: "what to ignore before comparing (default: none — keep everything)" },
                    "strip ", h("select", { class: "aset", dataset: { k: "strip" } },
                        h("option", { value: "none", selected: (a.strip ?? "none") === "none" }, "none"),
                        h("option", { value: "alnum", selected: a.strip === "alnum" }, "alnum"),
                        h("option", { value: "spaces", selected: a.strip === "spaces" }, "spaces"))),
                h("label", { class: "flab" }, "case sensitive ",
                    h("input", { type: "checkbox", class: "aset", dataset: { k: "case" }, checked: !!a.case_sensitive, title: "off = fold case before comparing" })),
                h("div", { class: "detect-status muted" },
                    h("div", { class: "ds-verdict" }, "◯ —"),
                    h("div", { class: "ds-line ds-before", hidden: true }),
                    h("div", { class: "ds-line ds-after", hidden: true }),
                    h("div", { class: "ds-line ds-chars", hidden: true })),
                h("div", { class: "gn-foot" })),
        };
    }
    if (n.type === "item") {
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "itemid" }, value: n.ref.id, title: "item template" }),
            body: frag(h("div", { class: "item-img" }), h("div", { class: "item-lists" }, itemLists(n.ref, n.win))),
        };
    }
    if (n.type === "itemfield") return itemFieldParts(n);
    if (n.type === "itemtell") return itemTellParts(n);
    if (n.type === "scrollbar") return { title: "scrollbar", body: scrollbarParts(n) };
    if (n.type === "preview") {
        // live-read node — what the current layout would read from this window. Runs OCR
        // on demand (its own button, or the image's 👁), rendered inline.
        return {
            title: h("span", { class: "gi-id" }, `${n.ref.id} preview`),
            body: frag(
                h("div", { class: "nodehost scrollhost prev-host" },
                    h("p", { class: "muted", style: "padding:8px" }, "open the window image or edit it to preview what it reads")),
                h("div", { class: "gn-foot" },
                    h("button", { class: "prevcommit", title: "write these reads into the window's dataset (one revertable batch)" }, "commit to dataset"))),
        };
    }
    if (n.type === "vttable") {
        // A node's records grid, split out into its own satellite (dotted edge to the parent).
        // Dataset variant carries both the data + batches hosts (the parent's tabs pick which
        // shows); subset variant carries the single view host. Hosts keep the same classes the
        // parent used, so datanodes.js / refreshSubsetNode just look them up on this node instead.
        const r = n.ref;
        if (r.kind === "subset") {
            return {
                title: h("span", { class: "gi-id" }, `${r.id} data`),
                body: h("div", { class: "nodehost scrollhost sub-host" }, h("p", { class: "muted", style: "padding:8px" }, "loading…")),
            };
        }
        if (r.kind === "source") {
            // a file source's parse preview (what the current rules would produce, without writing)
            return {
                title: h("span", { class: "gi-id" }, `${r.id} preview`),
                body: frag(
                    h("div", { class: "src-prev-info muted" }),
                    h("div", { class: "nodehost scrollhost src-host" }, h("p", { class: "muted", style: "padding:8px" }, "edit the source or hit preview to parse"))),
            };
        }
        return {
            title: h("span", { class: "gi-id" }, `${r.ds} data`),
            head: slideToggle({ on: vtShowRemoved.get(r.ds) || false, cls: "vt-showrm", label: "removed", hidden: true, title: "show removed (no-longer-present) rows in the table + counts" }),
            body: frag(
                h("div", { class: "ds-tabs", role: "tablist" },
                    h("button", { class: "ds-tab on", dataset: { tab: "data" }, role: "tab" }, "data ", h("span", { class: "ds-tab-n data-n" })),
                    h("button", { class: "ds-tab", dataset: { tab: "batches" }, role: "tab", title: "this dataset's collection/save runs" }, "batches ", h("span", { class: "ds-tab-n bat-n" }))),
                h("div", { class: "nodehost scrollhost data-host" }, h("p", { class: "muted", style: "padding:8px" }, "loading…")),
                h("div", { class: "nodehost scrollhost bat-host" },
                    h("ul", { class: "history bat-list" }, h("li", { class: "muted" }, "loading…")),
                    h("div", { class: "bat-detail muted" }, "select a batch to see its events and what applying it changes"))),
        };
    }
    if (n.type === "subset") return subsetParts(n.ref);
    if (n.type === "producer") return producerParts(n.ref, model.producerSourceColumns(n.ref), model.producerJoinable(n.ref));
    if (n.type === "filesource") return { ...sourceParts(n.ref), head: satToggleBtn(`vt:src:${n.ref.id}`, "vttable") };
    if (n.type === "trigger") return triggerParts(n.ref, model);
    if (n.type === "dictionary") {
        // a named word list. Text reads snap to the closest entry (exact, then fuzzy). The
        // terms live in config/dictionaries/<source>; this node just references that file.
        const dict = n.ref;
        const count = (dict.terms || []).length;
        const src = dict.source || "—";
        const missing = !count && dict.source;   // a referenced file that resolved to nothing
        return {
            title: h("input", { class: "gi gi-id dictname", value: dict.name || dict.id, title: "dictionary name" }),
            body: frag(
                h("div", { class: "muted" },
                    `${count} word${count === 1 ? "" : "s"} · file `,
                    h("code", src),
                    missing && h("span", { class: "warn" }, " · file missing")),
                h("div", { class: "nodehost scrollhost dict-host" },
                    h("textarea", { class: "dictterms", spellcheck: "false", autocomplete: "off", placeholder: "one word per line\nNeo V11\nSoma Prime\n…" },
                        (dict.terms || []).join("\n"))),
                h("div", { class: "gn-foot" })),
        };
    }
    // dataset — receives/stores rows, deduped by the keys the records arrive with.
    // The key itself is no concern of the dataset: it's taught on the item templates
    // (or windows) that read the records.
    const ds = n.ref;
    const noDedup = !model.datasetDedup(ds);
    const kf = model.datasetKeyField(ds);
    // pin the configured key field even if the feeder schema doesn't (yet) list it, so a key on a
    // field the feeders don't currently declare stays selected rather than snapping to the auto default.
    const kfields = model.datasetFields(ds);
    const keyFields = !noDedup && kf && !kfields.includes(kf) ? [...kfields, kf] : kfields;
    const keyOpts = [
        // empty = no dataset-level override; key comes from whatever feeds it (a window's/item's
        // key, a file source's, or a producer's — e.g. the relic producer's name|item|state).
        h("option", { value: "" }, "key: auto"),
        keyFields.map((f) => h("option", { value: f, selected: !noDedup && kf === f }, `key: ${f}`)),
        h("option", { value: "__nodedup__", selected: noDedup }, "no dedup (keep every read)"),
    ];
    const bm = model.datasetBatchMode(ds);
    const batchOpts = [["run", "per run"], ["detection", "per detection"]]
        .map(([v, l]) => h("option", { value: v, selected: bm === v }, l));
    const sm = model.datasetSyncMode(ds);
    const syncOpts = [["accumulate", "accumulate"], ["mirror", "mirror (sync removals)"]]
        .map(([v, l]) => h("option", { value: v, selected: sm === v }, l));
    return {
        title: h("input", { class: "gi gi-id dsrename", value: ds, title: "dataset name" }),
        head: satToggleBtn(`vt:ds:${ds}`, "vttable"),
        body: frag(
            h("div", { class: "lab-grid" },
                "1 → many",
                h("select", { class: "dskey", title: "the key the dataset collapses many reads on (or none)" }, keyOpts),
                "batch",
                h("select", { class: "dsbatch", title: "how a live run splits into revertable batches: one per run, or a new batch each time the window is freshly detected (transient per-event screens like a timed offer / pop-up)" }, batchOpts),
                "sync",
                h("select", { class: "dssync", title: "accumulate: only add/update. mirror: keep the dataset equal to the live screen — a row gone from its visible scroll slice is removed (soft). Needs the feeding window's scrollbar drawn so the visible slice can be located (or a list that fits one screen)." }, syncOpts)),
            h("div", { class: "gn-foot" },
                h("button", { class: "dsclone" }, "clone"),
                h("button", { class: "dsclear danger" }, "clear data"))),
        ports: h("span", { class: "port out", title: "drag to a subset to feed it this dataset" }),
    };
}

// Friendly timestamp for a dataset's last change: clock time if today, else date.
export function fmtWhen(ts) {
    const t = String(ts);
    const today = new Date().toISOString().slice(0, 10);
    return t.slice(0, 10) === today ? t.slice(11, 16) : t.slice(0, 10);
}

// HH:MM:SS from an ISO timestamp — drops fractional seconds AND the timezone suffix (+00:00).
export function clockTime(ts) { const m = /T(\d{2}:\d{2}:\d{2})/.exec(String(ts || "")); return m ? m[1] : ""; }

// Render <option> NODES for `opts`, marking `sel` selected, and PIN `sel` into the list when the
// current option set doesn't include it — a saved value (renamed field, `_seq`, a column a live
// join hasn't surfaced yet) stays selected instead of snapping to the first option and being lost
// on the next edit. The one place every column/field dropdown gets this behaviour. Returns an ARRAY.
export function _optList(opts, sel) {
    const all = sel && !opts.includes(sel) ? [...opts, sel] : opts;
    return all.map((c) => h("option", { selected: c === sel }, c));
}

export function _colOpts(cols, sel) {
    return [h("option", { value: "", selected: !sel }, "—"), ..._optList(cols, sel)];
}
