// The page surface: lays out a page's widgets, applies style, evaluates show/enable
// conditions reactively, and — in edit mode — makes each widget draggable, resizable, and
// selectable. A full rebuild happens only on page switch / mode change / structural edit;
// data ticks reconcile inside each widget instance, and conditions toggle a class/hidden flag
// in place (rule 1) — never a rebuild.
//
// Position is resolved through each widget's optional `anchor` (where it's pinned): to the
// canvas or to another widget, at one of nine points (corners/edges/centre). x/y are the
// offset from that anchor point, so a widget anchored to another follows it when it moves or
// resizes. `placeAll()` recomputes every frame's left/top from the anchors — it runs after a
// build, on every drag/resize/nudge, and when the surface resizes, so dependents stay glued.

import { makeDraggable, addResizeGrips, GRID, snap } from "../graph/dragresize.js";
import { applyStyle, mergeStyle } from "./style.js";
import { widgetDef } from "./widgets/index.js";
import { evaluate, tokensIn, truthy } from "./expr.js";
import { resolveToken, subKeyForToken } from "./binding.js";
import { keySubscription, el } from "./widgets/util.js";
import { svg } from "../dom.js";

// nine anchor points: vertical t/m/b × horizontal l/c/r → fraction of the target box.
const FX = { l: 0, c: 0.5, r: 1 };
const FY = { t: 0, m: 0.5, b: 1 };
function anchorFrac(corner) {
    const c = typeof corner === "string" && corner.length === 2 ? corner : "tl";
    return { fx: FX[c[1]] ?? 0, fy: FY[c[0]] ?? 0 };
}

// x/y/w/h are stored as a number in a per-field unit (w.units.{x,y,w,h}, default px). Everything
// inside the canvas works in px, so values convert in/out: % is relative to the anchor target's
// box (the `ref` length), vw/vh (and the dynamic dvw/dvh) to the viewport. The "calc" unit is the
// exception: the value is a raw CSS calc body (a STRING, e.g. "100% - 20px") that the browser
// resolves for us via an offscreen probe — % in it is measured against the same `ref`.
export const POS_UNITS = ["px", "%", "vw", "vh", "dvw", "dvh", "calc"];
const r2 = (v) => Math.round(v * 100) / 100;
export const unitOf = (w, k) => (w.units && w.units[k]) || "px";

// Resolve a CSS calc body to signed px by parking it on the `left` of a hidden probe whose parent is
// `ref` px wide — so `%` measures against ref, while px/vw/vh resolve natively. One probe, reused.
let _calcParent = null, _calcEl = null;
function calcToPx(expr, ref) {
    if (typeof document === "undefined" || !document.body) return 0;
    if (!_calcParent) {
        _calcParent = document.createElement("div");
        _calcParent.style.cssText = "position:absolute;left:-99999px;top:0;height:0;visibility:hidden;pointer-events:none;";
        _calcEl = document.createElement("div");
        _calcEl.style.position = "absolute";
        _calcParent.appendChild(_calcEl);
        document.body.appendChild(_calcParent);
    }
    _calcParent.style.width = `${Math.max(0, ref || 0)}px`;
    _calcEl.style.left = "0px";                       // reset so an invalid expr falls back to 0
    _calcEl.style.left = `calc(${expr})`;             // browser drops it if invalid -> left stays 0
    return _calcEl.getBoundingClientRect().left - _calcParent.getBoundingClientRect().left;
}
function lenToPx(val, unit, ref) {
    switch (unit) {
        case "%": return (val / 100) * ref;
        case "vw": case "dvw": return (val / 100) * window.innerWidth;
        case "vh": case "dvh": return (val / 100) * window.innerHeight;
        case "calc": return calcToPx(String(val ?? "0"), ref);
        default: return val;
    }
}
function pxToLen(px, unit, ref) {
    switch (unit) {
        case "%": return ref ? (px / ref) * 100 : px;
        case "vw": case "dvw": return (px / window.innerWidth) * 100;
        case "vh": case "dvh": return (px / window.innerHeight) * 100;
        case "calc": return `${r2(px)}px`;   // seed a valid expr equal to the current px (string!)
        default: return px;
    }
}
// Write a px length back into a field IN ITS UNIT — but never overwrite a "calc" field, whose value
// is a hand-authored expression that drag/resize must leave intact.
function storeLen(w, k, px, ref) {
    if (unitOf(w, k) === "calc") return;
    w[k] = r2(pxToLen(px, unitOf(w, k), ref));
}

