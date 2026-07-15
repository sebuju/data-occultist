// Minimal DOM helpers to keep panel modules terse.
// Panels are collapsible <details>; open/closed state persists across re-renders
// (keyed by a stable string) so refreshing doesn't reset what you collapsed.

const collapsed = new Set();

export function collapse(key, on = true) { on ? collapsed.add(key) : collapsed.delete(key); }

// ---- hyperscript: the ONE element builder every site uses (CLAUDE.md rule 7) ----
// h(tag, props?, ...children) -> HTMLElement.  Replaces innerHTML string-building.
//   props (optional plain object):
//     class / className -> setAttribute("class")
//     dataset: {k: v}   -> el.dataset.k = v   (null/undefined skipped)
//     style: "a:b" | {prop: val}
//     onClick / onInput / ... (on* + function) -> addEventListener(type, fn)
//     disabled/hidden/selected/open/... (BOOL set) -> property (presence semantics)
//     value/textContent/spellcheck             -> property (round-trips live state)
//     anything else (title, aria-*, role, type, placeholder, ...) -> setAttribute
//   children: Node kept; string/number -> text node; array -> spread;
//     null/false/undefined/"" -> skipped (so `cond && h(...)` is inert).
// frag(...children) -> DocumentFragment for multiple roots with no wrapper.
// svg(tag, props?, ...children) -> element + ALL descendants built through it live
//   in the SVG namespace; every prop is setAttribute (hyphenated SVG attrs work).

const SKIP = (c) => c == null || c === false || c === "";

function appendChild(el, c) {
    if (Array.isArray(c)) { for (const k of c) appendChild(el, k); return; }
    if (SKIP(c)) return;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
}

const BOOL = new Set(["disabled", "hidden", "selected", "open", "checked", "readOnly", "multiple", "required"]);

function applyProps(el, props, ns) {
    for (const k in props) {
        const v = props[k];
        if (v == null) continue;
        if (k === "class" || k === "className") { el.setAttribute("class", v); continue; }
        if (k === "dataset") { for (const d in v) if (v[d] != null) el.dataset[d] = v[d]; continue; }
        if (k === "style") {
            if (typeof v === "string") el.style.cssText = v;
            else for (const s in v) if (v[s] != null) el.style[s] = v[s];
            continue;
        }
        if (k.startsWith("on") && typeof v === "function") { el.addEventListener(k.slice(2).toLowerCase(), v); continue; }
        if (k === "html" || k === "innerHTML") throw new Error("h(): innerHTML is banned -- pass child nodes");
        if (!ns && BOOL.has(k)) { if (v) el[k] = true; else el.removeAttribute(k.toLowerCase()); continue; }
        if (ns) { el.setAttribute(k, v); continue; }
        if (k === "value" || k === "textContent" || k === "spellcheck") { el[k] = v; continue; }
        el.setAttribute(k, v);
    }
}

function build(create, tag, props, children, ns) {
    // allow h("div", child) / h("div", [kids]) with no props object
    if (props != null && (props instanceof Node || typeof props !== "object" || Array.isArray(props))) {
        children = [props, ...children]; props = null;
    }
    const el = create(tag);
    if (props) applyProps(el, props, ns);
    for (const c of children) appendChild(el, c);
    return el;
}

export function h(tag, props, ...children) {
    return build((t) => document.createElement(t), tag, props, children, false);
}

export function frag(...children) {
    const f = document.createDocumentFragment();
    for (const c of children) appendChild(f, c);
    return f;
}

const SVGNS = "http://www.w3.org/2000/svg";
export function svg(tag, props, ...children) {
    return build((t) => document.createElementNS(SVGNS, t), tag, props, children, true);
}

