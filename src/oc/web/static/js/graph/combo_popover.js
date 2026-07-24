// The ONE searchable "add" combobox popover (rule 7 — the graph's first + only searchable dropdown),
// plus the shared body-level popover SHELL (anchoredPopover) both it and rich_picker.js build on.
// The sources-input "+" add control (sources_input.js) opens this instead of a native <select>: a
// body-level floating panel with a focused search field on top and a live-filtered, node-distance-
// ordered option list below. Built at document.body in screen coords so it escapes node overflow
// clipping and the #gworld zoom transform — exactly what ctxmenu / openOptionsPopover do. One
// instance at a time; dismiss on outside press / Escape via the shared onOutside primitive.
//
// comboPopover({ anchor, options, onPick, placeholder })
//   anchor      : the "+" trigger element. The popover positions under it, and its host node
//                 (anchor.closest('.gnode')) seeds the distance ordering.
//   options     : [{ value, label? }] addable options (label defaults to value).
//   onPick      : (value) => void — called with the chosen option's value, then the popover closes.
//   placeholder : search field placeholder (default "search...").
import { h } from "../dom.js";
import { model, pos, nw, nh } from "./state.js";
import { onOutside } from "../inputbus.js";

let _pop = null, _dismiss = null, _anchor = null;
export function closeCombo() {
    if (!_pop) return;
    _pop.remove(); _pop = null;
    _dismiss?.(); _dismiss = null;
    _anchor = null;
}
// is a rich-picker/combo popover currently open? (both mount through anchoredPopover below, so
// this one flag covers both) — camera.js consults it to skip wheel-zoom while one is open, since
// the panel is body-level and pinned at its open-time position, not glued to the anchor on pan/zoom.
export function comboOpen() { return _pop != null; }

