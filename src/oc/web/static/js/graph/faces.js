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

export const OPPOSITE_FACE = { L: "R", R: "L", T: "B", B: "T" };

// A node has FOUR faces and a port may sit on any of them. These three are the whole vocabulary for
// picking one, kept here beside FACE_OUT so no caller re-derives "which way is that" by hand:
//   faceToward  — the face a delta points at; the DOMINANT axis wins, so a target directly below is
//                 "B", not whichever of L/R a tie-break happens to fall on.
//   faceMidpoint— the centre of that face, where an unfanned port parks.
//   faceCss     — the inline style that parks an IDLE dot on it. ALWAYS a full override: the two port
//                 elements have different CSS homes (`.port.out` right, `.port.pwatch` left), so
//                 "leave it to the stylesheet" would mean a different face for each.
export const faceToward = (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "L" : "R") : (dy < 0 ? "T" : "B"));
export function faceMidpoint(r, face) {
    if (face === "L") return [r.x, r.y + r.h / 2];
    if (face === "R") return [r.x + r.w, r.y + r.h / 2];
    if (face === "T") return [r.x + r.w / 2, r.y];
    return [r.x + r.w / 2, r.y + r.h];
}
export const faceCss = (face) =>
    face === "L" ? "left:-4px;right:auto;top:50%;bottom:auto;transform:translateY(-50%)"
        : face === "T" ? "top:-4px;bottom:auto;left:50%;right:auto;transform:translateX(-50%)"
            : face === "B" ? "top:auto;bottom:-4px;left:50%;right:auto;transform:translateX(-50%)"
                : "left:auto;right:-4px;top:50%;bottom:auto;transform:translateY(-50%)";

export const PORT_MIN = 12;      // hard floor between fanned out-port dots on one face (dot is 8px) — no overlap
export const PORT_END_KEEP = 18; // min distance an endpoint stays off a node corner (> corner radius 14) so the
                                 // rounded bend can't swallow the stub

// How far an endpoint must stay off both ends of a face span. Shrinks on a short face so the usable
// band never inverts (a 20px face would otherwise want 18px of keep at each end). Shared by every
// endpoint placer — route.js fans/clamps, busroute.js straight shots — so no path is left unclamped.
export const faceKeep = (span) => Math.min(PORT_END_KEEP, Math.max(0, (span - PORT_MIN) / 2));
