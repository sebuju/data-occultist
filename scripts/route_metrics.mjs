// Route-quality metrics for the offline bench harness (scripts/route_bench.mjs), its only caller
// since the browser routing labs were retired. Distinct from followable.js: that is the pass/fail
// followability ORACLE the app and tests share; this is the softer quality read (proximity, gaps).
//
// through  = routes whose segments cut a node they don't terminate on (must be 0)
// overlaps = parallel segments of DIFFERENT lines sitting on top of each other (must be 0)
// tooClose = parallel segments of different lines within CLOSE px — visually ambiguous
// minGap   = smallest non-coincident gap between two parallel segments of different lines

const INSET = 6;     // shrink a node by this before testing — a route may legally graze the border
const CLOSE = 9;     // < this many px between two parallel wires = ambiguous

export function segHit(a, b, r) {
    const x1 = r.x + INSET, y1 = r.y + INSET, x2 = r.x + r.w - INSET, y2 = r.y + r.h - INSET;
    if (x2 <= x1 || y2 <= y1) return false;
    const ins = p => p[0] >= x1 && p[0] <= x2 && p[1] >= y1 && p[1] <= y2;
    if (ins(a) || ins(b)) return true;
    if (Math.abs(a[1] - b[1]) < 0.5) { const y = a[1]; if (y > y1 && y < y2 && Math.max(a[0], b[0]) > x1 && Math.min(a[0], b[0]) < x2) return true; }
    if (Math.abs(a[0] - b[0]) < 0.5) { const x = a[0]; if (x > x1 && x < x2 && Math.max(a[1], b[1]) > y1 && Math.min(a[1], b[1]) < y2) return true; }
    return false;
}

export function metrics(res, nodes) {
    let through = 0;
    for (const [k, rr] of res) { const sp = k.indexOf(" "), f = k.slice(0, sp), t = k.slice(sp + 1), p = rr.pts; if (!p) continue; for (const n of nodes) { if (n.id === f || n.id === t) continue; let hit = false; for (let i = 0; i + 1 < p.length; i++) if (segHit(p[i], p[i + 1], n)) { hit = true; break; } if (hit) { through++; break; } } }
    // PROXIMITY detection: two DIFFERENT lines' parallel segments whose spans overlap and whose coords
    // sit within CLOSE px are visually ambiguous (can't tell which is which) — even if not coincident.
    const Hs = [], Vs = [];
    for (const [k, rr] of res) { const p = rr.pts; if (!p) continue; for (let i = 0; i + 1 < p.length; i++) { const a = p[i], b = p[i + 1]; if (Math.abs(a[1] - b[1]) < 0.5) Hs.push({ c: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), k }); else if (Math.abs(a[0] - b[0]) < 0.5) Vs.push({ c: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), k }); } }
    let overlaps = 0, tooClose = 0, minGap = Infinity;
    const scan = (list) => {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            const A = list[i], B = list[j]; if (A.k === B.k) continue;
            if (Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo) <= 1) continue;   // spans don't run alongside
            const gap = Math.abs(A.c - B.c);
            if (gap < 1.5) overlaps++;
            else { if (gap < CLOSE) tooClose++; if (gap < minGap) minGap = gap; }
        }
    };
    scan(Hs); scan(Vs);
    return { through, overlaps, tooClose, minGap: Number.isFinite(minGap) ? +minGap.toFixed(1) : "-" };
}
