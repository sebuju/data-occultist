// Pure line-diff for a side-by-side view (no DOM). Classic LCS over line arrays, O(n*m)
// which is fine for a single profile's YAML (hundreds, not tens-of-thousands, of lines).
// First diff primitive in the repo — a future diff caller (backups compare? subset diff?)
// should reuse this rather than growing a second one (CLAUDE.md rule 7).

// lineDiff(aLines, bLines) -> [{ left, right, type }]
// type: "equal" | "add" (right only) | "remove" (left only) | "change" (both, differ).
// Adjacent remove+add runs of equal length are paired into "change" rows so the two
// sides stay visually aligned instead of stacking all removals then all additions.
export function lineDiff(aLines, bLines) {
    const n = aLines.length, m = bLines.length;
    // dp[i][j] = LCS length of aLines[i:] vs bLines[j:]
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = aLines[i] === bLines[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    // Walk the LCS table to emit a raw add/remove/equal op stream.
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (aLines[i] === bLines[j]) { ops.push({ type: "equal", left: aLines[i], right: bLines[j] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "remove", left: aLines[i], right: null }); i++; }
        else { ops.push({ type: "add", left: null, right: bLines[j] }); j++; }
    }
    while (i < n) { ops.push({ type: "remove", left: aLines[i++], right: null }); }
    while (j < m) { ops.push({ type: "add", left: null, right: bLines[j++] }); }

    // Pair up adjacent remove-runs with add-runs of the same length into "change" rows.
    const out = [];
    for (let k = 0; k < ops.length;) {
        if (ops[k].type !== "remove") { out.push(ops[k]); k++; continue; }
        let re = k; while (re < ops.length && ops[re].type === "remove") re++;
        let ae = re; while (ae < ops.length && ops[ae].type === "add") ae++;
        const removes = ops.slice(k, re), adds = ops.slice(re, ae);
        const pairs = Math.min(removes.length, adds.length);
        for (let p = 0; p < pairs; p++) out.push({ type: "change", left: removes[p].left, right: adds[p].right });
        for (let p = pairs; p < removes.length; p++) out.push(removes[p]);
        for (let p = pairs; p < adds.length; p++) out.push(adds[p]);
        k = ae;
    }
    return out;
}
