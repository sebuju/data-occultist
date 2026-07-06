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
import { h, frag, svg, TRASH, PLUS, COPY, PASTE, kv, subhead, gspan, srcRow, btn, iconBtn, trashBtn } from "../dom.js";
import { confMeter } from "./meter.js";
import { buildKey } from "../keys.js";
import { model, itemReads } from "./state.js";
import { ITEM_KINDS } from "./imaging.js";
import { producerParts } from "./producer_node.js";
import { sourceParts } from "./source_node.js";
import { toastParts } from "./toast_node.js";
import { soundParts } from "./sound_node.js";
import { triggerParts } from "./trigger_node.js";
import { sourcesInput } from "./sources_input.js";
import { subsetParts } from "./main.js";

// Header toggle button that shows/hides a node's opt-in satellite (preview / vt-table).
// `.gn-sat-tog` carries the satellite id; main.js wires every one through model.toggleSatellite.
const SAT_EYE = () => svg("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" },
    svg("path", { fill: "currentColor", d: "M8 3.5C4.5 3.5 1.7 5.7.5 8c1.2 2.3 4 4.5 7.5 4.5S14.3 10.3 15.5 8C14.3 5.7 11.5 3.5 8 3.5zm0 7.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z" }));
const SAT_GRID = () => svg("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" },
    svg("path", { fill: "none", stroke: "currentColor", "stroke-width": "1.3", d: "M2.5 2.5h11v11h-11zM2.5 6.5h11M2.5 10h11M6.5 2.5v11" }));
// dismissed-rows grid: a table glyph struck through (these are the rows a required field rejected)
const SAT_DISMISS = () => svg("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" },
    svg("path", { fill: "none", stroke: "currentColor", "stroke-width": "1.3", d: "M2.5 2.5h11v11h-11zM2.5 6.5h11M6.5 2.5v11" }),
    svg("path", { fill: "none", stroke: "currentColor", "stroke-width": "1.4", d: "M3 13L13 3" }));
const _SAT_LABEL = { preview: "preview", dismissed: "dismissed rows", vttable: "data table", producer: "preview (inputs + test fetch)" };
const _SAT_ICON = { preview: SAT_EYE, dismissed: SAT_DISMISS };
export function satToggleBtn(satId, kind) {
    const on = model.satelliteOn(satId);
    const title = `${on ? "hide" : "show"} ${_SAT_LABEL[kind] || "data table"}`;
    return h("button", {
        class: `gn-sat-tog gn-cog${on ? " on" : ""}`, dataset: { sat: satId },
        title, "aria-label": title, "aria-pressed": on,
    }, (_SAT_ICON[kind] || SAT_GRID)());
}

// A slide toggle: now a NATIVE checkbox (base.css renders every checkbox as a slide switch,
// node-tinted via graph.css --nt) — one toggle primitive, no bespoke SVG switch (rule 7). `cls` =
// caller class for positioning/wiring; optional `label` (wraps checkbox + text in a <label>);
// `hidden` starts it display:none (revealed later, e.g. once data shows it's relevant). Handlers
// read `.checked` on the `change` event (the class stays on the checkbox even when labelled).
export function slideToggle({ on, title, cls = "", label = "", hidden = false }) {
    const box = h("input", { type: "checkbox", class: `gn-slide ${cls}`.trim(), checked: on, title });
    const root = label ? h("label", { class: "gn-slide-wrap" }, box, h("span", { class: "gn-slide-lbl" }, label)) : box;
    if (hidden) root.hidden = true;
    return root;
}

// per-dataset "show removed (no-longer-present) rows" flag for the vt-table satellite (default
// off). Toggle lives in the satellite header; datanodes reads this to filter present===false rows.
export const vtShowRemoved = new Map();

export const TYPES = [["text", "text"], ["number", "number"], ["pips", "pips"], ["diamonds", "diamonds (rank)"]];
export const EXTRACTS = ["whole", "number", "number_before", "number_after", "text_before", "text_after"];
export const NEEDS_SEP = new Set(["number_before", "number_after", "text_before", "text_after"]);
// how the game dictionary participates in a ``dictionary`` rule (FieldRule.dict_mode)
export const DICT_MODES = [
    ["off", "off"],
    ["correct", "correct"],
    ["drop", "drop"],
    ["correct_drop", "correct + drop"],
];

// The rule pipeline (FieldRule). The raw read flows top-to-bottom through a field's rules;
// each fires when its `when` holds against the CURRENT value, then its `then` rewrites the
// value (and flow continues) or `drop` early-returns (record dropped). Which ops a field can
// use depends on its type — the codes gate the menus (see okRuleType), mirroring the plan's
// type table. Codes: any | t=text | n=number | tn=text+number | nc=number+count(pips/diamonds).

// condition (`when`): [value, label, needsArg, typeCode]
export const RULE_WHEN = [
    ["always", "always", false, "any"],
    ["empty", "is empty", false, "any"],
    ["no_digit", "has no digit", false, "tn"],
    ["all_digit", "is all digits", false, "tn"],
    ["has_digit", "has a digit", false, "tn"],
    ["no_letter", "has no letter", false, "tn"],
    ["all_letter", "is all letters", false, "tn"],
    ["has_letter", "has a letter", false, "tn"],
    ["below", "if below", true, "nc"],
    ["above", "if above", true, "nc"],
    ["equal", "if equal", true, "any"],
    ["not_equal", "if not equal", true, "any"],
    ["contains", "if contains", true, "t"],
];
// action (`then`): [value, label, typeCode]
export const RULE_THEN = [
    ["set", "set value", "any"],
    ["drop", "drop", "any"],
    ["lowercase", "lowercase", "t"],
    ["uppercase", "uppercase", "t"],
    ["fold", "fold accents", "t"],
    ["round", "round", "n"],
    ["floor", "floor", "n"],
    ["ceil", "ceil", "n"],
    ["extract", "extract", "tn"],
    ["dictionary", "dictionary", "t"],
];
const RULE_WHEN_ARG = new Set(RULE_WHEN.filter((r) => r[2]).map((r) => r[0]));
const WHEN_CODE = Object.fromEntries(RULE_WHEN.map(([v, , , c]) => [v, c]));
const THEN_CODE = Object.fromEntries(RULE_THEN.map(([v, , c]) => [v, c]));

// whether a rule op's type code is allowed for a field of `ftype` (see the codes above)
export function okRuleType(code, ftype) {
    if (code === "any") return true;
    const isText = ftype === "text", isNum = ftype === "number";
    const isCount = ftype === "pips" || ftype === "diamonds";
    if (code === "t") return isText;
    if (code === "n") return isNum;
    if (code === "tn") return isText || isNum;
    if (code === "nc") return isNum || isCount;
    return false;
}

