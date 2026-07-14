// Keyboard node-navigation geometry: pure picks over node centres. No DOM, no shared state —
// main.js feeds it {id,x,y} centres in world coords plus an anchor, and wires the results to the
// camera (arrow-nav pans, Enter selects). Split out so the geometry stays testable and main.js
// just does the key plumbing.

// The node whose centre is closest to a target world point. Used for Enter (select the
// centre-most node) and to seed arrow-nav when there's no anchor yet.
export function centreMost(centres, tx, ty) {
    let best = null, bd = Infinity;
    for (const c of centres) {
        const d = (c.x - tx) ** 2 + (c.y - ty) ** 2;
        if (d < bd) { bd = d; best = c.id; }
    }
    return best;
}

// The nearest node in a direction (dx,dy) from the anchor. A node only qualifies if it lies AHEAD
// along the direction and within a 45° cone of it (so Right picks a node to the right, not one
// mostly above that happens to be marginally rightward). For a DIAGONAL direction (both axes set)
// the candidate must also sit in that exact quadrant — a positive offset on BOTH axes — so a
// diagonal can only land on a genuinely off-axis node, never the same one a straight Up/Down/Left/
// Right would pick. When no such node exists the diagonal simply returns null (no invented target).
// Among qualifiers, prefer close and on-axis. Returns null if nothing lies in that direction.
export function nearestInDir(centres, from, dx, dy) {
    const diag = dx !== 0 && dy !== 0;
    const sx = Math.sign(dx), sy = Math.sign(dy);       // quadrant signs (captured pre-normalise)
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    let best = null, bs = Infinity;
    for (const c of centres) {
        if (c.id === from.id) continue;
        const vx = c.x - from.x, vy = c.y - from.y;
        if (diag && (Math.sign(vx) !== sx || Math.sign(vy) !== sy)) continue;   // off the diagonal's quadrant
        const along = vx * dx + vy * dy;                // distance ahead in the direction
        if (along <= 1e-3) continue;                    // behind or perpendicular -> not ahead
        const lateral = Math.abs(vx * -dy + vy * dx);   // perpendicular offset from the axis
        if (lateral > along) continue;                  // outside the 45° cone -> not "in" the direction
        const score = along + lateral * 2;              // close + on-axis wins
        if (score < bs) { bs = score; best = c.id; }
    }
    return best;
}
