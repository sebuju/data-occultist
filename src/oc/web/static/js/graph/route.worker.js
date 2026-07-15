// route.worker.js — runs the A* orthogonal router off the main thread.
//
// The pure compute (route.js/hierRoute.js/decollide.js/gates.js) has zero DOM/state deps, so it
// can run verbatim in a module worker. routing.js gathers all DOM-derived inputs (node rects,
// group boxes, CSS-free geometry) on the main thread, posts them here as plain data, and this
// worker returns the routed geometry Map. Nothing outside routing.js reads gateFaces/hierPassCache
// (gate-face hysteresis + hierRoute's per-pass memo) so they live here as module state and never
// cross the wire — only the request job in, the routes Map back.
//
// Protocol: {reqId, hier, decollide, nodes, grps, groupBox, nodeGroup, edges, outPorts, prevSides,
// titleBands, config, laneGap, containers, walls} -> {reqId, routes} | {reqId, error}.
// {reset:true} clears gateFaces/hierPassCache (mirrors window.__reroute's full recompute).
import { routeGraph } from "./route.js";
import { hierRoute } from "./hierRoute.js";
import { deCollide } from "./decollide.js";

let gateFaces = new Map();
let hierPassCache = new Map();

onmessage = (e) => {
    const m = e.data || {};
    if (m.reset) { gateFaces = new Map(); hierPassCache = new Map(); return; }
    const { reqId } = m;
    try {
        let res;
        if (m.hier) {
            // groupOf() rebuilt from the plain nodeGroup Map (functions don't structured-clone)
            const gof = (id) => m.nodeGroup.get(id) || null;
            const out = hierRoute(m.nodes, m.groupBox, gof, m.edges, {
                prevSides: m.prevSides, outPorts: m.outPorts, titleBands: m.titleBands,
                config: m.config, laneGap: m.laneGap, prevFace: gateFaces, passCache: hierPassCache,
            });
            res = out.routes; gateFaces = out.faces; hierPassCache = out.passCache;
            if (m.decollide) res = deCollide(res, m.walls, { laneGap: m.laneGap, containers: m.containers });
        } else {
            res = routeGraph(m.nodes, m.grps, m.edges, {
                prevSides: m.prevSides, outPorts: m.outPorts, titleBands: m.titleBands, config: m.config,
            });
        }
        postMessage({ reqId, routes: res });   // Map structured-clones fine
    } catch (err) {
        postMessage({ reqId, error: String((err && err.message) || err) });
    }
};