// whether a whole rule fits `ftype` (its when AND then are both valid) — a rule that doesn't
// is shown greyed and IGNORED by the executor (mirrors oc.collect.fields.rule_applies).
export function ruleValidForType(r, ftype) {
    return okRuleType(WHEN_CODE[r.when || "always"] ?? "any", ftype)
        && okRuleType(THEN_CODE[r.then || "set"] ?? "any", ftype);
}

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
        kv("static grid", h("input", { type: "checkbox", class: "winstatic", checked: w.static_grid !== false }),
            { title: "item rows: static tiles the data area into a fixed grid from the cell size (no OCR for location); off locates rows by OCR (a tell/locate field) — only needed for a scroll-parked list" }),
        kv("auto-scroll", h("input", { type: "checkbox", class: "winscroll", dataset: { k: "autoscroll" }, checked: !!sc.autoscroll }),
            { title: "precapture auto-scrolls this window's list while recording it" }),
        sc.autoscroll && kv("auto-scroll clicks", h("input", { type: "number", class: "winscroll", dataset: { k: "clicks" }, value: sc.scroll_clicks ?? 1, min: "1" }),
            { title: "wheel notches sent per auto-scroll nudge" }),
        kv("live", h("input", { type: "checkbox", class: "winlive", checked: w.live !== false }),
            { title: "attempt this window in live view" }),
        preprocessControls(w),
        windowItemOrder(w),
        windowDetects(w));
}

// Window-level OCR preprocess ("Text appearance"): clean the crop before reading so stylised
// game text is legible. `color` masks the taught text color(s) (eyedropper or hex) to clean
// black-on-white; `threshold` is global Otsu; `invert` flips light-on-dark; `scale` upsamples
// small fonts. Ported from the old teach page. Handlers live in main.js wireWindowControls.
const PP_MODES = [["none", "none"], ["color", "keep text color(s)"],
    ["threshold", "auto threshold"], ["invert", "invert"]];

export function preprocessControls(w) {
    const pp = w.preprocess || { mode: "none", colors: [], tolerance: 60, scale: 1.0 };
    const chips = (pp.colors || []).map((c, i) => h("span", { class: "pp-chip", style: `border-color:${c}` },
        h("span", { class: "pp-sw", style: `background:${c}` }),
        trashBtn({ cls: "pp-cx", dataset: { i }, title: "remove color" })));
    return frag(
        kv("preprocess", h("select", { class: "ppmode" },
            PP_MODES.map(([v, t]) => h("option", { value: v, selected: pp.mode === v }, t))),
            { title: "preprocess the crop before OCR: threshold = auto black/white (good default), color = keep only the taught text color(s), invert = flip light-on-dark" }),
        pp.mode === "color" && h("div", { class: "pp-color" },
            h("div", { class: "pp-chips" }, chips.length ? chips : h("span", { class: "muted" }, "no colors yet")),
            h("div", { class: "pp-row" },
                h("button", { class: "pp-pick", title: "sample the text color from the open image" }, "⊙ pick"),
                h("input", { class: "pp-hex", placeholder: "#ffffff", style: "width:9ch" }),
                h("button", { class: "pp-add" }, "add")),
            kv("tolerance", h("input", { type: "range", class: "pptol", min: "10", max: "200", value: pp.tolerance ?? 60 }),
                { title: "how close a pixel must be to a taught color to be kept" })),
        kv("upscale", h("input", { type: "number", class: "ppscale", step: "0.5", min: "1", max: "4", value: pp.scale ?? 1 }),
            { title: "upscale the crop before OCR — helps small fonts" }));
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
                kv("rows from top", h("input", { type: "number", class: "sbcut", dataset: { k: "rows", i }, value: s.rows ?? 0, min: "0" })),
                trashBtn({ cls: "sbcut-rm", dataset: { i }, title: "remove cutout" })),
            h("div", { class: "sb-cut-pos muted" }, s.pos != null ? `thumb ${(s.pos * 100).toFixed(2)}% · ${s.px ?? "?"}px` : "thumb —")));
    return frag(
        kv("orientation", h("select", { class: "sbset", dataset: { k: "orient" } },
            h("option", { selected: o === "vertical" }, "vertical"),
            h("option", { selected: o === "horizontal" }, "horizontal"))),
        subhead("cutouts", null, "capture the scrollbar at known scroll offsets, tag each with how many rows it has moved down from the top — the gain is fit automatically. Drag to reorder."),
        h("div", { class: "sb-cuts" }, samples.length
            ? samples.map(cut)
            : h("p", { class: "muted", style: "margin:2px 0" }, "no cutouts — open the window image, scroll, capture")),
        h("div", { class: "sb-cut-acts" },
            h("button", { class: "sb-capture", title: "crop the scrollbar from the open window image into a new cutout" }, "capture cutout")),
        samples.length ? h("div", { class: "sb-lock muted", title: "each cutout was cropped at the box's current position — moving the box would silently invalidate them all. Remove every cutout to unlock, or delete this node to reset box + cutouts." }, "box position locked by cutouts") : null,
        h("div", { class: "detect-status muted" }, "position: —"),
        h("div", { class: "sb-calib" },
            h("div", { class: "sbc-row", title: "scrollable rows = rows of content per full thumb travel, fit from the cutouts" },
                "rows ", h("span", { class: "sbc-gain" }, gain != null ? `${gain}` : "—")),
            h("div", { class: "sbc-row" }, "cutouts ", h("span", {}, `${usable}/${samples.length}`))));
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
// The detectors section of a window node (`opts`: heading, matchLabel, defaultMode, collide).
// The owner object just needs `.detect` + `.detect_mode`.
export function windowDetects(w, opts = {}) {
    const dets = w.detect || [];
    if (!dets.length) return null;
    const mode = w.detect_mode || opts.defaultMode || "all";
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
        subhead(opts.heading || "detects", null, "how these detectors decide a match"),
        kv(opts.matchLabel || "window matches if", modeSel),
        h("div", { class: "wd-row wd-head muted" },
            h("span", { class: "wd-name" }, "detector"),
            h("span", { class: "wd-status" }, "pass"),
            h("span", { class: "wd-req-h" }, "require")),
        rows,
        h("div", { class: "wd-verdict muted", title: opts.verdictTitle || "whether the current capture would be recognised as this window with the settings above" }),
        opts.collide === false ? null
            : h("div", { class: "wd-collide", title: "cross-window: detection picks ONE winner across all windows — does this window actually win, or does a sibling also match / steal it" }));
}

// The ▲/▼ move pair shared by every reorderable list — priority rows AND rule rows (rule 7:
// one primitive, many callers, no copied markup). `data` tags each button so the caller's
// handler resolves the target; the ends are disabled. HIGHEST/first on top.
export function moveButtons(i, count, mvCls, data, { upTitle, downTitle } = {}) {
    return frag(
        h("button", { class: `btn-icon ${mvCls}`, dataset: { ...data, d: "-1" }, disabled: i === 0, title: upTitle || "move up" }, "▲"),
        h("button", { class: `btn-icon ${mvCls}`, dataset: { ...data, d: "1" }, disabled: i === count - 1, title: downTitle || "move down" }, "▼"));
}

