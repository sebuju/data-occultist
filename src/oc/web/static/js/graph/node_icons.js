// Per-node-type header glyphs. Each is declared ONCE here and reused by every node
// header (fillNode), so the markup lives in a single place — swap a path here and every
// node of that type updates. All icons share one 24x24 box + stroke style (picked in
// /playground/icon-playground.html); they tint via currentColor (see .nicon in graph.css).

const wrap = (inner) =>
    `<svg class="nicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

// inner markup per type (currentColor; "fill" bits are written inline)
const INNER = {
    game: `<rect x="3" y="8" width="18" height="9" rx="4.5"/><line x1="7" y1="11" x2="7" y2="14"/><line x1="5.5" y1="12.5" x2="8.5" y2="12.5"/><circle cx="15.5" cy="11.5" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="13.5" r="1" fill="currentColor" stroke="none"/>`,
    window: `<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>`,
    preview: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>`,
    region: `<rect x="5" y="6" width="14" height="12" rx="1" stroke-dasharray="2 2"/><circle cx="5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="18" r="1.4" fill="currentColor" stroke="none"/>`,
    detect: `<circle cx="12" cy="12" r="7"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>`,
    scrollbar: `<rect x="9" y="3" width="6" height="18" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><rect x="9.7" y="6" width="4.6" height="5" rx="1" fill="currentColor" stroke="none"/>`,
    item: `<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M9 9h6v6H9z"/><path d="M9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3" opacity=".4"/>`,
    itemfield: `<rect x="3" y="9" width="12" height="6" rx="3"/><line x1="6.5" y1="12" x2="11" y2="12"/><path d="M17 9l3 3-3 3"/>`,
    // tell: a dashed detection box with a pass tick + the same child-of-item arrow as itemfield
    itemtell: `<rect x="2.5" y="7.5" width="11" height="9" rx="2" stroke-dasharray="2.4 2"/><path d="M5.5 12l2 2 3.4-3.8"/><path d="M17 9l3 3-3 3"/>`,
    dataset: `<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>`,
    subset: `<path d="M4 8h6l4 4h6M4 16h6l2-2"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>`,
    price: `<circle cx="12" cy="12" r="8"/><path d="M12 8v8M10 10.5c0-1 1-1.5 2-1.5s2 .6 2 1.5-1 1.3-2 1.5-2 .6-2 1.5 1 1.5 2 1.5 2-.5 2-1.5"/>`,
    dictionary: `<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11"/><line x1="9" y1="8" x2="14" y2="8"/>`,
    // file source: a document with a folded corner + log lines (it reads a game log/config file)
    filesource: `<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="18" x2="13" y2="18"/>`,
    // trigger has two looks, chosen by kind: a bolt for "on change", a clock for "interval".
    trigger_change: `<path d="M13 3L5 13h6l-1 8 8-10h-6z" fill="currentColor" stroke="none"/>`,
    trigger_timer: `<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 1.5"/><path d="M9 3h6M12 3v3"/>`,
};

// wrap each exactly once, then hand back the cached string on every call
const ICONS = Object.fromEntries(Object.entries(INNER).map(([k, v]) => [k, wrap(v)]));

// the header glyph for a node. `interval` triggers = clock; every other trigger = bolt.
export function nodeIcon(n) {
    if (n.type === "trigger") return ICONS[n.ref?.kind === "interval" ? "trigger_timer" : "trigger_change"];
    return ICONS[n.type] || "";
}

// The same glyph by bare type id (no node instance) — for menus/legends that name a type
// before any node exists. `trigger` defaults to the bolt. Shares the ONE icon source above.
export function iconFor(type) {
    if (type === "trigger") return ICONS.trigger_change;
    return ICONS[type] || "";
}
