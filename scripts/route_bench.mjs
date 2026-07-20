// Offline routing bench + correctness gate. Runs the real routeGraph/deCollide over a captured graph
// fixture in plain node (both modules are DOM-free), so a perf change can be measured and proven
// route-identical without a browser. This is the ONLY automated guard on route.js/decollide.js — the
// browser routing labs it grew alongside are retired, so its fixture + metrics now live here beside it
// (regenerate the fixture from the live app console: copy(JSON.stringify(window.__graphDump()))).
//
//   node scripts/route_bench.mjs                       # 3 runs, median per-phase timings + metrics
//   node scripts/route_bench.mjs --dump baseline.json  # also write the routes for later comparison
//   node scripts/route_bench.mjs --cmp baseline.json   # diff routes vs a dump; exit 1 on ANY change
//   node scripts/route_bench.mjs --router flat|flatdc --repeat 5 --clear 20 --lane 10
//
// Metrics (route_metrics.mjs): through-node / overlaps / too-close / minGap. A perf-only change must
// keep --cmp clean; the metrics catch the rest.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const { routeGraph } = await import(new URL("../src/oc/web/static/js/graph/route.js", import.meta.url));
const { deCollide } = await import(new URL("../src/oc/web/static/js/graph/decollide.js", import.meta.url));
const { metrics } = await import(new URL("./route_metrics.mjs", import.meta.url));

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf("--" + name); return i < 0 ? dflt : argv[i + 1]; };
const which = flag("router", "flatdc");
const repeat = +flag("repeat", 3);
const cfg = { clearance: +flag("clear", 20), laneGap: +flag("lane", 10), bench: true };
const dumpTo = flag("dump", null);
const cmpTo = flag("cmp", null);

// ---- fixture ----------------------------------------------------------------
const fx = JSON.parse(readFileSync(resolve(HERE, "graph-fixture.json"), "utf8"));
const nodes = Object.entries(fx.nodeRects).map(([id, r]) => ({ id, x: r.x, y: r.y, w: r.w, h: r.h }));
const edges = fx.links.map(l => ({ from: l.aId, to: l.bId, key: l.key, port: !!l.port, pinSrc: null, tether: false }));

const run = () => {
    const res = routeGraph(nodes, [], edges, { config: cfg });
    if (which === "flat") return res;
    return deCollide(res, nodes.map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h })), { laneGap: cfg.laneGap, containers: [], bench: cfg.bench });
};

// ---- capture the `[route]` / `[decollide]` bench lines route.js already emits -------------------
const phases = [];   // one {total,grid,ports,facing,astar,nudge,dc} per repeat
const realLog = console.log;
let cur = null;
console.log = (...a) => {
    const s = String(a[0] ?? "");
    let m = /^\[route\] (\d+)ms total \| grid (\d+) ports (\d+) facing (\d+) astar (\d+) nudge (\d+)/.exec(s);
    if (m) { cur = { total: +m[1], grid: +m[2], ports: +m[3], facing: +m[4], astar: +m[5], nudge: +m[6], dc: 0 }; return; }
    m = /^\[decollide\] (\d+(?:\.\d+)?)ms/.exec(s);
    if (m && cur) { cur.dc = Math.round(+m[1]); return; }
    realLog(...a);
};

let res = null, wall = [];
for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    res = run();
    wall.push(performance.now() - t0);
    if (cur) { phases.push(cur); cur = null; }
}
console.log = realLog;

// ---- report -----------------------------------------------------------------
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const P = (k) => med(phases.map(p => p[k]));
const m = metrics(res, nodes);

console.log(`router=${which} · ${res.size}/${edges.length} routed · ${nodes.length} nodes · ${repeat} runs`);
if (phases.length) console.log(`median ${Math.round(med(wall))}ms wall | grid ${P("grid")} ports ${P("ports")} facing ${P("facing")} astar ${P("astar")} nudge ${P("nudge")} decollide ${P("dc")}`);
console.log(`through-node ${m.through} · overlaps ${m.overlaps} · too-close ${m.tooClose} · minGap ${m.minGap}`);

// ---- dump / compare ---------------------------------------------------------
// Routes serialize as key -> {pts,d1,d2}; p1/p2 are copies of the endpoints, so they add nothing.
const ser = () => { const o = {}; for (const [k, r] of res) o[k] = { pts: r.pts, d1: r.d1, d2: r.d2 }; return o; };
if (dumpTo) { writeFileSync(dumpTo, JSON.stringify(ser(), null, 0)); console.log(`dumped ${res.size} routes -> ${dumpTo}`); }
if (cmpTo) {
    const base = JSON.parse(readFileSync(cmpTo, "utf8")), now = ser();
    const keys = new Set([...Object.keys(base), ...Object.keys(now)]);
    let diff = 0;
    for (const k of keys) {
        const a = base[k], b = now[k];
        if (!a || !b) { if (diff++ < 10) console.log(`  ${!a ? "added" : "removed"}: ${k}`); continue; }
        if (JSON.stringify(a) !== JSON.stringify(b)) { if (diff++ < 10) console.log(`  changed: ${k}`); }
    }
    if (diff) { console.log(`ROUTE DIFF: ${diff}/${keys.size} routes differ vs ${cmpTo}`); process.exit(1); }
    console.log(`routes identical to ${cmpTo} (${keys.size})`);
}
