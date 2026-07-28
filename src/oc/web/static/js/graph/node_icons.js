// Per-node-type header glyphs. Each is declared ONCE here and reused by every node
// header (fillNode), so the markup lives in a single place — swap a path here and every
// node of that type updates. All icons share one 24x24 box + stroke style (picked in
// /playground/icon-playground.html); they tint via currentColor (see .nicon in graph.css).
//
// Built through dom.js's svg() (rule 7: one element builder, no innerHTML). Returned as
// NODES — an icon is dropped straight into a header as a child. A DOM node can live in only
// ONE place, so each lookup builds a FRESH detached <svg>.
import { svg } from "../dom.js";

const P = (d, extra) => svg("path", { d, ...extra });
const C = (cx, cy, r, extra) => svg("circle", { cx, cy, r, ...extra });
const fill = { fill: "currentColor", stroke: "none" };

// inner-element factories per type (currentColor; solid "fill" bits opt out of the stroke style)
const INNER = {
    game: () => [
        svg("rect", { x: "3", y: "8", width: "18", height: "9", rx: "4.5" }),
        svg("line", { x1: "7", y1: "11", x2: "7", y2: "14" }),
        svg("line", { x1: "5.5", y1: "12.5", x2: "8.5", y2: "12.5" }),
        C("15.5", "11.5", "1", fill), C("18", "13.5", "1", fill),
    ],
    window: () => [P("M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3")],
    // atlas: a character "A" in a card — the taught cutout atlas (glyph + symbol references)
    atlas: () => [
        svg("rect", { x: "4", y: "4", width: "16", height: "16", rx: "2.5" }),
        P("M8.5 16.5 12 7.5 15.5 16.5"),
        svg("line", { x1: "9.6", y1: "13.4", x2: "14.4", y2: "13.4" }),
    ],
    preview: () => [P("M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"), C("12", "12", "2.6")],
    region: () => [
        svg("rect", { x: "5", y: "6", width: "14", height: "12", rx: "1", "stroke-dasharray": "2 2" }),
        C("5", "6", "1.4", fill), C("19", "6", "1.4", fill), C("5", "18", "1.4", fill), C("19", "18", "1.4", fill),
    ],
    detect: () => [
        C("12", "12", "7"),
        svg("line", { x1: "12", y1: "3", x2: "12", y2: "6" }), svg("line", { x1: "12", y1: "18", x2: "12", y2: "21" }),
        svg("line", { x1: "3", y1: "12", x2: "6", y2: "12" }), svg("line", { x1: "18", y1: "12", x2: "21", y2: "12" }),
        C("12", "12", "1.4", fill),
    ],
    scrollbar: () => [
        svg("rect", { x: "9", y: "3", width: "6", height: "18", rx: "1" }),
        svg("line", { x1: "9", y1: "12", x2: "15", y2: "12" }),
        svg("rect", { x: "9.7", y: "6", width: "4.6", height: "5", rx: "1", ...fill }),
    ],
    item: () => [
        svg("rect", { x: "4", y: "4", width: "16", height: "16", rx: "2.5" }),
        P("M9 9h6v6H9z"),
        P("M9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3", { opacity: ".4" }),
    ],
    itemfield: () => [
        svg("rect", { x: "3", y: "9", width: "12", height: "6", rx: "3" }),
        svg("line", { x1: "6.5", y1: "12", x2: "11", y2: "12" }), P("M17 9l3 3-3 3"),
    ],
    // tell: a dashed detection box with a pass tick + the same child-of-item arrow as itemfield
    itemtell: () => [
        svg("rect", { x: "2.5", y: "7.5", width: "11", height: "9", rx: "2", "stroke-dasharray": "2.4 2" }),
        P("M5.5 12l2 2 3.4-3.8"), P("M17 9l3 3-3 3"),
    ],
    // readout: a partly-filled bar/gauge — a live, non-persisted value read off the screen.
    readout: () => [
        svg("rect", { x: "3", y: "9", width: "18", height: "6", rx: "3" }),
        svg("rect", { x: "3", y: "9", width: "10", height: "6", rx: "3", ...fill }),
    ],
    // register: a key -> value lookup map (left column of keys, right column of held values).
    register: () => [
        svg("rect", { x: "4", y: "5", width: "16", height: "14", rx: "2" }),
        svg("line", { x1: "10", y1: "5", x2: "10", y2: "19" }),
        C("7", "9", "1", fill), C("7", "12", "1", fill), C("7", "15", "1", fill),
        svg("line", { x1: "12.5", y1: "9", x2: "17", y2: "9" }),
        svg("line", { x1: "12.5", y1: "12", x2: "17", y2: "12" }),
        svg("line", { x1: "12.5", y1: "15", x2: "17", y2: "15" }),
    ],
    // process: a value piped THROUGH a rules box (stacked rule lines) — arrow in, arrow out.
    process: () => [
        svg("line", { x1: "2", y1: "12", x2: "6", y2: "12" }),
        P("M4 10l2 2-2 2"),
        svg("rect", { x: "7", y: "5.5", width: "10", height: "13", rx: "2" }),
        svg("line", { x1: "9.5", y1: "9", x2: "14.5", y2: "9" }),
        svg("line", { x1: "9.5", y1: "12", x2: "14.5", y2: "12" }),
        svg("line", { x1: "9.5", y1: "15", x2: "12.5", y2: "15" }),
        svg("line", { x1: "18", y1: "12", x2: "22", y2: "12" }),
        P("M20 10l2 2-2 2"),
    ],
    dataset: () => [
        svg("ellipse", { cx: "12", cy: "6", rx: "7", ry: "2.6" }),
        P("M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"),
        P("M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"),
    ],
    subset: () => [P("M4 8h6l4 4h6M4 16h6l2-2"), C("19", "12", "1.6", fill)],
    // vttable: a records grid — header row underlined, one column divider, body row lines.
    vttable: () => [
        svg("rect", { x: "4", y: "5", width: "16", height: "14", rx: "2" }),
        svg("line", { x1: "4", y1: "9.5", x2: "20", y2: "9.5" }),
        svg("line", { x1: "4", y1: "14.25", x2: "20", y2: "14.25" }),
        svg("line", { x1: "11.5", y1: "9.5", x2: "11.5", y2: "19" }),
    ],
    // producer: a cloud with a down-arrow — it FETCHES external data and produces records.
    producer: () => [
        P("M6.5 19h10a3.5 3.5 0 0 0 .4-6.98 5 5 0 0 0-9.65-.7A4 4 0 0 0 6.5 19z"),
        svg("line", { x1: "12", y1: "4", x2: "12", y2: "11" }),
        P("M9 8.5 12 11.5 15 8.5"),
    ],
    dictionary: () => [
        P("M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"), P("M5 18a2 2 0 0 1 2-2h11"),
        svg("line", { x1: "9", y1: "8", x2: "14", y2: "8" }),
    ],
    // file source: a document with a folded corner + log lines (it reads a game log/config file)
    filesource: () => [
        P("M6 3h7l5 5v13H6z"), P("M13 3v5h5"),
        svg("line", { x1: "9", y1: "12", x2: "15", y2: "12" }),
        svg("line", { x1: "9", y1: "15", x2: "15", y2: "15" }),
        svg("line", { x1: "9", y1: "18", x2: "13", y2: "18" }),
    ],
    // trigger has two looks, chosen by kind: a bolt for "on change", a clock for "interval".
    trigger_change: () => [P("M13 3L5 13h6l-1 8 8-10h-6z", fill)],
    trigger_timer: () => [C("12", "13", "7"), P("M12 9.5V13l2.5 1.5"), P("M9 3h6M12 3v3")],
    // gate: a funnel — the tested value narrows to a pass/block channel.
    gate: () => [P("M5 5h14M5 5 10 12v6l4 2v-8L19 5")],
    // router: a fan-out — one input branches to several targets.
    router: () => [C("6", "12", "2.4"), C("18", "6", "2.4"), C("18", "18", "2.4"), P("M8 11 16 7M8 13 16 17")],
    // toast: a bell with a clapper — an OS desktop notification raised on fire.
    toast: () => [
        P("M18 15.5v-4.5a6 6 0 1 0-12 0v4.5l-1.6 2v.5h15.2v-.5z"),
        P("M9.8 20.5a2.3 2.3 0 0 0 4.4 0"),
    ],
    // overlay: a screen with a floating panel on it — live values drawn over the game.
    overlay: () => [
        P("M3 5h18v11H3z"),
        P("M9 20h6M12 16v4"),
        svg("rect", { x: "5.4", y: "7.2", width: "7", height: "4.4", rx: "1", fill: "currentColor",
                      opacity: ".55", stroke: "none" }),
    ],
    // overlaywidget: a small framed box with a text line — one placed element on an overlay.
    overlaywidget: () => [
        svg("rect", { x: "3.5", y: "6", width: "17", height: "12", rx: "1.6", "stroke-dasharray": "2.4 2" }),
        P("M7 11h10M7 14h6"),
    ],
    // sound: a speaker cone + two sound waves — a browser-played sound raised on fire.
    sound: () => [
        P("M4 9v6h3l5 4V5L7 9z", fill),
        P("M15.5 8.5a5 5 0 0 1 0 7"),
        P("M18 6a8 8 0 0 1 0 12"),
    ],
    // action: a database with a curved arrow — clears/clones/moves a dataset's data on fire.
    action: () => [
        svg("ellipse", { cx: "9", cy: "6", rx: "5.5", ry: "2.2" }),
        P("M3.5 6v5c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V6"),
        P("M14 14.5a4 4 0 1 1-1.2-2.9M13 10.5v2.2h-2.2", { opacity: ".9" }),
    ],
};

// the shared icon box + stroke style; the type's inner factory fills it. A fresh node each call.
function icon(key) {
    const make = INNER[key];
    if (!make) return null;
    return svg("svg", {
        class: "nicon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    }, make());
}

// the header glyph for a node. `interval` triggers = clock; every other trigger = bolt.
export function nodeIcon(n) {
    if (n.type === "trigger") return icon(["interval", "true_interval"].includes(n.ref?.kind) ? "trigger_timer" : "trigger_change");
    return icon(n.type);
}

// The same glyph by bare type id (no node instance) — for menus/legends that name a type
// before any node exists. `trigger` defaults to the bolt. Shares the ONE icon source above.
export function iconFor(type) {
    if (type === "trigger") return icon("trigger_change");
    return icon(type);
}
