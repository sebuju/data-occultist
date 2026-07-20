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

// ---- a band too narrow to inset must not INVERT (the short-face guard) ------------------------
{
    // 8px of overlap: 2*PORT_END_KEEP would exceed the span, so faceKeep collapses toward 0 rather
    // than producing hi < lo and an unroutable (or wildly misplaced) endpoint.
    const nodes = [{ id: "a", x: 0, y: 0, w: 80, h: 400 }, { id: "b", x: 300, y: 392, w: 80, h: 60 }];
    const edges = [{ from: "a", to: "b", key: "a b", pinSrc: null, insetEnd: 0 }];
    const out = busRouteGraph(nodes, edges, {});
    assert.strictEqual(out.size, 1, "a narrow overlap must still route");
    const y = startY(out, "a b");
    assert.ok(y >= 392 && y <= 400, `narrow-overlap endpoint escaped its band: y=${y}`);
}

console.log("straight-shot corner clamp: 3/3 OK");
