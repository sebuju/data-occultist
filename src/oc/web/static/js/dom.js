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

// The ONE delete/remove glyph, as a node factory (a DOM node can live in only one place,
// so each call returns a FRESH svg). Every "remove this row / chip / source / session"
// button drops `TRASH()` in instead of an ad-hoc x so they never drift apart again.
// `currentColor` fill = it takes the button's own colour; `.ic-trash` (style.css) sizes it.
export const TRASH = () =>
    svg("svg", { class: "ic-trash", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
        svg("path", { fill: "currentColor", d: "M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z" }));

// One labelled control row inside a `.lab-grid` (graph.css): a label cell that sizes to its
// own text (grid col 1) followed by whatever control the caller emits next (col 2). The ONE
// label-grid primitive -- triggers, the price node, and view config build their config rows
// from it so labels line up. `top` pins the label for control cells that wrap to several lines.
export const labCell = (label, title = "", top = false) =>
    h("span", { class: "lab" + (top ? " lab-top" : ""), title: title || null }, label);

// Monochrome inline icons as node factories (fill = currentColor, sized to 1em) -- used
// instead of colour emoji so icons match surrounding text colour. `.ic` aligns to baseline.
const _ic = (d) => () => svg("svg", { class: "ic", viewBox: "0 0 24 24", width: "1em", height: "1em", "aria-hidden": "true" },
    svg("path", { fill: "currentColor", d }));
export const CAMERA = _ic("M20 5h-3.2l-1.4-1.8c-.2-.2-.5-.2-.8-.2H9.4c-.3 0-.6 0-.8.2L7.2 5H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-8 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z");
export const WARN = _ic("M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z");
export const PAUSE = _ic("M6 5h4v14H6zM14 5h4v14h-4z");
export const STAR = _ic("M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z");
export const COPY = _ic("M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z");
