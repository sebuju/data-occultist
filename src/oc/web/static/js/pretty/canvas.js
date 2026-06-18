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
import { evaluate, tokensIn } from "./expr.js";
import { resolveToken, subKeyForToken } from "./binding.js";
import { keySubscription, el } from "./widgets/util.js";

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

    for (const widget of page.widgets) recs.set(widget.id, build(widget));
    placeAll();
    // NB: the edit-mode cue layer (drawAnchorCue) is drawn near the end of setup, not here — it reads
    // the SVGNS const + cue helpers declared further down, so calling it this early would TDZ.

    // anchored-to-canvas widgets (e.g. pinned to the right/bottom edge) re-place when the
    // surface changes size; cheap, and it keeps edge-pinned widgets where they belong. placeAll
    // resizes widgets, which can resize the surface again — running it synchronously inside the
    // observer trips "ResizeObserver loop completed with undelivered notifications", so defer to the
    // next frame (coalescing bursts) to break the feedback loop.
    let roFrame = 0;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
        if (roFrame) return;
        roFrame = requestAnimationFrame(() => { roFrame = 0; placeAll(); drawAnchorCue(); });
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
    function cueMark(cx, cy, shape, cls) {
        if (shape === "square") {
            const s = 8, r = document.createElementNS(SVGNS, "rect");
            r.setAttribute("x", cx - s / 2); r.setAttribute("y", cy - s / 2);
            r.setAttribute("width", s); r.setAttribute("height", s);
            r.setAttribute("class", cls);
            return r;
        }
        const c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 4.5);
        c.setAttribute("class", cls);
        return c;
    }
    // A distance chip centred on (cx, cy): text sized via getBBox, solid rect sized behind it.
    // `leg` = { axis, len } of the line it labels: when the chip's along-line extent would fill (or
    // overrun) that short gap it'd swallow the line, so shift it clear to the line's right side.
    function cueLabel(svg, cx, cy, text, leg, cls) {
        const g = document.createElementNS(SVGNS, "g");
        if (cls) g.setAttribute("class", cls);   // recolours the chip per what it measures (see CSS)
        const rect = document.createElementNS(SVGNS, "rect");
        rect.setAttribute("class", "pw-cue-lbl-bg"); rect.setAttribute("rx", "2");
        const t = document.createElementNS(SVGNS, "text");
        t.setAttribute("class", "pw-cue-lbl-tx");
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        t.setAttribute("x", cx); t.setAttribute("y", cy);
        t.textContent = text;
        g.appendChild(rect); g.appendChild(t); svg.appendChild(g);   // appended so getBBox resolves
        const bb = t.getBBox(), px = 4, py = 2;
        rect.setAttribute("x", bb.x - px); rect.setAttribute("y", bb.y - py);
        rect.setAttribute("width", bb.width + px * 2); rect.setAttribute("height", bb.height + py * 2);
        if (leg) {
            const along = leg.axis === "h" ? bb.width + px * 2 : bb.height + py * 2;
            if (along >= leg.len) g.setAttribute("transform", `translate(${bb.width / 2 + px + 3},0)`);
        }
        return { w: bb.width + px * 2, h: bb.height + py * 2 };   // chip size, for callers that size off the label
    }
    const distLabel = (w, k) => `${r2(Math.abs(w[k] ?? 0))}${unitOf(w, k)}`;
    // A dimension-span bar with end caps — reads as "this length". axis "h" spans a..b at y=fixed;
    // axis "v" spans a..b at x=fixed.
    function cueBar(svg, axis, a, b, fixed, cls) {
        if (axis === "h") {
            svg.appendChild(cueLine(a, fixed, b, fixed, cls));
            svg.appendChild(cueLine(a, fixed - 4, a, fixed + 4, cls));
            svg.appendChild(cueLine(b, fixed - 4, b, fixed + 4, cls));
        } else {
            svg.appendChild(cueLine(fixed, a, fixed, b, cls));
            svg.appendChild(cueLine(fixed - 4, a, fixed + 4, a, cls));
            svg.appendChild(cueLine(fixed - 4, b, fixed + 4, b, cls));
        }
    }
    // One widget's anchor cue: the offset rectangle (legs P->Q) + endpoint dots, amber. Selected
    // widgets also carry the per-leg distance labels; unselected ones draw a dim line so every
    // anchor is visible without flooding the canvas with chips.
    function drawAnchorCueOne(svg, rec, boxes, sel) {
        const w = rec.widget, a = w.anchor;
        if (!a || !a.to || !recs.has(a.to)) return;
        const sb = boxes.get(w.id), tb = boxes.get(a.to);
        if (!sb || !tb) return;
        const sf = anchorFrac(a.corner), tf = anchorFrac(a.target || a.corner);
        const P = { x: tb.left + tf.fx * tb.w, y: tb.top + tf.fy * tb.h };   // target's anchor point
        const Q = { x: sb.left + sf.fx * sb.w, y: sb.top + sf.fy * sb.h };   // widget's anchored corner
        const lc = sel ? "pw-cue-line" : "pw-cue-line pw-cue-dim";
        const dim = sel ? "" : " pw-cue-dim";
        // two legs at P and two at Q complete the offset rectangle; the second of each pair is dropped
        // when its gap is too tiny to separate from the first (and its label).
        const NEAR = 22;
        const farY = Math.abs(Q.y - P.y) >= NEAR, farX = Math.abs(Q.x - P.x) >= NEAR;
        const hLeg = { axis: "h", len: Math.abs(Q.x - P.x) }, vLeg = { axis: "v", len: Math.abs(Q.y - P.y) };
        if (Q.x !== P.x) {
            svg.appendChild(cueLine(P.x, P.y, Q.x, P.y, lc));
            if (sel) cueLabel(svg, (P.x + Q.x) / 2, P.y, distLabel(w, "x"), hLeg);
            if (farY) {
                svg.appendChild(cueLine(P.x, Q.y, Q.x, Q.y, lc));
                if (sel) cueLabel(svg, (P.x + Q.x) / 2, Q.y, distLabel(w, "x"), hLeg);
            }
        }
        if (Q.y !== P.y) {
            svg.appendChild(cueLine(P.x, P.y, P.x, Q.y, lc));
            if (sel) cueLabel(svg, P.x, (P.y + Q.y) / 2, distLabel(w, "y"), vLeg);
            if (farX) {
                svg.appendChild(cueLine(Q.x, P.y, Q.x, Q.y, lc));
                if (sel) cueLabel(svg, Q.x, (P.y + Q.y) / 2, distLabel(w, "y"), vLeg);
            }
        }
        svg.appendChild(cueMark(P.x, P.y, "circle", "pw-cue-dot" + dim));   // target's anchor point = circle
        svg.appendChild(cueMark(Q.x, Q.y, "square", "pw-cue-end" + dim));   // widget's own corner ("this") = square
    }
    // A widget's own width (cyan, bottom edge) and height (magenta, right edge) as labels only — the
    // chip text alone reads clearly, so no spans/bars are drawn.
    function drawDimCue(svg, rec, boxes) {
        const b = boxes.get(rec.widget.id); if (!b) return;
        // each tick sits just below its label and runs TWICE the label's size along its own axis.
        const wcx = b.left + b.w / 2, wcy = b.top + b.h;     // width label: centred on bottom edge
        const wl = cueLabel(svg, wcx, wcy, `${r2(b.w)}`, null, "pw-cue-dw-lbl");
        const wy = wcy + wl.h / 2 + 2;
        svg.appendChild(cueLine(wcx - wl.w, wy, wcx + wl.w, wy, "pw-cue-dw"));        // horizontal, length = 2x label width
        const hcx = b.left + b.w, hcy = b.top + b.h / 2;     // height label: centred on right edge
        const hl = cueLabel(svg, hcx, hcy, `${r2(b.h)}`, null, "pw-cue-dh-lbl");
        const hy = hcy + hl.h / 2 + 2;
        svg.appendChild(cueLine(hcx, hy, hcx, hy + hl.h * 2, "pw-cue-dh"));           // vertical, length = 2x label height
    }
    // Visualise a width/height match: span the matched edge on BOTH source and dependent, link their
    // midpoints with a dashed tie, and label with the axis (+ percent when not 100). Width = cyan on
    // top edges; height = magenta on left edges.
    // Box edges aligned to how placeAll paints the frame (left/top rounded, w/h kept), so cue lines
    // trace the visible element edge instead of sitting a sub-pixel off it.
    const frameEdges = (bx) => { const L = Math.round(bx.left), T = Math.round(bx.top); return { L, T, R: L + bx.w, B: T + bx.h }; };
    function drawMatchCue(svg, rec, boxes) {
        const w = rec.widget, db = boxes.get(w.id); if (!db) return;
        const pctSuffix = (k) => { const v = Number(w[k] ?? 100) || 100; return v === 100 ? "" : `·${r2(v)}%`; };
        if (w.matchW && w.matchW !== w.id && recs.has(w.matchW)) {
            const sb = boxes.get(w.matchW);
            if (sb) {
                const d = frameEdges(db), s = frameEdges(sb);
                cueBar(svg, "h", d.L, d.R, d.T, "pw-cue-mw");   // dependent's top edge
                cueBar(svg, "h", s.L, s.R, s.T, "pw-cue-mw");   // source's top edge
                svg.appendChild(cueLine((d.L + d.R) / 2, d.T, (s.L + s.R) / 2, s.T, "pw-cue-mlink-w"));
                cueLabel(svg, (d.L + d.R) / 2, d.T, `w${pctSuffix("matchWPct")}`, null, "pw-cue-mw-lbl");
            }
        }
        if (w.matchH && w.matchH !== w.id && recs.has(w.matchH)) {
            const sb = boxes.get(w.matchH);
            if (sb) {
                const d = frameEdges(db), s = frameEdges(sb);
                cueBar(svg, "v", d.T, d.B, d.L, "pw-cue-mh");   // dependent's left edge
                cueBar(svg, "v", s.T, s.B, s.L, "pw-cue-mh");   // source's left edge
                svg.appendChild(cueLine(d.L, (d.T + d.B) / 2, s.L, (s.T + s.B) / 2, "pw-cue-mlink-h"));
                cueLabel(svg, d.L, (d.T + d.B) / 2, `h${pctSuffix("matchHPct")}`, null, "pw-cue-mh-lbl");
            }
        }
    }
    // In edit mode, draw the relationship layer: matches (under), then anchors (selected last so its
    // labels sit on top), then the selected widget's own dimensions. ctx.cueScope "selected" limits
    // every cue to the selected widget(s); "all" shows every widget's (others' anchors dimmed). Outside
    // edit mode the layer is hidden.
    function drawAnchorCue() {
        if (ctx.mode !== "edit" || ctx.cueScope === "none") { if (cueSvg) cueSvg.style.display = "none"; return; }
        const svg = ensureCueSvg();
        const boxes = resolveBoxes();
        svg.setAttribute("width", surface.scrollWidth); svg.setAttribute("height", surface.scrollHeight);
        svg.style.display = ""; svg.innerHTML = "";
        const sel = (ctx.selectionIds && ctx.selectionIds()) || new Set();
        const selOnly = ctx.cueScope === "selected";
        const list = [...recs.values()];
        for (const rec of list) if (!selOnly || sel.has(rec.widget.id)) drawMatchCue(svg, rec, boxes);
        if (!selOnly) for (const rec of list) if (!sel.has(rec.widget.id)) drawAnchorCueOne(svg, rec, boxes, false);
        for (const rec of list) if (sel.has(rec.widget.id)) drawAnchorCueOne(svg, rec, boxes, true);
        for (const rec of list) if (!selOnly || sel.has(rec.widget.id)) drawDimCue(svg, rec, boxes);   // dims: all (or selected only)
    }

    function wireConditions(rec) {
        const c = rec.widget.conditions || {};
        const inners = [...tokensIn(c.visible_when || ""), ...tokensIn(c.enabled_when || "")];
        rec.condSub.sync(inners.map(subKeyForToken).filter(Boolean));
    }
    function applyConditions(rec) {
        const c = rec.widget.conditions || {};
        const resolve = (inner) => resolveToken(ctx, inner);
        const visible = evaluate(c.visible_when, resolve, true);
        const enabled = evaluate(c.enabled_when, resolve, true);
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
        del.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.5h10M6.4 4V2.8a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8V4M4.8 4.5l.5 8a1 1 0 0 0 1 .95h3.4a1 1 0 0 0 1-.95l.5-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
        placeAll,
        boxes: () => resolveBoxes(),   // resolved {left,top,w,h} per id — used for marquee hit-testing
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