// Render `page` into `surface`. Returns a controller with destroy()/updateAll()/select()/etc.
export function renderPage(surface, page, ctx) {
    surface.textContent = "";
    applyStyle(surface, mergeStyle(ctx.pretty.theme(), page.style));   // page-level style (theme defaults under it)
    const recs = new Map();   // widget id -> record
    let cueSvg = null;        // the edit-mode relationship overlay (declared early — drawAnchorCue runs below)
    let hoverId = null;       // widget hovered in edit mode — drives cue preview when nothing is selected

    for (const widget of page.widgets) build(widget);   // build() self-registers into `recs`
    placeAll();
    // NB: the edit-mode cue layer (drawAnchorCue) is drawn near the end of setup, not here — it reads
    // the SVGNS const + cue helpers declared further down, so calling it this early would TDZ.

    // anchored-to-canvas widgets (e.g. pinned to the right/bottom edge) re-place when the
    // surface changes size; cheap, and it keeps edge-pinned widgets where they belong. placeAll
    // resizes widgets, which can resize the surface again — running it synchronously inside the
    // observer trips "ResizeObserver loop completed with undelivered notifications", so defer to the
    // next frame (coalescing bursts) to break the feedback loop.
    let roFrame = 0, _roW = -1, _roH = -1;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
        if (roFrame) return;
        roFrame = requestAnimationFrame(() => {
            roFrame = 0;
            // Only react to a REAL surface-size change. .pw-surface is min-height/width:100% of #pretty,
            // so a scrollbar toggling #pretty's client size resizes the surface and re-fires this RO —
            // redrawing the cue, which can re-toggle the scrollbar (a flashing, CPU-pinning loop). Bail
            // when the size is unchanged so the loop can't sustain itself.
            const w = Math.round(surface.offsetWidth), h = Math.round(surface.offsetHeight);
            if (w === _roW && h === _roH) return;
            _roW = w; _roH = h;
            placeAll(); drawAnchorCue();
        });
    }) : null;
    ro && ro.observe(surface);

    function build(widget) {
        const def = widgetDef(widget.type);
        const frame = el("div", `pw pw-t-${widget.type}`);   // type class carries per-type defaults; inline style overrides
        frame.dataset.id = widget.id;
        frame.style.width = `${widget.w || 200}px`;
        frame.style.height = `${widget.h || 80}px`;
        frame.style.zIndex = String(widget.z || 1);
        applyStyle(frame, mergeStyle(ctx.pretty.theme(), widget.style));
        const host = el("div", "pw-content");
        frame.appendChild(host);
        surface.appendChild(frame);

        let inst = { update() {}, destroy() {} };
        if (def) { try { inst = def.create(host, widget, ctx) || inst; } catch (e) { host.textContent = String(e.message || e); } }

        // reactive conditions
        const condSub = keySubscription(ctx, () => applyConditions(rec));
        const rec = { widget, frame, host, inst, def, condSub };
        // Register BEFORE wiring/applying: resolvedCond (and match-rule target lookups) read `recs`,
        // so the rec must be in it first — otherwise the initial applyConditions resolves against a
        // missing rec, defaults to visible:true, and the condition silently never applies on build.
        recs.set(widget.id, rec);
        wireConditions(rec);
        applyConditions(rec);

        if (ctx.mode === "edit") wireEdit(rec);
        else { frame.classList.remove("pw-edit"); }
        return rec;
    }

    // ---- anchor-aware layout ----------------------------------------------------------

    // Resolve every widget's absolute box {left, top, w, h} from its anchor chain. The target is
    // the canvas (default) or another widget; the widget's own anchor point is placed at the
    // target's anchor point plus the widget's x/y offset. Memoised with a cycle guard so an
    // anchor loop falls back to the canvas instead of recursing forever.
    function resolveBoxes() {
        const surfW = surface.clientWidth || surface.offsetWidth || 0;
        const surfH = surface.clientHeight || surface.offsetHeight || 0;
        const memo = new Map();
        const box = (id, seen) => {
            if (memo.has(id)) return memo.get(id);
            const rec = recs.get(id);
            if (!rec) return null;
            const w = rec.widget;
            let tbox = { left: 0, top: 0, w: surfW, h: surfH };
            const a = w.anchor;
            if (a && a.to && a.to !== id && recs.has(a.to) && !seen.has(a.to)) {
                const t = box(a.to, new Set(seen).add(id));
                if (t) tbox = t;
            }
            let ww = lenToPx(w.w ?? 200, unitOf(w, "w"), tbox.w);
            let wh = lenToPx(w.h ?? 80, unitOf(w, "h"), tbox.h);
            // optional dimension match: copy another widget's RESOLVED px width/height. Resolved through
            // the same recursive box() with the same cycle guard as the anchor chain, so the source is
            // always computed first and a match loop (or a match back through an anchor) safely falls
            // back to the widget's own size instead of recursing forever.
            if (w.matchW && w.matchW !== id && recs.has(w.matchW) && !seen.has(w.matchW)) { const t = box(w.matchW, new Set(seen).add(id)); if (t) ww = t.w; }
            if (w.matchH && w.matchH !== id && recs.has(w.matchH) && !seen.has(w.matchH)) { const t = box(w.matchH, new Set(seen).add(id)); if (t) wh = t.h; }
            // scale the (matched-or-own) size by an optional percent (100 = unchanged, 25 = a quarter).
            // The box anchors at the widget's own `this` point (sf below), so the cut keeps that point put.
            ww *= (Number(w.matchWPct ?? 100) || 100) / 100;
            wh *= (Number(w.matchHPct ?? 100) || 100) / 100;
            const sf = anchorFrac(a && a.corner);                 // widget's own anchor point
            const tf = anchorFrac(a && (a.target || a.corner));   // point on the target box (defaults to corner)
            const ox = tbox.left + tf.fx * tbox.w, oy = tbox.top + tf.fy * tbox.h;
            const offX = lenToPx(w.x ?? 0, unitOf(w, "x"), tbox.w);
            const offY = lenToPx(w.y ?? 0, unitOf(w, "y"), tbox.h);
            const b = { left: ox - sf.fx * ww + offX, top: oy - sf.fy * wh + offY, w: ww, h: wh };
            memo.set(id, b);
            return b;
        };
        for (const id of recs.keys()) box(id, new Set());
        return memo;
    }
    function placeAll() {
        const boxes = resolveBoxes();
        for (const rec of recs.values()) {
            const b = boxes.get(rec.widget.id);
            if (!b) continue;
            rec.frame.style.left = `${Math.round(b.left)}px`;
            rec.frame.style.top = `${Math.round(b.top)}px`;
            rec.frame.style.width = `${b.w}px`;
            rec.frame.style.height = `${b.h}px`;
            rec.frame.style.zIndex = String(rec.widget.z || 1);
            // reflow a widget whose RESOLVED size changed (e.g. it matches one being resized) so its
            // content re-lays-out live, not just its frame box.
            if (rec._pw !== b.w || rec._ph !== b.h) {
                rec._pw = b.w; rec._ph = b.h;
                try { rec.inst.update && rec.inst.update(); } catch { /* guard */ }
            }
        }
        return boxes;
    }
    // The px size of a widget's anchor target box (the canvas, or another widget) — the reference
    // length a %/offset is measured against. Horizontal fields (x,w) use .w; vertical (y,h) use .h.
    function targetRef(id) {
        const rec = recs.get(id);
        const a = rec && rec.widget.anchor;
        if (a && a.to && a.to !== id && recs.has(a.to)) { const b = resolveBoxes().get(a.to); if (b) return { w: b.w, h: b.h }; }
        return { w: surface.clientWidth || surface.offsetWidth || 0, h: surface.clientHeight || surface.offsetHeight || 0 };
    }
    const refFor = (id, k) => { const r = targetRef(id); return k === "x" || k === "w" ? r.w : r.h; };

    // The full anchor-target box (canvas or another widget) for one widget — left/top too, not just
    // the reference lengths refFor gives.
    function anchorTargetBox(id) {
        const rec = recs.get(id);
        const a = rec && rec.widget.anchor;
        if (a && a.to && a.to !== id && recs.has(a.to)) { const b = resolveBoxes().get(a.to); if (b) return b; }
        return { left: 0, top: 0, w: surface.clientWidth || surface.offsetWidth || 0, h: surface.clientHeight || surface.offsetHeight || 0 };
    }
    // Back-solve a widget's x/y offsets so its anchored box (as resolveBoxes computes it) lands exactly
    // on `b`, the px box just produced by a drag-resize. This keeps the anchor link intact (it still
    // rides its target on future moves) while making the resize itself WYSIWYG — the dragged edge
    // stays where you let go instead of the anchor yanking the widget to recentre it.
    function offsetsForBox(w, b) {
        const a = w.anchor;
        const tbox = anchorTargetBox(w.id);
        const sf = anchorFrac(a && a.corner);
        const tf = anchorFrac(a && (a.target || a.corner));
        const ox = tbox.left + tf.fx * tbox.w, oy = tbox.top + tf.fy * tbox.h;
        return { x: r2(pxToLen(b.left - (ox - sf.fx * b.w), unitOf(w, "x"), tbox.w)),
                          y: r2(pxToLen(b.top - (oy - sf.fy * b.h), unitOf(w, "y"), tbox.h)) };
    }

    // Re-anchor a widget while keeping it visually in place: solve its x/y offset (in each field's
    // unit) so the new anchor resolves to the same box it currently occupies.
    function reanchor(id, anchor) {
        const rec = recs.get(id);
        if (!rec) return;
        const w = rec.widget;
        const before = resolveBoxes().get(id);
        w.anchor = anchor && anchor.to !== undefined
            ? { to: anchor.to, corner: anchor.corner || "tl", target: anchor.target || anchor.corner || "tl" }
            : { to: "", corner: "tl", target: "tl" };
        const sx = w.x, sy = w.y; w.x = 0; w.y = 0;
        const base = resolveBoxes().get(id);   // box with zero offset = the anchor-aligned position
        const ref = targetRef(id);
        w.x = before && base ? r2(pxToLen(before.left - base.left, unitOf(w, "x"), ref.w)) : sx;
        w.y = before && base ? r2(pxToLen(before.top - base.top, unitOf(w, "y"), ref.h)) : sy;
        placeAll(); drawAnchorCue();
        ctx.requestSave();
    }

    // ---- anchor cue (selected widget -> its anchor target) -----------------------------
    // When a selected widget is anchored to ANOTHER widget (not the canvas), outline that target
    // and draw the x/y offset as an L of two dashed lines — one horizontal, one vertical — from the
    // target's anchor point to the widget's anchored corner, so the "pinned to / point to" gap is
    // visible per-axis. Both legs ORIGINATE at the starting point P (the target's anchor point): the
    // horizontal one runs to the widget's x, the vertical one to its y. Each leg is labelled with its
    // distance in the widget's CONFIGURED unit for that field (unitOf x / y), midpoint, on a solid
    // chip for contrast. Redrawn whenever a box moves.
    const SVGNS = "http://www.w3.org/2000/svg";
    function ensureCueSvg() {
        if (!cueSvg) {
            cueSvg = document.createElementNS(SVGNS, "svg");
            cueSvg.setAttribute("class", "pw-anchor-cue");
            surface.appendChild(cueSvg);
        }
        return cueSvg;
    }
    function showAnchorCue() { drawAnchorCue(); }
    function cueLine(x1, y1, x2, y2, cls) {
        const l = document.createElementNS(SVGNS, "line");
        l.setAttribute("x1", x1); l.setAttribute("y1", y1);
        l.setAttribute("x2", x2); l.setAttribute("y2", y2);
        l.setAttribute("class", cls || "pw-cue-line");
        return l;
    }
    // Anchor endpoints are told apart by SHAPE, not size (same footprint): the target's anchor point
    // is a circle, the widget's own anchored corner ("this") is a square. The inspector shows the same
    // two glyphs next to its target / this pickers (see .pw-anchor-mark).
    // EVERY cue cap is the SAME CAP×CAP footprint — square caps, circle caps (diameter == side), and
    // the dimension-line end ticks (length == CAP) all share one size, so no cap is bigger/smaller
    // than another. No per-cap scaling.
    const CAP = 6;
    function cueMark(cx, cy, shape, cls) {
        if (shape === "square") {
            const r = document.createElementNS(SVGNS, "rect");
            r.setAttribute("x", cx - CAP / 2); r.setAttribute("y", cy - CAP / 2);
            r.setAttribute("width", CAP); r.setAttribute("height", CAP);
            r.setAttribute("class", cls);
            return r;
        }
        const c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", CAP / 2);
        c.setAttribute("class", cls);
        return c;
    }
    // ---- cue label layout -------------------------------------------------------------
    // Labels are QUEUED while a draw runs, then laid out together by flushLabels so they can keep
    // off the end caps, dodge each other (stagger), and grow a leader line back to home whenever
    // they can't sit on their own line. Each request:
    //   { cx, cy }  home centre (on the line)        text       cls        chip colour class
    //   axis        "h" flat / "v" rotated up the line
    //   p1, p2      the line's endpoints (its caps)  capClear   px to keep off those caps
    //   leaderCls   class for the home->chip tether when the chip is displaced
    let labelQ = [];
    function queueLabel(opts) { labelQ.push(opts); }
    function makeChip(svg, cx, cy, text, cls, hot) {
        const g = document.createElementNS(SVGNS, "g");
        const gc = (cls || "") + (hot ? " pw-cue-hot" : "");
        if (gc.trim()) g.setAttribute("class", gc.trim());   // recolours the chip per what it measures (see CSS); pw-cue-hot makes it pop
        const rect = document.createElementNS(SVGNS, "rect");
        rect.setAttribute("class", "pw-cue-lbl-bg"); rect.setAttribute("rx", "2");
        const t = document.createElementNS(SVGNS, "text");
        t.setAttribute("class", "pw-cue-lbl-tx");
        t.setAttribute("text-anchor", "middle"); t.setAttribute("dominant-baseline", "central");
        t.setAttribute("x", cx); t.setAttribute("y", cy); t.textContent = text;
        g.appendChild(rect); g.appendChild(t); svg.appendChild(g);   // appended so getBBox resolves
        const bb = t.getBBox(), px = 4, py = 2;
        rect.setAttribute("x", bb.x - px); rect.setAttribute("y", bb.y - py);
        rect.setAttribute("width", bb.width + px * 2); rect.setAttribute("height", bb.height + py * 2);
        return { g, w: bb.width + px * 2, h: bb.height + py * 2 };
    }
    // Lay out every queued label. A chip sits on its line (centred, opaque, hiding that span) only if
    // it FITS between the caps and nothing's there already; otherwise it's pushed PERPENDICULAR — past
    // the caps, toward the nearer page edge — and stepped further out until it clears earlier chips
    // (stagger). A displaced chip gets a leader line back to its home point on the line.
    // Normalise a line angle (radians) to (-90°, 90°] so text reads along the line without flipping
    // upside-down — a leg at 170° lays its glyph at -10°, still parallel to the line.
    function readableAngle(a) {
        while (a > Math.PI / 2) a -= Math.PI;
        while (a <= -Math.PI / 2) a += Math.PI;
        return a;
    }
    function flushLabels(svg) {
        const placed = [];
        const chips = [];   // every chip <g>, re-appended last so NO line (incl. leaders) covers a label
        const W = +svg.getAttribute("width") || window.innerWidth, H = +svg.getAttribute("height") || window.innerHeight;
        const overlaps = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
        for (const L of labelQ) {
            const { g, w, h } = makeChip(svg, L.cx, L.cy, L.text, L.cls, L.hot);
            chips.push(g);
            // angle the glyph sits at: explicit L.angle (match ties — along the diagonal), else the
            // axis shorthand ("v" = up the line = -90°, "h"/default = flat).
            const ang = readableAngle(L.angle != null ? L.angle : (L.axis === "v" ? -Math.PI / 2 : 0));
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const along = w, across = h;   // text reads ALONG the line; thickness is across it
            // AABB of the chip rotated by `ang`, centre shifted (dx,dy) from home
            const hx = (w * Math.abs(ca) + h * Math.abs(sa)) / 2;
            const hy = (w * Math.abs(sa) + h * Math.abs(ca)) / 2;
            const box = (dx, dy) => ({ x: L.cx + dx - hx, y: L.cy + dy - hy, w: 2 * hx, h: 2 * hy });
            const segLen = Math.hypot(L.p2.x - L.p1.x, L.p2.y - L.p1.y);
            const fits = along + 2 * L.capClear <= segLen;
            let dx = 0, dy = 0, displaced = false;
            if (!fits || overlaps(box(0, 0))) {
                displaced = true;
                // push PERPENDICULAR to the line; pick the side that leans toward the nearer page edges
                const px = -sa, py = ca;
                const sign = (px * (L.cx < W / 2 ? -1 : 1) + py * (L.cy < H / 2 ? -1 : 1)) >= 0 ? 1 : -1;
                const base = across / 2 + L.capClear + 2, step = across + 4;
                let k = 0;
                do { const off = sign * (base + k * step); dx = px * off; dy = py * off; k++; }
                while (overlaps(box(dx, dy)) && k < 40);
            }
            let tr = "";
            if (dx || dy) tr += `translate(${dx} ${dy}) `;   // screen-space shift OUTERMOST...
            if (ang) tr += `rotate(${ang * 180 / Math.PI} ${L.cx} ${L.cy})`;   // ...then orient the glyph in place
            if (tr) g.setAttribute("transform", tr.trim());
            placed.push(box(dx, dy));
            if (displaced) svg.insertBefore(cueLine(L.cx, L.cy, L.cx + dx, L.cy + dy, `${L.leaderCls || "pw-cue-leader"} pw-cue-leaderline${L.hot ? " pw-cue-hot" : ""}`), g);
        }
        for (const g of chips) svg.appendChild(g);   // lift all chips above every line drawn this pass
        labelQ = [];
    }
    const distLabel = (w, k) => `${r2(Math.abs(w[k] ?? 0))}${unitOf(w, k)}`;
    // One widget's anchor cue: the offset rectangle (legs P->Q) + endpoint dots, amber. Selected
    // widgets also carry the per-leg distance labels; unselected ones draw a dim line so every
    // anchor is visible without flooding the canvas with chips.
    function drawAnchorCueOne(svg, rec, boxes, sel, hot) {
        const w = rec.widget, a = w.anchor;
        if (!a || !a.to || !recs.has(a.to)) return;
        const sb = boxes.get(w.id), tb = boxes.get(a.to);
        if (!sb || !tb) return;
        const sf = anchorFrac(a.corner), tf = anchorFrac(a.target || a.corner);
        const P = { x: tb.left + tf.fx * tb.w, y: tb.top + tf.fy * tb.h };   // target's anchor point
        const Q = { x: sb.left + sf.fx * sb.w, y: sb.top + sf.fy * sb.h };   // widget's anchored corner
        const H = hot ? " pw-cue-hot" : "";
        const lc = (sel ? "pw-cue-line" : "pw-cue-line pw-cue-dim") + H;
        const dim = (sel ? "" : " pw-cue-dim") + H;
        // two legs at P and two at Q complete the offset rectangle; the second of each pair is dropped
        // when its gap is too tiny to separate from the first (and its label).
        const NEAR = 22;
        const farY = Math.abs(Q.y - P.y) >= NEAR, farX = Math.abs(Q.x - P.x) >= NEAR;
        const hLeg = { axis: "h", len: Math.abs(Q.x - P.x) }, vLeg = { axis: "v", len: Math.abs(Q.y - P.y) };
        if (Q.x !== P.x) {
            svg.appendChild(cueLine(P.x, P.y, Q.x, P.y, lc));
            if (sel) queueLabel({ cx: (P.x + Q.x) / 2, cy: P.y, text: distLabel(w, "x"), cls: null, hot, axis: "h", p1: { x: P.x, y: P.y }, p2: { x: Q.x, y: P.y }, capClear: 6, leaderCls: "pw-cue-line" });
            if (farY) {
                svg.appendChild(cueLine(P.x, Q.y, Q.x, Q.y, lc));
                if (sel) queueLabel({ cx: (P.x + Q.x) / 2, cy: Q.y, text: distLabel(w, "x"), cls: null, hot, axis: "h", p1: { x: P.x, y: Q.y }, p2: { x: Q.x, y: Q.y }, capClear: 6, leaderCls: "pw-cue-line" });
            }
        }
        if (Q.y !== P.y) {
            svg.appendChild(cueLine(P.x, P.y, P.x, Q.y, lc));
            if (sel) queueLabel({ cx: P.x, cy: (P.y + Q.y) / 2, text: distLabel(w, "y"), cls: null, hot, axis: "v", p1: { x: P.x, y: P.y }, p2: { x: P.x, y: Q.y }, capClear: 6, leaderCls: "pw-cue-line" });
            if (farX) {
                svg.appendChild(cueLine(Q.x, P.y, Q.x, Q.y, lc));
                if (sel) queueLabel({ cx: Q.x, cy: (P.y + Q.y) / 2, text: distLabel(w, "y"), cls: null, hot, axis: "v", p1: { x: Q.x, y: P.y }, p2: { x: Q.x, y: Q.y }, capClear: 6, leaderCls: "pw-cue-line" });
            }
        }
        svg.appendChild(cueMark(P.x, P.y, "circle", "pw-cue-dot" + dim));   // target's anchor point = circle
        svg.appendChild(cueMark(Q.x, Q.y, "square", "pw-cue-end" + dim));   // widget's own corner ("this") = square
    }
    // A widget's own width (cyan, bottom edge) and height (magenta, right edge) as labels only — the
    // chip text alone reads clearly, so no spans/bars are drawn. A dimension MATCHED to another widget
    // is already labelled by the match cue (mw/mh), so its own-size label is skipped (no duplicate).
    function drawDimCue(svg, rec, boxes, hot) {
        const w = rec.widget, b = boxes.get(w.id); if (!b) return;
        const H = hot ? " pw-cue-hot" : "";
        const hasMW = w.matchW && w.matchW !== w.id && recs.has(w.matchW);
        const hasMH = w.matchH && w.matchH !== w.id && recs.has(w.matchH);
        // each cue is a dimension line spanning the widget's ACTUAL size along the measured edge
        // (width on the bottom edge, height on the right edge), split around the centred chip. Edges
        // come from frameEdges so the line traces the painted frame (left/top rounded), pixel-exact.
        const e = frameEdges(b);
        if (!hasMW) {                                            // width: full line on the bottom edge + caps
            const y = e.B, cx = (e.L + e.R) / 2;
            svg.appendChild(cueLine(e.L, y, e.R, y, "pw-cue-dw" + H));
            svg.appendChild(cueLine(e.L, y - CAP / 2, e.L, y + CAP / 2, "pw-cue-dw" + H));   // left end cap
            svg.appendChild(cueLine(e.R, y - CAP / 2, e.R, y + CAP / 2, "pw-cue-dw" + H));   // right end cap
            queueLabel({ cx, cy: y, text: `${r2(b.w)}`, cls: "pw-cue-dw-lbl", hot, axis: "h", p1: { x: e.L, y }, p2: { x: e.R, y }, capClear: 6, leaderCls: "pw-cue-dw" });
        }
        if (!hasMH) {                                            // height: full line on the right edge + caps
            const x = e.R, cy = (e.T + e.B) / 2;
            svg.appendChild(cueLine(x, e.T, x, e.B, "pw-cue-dh" + H));
            svg.appendChild(cueLine(x - CAP / 2, e.T, x + CAP / 2, e.T, "pw-cue-dh" + H));   // top end cap
            svg.appendChild(cueLine(x - CAP / 2, e.B, x + CAP / 2, e.B, "pw-cue-dh" + H));   // bottom end cap
            queueLabel({ cx: x, cy, text: `${r2(b.h)}`, cls: "pw-cue-dh-lbl", hot, axis: "v", p1: { x, y: e.T }, p2: { x, y: e.B }, capClear: 6, leaderCls: "pw-cue-dh" });
        }
    }
    // Visualise a width/height match as a single dashed tie running between the two elements'
    // NEAREST facing edges (not centre-to-centre), labelled with the matched element's id (+ percent
    // when not 100). Width tie = cyan, height tie = magenta.
    // Box edges aligned to how placeAll paints the frame (left/top rounded, w/h kept).
    const frameEdges = (bx) => { const L = Math.round(bx.left), T = Math.round(bx.top); return { L, T, R: L + bx.w, B: T + bx.h }; };
    // shortest connector between two axis-aligned boxes: if their X ranges overlap it's a vertical
    // segment between the facing horizontal edges (at the overlap's mid-x); if Y ranges overlap,
    // horizontal between the facing vertical edges; otherwise the nearest corners.
    function edgeConnector(a, b) {
        const ox = Math.max(a.L, b.L) < Math.min(a.R, b.R);
        const oy = Math.max(a.T, b.T) < Math.min(a.B, b.B);
        if (ox) {
            const x = (Math.max(a.L, b.L) + Math.min(a.R, b.R)) / 2;
            if (a.B <= b.T) return [x, a.B, x, b.T];
            if (b.B <= a.T) return [x, a.T, x, b.B];
            return [x, (a.T + a.B) / 2, x, (b.T + b.B) / 2];   // overlap both axes — degenerate
        }
        if (oy) {
            const y = (Math.max(a.T, b.T) + Math.min(a.B, b.B)) / 2;
            if (a.R <= b.L) return [a.R, y, b.L, y];
            if (b.R <= a.L) return [a.L, y, b.R, y];
            return [(a.L + a.R) / 2, y, (b.L + b.R) / 2, y];
        }
        const ax = a.R <= b.L ? a.R : a.L, bx = b.R <= a.L ? b.R : b.L;
        const ay = a.B <= b.T ? a.B : a.T, by = b.B <= a.T ? b.B : b.T;
        return [ax, ay, bx, by];
    }
    // `only` (optional Set): when given, draw ONLY ties whose matched id is in it — used to show a
    // connected widget's tie INTO the selection without its unrelated matches.
    function drawMatchCue(svg, rec, boxes, hot, only) {
        const w = rec.widget, db = boxes.get(w.id); if (!db) return;
        const H = hot ? " pw-cue-hot" : "";
        const pctSuffix = (k) => { const v = Number(w[k] ?? 100) || 100; return v === 100 ? "" : `·${r2(v)}%`; };
        const tie = (srcId, lineCls, lblCls, capCls, pctKey) => {
            if (only && !only.has(srcId)) return;
            const sb = boxes.get(srcId); if (!sb) return;
            const [x1, y1, x2, y2] = edgeConnector(frameEdges(db), frameEdges(sb));
            svg.appendChild(cueLine(x1, y1, x2, y2, lineCls + H));
            svg.appendChild(cueMark(x1, y1, "square", capCls + H));   // start cap = square (this widget's end)
            svg.appendChild(cueMark(x2, y2, "circle", capCls + H));   // end cap = sphere (matched element's end)
            queueLabel({ cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, text: `${srcId}${pctSuffix(pctKey)}`, cls: lblCls, hot, angle: Math.atan2(y2 - y1, x2 - x1), p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, capClear: 9, leaderCls: lineCls });
        };
        if (w.matchW && w.matchW !== w.id && recs.has(w.matchW)) tie(w.matchW, "pw-cue-mlink-w", "pw-cue-mw-lbl", "pw-cue-mcap-w", "matchWPct");
        if (w.matchH && w.matchH !== w.id && recs.has(w.matchH)) tie(w.matchH, "pw-cue-mlink-h", "pw-cue-mh-lbl", "pw-cue-mcap-h", "matchHPct");
    }
    // In edit mode, draw the relationship layer: matches (under), then anchors, then each widget's
    // own dimensions. cueScope "all" shows EVERY widget's cues fully. "selected" shows the focus
    // widget(s) — the selection, or the hovered one when nothing is selected — with their FULL cue
    // set, PLUS the connecting cue of any OTHER widget that points at the focus (its anchor.to or a
    // width/height match), so a relationship reads from both ends. Connected widgets contribute only
    // that one tie, not their own dimensions. Every drawn cue is bright; no dimmed pass.
    function drawAnchorCue() {
        if (ctx.mode !== "edit") { if (cueSvg) cueSvg.style.display = "none"; return; }
        const svg = ensureCueSvg();
        const boxes = resolveBoxes();
        // Size the cue layer purely from the resolved WIDGET geometry — never from the surface's
        // client/scroll size. The SVG is a child of the surface and .pw-surface is min-height:100% of
        // the scrollable #pretty, so any size read off the surface moves with the scrollbars: feeding
        // it back into the SVG made the scrollbar flash and pinned the CPU in a bistable RO loop. Widget
        // boxes are fixed px (scrollbar-independent), so this is stable AND never exceeds what the
        // widgets already demand (no phantom overflow). Empty page -> 0×0 (nothing to draw).
        let cw = 0, ch = 0;
        for (const b of boxes.values()) { cw = Math.max(cw, b.left + b.w); ch = Math.max(ch, b.top + b.h); }
        svg.setAttribute("width", Math.ceil(cw)); svg.setAttribute("height", Math.ceil(ch));
        svg.style.display = ""; svg.replaceChildren();
        labelQ = [];   // collect every cue's labels, then lay them out together (below)
        const sel = (ctx.selectionIds && ctx.selectionIds()) || new Set();
        const list = [...recs.values()];
        const all = ctx.cueScope === "all";
        // focus = the widget(s) whose relationships we expand: the selection, or the hover preview.
        const focus = sel.size ? sel : (hoverId ? new Set([hoverId]) : new Set());
        // a widget gets its FULL cue set when in "all" scope or when it IS a focus widget.
        const primary = (id) => all || focus.has(id);
        // a NON-focus widget connects to the focus via its anchor target or a width/height match.
        const anchorsFocus = (w) => w.anchor && w.anchor.to && focus.has(w.anchor.to);
        const matchesFocus = (w) => (w.matchW && w.matchW !== w.id && focus.has(w.matchW)) ||
            (w.matchH && w.matchH !== w.id && focus.has(w.matchH));
        // cues "pop" (pw-cue-hot) only in "all" scope, where a selected/hovered widget must stand out
        // from the rest of the layer. In "selected" scope only the relevant cues are drawn anyway.
        const hot = (id) => all && (sel.has(id) || id === hoverId);
        for (const rec of list) {
            const w = rec.widget;
            if (primary(w.id)) drawMatchCue(svg, rec, boxes, hot(w.id));
            else if (focus.size && matchesFocus(w)) drawMatchCue(svg, rec, boxes, false, focus);   // tie INTO focus only
        }
        for (const rec of list) {
            const w = rec.widget;
            if (primary(w.id)) drawAnchorCueOne(svg, rec, boxes, true, hot(w.id));
            else if (focus.size && anchorsFocus(w)) drawAnchorCueOne(svg, rec, boxes, true, false);
        }
        for (const rec of list) {
            const w = rec.widget;
            if (primary(w.id)) drawDimCue(svg, rec, boxes, hot(w.id));   // own size: focus widgets only
        }
        flushLabels(svg);   // labels last so they sit above every line, dodging caps + each other
    }

    // A widget's REAL (non-match) show/enable from its compiled visible_when / enabled_when.
    function realCond(w) {
        const c = w.conditions || {};
        const resolve = (inner) => resolveToken(ctx, inner);
        return {
            visible: truthy(evaluate(c.visible_when, resolve, true)),
            enabled: truthy(evaluate(c.enabled_when, resolve, true)),
        };
    }
    // Resolved show/enable for a widget: its own real conditions AND-ed with every "match" rule it
    // carries. A match rule mirrors another element's RESOLVED show/enable, so ONE authored condition
    // can drive many elements. Real conditions resolve first, then matches; recursion is cycle-guarded
    // exactly like resolveBoxes handles matchW/matchH — a match loop falls back to the element's own
    // real state instead of recursing forever.
    function resolvedCond(id, seen) {
        const rec = recs.get(id);
        if (!rec) return { visible: true, enabled: true };
        let { visible, enabled } = realCond(rec.widget);
        for (const r of (rec.widget.conditions?.rules || [])) {
            if (r.effect !== "match" || !r.source || r.source === id) continue;
            if (!recs.has(r.source) || seen.has(r.source)) continue;
            const t = resolvedCond(r.source, new Set(seen).add(id));
            const st = r.state || "both";
            if (st === "show" || st === "both") visible = visible && t.visible;
            if (st === "enabled" || st === "both") enabled = enabled && t.enabled;
        }
        return { visible, enabled };
    }
    // Every {{token}} this widget's conditions depend on — INCLUDING those of any match target
    // (transitively, cycle-guarded), so a matcher re-evaluates the instant the source it mirrors flips.
    function condTokens(id, seen, out) {
        const rec = recs.get(id);
        if (!rec) return out;
        const c = rec.widget.conditions || {};
        for (const inner of [...tokensIn(c.visible_when || ""), ...tokensIn(c.enabled_when || "")]) out.add(inner);
        for (const r of (c.rules || [])) {
            if (r.effect === "match" && r.source && r.source !== id && recs.has(r.source) && !seen.has(r.source))
                condTokens(r.source, new Set(seen).add(id), out);
        }
        return out;
    }
    function wireConditions(rec) {
        const inners = [...condTokens(rec.widget.id, new Set(), new Set())];
        rec.condSub.sync(inners.map(subKeyForToken).filter(Boolean));
    }
    function applyConditions(rec) {
        const { visible, enabled } = resolvedCond(rec.widget.id, new Set());
        // in edit mode never hide (so you can still select/move a conditionally-hidden widget) —
        // dim it instead so the rule is visible while authoring.
        if (ctx.mode === "edit") {
            rec.frame.hidden = false;
            rec.frame.classList.toggle("pw-cond-hidden", !visible);
            rec.frame.classList.toggle("pw-cond-disabled", !enabled);
        } else {
            rec.frame.hidden = !visible;
            rec.frame.classList.toggle("pw-disabled", !enabled);
        }
    }

    function wireEdit(rec) {
        const { frame, widget } = rec;
        frame.classList.add("pw-edit");
        // hover preview: when nothing is selected, hovering a widget shows ITS cues (so you can
        // inspect a relationship without committing a selection). No redraw while a selection owns
        // the layer, or in "all" scope where every widget is already drawn.
        // In "selected" scope, hovering with nothing selected previews that widget's cues. In "all"
        // scope every widget is already drawn, but a hover still redraws so the hovered widget's cues
        // light up (pw-cue-hot). A selection owns the layer, so no hover redraw while one exists.
        frame.addEventListener("mouseenter", () => {
            hoverId = widget.id;
            if (!ctx.selectionIds().size) drawAnchorCue();
        });
        frame.addEventListener("mouseleave", () => {
            if (hoverId !== widget.id) return;
            hoverId = null;
            if (!ctx.selectionIds().size) drawAnchorCue();
        });
        // Click selects: shift toggles into the current group; a plain click on an already-selected
        // widget keeps the group (so it can be dragged in tandem), else it becomes the sole selection.
        frame.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0) return;
            if (ev.target.closest(".rz-grip, .rz-reset, .pw-del")) return;
            if (ev.shiftKey) ctx.selectWidget(widget.id, true);
            else if (!ctx.selectionIds().has(widget.id)) ctx.selectWidget(widget.id);
        });
        // hover trashcan -> delete with standard armed two-click confirm (rule 2)
        const del = el("button", "pw-del");
        del.title = "delete widget (click again to confirm)";
        del.appendChild(svg("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": "true" },
            svg("path", {
                d: "M3 4.5h10M6.4 4V2.8a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8V4M4.8 4.5l.5 8a1 1 0 0 0 1 .95h3.4a1 1 0 0 0 1-.95l.5-8",
                fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round", "stroke-linejoin": "round",
            })));
        del.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); });   // don't start a drag/select
        del.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.classList.add("armed"); setTimeout(() => { del.dataset.armed = "0"; del.classList.remove("armed"); }, 2500); return; }
            ctx.removeWidget(widget.id);
        });
        frame.appendChild(del);
        // Drag moves the whole selection in tandem when this widget is part of a multi-selection,
        // else just this one. The delta is snapped (not each absolute position) so the group keeps
        // its relative grid, and clamped so no member crosses the canvas edge.
        let sx = 0, sy = 0, movers = [];
        makeDraggable(frame, {
            handle: frame, threshold: 3, cursor: "grabbing",
            ignore: "input, select, textarea, button, a, .rz-grip, .rz-reset",
            onStart: (ev) => {
                sx = ev.clientX; sy = ev.clientY;
                const sel = ctx.selectionIds();
                const ids = sel.has(widget.id) && sel.size > 1 ? [...sel] : [widget.id];
                // capture each mover's start position IN PX + its unit/ref, so the px delta converts back
                // into whatever unit the field uses (px/%/vw/vh/dvw/dvh).
                movers = ids.map((id) => recs.get(id)).filter(Boolean).map((r) => {
                    const w = r.widget, ref = targetRef(w.id);
                    return { w, ux: unitOf(w, "x"), uy: unitOf(w, "y"), refW: ref.w, refH: ref.h,
                        pxX: lenToPx(w.x ?? 0, unitOf(w, "x"), ref.w), pxY: lenToPx(w.y ?? 0, unitOf(w, "y"), ref.h) };
                });
            },
            onMove: (e) => {
                // snap the DELTA (not each absolute position) so a multi-selection keeps its relative
                // grid. Offsets are anchor-relative and may be negative (e.g. anchored bottom-right), so
                // they're NOT clamped to >= 0 — clamping broke dragging for any non-top-left anchor.
                const dx = snap(e.clientX - sx), dy = snap(e.clientY - sy);
                for (const m of movers) { storeLen(m.w, "x", m.pxX + dx, m.refW); storeLen(m.w, "y", m.pxY + dy, m.refH); }
                placeAll(); drawAnchorCue();
                if (movers[0]) ctx.geomChanged && ctx.geomChanged(movers[0].w.id);
            },
            onSettle: () => ctx.requestSave(),
        });
        addResizeGrips(frame, {
            both: true, snap: true,
            // left-grip moves the left edge; addResizeGrips works in PX so just reposition the frame here
            // (onResize reads frame.offset* and stores everything). Don't placeAll here or it would reset
            // the width addResizeGrips just set, before onResize reads it.
            left: (v) => { if (v === undefined) return frame.offsetLeft; frame.style.left = `${v}px`; },
            // Resize is WYSIWYG: take the frame box the grips just drew, store its size, and back-solve
            // x/y so the anchor RESOLVES to that same box — so the anchor doesn't yank the widget around
            // mid-resize, yet still rides its target on future moves. pct (own-size scaling) is divided
            // back out so resolveBoxes re-applying it doesn't compound.
            onResize: () => {
                const b = { left: frame.offsetLeft, top: frame.offsetTop, w: frame.offsetWidth, h: frame.offsetHeight };
                const pw = (Number(widget.matchWPct ?? 100) || 100) / 100, ph = (Number(widget.matchHPct ?? 100) || 100) / 100;
                storeLen(widget, "w", b.w / pw, refFor(widget.id, "w"));
                storeLen(widget, "h", b.h / ph, refFor(widget.id, "h"));
                const off = offsetsForBox(widget, b);
                if (unitOf(widget, "x") !== "calc") widget.x = off.x;
                if (unitOf(widget, "y") !== "calc") widget.y = off.y;
                placeAll(); drawAnchorCue();
                ctx.geomChanged && ctx.geomChanged(widget.id);
            },
            onSettle: () => ctx.requestSave(),
        });
    }

    drawAnchorCue();   // initial edit-mode cue layer — here, after SVGNS + cue helpers are initialized

    return {
        updateAll() { for (const rec of recs.values()) try { rec.inst.update && rec.inst.update(); } catch { /* guard */ } },
        select(sel) {
            const ids = sel instanceof Set ? sel : sel ? new Set([sel]) : new Set();
            for (const rec of recs.values()) rec.frame.classList.toggle("pw-sel", ids.has(rec.widget.id));
        },
        // transient highlight (elements panel hover): flag one frame, clear the rest. null clears all.
        highlight(id) { for (const rec of recs.values()) rec.frame.classList.toggle("pw-hl", rec.widget.id === id); },
        placeAll,
        boxes: () => resolveBoxes(),   // resolved {left,top,w,h} per id — used for marquee hit-testing
        condState: (id) => resolvedCond(id, new Set()),   // resolved {visible,enabled} — for the inspector's match read-out
        // Re-wire + re-evaluate every widget's conditions in place after the rules were edited — so a
        // condition change applies WITHOUT a full rebuild (which would tear down embedded panels and
        // stop the live collector). Re-wiring all is cheap and keeps match dependencies consistent.
        recondition() { for (const rec of recs.values()) { wireConditions(rec); applyConditions(rec); } },
        reanchor,
        showAnchorCue,
        // px nudge (WASD) -> back into each field's unit
        nudge(dx, dy, ids) {
            const set = ids instanceof Set ? ids : new Set(ids ? [].concat(ids) : []);
            for (const id of set) {
                const r = recs.get(id); if (!r) continue; const w = r.widget;
                const rx = refFor(id, "x"), ry = refFor(id, "y");
                storeLen(w, "x", lenToPx(w.x ?? 0, unitOf(w, "x"), rx) + dx, rx);
                storeLen(w, "y", lenToPx(w.y ?? 0, unitOf(w, "y"), ry) + dy, ry);
            }
            placeAll(); drawAnchorCue();
        },
        // inspector geom edits: set a value (in the field's current unit) and re-place
        setGeom(id, patch) {
            const rec = recs.get(id); if (!rec) return; const w = rec.widget;
            for (const k of ["x", "y", "w", "h"]) if (k in patch) {
                const v = patch[k];
                if (unitOf(w, k) === "calc") w[k] = String(v);        // freeform expression
                else if (Number.isFinite(v)) w[k] = v;
            }
            placeAll(); drawAnchorCue();
            if (("w" in patch) || ("h" in patch)) { try { rec.inst.update && rec.inst.update(); } catch { /* */ } }
        },
        // change a field's unit, preserving its on-screen px so the widget doesn't jump. The stored
        // value is rounded (r2) per unit, so a naive value->px->value round-trip drifts (px->%->px
        // loses precision each hop). Cache the EXACT px per field and reuse it whenever the current
        // stored value still rounds back to it — so toggling a unit out and back is lossless. A manual
        // edit (or drag) changes the value so the cache no longer matches and we recompute from it.
        setUnit(id, k, unit) {
            const rec = recs.get(id); if (!rec) return; const w = rec.widget;
            const ref = refFor(id, k);
            const def = k === "w" ? 200 : k === "h" ? 80 : 0;
            const curUnit = unitOf(w, k);
            const cache = (rec.pxCache = rec.pxCache || {});
            const cached = cache[k];
            const matches = cached != null && r2(pxToLen(cached, curUnit, ref)) === (w[k] ?? def);
            const px = matches ? cached : lenToPx(w[k] ?? def, curUnit, ref);
            w.units = w.units || {}; w.units[k] = unit;
            const conv = pxToLen(px, unit, ref);
            w[k] = unit === "calc" ? conv : r2(conv);   // calc -> a "<px>px" string seed; numeric -> rounded
            cache[k] = px;   // keep the exact px so the next toggle stays lossless
            placeAll(); drawAnchorCue();
        },
        // match a dimension to another widget's resolved size. key is "matchW" / "matchH"; to is the
        // source widget id ("" clears). Resolution (and cycle safety) lives in resolveBoxes; here we
        // just record the link and re-place — every dependent recomputes from the single resolve pass.
        setMatch(id, key, to) {
            const rec = recs.get(id); if (!rec) return;
            if (to) rec.widget[key] = to; else delete rec.widget[key];
            placeAll(); drawAnchorCue();
        },
        // scale a matched/own dimension by a percent. key is "matchWPct" / "matchHPct"; 100 (default)
        // is stored as nothing so the widget stays clean.
        setMatchPct(id, key, pct) {
            const rec = recs.get(id); if (!rec) return;
            const v = Number(pct);
            if (Number.isFinite(v) && v !== 100) rec.widget[key] = v; else delete rec.widget[key];
            placeAll(); drawAnchorCue();
        },
        geom(id) {
            const r = recs.get(id); if (!r) return null; const w = r.widget;
            return { x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 200, h: w.h ?? 80,
                units: { x: unitOf(w, "x"), y: unitOf(w, "y"), w: unitOf(w, "w"), h: unitOf(w, "h") } };
        },
        destroy() { ro && ro.disconnect(); if (roFrame) cancelAnimationFrame(roFrame); for (const rec of recs.values()) { try { rec.inst.destroy && rec.inst.destroy(); } catch { /* */ } rec.condSub.destroy(); } recs.clear(); },
    };
}

export { GRID };
