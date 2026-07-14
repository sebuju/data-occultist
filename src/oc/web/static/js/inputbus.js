// THE one home for global (document/window) input wiring. Every app-lifetime keyboard shortcut,
// every "click outside closes me" dismiss, and the permanent mouse/window singletons register HERE
// instead of each hand-rolling its own document.addEventListener. Two payoffs:
//   1. Conflicts are visible. Who owns Escape / WASD / arrows in which view is one sorted list, not
//      11 scattered listeners whose ordering is an accident of capture-vs-bubble + registration.
//   2. Nothing dangles. Every registration returns a dispose(); a transient owner (a menu, an armed
//      button, an open batch) tears its entry down on close.
//
// SCOPE: this file owns only GLOBAL listeners. Per-element handlers built during node/panel render
// stay local (they GC with their DOM, never conflict) and the self-cleaning drag loops
// (dragresize.js / camera.js) are their own primitive — neither belongs here.
//
// Handler BODIES stay in their owner modules. main.js's WASD/overlay-nudge code needs main.js-local
// state (overlays, editBox, nodeSizes, …); it is *registered* here, not moved. This module owns the
// dispatch + ordering + guards, nothing domain-specific.

export const SCOPE = { GRAPH: "graph", PRETTY: "pretty", ANY: "any" };

// The graph view and the pretty (dashboard) view own the keyboard mutually exclusively. `prettyActive`
// is a main.js-local `let` we cannot import (backward/circular dep), but it is exactly mirrored by the
// body class (main.js toggles `document.body.classList.toggle("pretty-mode", on)`), which pretty.js
// already reads. The body class is the single source of truth for scope.
export function currentScope() {
    return document.body.classList.contains("pretty-mode") ? SCOPE.PRETTY : SCOPE.GRAPH;
}

// Superset of the two typing guards that used to live inline: main.js bailed on activeElement in
// INPUT/SELECT/TEXTAREA; pretty.js bailed on ev.target.closest("input,select,textarea,
// [contenteditable=true]"). Unify both (+ isContentEditable) so a shortcut never fires while a text
// field owns the key. Entries that MUST fire from inside a field (modal Escape, edit_txn Enter/Esc)
// opt out with allowInField:true.
const FIELD_SEL = "input, select, textarea, [contenteditable=true]";
export function isTypingTarget(ev) {
    const ae = document.activeElement;
    if (ae && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) return true;
    if (ae && ae.isContentEditable) return true;
    const t = ev && ev.target;
    if (t && t.closest && t.closest(FIELD_SEL)) return true;
    return false;
}

// ---- keyboard registry -------------------------------------------------------------------------
// ONE capture-phase document keydown listener drives every entry. Capture (not bubble) so a
// registered entry reproduces the ordering the old capture handlers relied on to beat the graph's
// bubble handler; priority then orders everything inside the single loop.
//
// entry = { combo?, match?, scope, priority, allowInField, when?, run, stop? }
//   combo   normalized key spec (see matchesCombo) — string | array | "*". Omit and pass match()
//           for bespoke logic (3-stage Escape, WASD dir-map, navIdle arrows).
//   match   (ev) => bool key filter, an alternative / addition to combo.
//   scope   SCOPE.GRAPH | PRETTY | ANY, checked against currentScope().
//   priority higher runs first; ties keep registration order.
//   allowInField default false -> entry skipped while isTypingTarget(ev).
//   when()  optional extra guard (overlay active, batch dirty, selection non-empty, navIdle).
//   run(ev) does its OWN preventDefault exactly where the original did. Returns truthy to CONSUME
//           (stop dispatching to lower-priority entries).
//   stop    when true, a consumed key also gets ev.stopPropagation()+stopImmediatePropagation()
//           so non-registry DOM listeners don't also see it. Set ONLY where the original called
//           stopPropagation (edit_txn, precap lightbox, clone-drag). Everything else falls through
//           exactly as it does today (e.g. the graph Escape runs behind an unconsumed modal Escape).
let _seq = 0;
const _keys = new Map();   // token -> entry (with _seq for stable sort)
let _sorted = [];          // entries sorted priority desc, then registration order
function _resort() {
    _sorted = [..._keys.values()].sort((a, b) => (b.priority - a.priority) || (a._seq - b._seq));
}

export function registerKey(entry) {
    const token = ++_seq;
    const e = {
        combo: entry.combo,
        match: entry.match,
        scope: entry.scope || SCOPE.ANY,
        priority: entry.priority || 0,
        allowInField: !!entry.allowInField,
        when: entry.when,
        run: entry.run,
        stop: !!entry.stop,
        _seq: token,
    };
    _keys.set(token, e);
    _resort();
    return function dispose() { if (_keys.delete(token)) _resort(); };
}

