// Node body HTML builders: the pure functions that turn a node's model into its header/body/ports
// HTML strings. No DOM, no events, no rendering -- wiring lives in main.js, which calls nodeParts()
// then attaches handlers. Extracted from main.js. (Subset builders stay in main -- they tangle with
// the live vtable column set -- so nodeParts imports subsetParts back.)
import { esc, TRASH } from "../dom.js";
import { buildKey } from "../keys.js";
import { model, itemReads } from "./state.js";
import { ITEM_KINDS } from "./imaging.js";
import { priceParts } from "./price_node.js";
import { sourceParts } from "./source_node.js";
import { triggerParts } from "./trigger_node.js";
import { subsetParts } from "./main.js";

// Header toggle button that shows/hides a node's opt-in satellite (preview / vt-table).
// `.gn-sat-tog` carries the satellite id; main.js wires every one through model.toggleSatellite.
const SAT_EYE = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 3.5C4.5 3.5 1.7 5.7.5 8c1.2 2.3 4 4.5 7.5 4.5S14.3 10.3 15.5 8C14.3 5.7 11.5 3.5 8 3.5zm0 7.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z"/></svg>`;
const SAT_GRID = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.5 2.5h11v11h-11zM2.5 6.5h11M2.5 10h11M6.5 2.5v11"/></svg>`;
export function satToggleBtn(satId, kind) {
    const on = model.satelliteOn(satId);
    const title = `${on ? "hide" : "show"} ${kind === "preview" ? "preview" : "data table"}`;
    return `<button class="gn-sat-tog gn-cog${on ? " on" : ""}" data-sat="${esc(satId)}" title="${title}" aria-label="${title}" aria-pressed="${on}">${kind === "preview" ? SAT_EYE : SAT_GRID}</button>`;
}

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

// <option>s for a field's dictionary picker: "all" (every enabled dictionary pooled)
// + each named dictionary. `sel` is the field's pinned DictionaryDef.id ("" = pooled).
export function dictOptions(sel) {
    const dicts = model.profile.dictionaries || [];
    const opts = [`<option value="" ${!sel ? "selected" : ""}>all</option>`];
    for (const d of dicts)
        opts.push(`<option value="${esc(d.id)}" ${sel === d.id ? "selected" : ""}>${esc(d.name || d.id)}</option>`);
    // pin a referenced dictionary the profile no longer lists, so the field keeps pointing at it
    // (shown by bare id) instead of silently snapping to "all" on the next edit.
    if (sel && !dicts.some((d) => d.id === sel))
        opts.push(`<option value="${esc(sel)}" selected>${esc(sel)}</option>`);
    return opts.join("");
}

export function windowControls(w) {
    // The record key is taught per item template (key section in the item node; the teach
    // page covers grid windows). Where records flow is shown by the wire to the dataset node.
    // The toggles are slide-toggle flabs; the image selector / recapture / page nav live
    // below the canvas (built in openImage). "clicks" only shows when auto-scroll is on.
    const sc = w.scroll || {};
    return `<label class="flab" title="item rows: static tiles the data area into a fixed grid from the cell size (no OCR for location); off locates rows by OCR (a tell/locate field) — only needed for a scroll-parked list">static grid <input type="checkbox" class="winstatic" ${w.static_grid !== false ? "checked" : ""}/></label>
    <label class="flab" title="precapture auto-scrolls this window's list while recording it">auto-scroll <input type="checkbox" class="winscroll" data-k="autoscroll" ${sc.autoscroll ? "checked" : ""}/></label>
    ${sc.autoscroll ? `<label class="flab" title="wheel notches sent per auto-scroll nudge">auto-scroll clicks <input type="number" class="winscroll" data-k="clicks" value="${sc.scroll_clicks ?? 1}" min="1"/></label>` : ""}
    <label class="flab" title="attempt this window in live view">live <input type="checkbox" class="winlive" ${w.live !== false ? "checked" : ""}/></label>
    ${windowItemOrder(w)}
    ${(w.items || []).length ? `<div class="wi-drift muted" title="how far located cells sit from the content they should bracket, split by axis — x and y as avg/max % of a CELL (25% = a quarter-cell off). 0 = dead-on; high = cells drift off their columns (x) or rows (y). Filled by the read.">grid drift: <span class="wd-drift">—</span></div>` : ""}
    ${windowDetects(w)}`;
}

