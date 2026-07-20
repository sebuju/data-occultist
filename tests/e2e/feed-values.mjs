// Headless spec for the testing inspector's value generator (graph/feed_values.js).
//
// DOM-free with an injectable rng, so it runs straight in Node. Pins the two stateful/probabilistic
// behaviours that silently rot otherwise: a counter must SWEEP and WRAP (not stick at a bound or
// step off into infinity), and the wrong-type garble must fire at the requested rate and produce a
// value of the type the field does NOT expect.
//
// Run:  node tests/e2e/feed-values.mjs
import { defaultRowState, rollValue, stepCounter, rawValue, garbleFor, WRONG_FOR_NUMBER, WRONG_FOR_TEXT }
    from "../../src/oc/web/static/js/graph/feed_values.js";

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`   ${cond ? "✓" : "✗"} ${msg}`); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// a deterministic rng that walks a fixed list of values, cycling
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const take = (st, n) => Array.from({ length: n }, () => rawValue(st));

console.log("countup: starts at min, steps, wraps at max");
{
    const st = { ...defaultRowState("number"), mode: "countup", min: "0", max: "3", step: "1" };
    eq(take(st, 6), ["0", "1", "2", "3", "0", "1"], "sweeps 0..3 then wraps to 0");
}

console.log("countdown: starts at max, steps down, wraps at min");
{
    const st = { ...defaultRowState("number"), mode: "countdown", min: "0", max: "3", step: "1" };
    eq(take(st, 6), ["3", "2", "1", "0", "3", "2"], "sweeps 3..0 then wraps to 3");
}

console.log("counters tolerate however the bounds are typed");
{
    // min/max reversed by the user — lo/hi are derived, so direction still comes from the MODE
    const up = { ...defaultRowState("number"), mode: "countup", min: "3", max: "0", step: "1" };
    eq(take(up, 5), ["0", "1", "2", "3", "0"], "countup with reversed bounds still counts up");
    const down = { ...defaultRowState("number"), mode: "countdown", min: "3", max: "0", step: "1" };
    eq(take(down, 5), ["3", "2", "1", "0", "3"], "countdown with reversed bounds still counts down");
}

console.log("counter step: fractional, oversized, and zero");
{
    const frac = { ...defaultRowState("number"), mode: "countup", min: "0", max: "1", step: "0.25" };
    eq(take(frac, 6), ["0", "0.25", "0.5", "0.75", "1", "0"], "fractional step rounds to 2dp and wraps");
    // a step past the far end must wrap rather than overshoot forever
    const big = { ...defaultRowState("number"), mode: "countup", min: "0", max: "3", step: "10" };
    eq(take(big, 3), ["0", "0", "0"], "a step larger than the range wraps every tick (never escapes)");
    // 0 / blank step would freeze the counter -> falls back to 1
    const zero = { ...defaultRowState("number"), mode: "countup", min: "0", max: "3", step: "0" };
    eq(take(zero, 3), ["0", "1", "2"], "a zero step falls back to 1 instead of freezing");
}

console.log("editing a bound re-seeds the counter (cur outside range)");
{
    const st = { ...defaultRowState("number"), mode: "countdown", min: "0", max: "100", step: "10" };
    eq(stepCounter(st), "100", "starts at max");
    eq(stepCounter(st), "90", "steps down");
    st.max = "50";            // user narrows the range; cur (80) is now outside it
    st.cur = null;            // which is exactly what the min/max input handler does
    eq(stepCounter(st), "50", "re-seeds to the new max");
}

console.log("counters work on a TEXT-typed row (sweeping a threshold is type-agnostic)");
{
    const st = { ...defaultRowState("text"), mode: "countup", min: "0", max: "2", step: "1" };
    eq(take(st, 4), ["0", "1", "2", "0"], "text row still counts");
}

console.log("fixed / random modes unchanged");
{
    const fx = { ...defaultRowState("text"), mode: "fixed", value: "Forma" };
    eq(rawValue(fx), "Forma", "fixed returns its value verbatim");
    const num = { ...defaultRowState("number"), mode: "random", min: "10", max: "20", int: true };
    eq(rawValue(num, () => 0.5), "15", "random number rolls in range (int)");
    const txt = { ...defaultRowState("text"), mode: "random", pool: " a , b , c " };
    eq(rawValue(txt, () => 0), "a", "random text picks from the trimmed pool");
    const empty = { ...defaultRowState("text"), mode: "random", pool: "" };
    eq(rawValue(empty, () => 0), "", "an empty pool yields empty, not undefined");
}

console.log("wrong-type garble");
{
    const num = { ...defaultRowState("number"), mode: "fixed", value: "1200" };
    // rng call order in rollValue: rawValue may consume none (fixed), then the dice, then the pick
    eq(rollValue(num, { garble: true, pct: 100, rnd: seq(0) }), WRONG_FOR_NUMBER[0], "number row garbles to text at 100%");
    eq(rollValue(num, { garble: true, pct: 0, rnd: seq(0.99) }), "1200", "0% never garbles");
    eq(rollValue(num, { garble: false, pct: 100, rnd: seq(0) }), "1200", "garble off is a no-op even at 100%");
    const txt = { ...defaultRowState("text"), mode: "fixed", value: "Forma" };
    ok(WRONG_FOR_TEXT.includes(rollValue(txt, { garble: true, pct: 100, rnd: seq(0) })), "text row garbles to a number");
    // a counter is numeric whatever the declared type says
    const ctr = { ...defaultRowState("text"), mode: "countup", min: "0", max: "5", step: "1" };
    ok(WRONG_FOR_NUMBER.includes(garbleFor(ctr, () => 0)), "a counter on a text row garbles to TEXT wreckage (it emits numbers)");
}

console.log("garble rate is honoured over many rolls");
{
    const st = { ...defaultRowState("number"), mode: "fixed", value: "5" };
    let garbled = 0;
    for (let i = 0; i < 2000; i++) {
        if (rollValue(st, { garble: true, pct: 25 }) !== "5") garbled++;
    }
    const rate = garbled / 2000;
    ok(rate > 0.18 && rate < 0.32, `~25% of sends garbled (got ${(rate * 100).toFixed(1)}%)`);
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