function _dispatch(ev) {
    const scope = currentScope();
    const typing = isTypingTarget(ev);
    for (const e of _sorted) {
        if (e.scope !== SCOPE.ANY && e.scope !== scope) continue;
        if (typing && !e.allowInField) continue;
        if (e.combo && !matchesCombo(ev, e.combo)) continue;
        if (e.match && !e.match(ev)) continue;
        if (e.when && !e.when(ev)) continue;
        if (e.run(ev)) {                          // truthy = handled -> stop the registry
            // The loop's `return` already stops lower-priority entries; stopPropagation is only for
            // NON-registry DOM listeners (a bubble handler). Match the originals, which called
            // stopPropagation only (never stopImmediate).
            if (e.stop) ev.stopPropagation();
            return;
        }
    }
}
document.addEventListener("keydown", _dispatch, true);

// Combo matcher for the simple entries. Grammar (case-insensitive on the key letter):
//   "*"                         any key (cancelPan, clone-abort)
//   "Escape" | "Enter" | "Tab" | "Delete" | "PageUp" | "PageDown" | "ArrowLeft".. | "r" | "w"..
//   "Mod+Z"                     Ctrl (win) or Meta (mac) + Z, WITHOUT shift
//   "Shift+Mod+Z"               + shift
//   "Mod+Y"                     redo alt
//   "Shift+Tab" | "Shift+r"     shift + key
// Pass an array to match ANY of several combos. `Mod` = ctrlKey || metaKey.
export function matchesCombo(ev, combo) {
    if (Array.isArray(combo)) return combo.some((c) => matchesCombo(ev, c));
    if (combo === "*") return true;
    const parts = combo.split("+");
    const key = parts[parts.length - 1];
    const wantShift = parts.includes("Shift");
    const wantMod = parts.includes("Mod");
    const mod = !!(ev.ctrlKey || ev.metaKey);
    if (wantMod !== mod) return false;
    if (wantShift !== !!ev.shiftKey) return false;
    // For non-Mod plain keys the original handlers also required no alt; keep that.
    if (!wantMod && ev.altKey) return false;
    const named = ["Escape", "Enter", "Tab", "Delete", "PageUp", "PageDown",
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (named.includes(key)) return ev.key === key;
    return ev.key.toLowerCase() === key.toLowerCase();   // letter keys (w/a/s/d/r/z/y)
}

// ---- global mouse / window singletons ----------------------------------------------------------
// Thin central wrapper: register on a target, get a dispose() back, and record the binding so
// listGlobals() can audit "every live global listener in one place". Bodies stay in owners.
const _globals = new Set();   // { target, type, owner }
export function onGlobal(target, type, handler, options, owner = "") {
    target.addEventListener(type, handler, options);
    const rec = { target, type, owner };
    _globals.add(rec);
    return function dispose() {
        target.removeEventListener(type, handler, options);
        _globals.delete(rec);
    };
}
export function listGlobals() {
    return {
        keys: _sorted.map((e) => ({ combo: e.combo, scope: e.scope, priority: e.priority, seq: e._seq })),
        mouse: [..._globals].map((g) => ({
            target: g.target === window ? "window" : g.target === document ? "document" : (g.target.id || g.target.className || "el"),
            type: g.type, owner: g.owner,
        })),
    };
}

// ---- outside-dismiss primitive ----------------------------------------------------------------
// Replaces the 7 copy-pasted "capture-phase pointer/mousedown outside closes X" blocks. Fires cb(ev)
// when a press lands OUTSIDE `el` (and outside every opts.also region). cb runs SYNCHRONOUSLY inside
// the pointer event (edit_txn depends on this: a focused input's blur-driven `change` must land in
// the still-open batch — do NOT debounce/rAF). Returns dispose(); also self-disposes once `el`
// detaches from the document, matching the old self-removal on close.
//   opts.event   "pointerdown" (default) | "mousedown"  — keep each site's original type so its
//                relative ordering vs other capture handlers is unchanged.
//   opts.also    () => Element | Element[]  — extra regions counted as "inside" (a bound overlay canvas).
//   opts.defer   true -> attach on setTimeout(0) so the opening click can't instantly self-close.
//   opts.escape  true -> also dismiss on Escape (registers an ANY-scope Escape entry, non-consuming).
//   opts.escapePriority  priority for that Escape entry (default 80).
export function onOutside(el, cb, opts = {}) {
    const event = opts.event || "pointerdown";
    let disposed = false;
    const insideEls = () => {
        const a = typeof opts.also === "function" ? opts.also() : opts.also;
        if (!a) return [];
        return Array.isArray(a) ? a : [a];
    };
    const onEvt = (e) => {
        if (disposed) return;
        if (!document.contains(el)) { dispose(); return; }   // safety net: el gone -> stop listening
        if (el.contains(e.target)) return;
        for (const x of insideEls()) if (x && x.contains(e.target)) return;
        cb(e);
    };
    let escDispose = null;
    const arm = () => {
        if (disposed) return;
        document.addEventListener(event, onEvt, true);
        if (opts.escape) {
            escDispose = registerKey({
                combo: "Escape", scope: SCOPE.ANY, priority: opts.escapePriority ?? 80,
                run: () => { cb(); return false; },   // non-consuming, like the originals
            });
        }
    };
    if (opts.defer) setTimeout(arm, 0); else arm();
    function dispose() {
        if (disposed) return;
        disposed = true;
        document.removeEventListener(event, onEvt, true);
        escDispose?.();
    }
    return dispose;
}
