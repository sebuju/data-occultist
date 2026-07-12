// Stale-tab save guard: when a save comes back 409 (someone else saved a structural
// change since this tab loaded — another tab, an external edit), this modal shows the
// two YAMLs side by side with timestamps and lets the user pick a side. No auto-merge —
// merging config is not something to guess at silently.
import { h, btn } from "../dom.js";
import { openModal } from "../modal.js";
import { armedButton } from "./armbtn.js";
import { fmtDateTime } from "../datefmt.js";
import { liveAgo } from "../ago.js";
import { lineDiff } from "../linediff.js";
import { profileVersion } from "../api.js";

// Profile YAML can run to thousands of lines, and almost all of it is unchanged on a
// conflict — nobody can inspect a 3500-row dump. Collapse long equal runs to CONTEXT
// lines either side of each change and fold the rest into a "… N unchanged lines"
// marker, so the modal shows only the hunks that actually differ (CLAUDE.md rule 4:
// a diff view is a preview, not a data dump). A safety cap still bounds the worst case.
const DIFF_CONTEXT = 3;
const DIFF_ROW_CAP = 400;

// collapse(rows) -> [{ kind:"row", row } | { kind:"fold", count }]
// Keeps every non-equal row plus DIFF_CONTEXT equal rows adjacent to a change; every
// other equal run becomes one fold marker.
function collapse(rows) {
    const keep = new Array(rows.length).fill(false);
    rows.forEach((r, idx) => {
        if (r.type === "equal") return;
        for (let k = Math.max(0, idx - DIFF_CONTEXT); k <= Math.min(rows.length - 1, idx + DIFF_CONTEXT); k++) keep[k] = true;
    });
    const out = [];
    for (let i = 0; i < rows.length;) {
        if (keep[i]) { out.push({ kind: "row", row: rows[i] }); i++; continue; }
        let j = i; while (j < rows.length && !keep[j]) j++;
        out.push({ kind: "fold", count: j - i });
        i = j;
    }
    return out;
}

function diffTable(serverText, incomingText) {
    const items = collapse(lineDiff(serverText.split("\n"), incomingText.split("\n")));
    const shown = items.slice(0, DIFF_ROW_CAP);
    const body = h("div", { class: "conf-diff" },
        ...shown.map((it) => it.kind === "fold"
            ? h("div", { class: "conf-diff-fold" }, `… ${it.count} unchanged line${it.count === 1 ? "" : "s"}`)
            : h("div", { class: `conf-diff-row cd-${it.row.type}` },
                h("div", { class: "cd-cell cd-left" }, it.row.left ?? ""),
                h("div", { class: "cd-cell cd-right" }, it.row.right ?? ""))));
    if (items.length > shown.length) {
        body.appendChild(h("div", { class: "conf-diff-fold" }, `+${items.length - shown.length} more rows (truncated)`));
    }
    return body;
}

// openConflictModal(payload, { onOverwrite, onLoadServer })
//   payload: { server_yaml, incoming_yaml, server_modified, server_version } (from the 409 body)
//   onOverwrite(): async, force-saves this tab's copy over the server's
//   onLoadServer(): async, discards this tab's pending edit and reloads the server copy
// "Your copy" tail: either a live-ticking "opened DD/MM/YY HH:MM (x ago)" or nothing
// when this tab has no recorded open time.
function mineHead(mine) {
    if (!mine) return [];
    const ago = h("span");
    liveAgo(ago, mine.openedAt);
    return [` — opened ${fmtDateTime(mine.openedAt)} (`, ago, ")"];
}

export function openConflictModal(name, payload, { onOverwrite, onLoadServer }) {
    const mine = profileVersion(name);
    // the relative "(x ago)" spans tick live off ago.js's shared 1s interval; they
    // auto-drop when the modal closes and their nodes leave the DOM (no teardown here).
    const serverAgo = h("span");
    liveAgo(serverAgo, payload.server_modified);
    const head = h("div", { class: "conf-diff-head" },
        h("div", { class: "conf-diff-col-label" },
            h("b", {}, "Server"), ` — saved ${fmtDateTime(payload.server_modified)} (`, serverAgo, ")"),
        h("div", { class: "conf-diff-col-label" },
            h("b", {}, "Your copy"), ...mineHead(mine)));

    const footer = h("div", { class: "conf-diff-actions" },
        btn("Discard mine, load server", {
            cls: "btn",
            onClick: async () => { handle.close(); await onLoadServer(); },
        }),
        armedButton({
            label: "Overwrite server", arm: "overwrite?",
            cls: "btn-trash",
            title: "Replace the server's copy with yours — the change made elsewhere is lost",
            onFire: async () => { await onOverwrite(); handle.close(); },
        }));

    const node = h("div", { class: "conf-diff-wrap" },
        head, diffTable(payload.server_yaml, payload.incoming_yaml), footer);
    const handle = openModal({ title: `Profile "${name}" changed on server`, size: "large", node });
    return handle;
}
