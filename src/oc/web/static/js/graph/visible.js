// Defer work until an element first scrolls into view. One shared IntersectionObserver (rule 7 —
// don't hand-roll a second one per caller) backs every "lazy until visible" need in the graph
// editor: a toast node's server-rendered previews are the first caller, but any future node with
// an expensive boot-time fetch should reuse this rather than adding its own observer.
const _cbs = new WeakMap();   // element -> fn, so the one observer's callback can look it up
const _io = new IntersectionObserver((entries) => {
    for (const e of entries) {
        if (!e.isIntersecting) continue;
        const fn = _cbs.get(e.target);
        _io.unobserve(e.target);
        _cbs.delete(e.target);
        if (fn) fn();
    }
}, { rootMargin: "200px" });   // start the fetch a bit before the element actually reaches the viewport

// Run `fn` once, the first time `el` intersects the viewport (or ~200px before it does). No-ops
// safely if `el` is falsy/already detached — the observer just never sees it intersect.
export function whenVisible(el, fn) {
    if (!el) return;
    _cbs.set(el, fn);
    _io.observe(el);
}