// A collapsible panel: <details><summary>{legend}</summary><div class="fs-body">{body}</div></details>.
// `legend` and `body` are nodes (or strings); `key` (required when legend isn't a plain
// string) keys the persisted open/closed state.
// `opts.open` overrides the persisted state (caller owns the open flag — e.g. the sources panel,
// which defaults its sections closed); `opts.onToggle(isOpen)` fires after a user toggle (e.g. to
// fetch values lazily on uncollapse).
export function fieldset(legend, body, key, opts = {}) {
    key = key || (typeof legend === "string" ? legend.trim() : "");
    const d = document.createElement("details");
    d.className = "panel-fs";
    d.open = opts.open !== undefined ? opts.open : !collapsed.has(key);
    const summary = h("summary", legend);
    d.append(summary, h("div", { class: "fs-body" }, body));
    summary.addEventListener("click", () => {
        // d.open reflects the *previous* state during the click; flip it.
        setTimeout(() => { collapse(key, !d.open); opts.onToggle && opts.onToggle(d.open); }, 0);
    });
    return d;
}

export function mount(container, el) { container.replaceChildren(el); }

// The ONE ResizeObserver idiom (CLAUDE.md rule 7). Every site that wants to react to an
// element's box change goes through this instead of hand-rolling `new ResizeObserver` +
// its own rAF coalescing + size-diff gate + teardown (which drifted per-site: some sync,
// some leaked, some snapped on incidental reflow).
//   observeResize(target, cb, opts) -> dispose()
//     coalesce (default true): fold a burst of ticks into ONE cb per animation frame.
//     gate     (default false): skip the cb when the ROUNDED content-box w/h is unchanged
//       from the last delivery. This is what kills self-write feedback loops (a cb that
//       resizes its own target) and the "ResizeObserver loop completed with undelivered
//       notifications" warning — without every caller re-implementing _roW/_roH bookkeeping.
//   cb receives { width, height, target } (rounded content dims from the latest entry).
//   Returns a dispose() that disconnect()s AND cancels any pending frame.
// No-op (dispose is a no-op) where ResizeObserver is unavailable, so callers drop the
// `typeof ResizeObserver !== "undefined"` guard they all used to carry.
export function observeResize(target, cb, { coalesce = true, gate = false } = {}) {
    if (typeof ResizeObserver === "undefined" || !target) return () => {};
    let raf = 0, lastW = -1, lastH = -1;
    const deliver = (w, h) => {
        if (gate && w === lastW && h === lastH) return;   // no real size delta -> no cb (loop guard)
        lastW = w; lastH = h;
        cb({ width: w, height: h, target });
    };
    const ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];               // latest box only; older ticks are stale
        const r = e.contentRect;
        const w = Math.round(r.width), h = Math.round(r.height);
        if (!coalesce) { deliver(w, h); return; }
        if (raf) return;                                      // a frame is already queued
        raf = requestAnimationFrame(() => { raf = 0; deliver(w, h); });
    });
    ro.observe(target);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); raf = 0; };
}