// One reorderable priority row: a name + ▲/▼, HIGHEST on top. Shared by the item-template
// priority list AND the window-priority list. The caller passes the wiring-hook classes
// (row/name/move) so main.js binds the right move + name-jump handlers, and the tooltips.
function priorityRow(id, i, count, { rowCls, nameCls, mvCls, nameTitle, upTitle, downTitle, dot }) {
    return h("div", { class: rowCls, dataset: { id } },
        dot && h("span", { class: "live-wdot", title: "live off" }),   // live-recognition dot (wp-rows only); syncWpDots toggles .on
        h("span", { class: nameCls, title: nameTitle }, id),
        moveButtons(i, count, mvCls, { id }, { upTitle, downTitle }));
}

// Item templates listed in PRIORITY order, HIGHEST first — the top row wins when cells
// overlap a tile; the BOTTOM row is priority 0 (the static grid's base cell, which sets the
// grid pitch). Reordering IS how priority is set; the number itself is never shown. Click a
// name to jump to that item's node.
export function windowItemOrder(w) {
    const items = [...(w.items || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    if (!items.length) return null;
    const rows = items.map((it, i) => priorityRow(it.id, i, items.length, {
        rowCls: "wi-row", nameCls: "wi-name", mvCls: "wimv",
        nameTitle: "select this item's node",
        upTitle: "move up — higher priority (wins tile overlaps)",
        downTitle: "move down — lower priority (bottom = base cell, sets the grid pitch)" }));
    return frag(
        subhead("templates", null, "template priority order — highest on top (wins tile overlaps); the bottom template is the base cell that sets the grid pitch"),
        rows);
}

// The cell size (item.box w/h, window fractions) shown as editable inputs below the cutout
// canvas. Under static grid this IS the grid pitch (column/row spacing); the cell's position
// is unused. Editing reuses setItemCellKeepingChildren so fields/tells stay visually put.
export function cellSizeControls(it) {
    const b = it.box || { w: 0, h: 0 };
    const v = (n) => +(+n || 0).toFixed(4);
    return frag(
        kv("width", h("input", { type: "number", class: "csize", dataset: { k: "w" }, step: "0.001", min: "0.001", value: v(b.w) }),
            { title: "cell width as a window fraction — the static grid's column pitch" }),
        kv("height", h("input", { type: "number", class: "csize", dataset: { k: "h" }, step: "0.001", min: "0.001", value: v(b.h) }),
            { title: "cell height as a window fraction — the static grid's row pitch" }),
        coverControls(it));
}

// Occlusion guard (per item): how much of the cell must sit INSIDE the data area, per axis, for
// the record to be stored. A row the scroll clips below this is dismissed (and marked on the
// canvas) — guards against reading a half-visible top/bottom row. Shown as a percent (stored
// 0..1). Does NOT affect grid location, only the forwarded/stored data.
export function coverControls(it) {
    const pct = (n, d) => Math.round((n ?? d) * 100);
    return frag(
        kv("cover x %", h("input", { type: "number", class: "ccover", dataset: { k: "x" }, step: "5", min: "0", max: "100", value: pct(it.min_cover_x, 0.75) }),
            { title: "minimum % of the cell that must be inside the data area HORIZONTALLY to store the row — an edge column clipped past this is dismissed" }),
        kv("cover y %", h("input", { type: "number", class: "ccover", dataset: { k: "y" }, step: "5", min: "0", max: "100", value: pct(it.min_cover_y, 0.75) }),
            { title: "minimum % of the cell that must be inside the data area VERTICALLY to store the row — a top/bottom row the scroll occludes past this is dismissed" }));
}

// The operand input(s) a rule's `then` needs, shown inline after the action select. Only the
// relevant ones for the chosen action appear (a `drop`/`lowercase`/… needs none). `d` is the
// shared dataset ({ri, fid?}) the node wiring reads.
function ruleThenOperands(r, then, d) {
    if (then === "set")
        return [h("input", { class: "rule-val", dataset: d, value: r.value || "", placeholder: "value", title: "value written into the field" })];
    if (then === "extract")
        return [
            h("select", { class: "rule-strategy", dataset: d, title: "which piece to pull out of the value" },
                EXTRACTS.filter((v) => v !== "whole").map((v) => h("option", { value: v, selected: (r.strategy || "number") === v }, v))),
            NEEDS_SEP.has(r.strategy || "number") && h("input", { class: "rule-sep", dataset: d, value: r.sep || "/", placeholder: "sep", title: "split token (e.g. / or Rank)" }),
        ];
    if (then === "dictionary") {
        const hasDicts = (model.profile.dictionaries || []).length;
        const dmode = r.dict_mode || "correct";
        return [
            h("select", { class: "rule-dmode", dataset: d, title: "off = not consulted; correct = fix words; drop = validate only; correct + drop = fix, drop unmatchable" },
                DICT_MODES.map(([v, t]) => h("option", { value: v, selected: dmode === v }, t))),
            (hasDicts && dmode !== "off") && h("select", { class: "rule-udict", dataset: d, title: "which authored dictionary (all = every enabled one pooled)" }, dictOptions(r.dict_id || "")),
            dmode !== "off" && h("input", { type: "number", class: "rule-fuzzy", dataset: d, step: "0.05", min: "0", max: "1", value: r.fuzzy ?? 0.82, title: "similarity (0-1) an uncertain read must reach to snap to a known word" }),
        ];
    }
    return [];
}

// One field's RULE PIPELINE rows (FieldRule list) — the value flows top-to-bottom. Each row:
// ▲/▼ reorder, the `when` condition (+ its arg), the `then` action (+ its operands), delete;
// and a `.frule-trace` slot below the row that the node wiring fills with `in → out` from a
// live read of the current canvas. Menus are filtered to the field's type (okRuleType).
// `cls` is unused here (rules have their own classes); `fid` (item fields) tags each control.
export function ruleRows(fd, cls, fid) {
    const da = fid ? { fid } : {};
    const rules = fd.rules || [];
    const ftype = fd.type || "text";
    // every op is listed; ones invalid for this type are DISABLED (greyed) so the current value
    // still shows and can't be re-picked. `opts([v,label,code],...)` builds those <option>s.
    const opts = (list, cur, codeIdx) => list.map((row) => h("option",
        { value: row[0], selected: cur === row[0], disabled: !okRuleType(row[codeIdx], ftype) }, row[1]));
    if (!rules.length) return h("div", { class: "muted frule-empty" }, "no rules — the read passes through");
    return rules.map((r, i) => {
        const when = r.when || "always", then = r.then || "set";
        const d = { ri: i, ...da };
        const invalid = !ruleValidForType(r, ftype);   // whole rule doesn't fit -> greyed + ignored
        return h("div", { class: `frule${invalid ? " frule-invalid" : ""}`, dataset: { ri: i },
                          title: invalid ? "this rule doesn't apply to the field's type — greyed out and ignored" : "" },
            h("div", { class: "frule-head" },
                h("span", { class: "frule-n", title: `rule ${i + 1}` }, String(i + 1) + ".",
                    moveButtons(i, rules.length, "rulemv", d, { upTitle: "run earlier", downTitle: "run later" })),
                h("select", { class: "rule-when", dataset: d, title: "condition tested on the running value" },
                    opts(RULE_WHEN, when, 3)),
                RULE_WHEN_ARG.has(when) && h("input", { class: "rule-arg", dataset: d, value: r.arg || "", placeholder: "value", title: "value the condition compares against" }),
                h("span", { class: "rule-arrow muted" }, "→"),
                h("select", { class: "rule-then rule-op", dataset: d, title: "action when it matches (drop stops here; others rewrite the value and continue)" },
                    opts(RULE_THEN, then, 2)),
                ...ruleThenOperands(r, then, d),
                trashBtn({ cls: "rule-del", dataset: d, title: "remove this rule" })),
            h("div", { class: "frule-trace muted", dataset: d }));
    });
}

// The per-field config body, SHARED by the region / item-field / readout nodes (one renderer,
// not three copies). All value processing is authored in the rule PIPELINE below; only the
// capture/confidence knobs (type + isolate + glyph-check + conf) sit up top. `cls` is the
// wiring's change-class ("fset" | "ffset" | "roset"); `fid` (item fields) tags each control.
export function fieldConfigBody(fd, cls, fid) {
    const da = fid ? { fid } : {};
    const isText = (fd.type || "text") === "text";
    return frag(
        kv("type", h("select", { class: cls, dataset: { k: "type", ...da } }, TYPES.map(([v, t]) => h("option", { value: v, selected: fd.type === v }, t)))),
        kv("isolate", h("input", { type: "checkbox", class: cls, dataset: { k: "isolate", ...da }, checked: !!fd.isolate }),
            { title: "read this box in isolation: OCR only its own crop instead of picking tokens from the window-wide pass — use when a digit fuses with a neighbouring glyph (e.g. an '8' read as '81')" }),
        isText && kv("glyph-check", h("input", { type: "checkbox", class: cls, dataset: { k: "glyph_check", ...da }, checked: !!fd.glyph_check }),
            { title: "glyph-check: after OCR, match each cleanly-separated character against the game's taught glyph atlas and fix confident single-glyph misreads the dictionary can't (e.g. Q↔G where both are valid). Teach glyphs on the game node." }),
        kv("conf", confMeter({ cls, k: "minconf", value: fd.min_confidence ?? 0, fid }),
            { title: "minimum OCR confidence this field must reach — a weaker genuine read drops the whole record (0 = use the global floor). Drag the bar to set it." }),
        subhead("rules"),
        gspan("frule-list", ruleRows(fd, cls, fid)),
        h("div", { class: "frule-btns" },
            h("button", { class: "rulecopy", dataset: { ...da }, disabled: !(fd.rules || []).length, title: "copy this pipeline" }, COPY()),
            h("button", { class: "rulepaste", dataset: { ...da }, title: "replace all rules with the copied pipeline" }, PASTE()),
            h("button", { class: "ruleadd", dataset: { ...da }, title: "add a rule to the pipeline" }, PLUS())));
}

// One item field is its OWN node (a child of its item node). It renders the shared
// per-field config (against the window's FieldDef) plus the row-role controls (tell /
// locate / align) that only make sense for a field inside an item template.
export function itemFieldParts(n) {
    const f = n.ref, fd = n.field || { type: "text", extract: "whole", fuzzy: 0.82 };
    const alignSel = (cls, vals, cur) => h("select", { class: cls, dataset: { fid: f.id } },
        vals.map((v) => h("option", { selected: cur === v }, v)));
    const body = frag(
        fieldConfigBody(fd, "ffset", f.id),
        subhead("row role"),
        kv("tell", h("input", { type: "checkbox", class: "itell", dataset: { fid: f.id }, checked: !!f.tell }),
            { title: "require this field to read something — it doubles as a tell" }),
        f.tell && kv("tell conf", confMeter({ cls: "itellconf", value: f.tell_conf ?? 0, fid: f.id }),
            { title: "minimum OCR confidence the read must reach (0 = any). Drag the bar to set it." }),
        (f.tell && fd.type === "number") && kv("allow text", h("input", { type: "checkbox", class: "itelltext", dataset: { fid: f.id }, checked: !!f.tell_allow_text }),
            { title: "pass the tell even when the read carries text (e.g. a unit symbol or glyph), not only a clean number" }),
        kv("locate", h("input", { type: "checkbox", class: "iloc", dataset: { fid: f.id }, checked: !!f.locate }),
            { title: "use this field to LOCATE rows (anchor the grid) — independent of tell; a reliable text field (e.g. the name) can locate without being a tell" }),
        (f.tell || f.locate) && frag(
            kv("align y", alignSel("itellalign", ["none", "top", "center", "bottom"], f.align || n.item.align || "center"),
                { title: "vertical anchor: which line of a wrapped name fixes the ROW" }),
            kv("align x", alignSel("itellalignx", ["left", "center", "right"], f.align_x || n.item.align_x || "left"),
                { title: "horizontal anchor: which edge of the text fixes the COLUMN — pick the side the text is aligned to in the cell (e.g. left for a left-aligned name). Lets columns be found from content, immune to blank data-area margins." })));
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
            kv("checks", h("select", { class: "tset", dataset: { k: "field" } }, _colOpts((it.fields || []).map((f) => f.field), t.field)),
                { title: "which field's read this tell checks. Leave blank (—) to check ANY column's read — the tell isn't tied to one field." }),
            kv("text", h("input", { class: "tset", dataset: { k: "text" }, value: t.text || "", placeholder: "(any)" }),
                { title: "optional: require the read to MATCH this text (scored like a detector). Empty = just needs to read SOMETHING (the chosen field, or any column when blank). NOTE: an empty-text tell bound to a field is identical to flagging that field 'tell' — use the field's own tell flag instead." }),
            (t.text || "").trim() && frag(
                kv("mode", tset("match", ["partial", "full", "exact", "prefix"], t.match, "partial"),
                    { title: "how text is compared: partial=substring (loose); full=whole-string; exact=equal; prefix=starts-with" }),
                kv("min chars", h("input", { type: "number", class: "tset", dataset: { k: "minchars" }, step: "1", min: "0", value: t.min_chars ?? 0 }),
                    { title: "hard floor: reads shorter than this never match (kills tiny-blob false hits)" }),
                kv("strip", tset("strip", ["alnum", "spaces", "none"], t.strip, "alnum"),
                    { title: "what to ignore before comparing" }),
                kv("case sensitive", h("input", { type: "checkbox", class: "tset", dataset: { k: "case" }, checked: !!t.case_sensitive }),
                    { title: "off = fold case before comparing" }))),
        (t.kind === "color" || t.kind === "border") && kv("color", h("input", { type: "color", class: "tset", dataset: { k: "color" }, value: t.color || "#ffcc00" }),
            { title: t.kind === "border" ? "the color that must ride the box's perimeter band" : "the color that must be present in the tell box" }),
        t.kind === "border" && kv("width", h("input", { type: "number", class: "tset", dataset: { k: "width" }, step: "0.02", min: "0", max: "0.5", value: t.width ?? 0.2 }),
            { title: "thickness of the sampled perimeter band, as a fraction (0..1) of the box's shorter side. Only this ring is checked for the color; the fill is ignored." }),
        t.kind === "template" && h("div", { class: "tt-ref", title: "the saved sub-image this tell matches — the tell box cropped from the item's frozen cutout" },
            it.cutout ? h("canvas", { class: "tt-ref-canvas" }) : h("div", { class: "muted" }, "no cutout yet")),
        t.kind === "template" && kv("margin", h("input", { type: "number", class: "tset", dataset: { k: "margin" }, step: "0.05", min: "0", max: "1", value: t.margin ?? 0.25 }),
            { title: "search margin: how far the live crop grows beyond the box (per side, as a fraction of the box) so the saved image is found even when the located cell drifts a few px. 0 = match the exact box only." }),
        kv("threshold", h("input", { type: "number", class: "tset", dataset: { k: "threshold" }, step: "0.05", min: "0", max: "1", value: t.threshold ?? 0.5 }),
            { title: t.kind === "text" ? "pass score (0..1) the read-vs-text match must reach (when text is set)" : "pass score (0..1) the tell must reach" }),
        !staticOn && kv("locate", h("input", { type: "checkbox", class: "tloc", checked: !!t.locate }),
            { title: "use this tell to LOCATE rows (anchor the grid) — only one tell per item locates" }),
        (t.locate && !staticOn) && frag(
            kv("align y", tset("align", ["none", "top", "center", "bottom"], t.align || it.align, "center"),
                { title: "vertical anchor: which line of a wrapped name fixes the ROW" }),
            kv("align x", tset("align_x", ["left", "center", "right"], t.align_x || it.align_x, "left"),
                { title: "horizontal anchor: which edge of the text fixes the COLUMN — pick the side the text is aligned to in the cell. Lets columns be found from content, immune to blank data-area margins." })));
    return { title: h("input", { class: "gi gi-id", dataset: { k: "tellid" }, value: t.id, title: "tell id" }), body };
}