// The window's detectors as rows below templates: how they combine (all/any) + each
// detector's polarity (require present / require absent), with a LIVE per-row verdict and
// an overall pass/fail for the current image. The detect NODE still edits each detector's
// text/threshold; this section edits only the window-level match POLICY. Statuses
// (`.wd-status`, `.wd-verdict`) are filled live by setWindowDetectStatus (reconciled in place,
// never rebuilt per tick) and hold blank until the first detect pass returns.
export function windowDetects(w) {
    const dets = w.detect || [];
    if (!dets.length) return "";
    const mode = w.detect_mode || "all";
    const sel = (val, opts, cls, attrs = "") => `<select class="${cls}" ${attrs}>` +
        opts.map(([v, t]) => `<option value="${v}" ${val === v ? "selected" : ""}>${t}</option>`).join("") + "</select>";
    const modeSel = sel(mode, [["all", "all"], ["any", "any"]], "wd-mode",
        `title="all = every detector must pass (AND); any = at least one passes (OR)"`);
    // Three columns: col1 = detector name, col2 = its live status, col3 = the polarity select
    // bound to that detector. The select is width:100% (min-width:0), so it can never overflow
    // (the window body clips overflow). The header row labels all three columns.
    const rows = dets.map((d) => {
        const off = d.enabled === false;   // disabled detectors are greyed + their control locked
        const negAttrs = `data-id="${esc(d.id)}" title="require this landmark PRESENT (positive), or ABSENT (negative — the window fails if it IS found)"${off ? " disabled" : ""}`;
        return `<div class="wd-row${off ? " wd-disabled" : ""}" data-id="${esc(d.id)}">
      <span class="wd-name" title="${esc(d.id)} — open this detector's node">${esc(d.id)}</span>
      <span class="wd-status muted" data-id="${esc(d.id)}" title="live: does this detector pass its requirement on the current image">${off ? "disabled" : ""}</span>
      ${sel(d.negate ? "absent" : "present", [["present", "present"], ["absent", "absent"]], "wd-neg", negAttrs)}
    </div>`;
    }).join("");
    return `<div class="muted il-h wi-h" title="how this window's detectors decide a match">detects</div>
    <label class="wd-mode-line muted">window matches if ${modeSel}</label>
    <div class="wd-row wd-head muted"><span class="wd-name">detector</span><span class="wd-status">pass</span><span class="wd-req-h">require</span></div>
    ${rows}
    <div class="wd-verdict muted" title="whether the current capture would be recognised as this window with the settings above"></div>`;
}

