// route.worker.js — runs the A* orthogonal router off the main thread.
//
// The pure compute (route.js/hierRoute.js/decollide.js/gates.js) has zero DOM/state deps, so it
// can run verbatim in a module worker. routing.js gathers all DOM-derived inputs (node rects,
// group boxes, CSS-free geometry) on the main thread, posts them here as plain data, and this
// worker returns the routed geometry Map. Nothing outside routing.js reads gateFaces/hierPassCache
// (gate-face hysteresis + hierRoute's per-pass memo) so they live here as module state and never
// cross the wire — only the request job in, the routes Map back.
//
// Protocol: {reqId, router, bus, hier, decollide, nodes, grps, groupBox, nodeGroup, edges, outPorts,
// prevSides, titleBands, blockRects, config, laneGap, containers, walls}
//   -> {reqId, routes, corridors, grade} | {reqId, error}.   `corridors` is the bus router's carved
// channels, posted back for the debug tint (routing.js ROUTE.corridors) so the main thread never
// recomputes them; `grade` is the followability audit of this pass, computed here (m.grade) because it
// is pure compute and the main thread has no business running an O(segments^2) scan mid-frame.
// {reset:true} clears gateFaces/hierPassCache (mirrors window.__reroute's full recompute).
import { routeGraph } from "./route.js";
import { hierRoute } from "./hierRoute.js";
import { deCollide } from "./decollide.js";
import { busRouteGraph } from "./busgraph.js";
import { gradeRoutes } from "./followable.js";

const rectsOf = (nodes) => { const o = {}; for (const n of nodes) o[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h }; return o; };

let gateFaces = new Map();
let hierPassCache = new Map();

onmessage = (e) => {
    const m = e.data || {};
    if (m.reset) { gateFaces = new Map(); hierPassCache = new Map(); return; }
    const { reqId } = m;
    try {
        let res, corridors = null;
        if (m.router === "bus") {
            // bus corridors; group heading bands are hard rects, misses fall back to a routeGraph pass
            // over only the edges that missed (so a clean run costs no A* at all).
            res = busRouteGraph(m.nodes, m.edges, {
                blockRects: m.blockRects, bus: m.bus,
                fallback: (missed) => routeGraph(m.nodes, [], missed, {
                    prevSides: m.prevSides, outPorts: m.outPorts, titleBands: m.titleBands, config: m.config,
                }),
                deconflict: m.decollide ? (r) => deCollide(r, m.walls, { laneGap: m.laneGap, containers: [] }) : null,
                onCorridors: (c) => { corridors = c; },
            });
        } else if (m.hier) {
            // groupOf() rebuilt from the plain nodeGroup Map (functions don't structured-clone)
            const gof = (id) => m.nodeGroup.get(id) || null;
            const out = hierRoute(m.nodes, m.groupBox, gof, m.edges, {
                prevSides: m.prevSides, outPorts: m.outPorts, titleBands: m.titleBands,
                config: m.config, laneGap: m.laneGap, prevFace: gateFaces, passCache: hierPassCache,
            });
            res = out.routes; gateFaces = out.faces; hierPassCache = out.passCache;
            if (m.decollide) res = deCollide(res, m.walls, { laneGap: m.laneGap, containers: m.containers, bench: m.config && m.config.bench });
        } else {
            res = routeGraph(m.nodes, [], m.edges, {
                prevSides: m.prevSides, outPorts: m.outPorts, titleBands: m.titleBands, config: m.config,
            });
            // one global pass leaves a few coincident runs (nudge separates within corridors, not across
            // near-identical coords); a single de-collision pass fans them apart. containers=[] — flat has
            // no hard group boxes, so a lane shift is bounded only by nodes+bands (m.walls).
            if (m.decollide) res = deCollide(res, m.walls, { laneGap: m.laneGap, containers: [], bench: m.config && m.config.bench });
        }
        postMessage({ reqId, routes: res, corridors, grade: m.grade ? gradeRoutes(res, rectsOf(m.nodes)) : null });   // Map structured-clones fine
    } catch (err) {
        postMessage({ reqId, error: String((err && err.message) || err) });
    }
};