// The ONE delete/remove glyph, as a node factory (a DOM node can live in only one place,
// so each call returns a FRESH svg). Every "remove this row / chip / source / session"
// button drops `TRASH()` in instead of an ad-hoc x so they never drift apart again.
// `currentColor` fill = it takes the button's own colour; `.ic-trash` (style.css) sizes it.
export const TRASH = () =>
    svg("svg", { class: "ic-trash", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
        svg("path", { fill: "currentColor", d: "M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z" }));

// One labelled control row inside the node body grid (`.gn-grid`, graph.css): a label cell
// that sizes to its own text (grid col 1) followed by whatever control the caller emits next
// (col 2). The ONE label-cell primitive -- EVERY node's k/v rows build on it so labels line up
// in one column node-wide, and grid children are never naked text (rule: wrap all labels).
// `top` pins the label for control cells that wrap to several lines.
export const labCell = (label, title = "", top = false, cls = "") =>
    h("span", { class: "lab" + (top ? " lab-top" : "") + (cls ? " " + cls : ""), title: title || null }, label);

// A k/v field row for the body grid: the wrapped label (col 1) + the control (col 2), emitted
// as two DIRECT grid children (never a wrapping row element — that would break the shared
// column). This is THE way to add a labelled control to a node body. `title` tooltips the label;
// `top` aligns the label to the first line of a tall/wrapping control.
export const kv = (label, control, { title = "", top = false } = {}) =>
    frag(labCell(label, title, top), control);

// A body-grid sub-heading: uppercase dim label that spans BOTH columns and carries the dashed
// rule beneath it (graph.css `.fgrp`). `extra` is optional trailing content (e.g. rule +/copy
// buttons) kept on the same line. The ONE subheading primitive (rule 7).
export const subhead = (text, extra = null, title = "") =>
    h("div", { class: "fgrp gspan", title: title || null }, text, extra);

// A full-width body-grid block: any non-k/v content (image, list, table, textarea, multi-control
// row) spans both columns. Wrap such content in this so it sits in the grid without breaking the
// label column. `cls` adds caller classes; extra props merge in.
export const gspan = (cls, ...children) => {
    const c = typeof cls === "string" ? cls : "";
    const kids = typeof cls === "string" ? children : [cls, ...children];
    return h("div", { class: `gspan${c ? " " + c : ""}` }, ...kids);
};

// ---- the ONE button system (rule 7). Node buttons come in exactly three looks, by CLASS:
//   .btn        accent action (footer fetch/read/fire/test/play/save) — node-coloured
//   .btn-trash  hollow-danger remove/clear (the ONLY break from accent) — carries TRASH()
//   .btn-icon   bare square for cog / ▲▼ / tiny inline actions
// Base `button` (controls.css) supplies padding/radius/hover; these add only the colour/size
// treatment. No `:has()` — the trash look is an explicit class, not inferred from the icon.
// `btn(label, {cls, onClick, title, icon, disabled, dataset})` builds a labelled action button;
// `icon` (a node factory or node) is placed before the label.
export function btn(label, { cls = "btn", onClick, title, icon, disabled = false, dataset } = {}) {
    return h("button", {
        class: cls, title: title || null, disabled, dataset,
        onClick: onClick || null,
    }, typeof icon === "function" ? icon() : icon, label ? (icon ? " " : "") + label : null);
}
// An icon-only button (cog / move / tiny). `danger` swaps in the hollow-danger look.
export function iconBtn(icon, { cls = "", title, onClick, disabled = false, dataset, danger = false } = {}) {
    const base = danger ? "btn-trash" : "btn-icon";
    return h("button", {
        class: `${base}${cls ? " " + cls : ""}`, title: title || null, disabled, dataset,
        onClick: onClick || null,
    }, typeof icon === "function" ? icon() : icon);
}
// The ONE remove/clear button: hollow-danger square carrying the shared TRASH() glyph. Replaces
// every hand-rolled `h("button",{class:"… danger"}, TRASH())` so the trash look never drifts and
// no `:has(> .ic-trash)` rule is needed.
export const trashBtn = ({ cls = "", title = "remove", dataset, onClick, disabled = false } = {}) =>
    iconBtn(TRASH(), { cls, title, dataset, onClick, disabled, danger: true });

// A wired-sources row: the pinned label (col 1) + a `.sv-inputs` pill list (col 2), as two grid
// children. THE way to add a source-pill list to a node body (rule 7) — every sourcesInput
// (graph/sources_input.js) site builds on it. The label carries `.sv-lab` so graph.css aligns it
// to the first pill line (defined once here, not detected per-site via a :has() selector).
// `inputs` is the built `.sv-inputs` (sourcesInput's return value).
export const srcRow = (label, title, inputs) => frag(labCell(label, title, true, "sv-lab"), inputs);

// Monochrome inline icons as node factories (fill = currentColor, sized to 1em) -- used
// instead of colour emoji so icons match surrounding text colour. `.ic` aligns to baseline.
const _ic = (d) => () => svg("svg", { class: "ic", viewBox: "0 0 24 24", width: "1em", height: "1em", "aria-hidden": "true" },
    svg("path", { fill: "currentColor", d }));
export const CAMERA = _ic("M20 5h-3.2l-1.4-1.8c-.2-.2-.5-.2-.8-.2H9.4c-.3 0-.6 0-.8.2L7.2 5H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-8 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z");
export const WARN = _ic("M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z");
export const PAUSE = _ic("M6 5h4v14H6zM14 5h4v14h-4z");
export const STAR = _ic("M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z");
export const COPY = _ic("M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z");
export const PLUS = _ic("M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z");
export const CHECK = _ic("M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z");
export const XMARK = _ic("M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z");
export const PASTE = _ic("M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z");
export const UNDO = _ic("M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z");