// Item templates listed in PRIORITY order, HIGHEST first — the top row wins when cells
// overlap a tile; the BOTTOM row is priority 0 (the static grid's base cell, which sets the
// grid pitch). Reordering IS how priority is set; the number itself is never shown. Click a
// name to jump to that item's node.
export function windowItemOrder(w) {
    const items = [...(w.items || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    if (!items.length) return "";
    const rows = items.map((it, i) => `<div class="wi-row" data-id="${esc(it.id)}">
      <span class="wi-name" title="select this item's node">${esc(it.id)}</span>
      <button class="wimv" data-id="${esc(it.id)}" data-d="-1" ${i === 0 ? "disabled" : ""} title="move up — higher priority (wins tile overlaps)">▲</button>
      <button class="wimv" data-id="${esc(it.id)}" data-d="1" ${i === items.length - 1 ? "disabled" : ""} title="move down — lower priority (bottom = base cell, sets the grid pitch)">▼</button>
    </div>`).join("");
    return `<div class="muted il-h wi-h" title="template priority order — highest on top (wins tile overlaps); the bottom template is the base cell that sets the grid pitch">templates</div>${rows}`;
}

// The cell size (item.box w/h, window fractions) shown as editable inputs below the cutout
// canvas. Under static grid this IS the grid pitch (column/row spacing); the cell's position
// is unused. Editing reuses setItemCellKeepingChildren so fields/tells stay visually put.
export function cellSizeControls(it) {
    const b = it.box || { w: 0, h: 0 };
    const v = (n) => +(+n || 0).toFixed(4);
    // priority-0 is the static grid's base cell; a non-0 item can match its w/h so every
    // template tiles on the same pitch (only shown when this item isn't priority 0 itself)
    return `<label class="flab" title="cell width as a window fraction — the static grid's column pitch">width <input type="number" class="csize" data-k="w" step="0.001" min="0.001" value="${v(b.w)}"/></label>
    <label class="flab" title="cell height as a window fraction — the static grid's row pitch">height <input type="number" class="csize" data-k="h" step="0.001" min="0.001" value="${v(b.h)}"/></label>`;
}

// One field's fallback-rule rows (FieldRule list). `cls` is the change-class the node
// wiring listens on; `fid` (item fields) tags each control so the wiring resolves the
// field. The value input shows only for a `set` rule (a `drop` needs none).
export function ruleRows(fd, cls, fid) {
    const da = fid ? ` data-fid="${esc(fid)}"` : "";
    const rules = fd.rules || [];
    if (!rules.length) return `<div class="muted frule-empty">no rules — the read is used as-is</div>`;
    return rules.map((r, i) => {
        const whenOpts = RULE_WHEN.map(([v, t]) => `<option value="${v}" ${(r.when || "empty") === v ? "selected" : ""}>${t}</option>`).join("");
        const thenOpts = RULE_THEN.map(([v, t]) => `<option value="${v}" ${(r.then || "set") === v ? "selected" : ""}>${t}</option>`).join("");
        const showVal = (r.then || "set") === "set";
        return `<div class="frule" data-ri="${i}">
      <select class="rule-when" data-ri="${i}"${da} title="condition tested on the raw read">${whenOpts}</select>
      <select class="rule-then" data-ri="${i}"${da} title="what to do when it matches">${thenOpts}</select>
      ${showVal ? `<input class="rule-val" data-ri="${i}"${da} value="${esc(r.value || "")}" placeholder="value" title="value substituted into the field"/>` : ""}
      <button class="rule-del danger" data-ri="${i}"${da} title="remove this rule">${TRASH}</button>
    </div>`;
    }).join("");
}

// The per-field config body, SHARED by the region node and the item-field node (one
// renderer, not two copies). Inputs are grouped under .fgrp sub-headings and only the
// ones that DO something for the current type/mode are shown. `cls` is the wiring's
// change-class ("fset" | "ffset"); `fid` (item fields) tags each control.
export function fieldConfigBody(fd, cls, fid) {
    const da = fid ? ` data-fid="${esc(fid)}"` : "";
    const pips = fd.type === "pips" || fd.type === "diamonds";
    const isText = fd.type === "text";
    const isNum = fd.type === "number";
    const dictOn = (fd.dict_mode || "correct") !== "off";   // dictionary actually consulted
    const hasDicts = (model.profile.dictionaries || []).length;
    const types = TYPES.map(([v, t]) => `<option value="${v}" ${fd.type === v ? "selected" : ""}>${t}</option>`).join("");
    const exs = EXTRACTS.map((v) => `<option ${(fd.extract || "whole") === v ? "selected" : ""}>${v}</option>`).join("");
    return `
    <div class="fgrp">read</div>
    <label class="flab" title="read this box in isolation: OCR only its own crop instead of picking tokens from the window-wide pass — use when a digit fuses with a neighbouring glyph (e.g. drain '8' read as '81')">isolate <input type="checkbox" class="${cls}" data-k="isolate"${da} ${fd.isolate ? "checked" : ""}/></label>
    <label class="flab">type <select class="${cls}" data-k="type"${da}>${types}</select></label>
    ${pips ? "" : `<label class="flab">extract <select class="${cls}" data-k="extract"${da}>${exs}</select></label>`}
    ${(!pips && NEEDS_SEP.has(fd.extract)) ? `<label class="flab">separator <input class="${cls}" type="text" data-k="sep"${da} value="${esc(fd.separator || "/")}"/></label>` : ""}
    <label class="flab" title="minimum OCR confidence this field must reach — a weaker read drops the whole record (0 = use the global floor)">conf <input type="number" class="${cls}" data-k="minconf"${da} step="0.05" min="0" max="1" value="${fd.min_confidence ?? 0}"/></label>
    ${isNum ? `<label class="flab" title="lowest plausible value — a read below this is a misread and drops the record (blank = no minimum)">min <input type="number" class="${cls}" data-k="min"${da} value="${fd.min ?? ""}" placeholder="(none)"/></label>
    <label class="flab" title="highest plausible value — a read above this is a misread and drops the record (blank = no maximum)">max <input type="number" class="${cls}" data-k="max"${da} value="${fd.max ?? ""}" placeholder="(none)"/></label>` : ""}
    ${isText ? `<div class="fgrp">dictionary</div>
    <label class="flab" title="off = dictionary not consulted; correct = fix words, keep unmatched; drop = no fixes, unmatched read dropped; correct + drop = fix words, unmatchable read dropped">dict <select class="${cls}" data-k="dictmode"${da}>${DICT_MODES.map(([v, t]) => `<option value="${v}" ${(fd.dict_mode || "correct") === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    ${(hasDicts && dictOn) ? `<label class="flab" title="which authored dictionary this field snaps to (all = every enabled one pooled)">use dict <select class="${cls}" data-k="usedict"${da}>${dictOptions(fd.dictionary)}</select></label>` : ""}
    <label class="flab" title="learn the dictionary from confident reads, fuzzy-correct uncertain ones">learn <input type="checkbox" class="${cls}" data-k="learn"${da} ${fd.learn ? "checked" : ""}/></label>
    ${(fd.learn || dictOn) ? `<label class="flab" title="similarity (0-1) an uncertain read must reach to snap to a known word; higher = stricter">fuzzy <input type="number" class="${cls}" data-k="fuzzy"${da} step="0.05" min="0" max="1" value="${fd.fuzzy ?? 0.82}"/></label>` : ""}` : ""}
    <div class="fgrp">rules <button class="ruleadd"${da} title="add a fallback rule">+ rule</button></div>
    ${ruleRows(fd, cls, fid)}`;
}

// One item field is its OWN node (a child of its item node). It renders the shared
// per-field config (against the window's FieldDef) plus the row-role controls (tell /
// locate / align) that only make sense for a field inside an item template.
export function itemFieldParts(n) {
    const f = n.ref, fd = n.field || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
    const body = `${fieldConfigBody(fd, "ffset", f.id)}
    <div class="fgrp">row role</div>
    <label class="flab" title="require this field to read something — it doubles as a tell">tell <input type="checkbox" class="itell" data-fid="${f.id}" ${f.tell ? "checked" : ""}/></label>
    ${f.tell ? `<label class="flab" title="minimum OCR confidence the read must reach (0 = any)">tell conf <input type="number" class="itellconf" data-fid="${f.id}" step="0.05" min="0" max="1" value="${f.tell_conf ?? 0}"/></label>` : ""}
    ${f.tell && fd.type === "number" ? `<label class="flab" title="pass the tell even when the read carries text (e.g. a polarity glyph), not only a clean number">allow text <input type="checkbox" class="itelltext" data-fid="${f.id}" ${f.tell_allow_text ? "checked" : ""}/></label>` : ""}
    <label class="flab" title="use this field to LOCATE rows (anchor the grid) — independent of tell; a reliable text field (e.g. the name) can locate without being a tell">locate <input type="checkbox" class="iloc" data-fid="${f.id}" ${f.locate ? "checked" : ""}/></label>
    ${(f.tell || f.locate) ? `<label class="flab" title="vertical anchor: which line of a wrapped name fixes the ROW">align y <select class="itellalign" data-fid="${f.id}">${["none", "top", "center", "bottom"].map((v) => `<option ${(f.align || n.item.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label class="flab" title="horizontal anchor: which edge of the text fixes the COLUMN — pick the side the text is aligned to in the cell (e.g. left for a left-aligned name). Lets columns be found from content, immune to blank data-area margins.">align x <select class="itellalignx" data-fid="${f.id}">${["left", "center", "right"].map((v) => `<option ${(f.align_x || n.item.align_x || "left") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
    <div class="gn-foot"></div>`;
    return { title: `<input class="gi gi-id" data-k="fldid" value="${esc(f.id)}" title="field id" />`, body };
}

// One tell is its OWN node (a child of its item node). It renders the per-tell controls that
// used to live inline in the item node: kind, the kind-specific input (field for text, colour
// for color), threshold, and — only when the window locates rows by OCR (static grid off) —
// the locate toggle + its align. Mirrors itemFieldParts.
export function itemTellParts(n) {
    const t = n.ref, it = n.item, w = n.win;
    const staticOn = w.static_grid !== false;   // static grid tiles rows from the cell — locate is unused
    const body = `
    <label class="flab" title="what this tell checks">kind <span class="tt-kind">${esc(t.kind)}</span></label>
    ${t.kind === "text" ? `<label class="flab" title="which field's read this tell checks. Leave blank (—) to check ANY column's read — the tell isn't tied to one field.">checks <select class="tset" data-k="field">${_colOpts((it.fields || []).map((f) => f.field), t.field)}</select></label>
    <label class="flab" title="optional: require the read to MATCH this text (scored like a detector). Empty = just needs to read SOMETHING (the chosen field, or any column when blank). NOTE: an empty-text tell bound to a field is identical to flagging that field 'tell' — use the field's own tell flag instead.">text <input class="tset" data-k="text" value="${esc(t.text || "")}" placeholder="(any)"/></label>
    ${(t.text || "").trim() ? `<label class="flab" title="how text is compared: partial=substring (loose); full=whole-string; exact=equal; prefix=starts-with">mode
      <select class="tset" data-k="match">${["partial", "full", "exact", "prefix"].map((v) => `<option value="${v}" ${(t.match ?? "partial") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    ${["partial", "prefix"].includes(t.match ?? "partial") ? `<label class="flab" title="match if the read word is included in this text (instead of the text in the read)">read ⊆ text <input type="checkbox" class="tset" data-k="incl" ${t.included ? "checked" : ""}/></label>` : ""}
    <label class="flab" title="hard floor: reads shorter than this never match (kills tiny-blob false hits)">min chars <input type="number" class="tset" data-k="minchars" step="1" min="0" value="${t.min_chars ?? 0}"/></label>
    <label class="flab" title="what to ignore before comparing">strip
      <select class="tset" data-k="strip">${["alnum", "spaces", "none"].map((v) => `<option value="${v}" ${(t.strip ?? "alnum") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label class="flab" title="off = fold case before comparing">case sensitive <input type="checkbox" class="tset" data-k="case" ${t.case_sensitive ? "checked" : ""}/></label>` : ""}` : ""}
    ${t.kind === "color" ? `<label class="flab" title="the colour that must be present in the tell box">colour <input type="color" class="tset" data-k="color" value="${t.color || "#ffcc00"}"/></label>` : ""}
    <label class="flab" title="${t.kind === "text" ? "pass score (0..1) the read-vs-text match must reach (when text is set)" : "pass score (0..1) the tell must reach"}">threshold <input type="number" class="tset" data-k="threshold" step="0.05" min="0" max="1" value="${t.threshold ?? 0.5}"/></label>
    ${staticOn ? "" : `<label class="flab" title="use this tell to LOCATE rows (anchor the grid) — only one tell per item locates">locate <input type="checkbox" class="tloc" ${t.locate ? "checked" : ""}/></label>`}
    ${(t.locate && !staticOn) ? `<label class="flab" title="vertical anchor: which line of a wrapped name fixes the ROW">align y <select class="tset" data-k="align">${["none", "top", "center", "bottom"].map((v) => `<option ${(t.align || it.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label class="flab" title="horizontal anchor: which edge of the text fixes the COLUMN — pick the side the text is aligned to in the cell. Lets columns be found from content, immune to blank data-area margins.">align x <select class="tset" data-k="align_x">${["left", "center", "right"].map((v) => `<option ${(t.align_x || it.align_x || "left") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
    <div class="gn-foot"></div>`;
    return { title: `<input class="gi gi-id" data-k="tellid" value="${esc(t.id)}" title="tell id" />`, body };
}

export function itemLists(it, w) {
    // tells are their OWN nodes now — the item lists only a compact summary (id + kind + remove);
    // the full per-tell editor lives on each tell node (itemTellParts). Mirrors fieldsSummary below.
    const tellsSummary = (it.tells || []).map((t) => `<div class="ti-sum" data-tid="${esc(t.id)}" title="select this tell's node">
      <span class="ti-sum-name">${esc(t.id)}</span>
      <span class="ti-sum-kind muted">${esc(t.kind)}</span>
      <button class="ti-del danger" data-tid="${esc(t.id)}" title="remove">${TRASH}</button></div>`).join("");
    // fields flagged as tells (f.tell) show here too, read-only — they're edited in the fields
    // list below; the only action is remove, which just unchecks the field's tell flag.
    const fieldTells = (it.fields || []).filter((f) => f.tell).map((f) => `<div class="ti-row ti-fieldtell" data-fid="${esc(f.id)}">
      <span class="ti-kind">field</span>
      <span class="ti-name">${esc(f.id)}</span>
      <span class="ti-ro muted">tell · conf ${f.tell_conf ?? 0}</span>
      <button class="ti-untell danger" data-fid="${esc(f.id)}" title="stop using this field as a tell">${TRASH}</button></div>`).join("");
    // fields are their OWN nodes now — the item lists only a compact summary (name + remove);
    // the full per-field editor lives on each field node (itemFieldParts).
    const fieldsSummary = (it.fields || []).map((f) => `<div class="if-sum" data-fid="${esc(f.id)}" title="select this field's node">
      <span class="if-sum-name">${esc(f.id)}</span>
      <button class="if-del danger" data-fid="${esc(f.id)}" title="remove">${TRASH}</button></div>`).join("");
    // the cutout draw-mode buttons, split by what they draw: cell under "cell", field under
    // "fields", every tell kind under "tells". Selecting one sets the active draw kind.
    const drawBtn = ([v, label, icon, tip]) => `<button class="tool" data-kind="${v}" title="${esc(tip || `draw ${label}`)}">${icon} ${label}</button>`;
    // copy w/h from the priority-0 base cell — sits next to the cell draw button (non-base only)
    const matchBtn = (it.priority || 0) === 0 ? ""
        : `<button class="csize-match" title="copy width & height from the base cell (priority 0 — the bottom template, the static grid's base pitch)">match base</button>`;
    const cellBtns = ITEM_KINDS.filter(([v]) => v === "bbox").map(drawBtn).join("") + matchBtn;
    const fieldBtns = ITEM_KINDS.filter(([v]) => v === "field").map(drawBtn).join("");
    const tellBtns = ITEM_KINDS.filter(([v]) => v !== "bbox" && v !== "field").map(drawBtn).join("");
    return `<div class="muted il-h">cell</div>
    <div class="il-tools">${cellBtns}</div>
    ${cellSizeControls(it)}
    <div class="muted il-h">tells</div>
    <div class="il-tools">${tellBtns}</div>
    ${(tellsSummary + fieldTells) || '<div class="muted">draw a tell on the cutout</div>'}
    <div class="muted il-h">fields</div>
    <div class="il-tools">${fieldBtns}</div>
    ${fieldsSummary || '<div class="muted">draw a field on the cutout</div>'}
    ${keySection(it, w)}
    `;
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
        ? used.map((fid, i) => `<div class="key-row" data-i="${i}">
      <select class="kfield" data-i="${i}">${(fids.includes(fid) ? fids : [fid, ...fids])
        .map((f) => `<option ${f === fid ? "selected" : ""}>${esc(f)}</option>`).join("")}</select>
      <button class="kmv" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""} title="earlier in the key">▲</button>
      <button class="kmv" data-i="${i}" data-d="1" ${i === used.length - 1 ? "disabled" : ""} title="later in the key">▼</button>
      <button class="kdel danger" data-i="${i}" ${used.length <= 1 ? "disabled" : ""} title="remove from the key">${TRASH}</button>
    </div>`).join("")
        : `<div class="key-row muted" title="no fields yet — draw a field on the cutout to key on it">—</div>`;
    const addable = fids.filter((f) => !used.includes(f));
    return `<div class="muted il-h" title="which fields identify a record — reads with the same key merge; a different key (e.g. another level) is its own record. A record missing any key part is dropped.">key</div>
    <label class="flab" title="joins the parts in the stored key">separator <input class="ksep" value="${esc(eff.sep ?? "|")}" size="2"/></label>
    ${addable.length ? `<label class="flab" title="add a field to the key">+ field <select class="kadd"><option value="">field…</option>${addable.map((f) => `<option>${esc(f)}</option>`).join("")}</select></label>` : ""}
    <label class="flab" title="treat keys differing only in case as distinct">is case-sensitive <input type="checkbox" class="kcase" ${eff.case_sensitive ? "checked" : ""}/></label>
    ${rows}`;
}

// The key the LAST cutout read would store under — recomputed instantly from the
// cached read on every key-config edit (client mirror of the server's KeySpec),
// refreshed again when the automatic cutout read lands. Empty until a read exists.
export function keyPrevHTML(winId, itemId) {
    const it = model.item(winId, itemId), w = model.window(winId);
    const rd = itemReads.get(`${winId}:${itemId}`);
    if (!it || !w || !rd) return "";
    const eff = model.effectiveItemKey(winId, itemId);
    const vals = {};
    for (const [k, v] of Object.entries(rd.fields || {})) vals[k] = v.value;
    const key = buildKey(vals, eff);
    if (key !== null) return `<b class="conf-ok">${esc(key)}</b>`;   // label ("key:") is the readout grid's job now
    const used = eff.fields && eff.fields.length ? eff.fields : [];
    const miss = used.find((f) => vals[f] === null || vals[f] === undefined || vals[f] === "");
    return `<span class="tc-bad">∅ no key${miss ? ` — ${esc(miss)} read empty` : ""}</span> <span class="muted">(record dropped)</span>`;
}

export function nodeParts(n) {
    if (n.type === "game") {
        const g = n.ref;
        return {
            title: `<input class="gi gi-id" data-k="name" value="${esc(g.name)}" title="game name" />`,
            body: `
        <label class="flab">process <input class="gi" data-k="proc" value="${esc((g.process_names || []).join(", "))}" placeholder="Warframe.x64.exe" /></label>
        <label class="flab">title hint <input class="gi" data-k="title" value="${esc(g.window_title_hint || "")}" placeholder="Warframe" /></label>`,
        };
    }
    if (n.type === "window") {
        const w = n.ref;
        return {
            title: `<input class="gi gi-id" data-k="winid" value="${esc(w.id)}" />`,
            head: satToggleBtn(`prev:${w.id}`, "preview"),
            body: `<div class="win-controls">${windowControls(w)}</div><div class="win-img"></div>`,
            ports: `<span class="port out" title="drag to a dataset to send this window's rows there"></span>`,
        };
    }
    if (n.type === "region") {
        const f = n.field || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
        return {
            title: `<input class="gi gi-id" data-k="regid" value="${esc(n.ref.id)}" title="region / field id" />`,
            body: `${fieldConfigBody(f, "fset")}
        <div class="gn-foot"></div>`,
        };
    }
    if (n.type === "detect") {
        const a = n.ref;
        return {
            title: `<input class="gi gi-id" data-k="detid" value="${esc(a.id)}" title="detector: all must match to capture" />`,
            body: `<label class="flab">text <input class="aset" data-k="text" value="${esc(a.text || "")}" placeholder="EQUIPMENT" /></label>
        <label class="flab" title="how text is compared: partial=substring (loose); full=whole-string; exact=equal; prefix=starts-with">mode
          <select class="aset" data-k="match">
            <option value="partial" ${(a.match ?? "partial") === "partial" ? "selected" : ""}>partial</option>
            <option value="full" ${a.match === "full" ? "selected" : ""}>full</option>
            <option value="exact" ${a.match === "exact" ? "selected" : ""}>exact</option>
            <option value="prefix" ${a.match === "prefix" ? "selected" : ""}>prefix</option>
          </select></label>
        ${["partial", "prefix"].includes(a.match ?? "partial") ? `<label class="flab">read ⊆ text <input type="checkbox" class="aset" data-k="incl" ${a.included ? "checked" : ""} title="match if the read word is included in this text (instead of the text in the read)" /></label>` : ""}
        <label class="flab">threshold <input type="number" class="aset" data-k="thr" step="0.05" min="0" max="1" value="${a.threshold ?? 0.8}" /></label>
        <label class="flab" title="hard floor: reads shorter than this never match (kills tiny-blob false hits)">min chars <input type="number" class="aset" data-k="minchars" step="1" min="0" value="${a.min_chars ?? 0}" /></label>
        <label class="flab" title="what to ignore before comparing (default: none — keep everything)">strip
          <select class="aset" data-k="strip">
            <option value="none" ${(a.strip ?? "none") === "none" ? "selected" : ""}>none</option>
            <option value="alnum" ${a.strip === "alnum" ? "selected" : ""}>alnum</option>
            <option value="spaces" ${a.strip === "spaces" ? "selected" : ""}>spaces</option>
          </select></label>
        <label class="flab">case sensitive <input type="checkbox" class="aset" data-k="case" ${a.case_sensitive ? "checked" : ""} title="off = fold case before comparing" /></label>
        <div class="detect-status muted">
          <div class="ds-verdict">◯ —</div>
          <div class="ds-line ds-before" hidden></div>
          <div class="ds-line ds-after" hidden></div>
          <div class="ds-line ds-chars" hidden></div>
        </div>
        <div class="gn-foot"></div>`,
        };
    }
    if (n.type === "item") {
        return { title: `<input class="gi gi-id" data-k="itemid" value="${esc(n.ref.id)}" title="item template" />`,
            body: `<div class="item-img"></div><div class="item-lists">${itemLists(n.ref, n.win)}</div>` };
    }
    if (n.type === "itemfield") return itemFieldParts(n);
    if (n.type === "itemtell") return itemTellParts(n);
    if (n.type === "scrollbar") {
        const o = n.ref.scrollbar_orientation || "vertical";
        return {
            title: "scrollbar",
            body: `<label class="flab">orientation <select class="sbset" data-k="orient">
          <option ${o === "vertical" ? "selected" : ""}>vertical</option>
          <option ${o === "horizontal" ? "selected" : ""}>horizontal</option></select></label>
        <div class="detect-status muted">position: —</div>
        <div class="gn-foot"></div>`,
        };
    }
    if (n.type === "preview") {
        // live-read node — what the current layout would read from this window. Runs OCR
        // on demand (its own button, or the image's 👁), rendered inline.
        return {
            title: `<span class="gi-id">${esc(n.ref.id)} preview</span>`,
            body: `<div class="nodehost scrollhost prev-host"><p class="muted" style="padding:8px">open the window image or edit it to preview what it reads</p></div>
        <div class="gn-foot"><button class="prevcommit" title="write these reads into the window's dataset (one revertable batch)">commit to dataset</button></div>`,
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
                title: `<span class="gi-id">${esc(r.id)} data</span>`,
                body: `<div class="nodehost scrollhost sub-host"><p class="muted" style="padding:8px">loading…</p></div>`,
            };
        }
        return {
            title: `<span class="gi-id">${esc(r.ds)} data</span>`,
            body: `<div class="ds-tabs" role="tablist">
          <button class="ds-tab on" data-tab="data" role="tab">data <span class="ds-tab-n data-n"></span></button>
          <button class="ds-tab" data-tab="batches" role="tab" title="this dataset's collection/save runs">batches <span class="ds-tab-n bat-n"></span></button>
        </div>
        <div class="nodehost scrollhost data-host"><p class="muted" style="padding:8px">loading…</p></div>
        <div class="nodehost scrollhost bat-host">
          <ul class="history bat-list"><li class="muted">loading…</li></ul>
          <div class="bat-detail muted">select a batch to see its events and what applying it changes</div>
        </div>`,
        };
    }
    if (n.type === "subset") return subsetParts(n.ref);
    if (n.type === "price") return priceParts(n.ref, model.priceSourceColumns(n.ref), model.priceJoinable(n.ref));
    if (n.type === "filesource") return sourceParts(n.ref);
    if (n.type === "trigger") return triggerParts(n.ref, model);
    if (n.type === "dictionary") {
        // a named word list. Text reads snap to the closest entry (exact, then fuzzy). The
        // terms live in config/dictionaries/<source>; this node just references that file.
        const dict = n.ref;
        const count = (dict.terms || []).length;
        const src = dict.source || "—";
        const missing = !count && dict.source;   // a referenced file that resolved to nothing
        return {
            title: `<input class="gi gi-id dictname" value="${esc(dict.name || dict.id)}" title="dictionary name" />`,
            body: `<div class="muted">${count} word${count === 1 ? "" : "s"} · file <code>${esc(src)}</code>${missing ? ` <span class="warn">· file missing</span>` : ""}</div>
        <div class="nodehost scrollhost dict-host"><textarea class="dictterms" spellcheck="false" autocomplete="off" placeholder="one word per line\nNeo V11\nSoma Prime\n…">${esc((dict.terms || []).join("\n"))}</textarea></div>
        <div class="gn-foot"></div>`,
        };
    }
    // dataset — receives/stores rows, deduped by the keys the records arrive with.
    // The key itself is no concern of the dataset: it's taught on the item templates
    // (or windows) that read the records.
    const ds = n.ref;
    const noDedup = !model.datasetDedup(ds);
    const kf = model.datasetKeyField(ds);
    // pin the configured key field even if the window schema doesn't (yet) list it, so a key on a
    // field the windows don't currently declare stays selected rather than snapping to "from windows".
    const kfields = model.datasetFields(ds);
    const keyFields = !noDedup && kf && !kfields.includes(kf) ? [...kfields, kf] : kfields;
    const keyOpts = ['<option value="">key: from windows</option>']
        .concat(keyFields.map((f) => `<option value="${esc(f)}"${!noDedup && kf === f ? " selected" : ""}>key: ${esc(f)}</option>`))
        .concat([`<option value="__nodedup__"${noDedup ? " selected" : ""}>no dedup (keep every read)</option>`]).join("");
    const bm = model.datasetBatchMode(ds);
    const batchOpts = [["run", "per run"], ["detection", "per detection"]]
        .map(([v, l]) => `<option value="${v}"${bm === v ? " selected" : ""}>${l}</option>`).join("");
    return {
        title: `<input class="gi gi-id dsrename" value="${esc(ds)}" title="dataset name" />`,
        head: satToggleBtn(`vt:ds:${ds}`, "vttable"),
        body: `<div class="lab-grid">1 → many<select class="dskey" title="the key the dataset collapses many reads on (or none)">${keyOpts}</select>
      batch<select class="dsbatch" title="how a live run splits into revertable batches: one per run, or a new batch each time the window is freshly detected (transient per-event screens like relic offerings)">${batchOpts}</select></div>
      <div class="gn-foot"><button class="dsclone">clone</button><button class="dsclear danger">clear data</button></div>`,
        ports: `<span class="port out" title="drag to a subset to feed it this dataset"></span>`,
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

// Render <option>s for `opts`, marking `sel` selected, and PIN `sel` into the list when the
// current option set doesn't include it — a saved value (renamed field, `_seq`, a column a live
// join hasn't surfaced yet) stays selected instead of snapping to the first option and being lost
// on the next edit. The one place every column/field dropdown gets this behaviour.
export function _optList(opts, sel) {
    const all = sel && !opts.includes(sel) ? [...opts, sel] : opts;
    return all.map((c) => `<option${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");
}

export function _colOpts(cols, sel) {
    return `<option value=""${sel ? "" : " selected"}>—</option>` + _optList(cols, sel);
}
