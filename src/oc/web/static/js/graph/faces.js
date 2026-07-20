// Face-normal constants + the one "pull an arriving endpoint into the node" primitive, shared by
// both routers (route.js A* fallback and busgraph.js bus path) so the inset can never diverge.
export const FACE_OUT = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };

// Pull the arriving endpoint `by` px INTO the node along its face normal, so a centred end-cap
// straddles the node edge instead of floating outside it. Mutates and returns pts. No-op when the
// side is unknown, `by` is 0/falsy, or there is no segment to anchor.
export function insetEndpoint(pts, side, by) {
    const v = FACE_OUT[side];
    if (!by || !v || pts.length < 2) return pts;
    const i = pts.length - 1;
    pts[i] = [pts[i][0] - v[0] * by, pts[i][1] - v[1] * by];
    return pts;
}
