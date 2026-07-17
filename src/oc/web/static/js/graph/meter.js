// Shared editable segmented meter (rule 7). Renders a 0..1 value as a row of segments + a numeric
// readout, and lets the user SET it by clicking / dragging across the bar. It drives a HIDDEN
// <input> carrying the caller's usual change-class + dataset.k, so the node's existing change
// wiring persists the value untouched — the bar is pure UI over that input, no new save path.
//
// This is the "de-inputted" threshold control: a number field (e.g. a field's min OCR confidence,
// a tell's threshold) becomes one bar you drag, instead of a spin-box. Pass `live` (0..1) to also
// paint the last actual reading as a ghost fill behind the threshold marker (used where a node has
// a live read to show); omit it for a plain editable threshold.
import { h } from "../dom.js";

const SEGS = 10;   // DEFAULT segment count (visual only; value is continuous, quantised by `step`).
                   // Fixed 6px-wide segs (graph.css) -> 10 fits the narrowest node value cell without
                   // clipping. Callers over a wider value range (e.g. a 0..200 tolerance) pass `segs`.

// opts: { cls, k, value, fid, title, step, segs, lo, hi, fmt }
//   cls   - change-class the node already wires (e.g. "ffset" / "fset" / "roset" / "pptol")
//   k     - dataset.k the node's handler switches on (omit for handlers that read value directly)
//   value - initial value (in [lo, hi])
//   fid   - item-field id to tag the hidden input with (item-field nodes key by it)
//   step  - quantisation of the committed value (default 0.05, matches the old confidence input)
//   segs  - segment count (default 10)
//   lo,hi - value range the bar spans (default 0..1, the confidence meter)
//   fmt   - format the numeric readout (default 2-decimal; e.g. integer for a tolerance)
export function confMeter({ cls, k = null, value = 0, fid = null, title = "", step = 0.05,
                           segs = SEGS, lo = 0, hi = 1, fmt = null } = {}) {
    const span = (hi - lo) || 1;
    const fmtVal = fmt || ((v) => v.toFixed(2));
    const ds = { ...(k ? { k } : {}), ...(fid ? { fid } : {}) };
    const hidden = h("input", { type: "hidden", class: cls, dataset: ds, value: String(value) });
    const segEls = Array.from({ length: segs }, () => h("span", { class: "seg off" }));
    const bar = h("div", { class: "segs" }, ...segEls);
    const pct = h("span", { class: "pct" });
    const wrap = h("div", { class: "meter editable", title, tabindex: "0" }, bar, pct, hidden);

    const clampV = (v) => Math.max(lo, Math.min(hi, v));
    const fracOf = (v) => (v - lo) / span;                       // value -> 0..1 fill fraction
    function paint(v) {
        const bars = Math.round(fracOf(v) * segs);
        segEls.forEach((s, i) => {
            const full = i < bars;
            s.classList.toggle("on", full);
            s.classList.toggle("off", !full);
        });
        pct.textContent = fmtVal(v);
    }
    function set(v, commit) {
        v = +clampV(Math.round(v / step) * step).toFixed(6);
        paint(v);
        if (commit && +hidden.value !== v) {
            hidden.value = String(v);
            hidden.dispatchEvent(new Event("change", { bubbles: true }));   // -> the node's existing handler persists it
        }
    }
    const clampF = (f) => Math.max(0, Math.min(1, f));
    const fracFromX = (clientX) => { const r = bar.getBoundingClientRect(); return clampF((clientX - r.left) / (r.width || 1)); };
    const valFromX = (clientX) => lo + fracFromX(clientX) * span;

    let dragging = false;
    // stop the press reaching the card's drag handle (it only ignores button/input/select/textarea/a,
    // not this div) so dragging the bar sets the value instead of moving the whole node.
    bar.addEventListener("mousedown", (e) => e.stopPropagation());
    bar.addEventListener("pointerdown", (e) => {
        if (e.button != null && e.button !== 0) return;
        dragging = true; try { bar.setPointerCapture(e.pointerId); } catch {}
        set(valFromX(e.clientX), true); e.stopPropagation(); e.preventDefault();
    });
    // hover preview: with no button down, light segments up to the cursor (slider affordance —
    // shows where a click lands) via a .hot class; committed .on state is untouched until a press.
    const hover = (frac) => {
        const units = Math.round(clampF(frac) * segs * 2);
        segEls.forEach((s, i) => {
            const full = units >= (i + 1) * 2;
            s.classList.toggle("hot", full);
            s.classList.toggle("hot-half", !full && units === i * 2 + 1);
        });
    };
    const clearHover = () => segEls.forEach((s) => s.classList.remove("hot", "hot-half"));
    bar.addEventListener("pointermove", (e) => { if (dragging) set(valFromX(e.clientX), true); else hover(fracFromX(e.clientX)); });
    bar.addEventListener("pointerleave", clearHover);
    const end = (e) => { dragging = false; try { bar.releasePointerCapture(e.pointerId); } catch {} };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
    wrap.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { set(+hidden.value + step, true); e.preventDefault(); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { set(+hidden.value - step, true); e.preventDefault(); }
    });

    paint(+hidden.value || lo);
    return wrap;
}