// A readout is ONE self-contained node: it owns its box and its read config inline
// (fieldConfigBody, exactly like a region node), reading a LIVE, non-persisted value the
// triggers can watch. The live value shows in `.ro-live` (updated in place from the
// heartbeat, never persisted), next to what the current image would read (`.ro-preview`).
export function readoutParts(n) {
    const v = n.ref;
    const fd = n.field || { type: "number", extract: "whole", fuzzy: 0.82 };
    const body = frag(
        fieldConfigBody(fd, "roset", fd.id),   // the box's read config, like a region node
        subhead("live value"),
        h("div", { class: "ro-live muted", dataset: { ro: v.id } }, "—"));   // updated in place from the heartbeat
    return {
        title: h("input", { class: "gi gi-id", dataset: { k: "roid" }, value: v.id,
            title: "readout id — what a trigger watches and a toast tokens as {{readout:id}}" }),
        body,
        // drag this readout's out-port onto a toast to feed it the live value as {{readout:id}}
        ports: h("span", { class: "port out", title: "drag to a toast to feed it this readout's live value" }),
    };
}

export function itemLists(it, w) {
    // tells are their OWN nodes now — the item lists only a compact summary (id + kind + remove);
    // the full per-tell editor lives on each tell node (itemTellParts). Mirrors fieldsSummary below.
    const tellsSummary = (it.tells || []).map((t) => h("div", { class: "ti-sum", dataset: { tid: t.id }, title: "select this tell's node" },
        h("span", { class: "ti-sum-name" }, t.id),
        h("span", { class: "ti-sum-kind muted" }, t.kind),
        trashBtn({ cls: "ti-del", dataset: { tid: t.id }, title: "remove" })));
    // fields flagged as tells (f.tell) show here too, read-only — they're edited in the fields
    // list below; the only action is remove, which just unchecks the field's tell flag.
    const fieldTells = (it.fields || []).filter((f) => f.tell).map((f) => h("div", { class: "ti-row ti-fieldtell", dataset: { fid: f.id } },
        h("span", { class: "ti-kind" }, "field"),
        h("span", { class: "ti-name" }, f.id),
        h("span", { class: "ti-ro muted" }, `tell · conf ${f.tell_conf ?? 0}`),
        trashBtn({ cls: "ti-untell", dataset: { fid: f.id }, title: "stop using this field as a tell" })));
    // fields are their OWN nodes now — the item lists only a compact summary (name + remove);
    // the full per-field editor lives on each field node (itemFieldParts).
    const fieldsSummary = (it.fields || []).map((f) => h("div", { class: "if-sum", dataset: { fid: f.id }, title: "select this field's node" },
        h("span", { class: "if-sum-name" }, f.id),
        trashBtn({ cls: "if-del", dataset: { fid: f.id }, title: "remove" })));
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
        subhead("cell"),
        h("div", { class: "il-tools" }, cellBtns),
        cellSizeControls(it),
        kv("terminator", h("input", { type: "checkbox", class: "iterm", checked: !!it.terminator }),
            { title: "terminator: when this template is detected it marks the END of the list — every record positioned after it is discarded (an unowned/'no more results' placeholder). Ordered scroll/mirror datasets only." }),
        subhead("tells"),
        h("div", { class: "il-tools" }, tellBtns),
        (tellsSummary.length || fieldTells.length) ? [tellsSummary, fieldTells] : h("div", { class: "muted" }, "draw a tell on the cutout"),
        subhead("fields"),
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
            h("button", { class: "btn-icon kmv", dataset: { i, d: "-1" }, disabled: i === 0, title: "earlier in the key" }, "▲"),
            h("button", { class: "btn-icon kmv", dataset: { i, d: "1" }, disabled: i === used.length - 1, title: "later in the key" }, "▼"),
            trashBtn({ cls: "kdel", dataset: { i }, disabled: used.length <= 1, title: "remove from the key" })))
        : h("div", { class: "key-row muted", title: "no fields yet — draw a field on the cutout to key on it" }, "—");
    const addable = fids.filter((f) => !used.includes(f));
    return frag(
        subhead("key", null, "which fields identify a record — reads with the same key merge; a different key (e.g. another level) is its own record. A record missing any key part is dropped."),
        kv("separator", h("input", { class: "ksep", value: eff.sep ?? "|", size: "2" }),
            { title: "joins the parts in the stored key" }),
        addable.length && kv("+ field", h("select", { class: "kadd" }, h("option", { value: "" }, "field…"), addable.map((f) => h("option", f))),
            { title: "add a field to the key" }),
        kv("is case-sensitive", h("input", { type: "checkbox", class: "kcase", checked: !!eff.case_sensitive }),
            { title: "treat keys differing only in case as distinct" }),
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

// Which kind a detector is, derived from which fields are set (the model has no explicit
// kind field — template/text are inferred, colour adds the colour fields). Single source so
// the node body, wiring, and live verdict all agree.
export function detectKind(a) {
    if (a.template) return "template";
    if (a.color != null && a.text == null) return a.width ? "border" : "color";
    return "text";
}

// The game node's WINDOW PRIORITY list: the live-toggled windows in recognition order, HIGHEST
// first. During gameplay the classifier tries them in this order and early-returns on the first
// match — cheaper than scoring every window, and it lands on the most important live screen (top
// row) first. Reordering IS how priority is set (▲/▼); the number is never shown. Only windows
// with `live` on appear here, and the list updates as that toggle flips on a window node.
// In its own builder so rebuildNode refreshes JUST this section (rule 7, mirrors windowItemOrder).
export function gamePriority() {
    const wins = model.liveWindowsInPriority();   // ordered live WindowDefs (priority first)
    const rows = wins.map((w, i) => priorityRow(w.id, i, wins.length, {
        rowCls: "wp-row", nameCls: "wp-name", mvCls: "wpmv", dot: true,
        nameTitle: "select this window's node",
        upTitle: "move up — higher priority (recognised sooner)",
        downTitle: "move down — lower priority" }));
    return frag(
        subhead("window priority", null, "live-toggled windows in recognition priority — the classifier tries them top-first and stops at the first match. Turn a window's 'live' on to add it here."),
        wins.length ? rows
            : h("p", { class: "muted", style: "margin:4px 0" }, "no live windows — turn on 'live' on a window to prioritise it"));
}

export function nodeParts(n) {
    if (n.type === "game") {
        const g = n.ref;
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "name" }, value: g.name, title: "game name" }),
            body: frag(
                kv("process", h("input", { class: "gi", dataset: { k: "proc" }, value: (g.process_names || []).join(", "), placeholder: "Warframe.x64.exe" })),
                kv("title hint", h("input", { class: "gi", dataset: { k: "title" }, value: g.window_title_hint || "", placeholder: "Warframe" })),
                // window-priority list in its OWN wrapper so rebuildNode refreshes JUST this
                // (on reorder, or when a window's `live` toggle flips) — mirrors `.win-controls`.
                h("div", { class: "game-priority" }, gamePriority())),
        };
    }
    if (n.type === "glyphs") {
        // Standalone glyph-atlas node (attached to the game node). Its OWN image surface
        // (.glyph-img, wired by imaging.js openGlyphImage) — kept separate from the game
        // node whose canvas already hosts gate detectors — plus the taught-glyph list
        // (.glyph-atlas, populated by refreshGlyphAtlas).
        return {
            title: h("span", { class: "gi-id", title: "taught glyph atlas — fixes confident single-glyph misreads (e.g. Q↔G) on glyph-check fields" }, "glyphs"),
            body: frag(
                h("div", { class: "glyph-img" }),        // image surface + positioning rect + compose bar
                h("div", { class: "glyph-preview" }),    // live cutout of the drawn box (manual flow)
                h("div", { class: "glyph-pending" }),    // auto-glypher proposals awaiting correct+confirm
                h("div", { class: "glyph-atlas" })),     // the taught atlas (alphabetical)
        };
    }
    if (n.type === "window") {
        const w = n.ref;
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "winid" }, value: w.id }),
            head: satToggleBtn(`prev:${w.id}`, "preview"),
            body: frag(
                h("div", { class: "win-controls gn-grid" }, windowControls(w)),
                h("div", { class: "win-img" })),
            ports: h("span", { class: "port out", title: "drag to a dataset to send this window's rows there" }),
        };
    }
    if (n.type === "region") {
        const f = n.field || { type: "text", extract: "whole", fuzzy: 0.82 };
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "regid" }, value: n.ref.id, title: "region / field id" }),
            body: fieldConfigBody(f, "fset"),
        };
    }
    if (n.type === "detect") {
        const a = n.ref;
        const kind = detectKind(a);
        // text-kind controls (text/mode/min-chars/strip/case) — only OCR detectors use them
        const textBody = frag(
            kv("text", h("input", { class: "aset", dataset: { k: "text" }, value: a.text || "", placeholder: "EQUIPMENT" })),
            kv("mode", h("select", { class: "aset", dataset: { k: "match" } },
                h("option", { value: "partial", selected: (a.match ?? "partial") === "partial" }, "partial"),
                h("option", { value: "full", selected: a.match === "full" }, "full"),
                h("option", { value: "exact", selected: a.match === "exact" }, "exact"),
                h("option", { value: "prefix", selected: a.match === "prefix" }, "prefix")),
                { title: "how text is compared: partial=substring (loose); full=whole-string; exact=equal; prefix=starts-with" }),
            kv("min chars", h("input", { type: "number", class: "aset", dataset: { k: "minchars" }, step: "1", min: "0", value: a.min_chars ?? 0 }),
                { title: "hard floor: reads shorter than this never match (kills tiny-blob false hits)" }),
            kv("strip", h("select", { class: "aset", dataset: { k: "strip" } },
                h("option", { value: "none", selected: (a.strip ?? "none") === "none" }, "none"),
                h("option", { value: "alnum", selected: a.strip === "alnum" }, "alnum"),
                h("option", { value: "spaces", selected: a.strip === "spaces" }, "spaces")),
                { title: "what to ignore before comparing (default: none — keep everything)" }),
            kv("case sensitive", h("input", { type: "checkbox", class: "aset", dataset: { k: "case" }, checked: !!a.case_sensitive, title: "off = fold case before comparing" })));
        // color/border-kind controls — cheap, no OCR. A color swatch + hex + eyedropper.
        const colorBody = frag(
            kv("color", h("span", { class: "aset-color" },
                h("input", { class: "aset", dataset: { k: "color" }, value: a.color || "", placeholder: "#rrggbb", size: "8" }),
                h("input", { type: "color", class: "aset aset-swatch", dataset: { k: "colorpick" }, title: "pick a color",
                    value: /^#[0-9a-fA-F]{6}$/.test(a.color || "") ? a.color : "#000000" })),
                { title: "fraction of pixels near this color (border = only on the box perimeter)" }),
            kv("tolerance", h("input", { type: "number", class: "aset", dataset: { k: "tol" }, step: "1", min: "0", value: a.tolerance ?? 32 }),
                { title: "how close a pixel's color must be (BGR distance) to count" }),
            kind === "border" && kv("border width", h("input", { type: "number", class: "aset", dataset: { k: "width" }, step: "0.01", min: "0", max: "0.5", value: a.width ?? 0.1 }),
                { title: "perimeter band thickness as a fraction of the box's shorter side" }));
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "detid" }, value: a.id,
                title: "detector: the window's detect_mode decides how these combine" }),
            body: frag(
                kv("kind", h("select", { class: "aset", dataset: { k: "kind" } },
                    h("option", { value: "text", selected: kind === "text" }, "text"),
                    h("option", { value: "color", selected: kind === "color" }, "color"),
                    h("option", { value: "border", selected: kind === "border" }, "border"),
                    ...(kind === "template" ? [h("option", { value: "template", selected: true }, "template")] : [])),
                    { title: "text = OCR a label (costs OCR); color/border = cheap pixel check (no OCR — use these for the live-mode gate)" }),
                kind === "text" ? textBody : kind === "template"
                    ? h("div", { class: "muted" }, "template image (set on the box)") : colorBody,
                kv("threshold", h("input", { type: "number", class: "aset", dataset: { k: "thr" }, step: "0.05", min: "0", max: "1", value: a.threshold ?? 0.8 })),
                h("div", { class: "detect-status muted" },
                    h("div", { class: "ds-verdict" }, "◯ —"),
                    h("div", { class: "ds-line ds-before", hidden: true }),
                    h("div", { class: "ds-line ds-after", hidden: true }),
                    h("div", { class: "ds-line ds-chars", hidden: true }))),
        };
    }
    if (n.type === "item") {
        return {
            title: h("input", { class: "gi gi-id", dataset: { k: "itemid" }, value: n.ref.id, title: "item template" }),
            body: frag(h("div", { class: "item-img" }), h("div", { class: "item-lists gn-grid" }, itemLists(n.ref, n.win))),
        };
    }
    if (n.type === "itemfield") return itemFieldParts(n);
    if (n.type === "itemtell") return itemTellParts(n);
    if (n.type === "readout") return readoutParts(n);
    if (n.type === "scrollbar") return { title: "scrollbar", body: scrollbarParts(n) };
    if (n.type === "preview") {
        // live-read node — what the current layout would read from this window. Runs OCR
        // on demand (its own button, or the image's 👁), rendered inline.
        return {
            title: h("span", { class: "gi-id" }, `${n.ref.id} preview`),
            body: h("div", { class: "nodehost scrollhost prev-host" },
                h("p", { class: "muted", style: "padding:8px" }, "open the window image or edit it to preview what it reads")),
            foot: h("button", { class: "prevcommit", title: "write these reads into the window's dataset (one revertable batch)" }, "push to dataset"),
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
        if (r.kind === "producer") {
            // an http producer's preview: what it WILL fetch (resolved names -> keys), the columns
            // it emits, and a live one-item test-fetch (raw response vs mapped row). Filled by
            // refreshProducerPreview; the button drives the probe.
            return {
                title: h("span", { class: "gi-id" }, `${r.id} preview`),
                body: frag(
                    h("div", { class: "pp-cols muted", style: "padding:4px 8px" }, "loading…"),
                    h("div", { class: "pp-result" }),
                    h("div", { class: "nodehost scrollhost pp-inputs" },
                        h("p", { class: "muted", style: "padding:8px" }, "resolved item list appears here"))),
                foot: frag(
                    h("input", { class: "pp-item", placeholder: "item to test (blank = first source)", style: "flex:1;min-width:0" }),
                    h("button", { class: "pp-probe" }, "test fetch")),
            };
        }
        if (r.kind === "source" || r.kind === "sourcedismissed") {
            // a file source's parse preview. Two variants share this body (same hosts, one refresh
            // fills both): `source` = rows the rules PRODUCE; `sourcedismissed` = rows a required
            // field REJECTED (shown so you can see why a line was dropped — never written).
            const dism = r.kind === "sourcedismissed";
            return {
                title: h("span", { class: "gi-id" }, `${r.id} ${dism ? "dismissed" : "preview"}`),
                body: frag(
                    h("div", { class: "src-prev-info muted" }),
                    h("div", { class: "nodehost scrollhost src-host" },
                        h("p", { class: "muted", style: "padding:8px" },
                            dism ? "rows dropped by a required field show here" : "edit the source or hit preview to parse"))),
            };
        }
        return {
            title: h("span", { class: "gi-id" }, `${r.ds} data`),
            // data | batches selector + the "show removed" toggle ride the node HEADER (gn-h), above the table
            head: frag(
                h("div", { class: "ds-tabs", role: "tablist" },
                    h("button", { class: "ds-tab on", dataset: { tab: "data" }, role: "tab" }, "data ", h("span", { class: "ds-tab-n data-n" })),
                    h("button", { class: "ds-tab", dataset: { tab: "batches" }, role: "tab", title: "this dataset's collection/save runs" }, "batches ", h("span", { class: "ds-tab-n bat-n" }))),
                slideToggle({ on: vtShowRemoved.get(r.ds) || false, cls: "vt-showrm", label: "removed", hidden: true, title: "show removed (no-longer-present) rows in the table + counts" })),
            body: frag(
                h("div", { class: "nodehost scrollhost data-host" }, h("p", { class: "muted", style: "padding:8px" }, "loading…")),
                // detail is placed BEFORE the list so flow.css can grow the list via a `.bat-detail:empty
                // + .bat-list` adjacent-sibling rule (no :has()); CSS `order` puts the list back on top.
                h("div", { class: "nodehost scrollhost bat-host" },
                    h("div", { class: "bat-detail muted" }, "select a batch to see its events and what applying it changes"),
                    h("ul", { class: "history bat-list" }, h("li", { class: "muted" }, "loading…")))),
        };
    }
    if (n.type === "subset") return subsetParts(n.ref);
    if (n.type === "producer") return { ...producerParts(n.ref, model.producerSourceColumns(n.ref), model.producerJoinable(n.ref)),
        head: n.ref.type === "http" ? satToggleBtn(`prod:${n.ref.id}`, "producer") : null };
    if (n.type === "filesource") return { ...sourceParts(n.ref),
        head: frag(satToggleBtn(`vt:src:${n.ref.id}`, "vttable"),
            satToggleBtn(`vtd:src:${n.ref.id}`, "dismissed")) };
    if (n.type === "trigger") return triggerParts(n.ref, model);
    if (n.type === "toast") return toastParts(n.ref, model);
    if (n.type === "sound") return soundParts(n.ref, model);
    if (n.type === "dictionary") {
        // a named word list. Text reads snap to the closest entry (exact, then fuzzy). The
        // terms live in config/dictionaries/<source>; this node just references that file.
        const dict = n.ref;
        const count = (dict.terms || []).length;
        const src = dict.source || "—";
        const missing = !count && dict.source;   // a referenced file that resolved to nothing
        const fed = model.dictIsFed(dict.id);     // terms are pulled from datasets, not hand-typed
        return {
            title: h("input", { class: "gi gi-id dictname", value: dict.id, title: "dictionary id" }),
            // wire a dataset's out-port here to feed its column values in as terms
            ports: h("span", { class: "port in", title: "drag a dataset here to feed it terms" }),
            body: frag(
                h("div", { class: "muted" },
                    `${count} word${count === 1 ? "" : "s"} · file `,
                    h("code", src),
                    missing && h("span", { class: "warn" }, " · file missing")),
                dictFeedsEditor(dict),
                h("div", { class: "nodehost scrollhost dict-host" },
                    h("textarea", { class: "dictterms", autocomplete: "off",
                        readOnly: fed, title: fed ? "terms are pulled from the wired dataset(s) — edit the source data, not this list" : "",
                        placeholder: "one word per line\nNeo V11\nSoma Prime\n…" },
                        (dict.terms || []).join("\n")))),
        };
    }
    // dataset — receives/stores rows, deduped by the keys the records arrive with.
    // The key itself is no concern of the dataset: it's taught on the item templates
    // (or windows) that read the records.
    const ds = n.ref;
    const mode = model.datasetKeyMode(ds);
    const kf = model.datasetKeyField(ds);
    // pin the configured key field even if the feeder schema doesn't (yet) list it, so a key on a
    // field the feeders don't currently declare stays selected rather than snapping to the auto default.
    const kfields = model.datasetFields(ds);
    const keyFields = mode === "single" && kf && !kfields.includes(kf) ? [...kfields, kf] : kfields;
    const keyOpts = [
        // empty = no dataset-level override; key comes from whatever feeds it (a window's/item's
        // key, a file source's, or a producer's — e.g. the relic table producer's name|item).
        h("option", { value: "", selected: mode === "auto" }, "key: auto"),
        keyFields.map((f) => h("option", { value: f, selected: mode === "single" && kf === f }, `key: ${f}`)),
        h("option", { value: "__concat__", selected: mode === "concat" }, "concat (combine fields)"),
        h("option", { value: "__nodedup__", selected: mode === "nodedup" }, "no dedup (keep every read)"),
    ];
    const concatEditor = mode === "concat" ? datasetConcatEditor(ds) : null;
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
            kv("1 → many", h("select", { class: "dskey", title: "the key the dataset collapses many reads on (or none)" }, keyOpts)),
            kv("batch", h("select", { class: "dsbatch", title: "how a live run splits into revertable batches: one per run, or a new batch each time the window is freshly detected (transient per-event screens like a timed offer / pop-up)" }, batchOpts)),
            kv("sync", h("select", { class: "dssync", title: "accumulate: only add/update. mirror: keep the dataset equal to the live screen — a row gone from its visible scroll slice is removed (soft). Needs the feeding window's scrollbar drawn so the visible slice can be located (or a list that fits one screen)." }, syncOpts)),
            concatEditor && gspan(concatEditor)),
        foot: h("button", { class: "dsclear danger" }, "clear data"),
        ports: h("span", { class: "port out", title: "drag to a subset to feed it this dataset" }),
    };
}

