// Pure-node test: a bus "straight shot" (two facing nodes with clear line of sight) must never
// attach its endpoint to a node CORNER. busroute.js is DOM-free, so this runs without a browser.
//
// The straight-shot path used to hand facingGeom's RAW overlap band to reserveLeg. Those bounds are
// node edges, so once contention pushed a lane off centre the endpoint landed within a laneGap of a
// corner — inside the 14px render radius, which swallowed the stub. It was also the one endpoint path
// with no clamp at all: route.js clamps twice (clampEnds + fanFaceEnds). Both now share faceKeep().
//
// Run:  node tests/e2e/straight-shot-corners.mjs
import assert from "node:assert";
import { busRouteGraph } from "../../src/oc/web/static/js/graph/busgraph.js";
import { faceKeep } from "../../src/oc/web/static/js/graph/faces.js";
import { deCollide } from "../../src/oc/web/static/js/graph/decollide.js";

const startY = (out, key) => out.get(key).pts[0][1];

// ---- contention drives lanes to the band ends; none may reach a corner ----------------------
{
    // 40 wires between one facing pair. reserveLeg fills centre-out, so the outermost lanes are
    // pushed hard against both ends of the overlap band — the case that used to seat on a corner.
    const nodes = [{ id: "a", x: 0, y: 0, w: 80, h: 400 }, { id: "b", x: 400, y: 0, w: 80, h: 400 }];
    const edges = Array.from({ length: 40 }, (_, i) => ({ from: "a", to: "b", key: `a b#${i}`, pinSrc: null, insetEnd: 0 }));
    const out = busRouteGraph(nodes, edges, {});
    assert.ok(out.size > 20, `expected most of the 40 wires to route, got ${out.size}`);
    const ys = [...out.keys()].map((k) => startY(out, k));
    const keep = faceKeep(400);
    assert.ok(Math.min(...ys) >= keep - 1e-6, `top lane sits on the corner: y=${Math.min(...ys)} < ${keep}`);
    assert.ok(Math.max(...ys) <= 400 - keep + 1e-6, `bottom lane sits on the corner: y=${Math.max(...ys)} > ${400 - keep}`);
}

// ---- a partial overlap is clamped against the SMALLER face, not the band it shares ------------
{
    // b's face covers only the bottom 40px of a's 400px face. The shared coord must clear b's corners.
    const nodes = [{ id: "a", x: 0, y: 0, w: 80, h: 400 }, { id: "b", x: 300, y: 360, w: 80, h: 60 }];
    const edges = Array.from({ length: 6 }, (_, i) => ({ from: "a", to: "b", key: `a b#${i}`, pinSrc: null, insetEnd: 0 }));
    const out = busRouteGraph(nodes, edges, {});
    const keep = faceKeep(40);   // overlap band is 360..400
    for (const k of out.keys()) {
        const y = startY(out, k);
        assert.ok(y >= 360 + keep - 1e-6 && y <= 400 - keep + 1e-6, `${k} outside the inset band: y=${y}`);
    }
}

// ---- a band too narrow to clear both corners is NOT a straight shot --------------------------
{
    // 8px of overlap: no coord in it can clear a rounded corner at both ends, so MIN_FACING_SPAN
    // (faces.js) rejects the pair outright and it must ride the buses / fallback instead of being
    // squeezed onto a corner. With no fallback wired here that means "not straight-shotted", not
    // "placed badly" — the misplacement this whole file guards against.
    const nodes = [{ id: "a", x: 0, y: 0, w: 80, h: 400 }, { id: "b", x: 300, y: 392, w: 80, h: 60 }];
    const edges = [{ from: "a", to: "b", key: "a b", pinSrc: null, insetEnd: 0 }];
    const out = busRouteGraph(nodes, edges, {});
    if (out.has("a b")) {
        const y = startY(out, "a b");
        assert.ok(y >= 392 && y <= 400, `narrow-overlap endpoint escaped its band: y=${y}`);
    }
}

// ---- deCollide may not slide a straight shot off the OTHER end's face ------------------------
{
    // A 2-point straight shot is ONE segment that is both ends' port stub, so its single coord docks a
    // face on BOTH nodes. deCollide's endpoint slide used to read the face of pts[0] alone: it happily
    // slid the shot along the small trigger's wide face and parked it on the big window's CORNER.
    const win = { x: 0, y: 0, w: 500, h: 900 };          // "equipment window" — bottom face y=900
    const trig = { x: 440, y: 1000, w: 140, h: 100 };    // trigger below it, overlapping x 440..500
    const walls = [win, trig];
    // the shot, seated mid-band by the router, plus a wall of foreign runs packing every coord from
    // well left of the window across the whole shared band — so the only collision-free coords left
    // are OUTSIDE it, and the slide has to be refused rather than taken onto the corner.
    const routes = new Map([["shot", { pts: [[470, 1000], [470, 900]], p1: [470, 1000], d1: "T", p2: [470, 900], d2: "B", via: "facing" }]]);
    for (let x = 200; x <= 486; x += 12) routes.set(`pack${x}`, { pts: [[x, 920], [x, 980]], p1: [x, 920], d1: "T", p2: [x, 980], d2: "B", via: "bus" });
    const out = deCollide(routes, walls, { laneGap: 12 });
    const x = out.get("shot").pts[0][0];
    const keep = faceKeep(60);                            // the shared overlap band is x 440..500
    assert.ok(x >= 440 + keep - 1e-6 && x <= 500 - keep + 1e-6,
        `deCollide slid the shot onto a window corner: x=${x}, band ${440 + keep}..${500 - keep}`);
    assert.strictEqual(out.get("shot").pts[1][0], x, "the shot must stay straight after the slide");
}

console.log("straight-shot corner clamp: 4/4 OK");
