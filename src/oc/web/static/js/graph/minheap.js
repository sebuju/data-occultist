// minheap.js — the shared binary min-heap behind the graph searches.
//
// Flat typed arrays instead of an array of tuples: a Float64Array of keys (the A*/Dijkstra `f`) and a
// parallel Int32Array of payloads (a packed state id). One instance is reused across searches —
// `clear()` resets the length, it never reallocates — so a search sitting inside a retry loop doesn't
// churn the allocator.
//
// The popped key is exposed as `.topKey` (set by `pop()`), since a search that prunes on cost needs
// the key it just took, and returning a pair would allocate.
//
// NOT yet a caller: route.js `makeAStar` fuses four payload lanes (f/g/node/dir) into its own heap and
// is documented as semantics-frozen — porting it would change tie-break order in the live routing hot
// path. New searches should use this.

export function makeHeap(cap = 1024) {
    let key = new Float64Array(cap), val = new Int32Array(cap), n = 0;
    const grow = () => {
        const k2 = new Float64Array(key.length * 2); k2.set(key); key = k2;
        const v2 = new Int32Array(val.length * 2); v2.set(val); val = v2;
    };
    const h = {
        topKey: 0,
        get size() { return n; },
        clear() { n = 0; },
        push(k, v) {
            if (n === key.length) grow();
            let i = n++; key[i] = k; val[i] = v;
            while (i) {
                const p = (i - 1) >> 1;
                if (key[p] <= key[i]) break;
                const tk = key[p]; key[p] = key[i]; key[i] = tk;
                const tv = val[p]; val[p] = val[i]; val[i] = tv;
                i = p;
            }
        },
        // Returns the min payload; its key lands in `h.topKey`. Undefined on an empty heap — callers
        // guard with `while (h.size)`.
        pop() {
            h.topKey = key[0];
            const out = val[0];
            n--;
            if (n) {
                key[0] = key[n]; val[0] = val[n];
                let i = 0;
                for (; ;) {
                    const a = 2 * i + 1, b = a + 1;
                    let m = i;
                    if (a < n && key[a] < key[m]) m = a;
                    if (b < n && key[b] < key[m]) m = b;
                    if (m === i) break;
                    const tk = key[m]; key[m] = key[i]; key[i] = tk;
                    const tv = val[m]; val[m] = val[i]; val[i] = tv;
                    i = m;
                }
            }
            return out;
        },
    };
    return h;
}