// The shared shell (rule 7): appends `panel` to document.body, clamps it fully on-screen under
// `anchor` (the exact math ctxmenu / groups popover also use), and wires outside-press/Escape
// dismiss via the shared onOutside primitive. Any caller wanting a transient body-level popover
// (comboPopover's search+list, rich_picker's grouped rich-row list, ...) builds its own panel
// contents and hands them here instead of re-deriving the clamp/dismiss boilerplate. Closes
// whatever popover this shell currently holds open before mounting a new one (single instance);
// returns a `close()` fn the caller can invoke itself (e.g. after a pick).
// Clicking the SAME anchor that already has the popover open is a toggle-close, not a reopen —
// otherwise a trigger button/input can never be used to dismiss its own popover, only
// outside-press/Escape can. Returns null in that case so the caller (comboPopover/richPickerPop)
// bails out before building list state or stealing focus into a panel that's no longer mounted.
export function anchoredPopover({ anchor, panel }) {
    if (_pop && _anchor === anchor) { closeCombo(); return null; }
    closeCombo();
    document.body.appendChild(panel);
    const a = anchor.getBoundingClientRect(), M = 8, r = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(M, Math.min(a.left, window.innerWidth - r.width - M))}px`;
    panel.style.top = `${Math.max(M, Math.min(a.bottom + 4, window.innerHeight - r.height - M))}px`;
    _pop = panel;
    _anchor = anchor;
    // `also: anchor` — the trigger itself must NOT count as "outside": mousedown fires before the
    // anchor's own click handler, so without this the outside-press dismiss would close the popover
    // first, then the click handler (seeing it already closed) reopens it fresh — close-then-instant-
    // reopen, not a toggle. Excluding the anchor here lets the click handler's own toggle check above
    // be the one thing that closes it.
    _dismiss = onOutside(panel, closeCombo, { event: "mousedown", defer: true, escape: true, also: anchor });
    return closeCombo;
}

// canvas center {x,y} of a node id, or null when the id is unknown / unplaced.
function centerOf(id) {
    const p = id && pos.get(id);
    return p ? { x: p.x + nw(id) / 2, y: p.y + nh(id) / 2 } : null;
}

// fzf-lite fuzzy match: query chars must appear IN ORDER in text (subsequence). Returns a score
// (higher = better) or -1 for no match. Bonuses reward a match at the start, after a separator
// (word boundary), and contiguous runs — so "gs" ranks "g_ship" above "targets". `q` is assumed
// already lowercased + trimmed and non-empty.
function fuzzyScore(q, text) {
    const t = text.toLowerCase();
    let ti = 0, score = 0, run = 0;
    for (const qc of q) {
        const at = t.indexOf(qc, ti);
        if (at < 0) return -1;
        let b = 1;
        if (at === 0) b += 5;                             // start of string
        else if (/[^a-z0-9]/.test(t[at - 1])) b += 3;     // right after a separator (word start)
        if (at === ti && ti > 0) { run += 1; b += run * 2; }   // contiguous with the previous match
        else run = 0;
        score += b;
        ti = at + 1;
    }
    return score;
}

// order options nearest-node-first from the host node. model.refNode maps a source ref -> its graph
// node id; options that don't resolve to a placed node (raw ids some lists pass) get Infinity and
// keep their original order at the end (stable) — best-effort, no caller changes.
function orderByDistance(options, hostId) {
    const from = centerOf(hostId);
    const d2 = (o) => {
        if (!from) return Infinity;
        const c = centerOf(model.refNode(o.value));
        return c ? (c.x - from.x) ** 2 + (c.y - from.y) ** 2 : Infinity;   // squared: order only, skip sqrt
    };
    return options
        .map((o, i) => ({ o, i, d: d2(o) }))
        .sort((a, b) => (a.d - b.d) || (a.i - b.i))
        .map((e) => e.o);
}

export function comboPopover({ anchor, options, onPick, placeholder = "search..." }) {
    const hostId = anchor.closest(".gnode")?.dataset.id || null;
    const ordered = orderByDistance(
        (options || []).map((o) => (typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value })),
        hostId);

    const list = h("div", { class: "sv-combo-list" });
    const search = h("input", { class: "sv-combo-search", type: "text", placeholder, spellcheck: false });
    const pop = h("div", { class: "sv-combo-pop" }, search, list);

    let rows = [], vals = [], hl = -1;   // current filtered row els + their values + highlighted index
    const setHl = (i) => {
        if (rows[hl]) rows[hl].classList.remove("hl");
        hl = Math.max(0, Math.min(i, rows.length - 1));
        const r = rows[hl];
        if (r) { r.classList.add("hl"); r.scrollIntoView({ block: "nearest" }); }
    };
    const pick = (v) => { closeCombo(); onPick(v); };

    const paint = () => {
        const q = search.value.trim().toLowerCase();
        // empty query -> keep the node-distance order; otherwise fuzzy-filter and rank by score
        // (ties fall back to the original distance order via the stable index).
        const shown = !q
            ? ordered.slice()
            : ordered.map((o, i) => ({ o, i, s: fuzzyScore(q, o.label) }))
                .filter((e) => e.s >= 0)
                .sort((a, b) => (b.s - a.s) || (a.i - b.i))
                .map((e) => e.o);
        vals = shown.map((o) => o.value);
        rows = shown.map((o) => h("div", { class: "sv-combo-opt", title: o.value, onClick: () => pick(o.value) }, o.label));
        list.replaceChildren(...(rows.length ? rows : [h("div", { class: "sv-combo-empty" }, "no matches")]));
        hl = -1;
        if (rows.length) setHl(0);
    };
    paint();

    search.addEventListener("input", paint);
    search.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setHl(hl + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHl(hl - 1); }
        else if (e.key === "Enter") { e.preventDefault(); if (vals[hl] != null) pick(vals[hl]); }
    });

    if (!anchoredPopover({ anchor, panel: pop })) return;   // toggle-closed (same anchor clicked again)
    search.focus();   // focus the search field on open (the explicit ask)
}