// A dictionary fed by dataset(s): the SHARED sources-input widget (rule 7 — the same chip +
// add-select the subset joins / producer sources use) holds the wired datasets, and each gets a
// per-source column-picker block below — every ticked column's values become terms (pulled +
// deduped on save). A dataset can be wired by dropping its out-port here OR via the "+ source"
// select.
function dictFeedsEditor(dict) {
    const feeds = model.dictFeeds(dict.id);
    const free = model.dictFeedable(dict.id);   // datasets not already feeding it
    if (!feeds.length && !free.length) return null;
    // per-source column pickers: each wired dataset lists its columns as checkboxes (full-width
    // blocks below the sources row)
    const cols = feeds.map((fd) => {
        const shown = [...new Set([...model.datasetFields(fd.dataset), ...(fd.columns || [])])];
        return h("div", { class: "gspan dict-feed", dataset: { ds: fd.dataset } },
            h("div", { class: "df-src mini muted" }, h("code", fd.dataset), " columns"),
            shown.length
                ? h("div", { class: "df-cols" }, shown.map((c) => h("label", { class: "chk" },
                    h("input", { type: "checkbox", class: "dfcol", dataset: { ds: fd.dataset, col: c }, checked: (fd.columns || []).includes(c) }), c)))
                : h("div", { class: "mini muted" }, "no columns — dataset has no data yet"));
    });
    // laid out like the subset/producer "sources" row: a labelled sources-input widget, its
    // per-source column blocks spanning below.
    return h("div", { class: "dict-feeds lab-grid" },
        srcRow("source", "datasets whose column values become terms",
            sourcesInput({ ids: feeds.map((fd) => fd.dataset), free, rmTitle: "stop feeding from this dataset" })),
        ...cols);
}

