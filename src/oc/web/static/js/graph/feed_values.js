// Value generation for the testing inspector: what a feed row actually sends on each tick.
//
// Four modes — `fixed` (this exact value), `random` (a fresh roll in range), and `countup` /
// `countdown` (step between min and max, wrapping at the far end so a loop keeps sweeping
// instead of flatlining at a bound). On top of any mode, an optional wrong-type garble swaps in
// a value of the type the field does NOT expect, to exercise the rule pipeline against a bad read.
//
// DOM-free and rng-injectable so it runs headless under Node — see tests/e2e/feed-values.mjs.
// panels/inspector.js owns the widgets; this owns what they produce.

export const isNumType = (t) => t === "number" || t === "pips" || t === "diamonds";
const round2 = (v) => String(Math.round(v * 100) / 100);

// Wrong-type garble pools: numbers get plausible OCR wreckage (letter/digit confusions, dashes,
// blanks) rather than random words — that's what a real bad read looks like.
export const WRONG_FOR_NUMBER = ["n/a", "--", "-", "", "O", "l2O", "S00", "???", "err"];
export const WRONG_FOR_TEXT = ["0", "42", "1234", "-1", "3.14", "00"];

// ONE row-state shape for every type/mode — the count modes need min/max/step even on a text
// readout (a counter is how you sweep a value through a gate threshold), so carrying the whole
// shape beats branching per type and losing the user's numbers when they switch mode.
export function defaultRowState(type) {
    const base = { type: type || "text", mode: "fixed", value: "", pool: "", enabled: true,
                   min: "0", max: "100", step: "1", integer: false, cur: null };
    return (type === "pips" || type === "diamonds") ? { ...base, max: "10" } : base;
}

// Step a counter one tick and return the value it was AT before stepping (so the first send emits
// the start, not start+step). min/max are the two ends in whichever order they're typed; the mode
// picks direction and start. `cur` outside the range re-seeds — that's how an edited bound resets.
export function stepCounter(st) {
    const a = Number(st.min) || 0, b = Number(st.max) || 0;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const up = st.mode === "countup";
    const step = Math.abs(Number(st.step)) || 1;
    if (st.cur == null || st.cur < lo || st.cur > hi) st.cur = up ? lo : hi;
    const v = st.cur;
    const next = up ? v + step : v - step;
    st.cur = (up ? next > hi : next < lo) ? (up ? lo : hi) : next;   // wrap at the far end
    return Number.isInteger(v) ? String(v) : round2(v);
}

// The row's value for its own mode, before any garble.
export function rawValue(st, rnd = Math.random) {
    if (st.mode === "countup" || st.mode === "countdown") return stepCounter(st);
    if (st.mode === "fixed") return st.value;
    if (st.type === "number") {
        const lo = Number(st.min) || 0, hi = Number(st.max) || 0;
        const v = lo + rnd() * (hi - lo);
        return st.integer ? String(Math.round(v)) : round2(v);
    }
    if (isNumType(st.type)) {
        const lo = Math.round(Number(st.min) || 0), hi = Math.round(Number(st.max) || 0);
        return String(lo + Math.round(rnd() * (hi - lo)));
    }
    const pool = (st.pool || "").split(",").map((s) => s.trim()).filter(Boolean);
    return pool.length ? pool[Math.floor(rnd() * pool.length)] : "";
}

// A value of the type this row does NOT produce. A counter is numeric whatever the field's
// declared type says, so it garbles to text like any other number source.
export function garbleFor(st, rnd = Math.random) {
    const numeric = isNumType(st.type) || st.mode === "countup" || st.mode === "countdown";
    const pool = numeric ? WRONG_FOR_NUMBER : WRONG_FOR_TEXT;
    return pool[Math.floor(rnd() * pool.length)];
}

// The value to send. `garble` applies to EVERY mode (fixed included) — the point is to perturb an
// otherwise predictable stream so a rule pipeline / gate meets the type it does not expect.
export function rollValue(st, { garble = false, pct = 0, rnd = Math.random } = {}) {
    const val = rawValue(st, rnd);
    if (!garble) return val;
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return rnd() * 100 < p ? garbleFor(st, rnd) : val;
}
