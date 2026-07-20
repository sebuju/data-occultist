// Pure-node test for the followability gate (no browser, no server — followable.js is DOM-free).
// Unit-asserts the checker itself: a clean transversal X passes; overlap / under-node / knot /
// self-overlap / crowd / hairpin each fail. This is the acceptance oracle a router is built to
// satisfy — the oracle must stay sound regardless of which routing method is in play.
//
// Run:  node tests/e2e/followable.mjs
import assert from "node:assert";
import { checkFollowable } from "../../src/oc/web/static/js/graph/followable.js";

// ---- checker soundness ----------------------------------------------------------------------
// clean transversal X: two wires, distinct directions, single shared interior point -> FOLLOWABLE
{
    const routes = { "a b": { pts: [[0, 0], [10, 10]] }, "c d": { pts: [[0, 10], [10, 0]] } };
    const v = checkFollowable(routes, {});
    assert.deepStrictEqual(v, [], "a clean X must pass");
}
// collinear overlap between two different wires -> overlap
{
    const routes = { "a b": { pts: [[0, 0], [10, 0]] }, "c d": { pts: [[3, 0], [13, 0]] } };
    const v = checkFollowable(routes, {});
    assert.ok(v.some((x) => x.kind === "overlap"), "collinear overlap must be caught");
}
// segment through a non-endpoint node interior -> under-node
{
    const routes = { "a b": { pts: [[0, 50], [200, 50]] } };
    const rects = { "a": { x: -20, y: 40, w: 20, h: 20 }, "b": { x: 200, y: 40, w: 20, h: 20 }, "mid": { x: 80, y: 30, w: 40, h: 40 } };
    const v = checkFollowable(routes, rects);
    assert.ok(v.some((x) => x.kind === "under-node" && x.node === "mid"), "a wire crossing a non-endpoint node must be caught");
}
// three distinct wires crossing at one point -> ambiguous-junction (knot)
{
    const routes = {
        "a b": { pts: [[-10, 0], [10, 0]] },
        "c d": { pts: [[0, -10], [0, 10]] },
        "e f": { pts: [[-10, -10], [10, 10]] },
    };
    const v = checkFollowable(routes, {});
    assert.ok(v.some((x) => x.kind === "ambiguous-junction" && x.knot), "a 3-wire knot must be caught");
}
// a wire doubling back on itself -> self-overlap
{
    const routes = { "a b": { pts: [[0, 0], [10, 0], [4, 0]] } };
    const v = checkFollowable(routes, {});
    assert.ok(v.some((x) => x.kind === "self-overlap"), "a backtrack must be caught");
}
// a wire's interior vertex landing on another wire's interior -> ambiguous-junction (T/merge)
{
    const routes = { "a b": { pts: [[0, 0], [20, 0]] }, "c d": { pts: [[10, 0], [10, 20]] } };
    const v = checkFollowable(routes, {});
    assert.ok(v.some((x) => x.kind === "ambiguous-junction"), "a T-merge must be caught");
}
// two parallel wires closer than 1px over a shared span -> crowd (read as one lane)
{
    const routes = { "a b": { pts: [[0, 0], [10, 0]] }, "c d": { pts: [[0, 0.3], [10, 0.3]] } };
    const v = checkFollowable(routes, {});
    assert.ok(v.some((x) => x.kind === "crowd"), "sub-pixel parallel lanes must be caught");
}
// the same wires a clear stroke+gap apart (4px) are fine
{
    const routes = { "a b": { pts: [[0, 0], [10, 0]] }, "c d": { pts: [[0, 4], [10, 4]] } };
    const v = checkFollowable(routes, {});
    assert.ok(!v.some((x) => x.kind === "crowd"), "wires a clear gap apart must pass");
}
// one wire folding back <1px from its own path (hairpin) -> crowd
{
    const routes = { "a b": { pts: [[0, 0], [10, 0], [10, 0.4], [0, 0.4], [0, 1]] } };
    const v = checkFollowable(routes, {});
    assert.ok(v.some((x) => x.kind === "crowd" && x.wires.length === 1), "a same-wire hairpin must be caught");
}
console.log("checker soundness: 9/9 OK");