// The concat-key editor: which fields combine into the identity, plus the same canonicalisation
// knobs a subset join has (case / punctuation / spacing / dropped words). Only shown in concat mode.
function datasetConcatEditor(ds) {
    const picked = model.datasetKeyFields(ds);
    const norm = model.datasetKeyNorm(ds);
    // offer every field the feeders declare, plus any already-picked field the schema doesn't list
    const fields = [...new Set([...model.datasetFields(ds), ...picked])];
    const chk = (cls, label, on) => h("label", { class: "chk" },
        h("input", { type: "checkbox", class: cls, checked: !!on }), label);
    return h("div", { class: "dsconcat" },
        h("div", { class: "mini muted" }, "combine fields — a row dedups only when ALL agree (e.g. name + item)"),
        fields.length
            ? h("div", { class: "dsk-fields" }, fields.map((f) => h("label", { class: "chk" },
                h("input", { type: "checkbox", class: "dskf", dataset: { field: f }, checked: picked.includes(f) }), f)))
            : h("div", { class: "mini muted" }, "no fields yet — wire a feeder first"),
        h("div", { class: "dsk-norm" },
            chk("dsk-ci", "ignore case", norm.case_insensitive),
            chk("dsk-punct", "strip punctuation", norm.strip_punct),
            chk("dsk-ws", "collapse spaces", norm.collapse_ws),
            h("label", { class: "chk chk-words" }, "drop words ",
                h("input", { class: "dsk-words", autocomplete: "off",
                    value: (norm.strip_words || []).join(" "), placeholder: "relic blueprint" }))));
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
