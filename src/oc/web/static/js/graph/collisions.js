// Shared window-collision rendering. Detection is cross-window: classify() scores
// every window's detectors against a frame and picks ONE winner, so a window can
// match its own image yet lose to a sibling. The collision report (toolbox modal)
// and the per-window node verdict (imaging.js) both speak this vocabulary — it
// lives here once, both import it.
import { h, WARN } from "../dom.js";

// Verdict copy + class for the collision report. One source of truth for everyone.
// `label` is a node-factory (fresh nodes per call — a DOM node lives in one place only).
export const COLLIDE_VERDICTS = {
    ok:            [() => "✓ ok",                       "conf-ok",   "only this window matched its image"],
    collision:     [() => [WARN(), " collision"],       "conf-warn", "another window also fully matched — ambiguous"],
    misclassified: [() => "✗ misclassified",            "conf-bad",  "another window WINS the tie-break — classify picks the wrong one"],
    self_no_match: [() => "✗ self no-match",            "conf-bad",  "this window's own image doesn't match it — detectors too strict/disabled"],
    no_image:      [() => "– no image",                 "muted",     "no bound capture to test — open the window node and bind one"],
};

// Join an array of nodes with a separator (string/node) between each — like Array.join
// but keeping live nodes instead of stringifying. Used to space inline detector chips.
export function intersperse(items, sep) {
    const out = [];
    items.forEach((it, i) => { if (i) out.push(sep); out.push(it); });
    return out;
}

// Single window's collision verdict, ready for an inline badge: the COLLIDE_VERDICTS
// lookup plus the "→ classifies as X" suffix when a different window wins the tie.
// Used by the per-window node verdict (imaging.js) and the report rows below.
export function verdictBadge(w) {
    const [label, cls, tip] = COLLIDE_VERDICTS[w.verdict] || [() => "?", "muted", ""];
    const winner = w.winner && w.winner !== w.window ? w.winner : null;
    return { label, cls, tip, winner };
}

// Full whole-profile report (the toolbox modal body).
export function collisionReportNode(data) {
    const wins = data.windows || [];
    if (!wins.length) return h("p", { class: "muted", style: "padding:12px" }, "no windows to check");
    const bad = wins.filter((w) => w.verdict !== "ok" && w.verdict !== "no_image").length;
    const head = bad
        ? h("p", { class: "conf-warn", style: "margin:0 0 8px" }, `${bad} window(s) collide — a frame could classify to the wrong window.`)
        : h("p", { class: "conf-ok", style: "margin:0 0 8px" }, "no collisions — every window matches only its own image.");
    const rows = wins.map((w) => {
        const { label, cls, tip, winner } = verdictBadge(w);
        // for a colliding/misclassified window, show WHICH windows also matched + their detector scores
        const offenders = (w.matches || []).filter((m) => m.matched && m.window !== w.window);
        const detail = offenders.map((m) => {
            const dets = (m.detectors || []).map((d) =>
                h("span", { class: "cc-det " + (d.matched ? "conf-ok" : "conf-bad") },
                    `${d.id} ${Math.round((d.score || 0) * 100)}%/${Math.round((d.threshold || 0) * 100)}%${d.read ? ` "${d.read}"` : ""}`));
            return h("div", { class: "cc-off" }, "↳ also matched ", h("b", m.window), " ", ...intersperse(dets, " "));
        });
        const win = winner ? h("span", { class: "muted" }, ` → classifies as ${winner}`) : null;
        return h("div", { class: "cc-row" },
            h("div", { class: "cc-head" },
                h("span", { class: cls, title: tip }, label()), " ", h("b", w.window), win,
                w.capture ? [" ", h("span", { class: "muted cc-cap" }, w.capture)] : null),
            detail);
    });
    return h("div", { class: "cc-wrap" }, head, h("div", { class: "cc-list" }, rows));
}
