// Stale-tab save guard: when a save comes back 409 (someone else saved a structural
// change since this tab loaded — another tab, an external edit), this modal shows the
// two YAMLs side by side with timestamps and lets the user pick a side. No auto-merge —
// merging config is not something to guess at silently.
import { h, frag, btn } from "../dom.js";
import { openModal } from "../modal.js";
import { armedButton } from "./armbtn.js";
import { fmtDateTime, since } from "../datefmt.js";
import { lineDiff } from "../linediff.js";
import { profileVersion } from "../api.js";

// A profile's own YAML is at most a few hundred lines — cap the rendered rows anyway
// (CLAUDE.md rule 4's spirit: a diff view is a preview, not a data dump) so a runaway
// case never freezes the modal.
const DIFF_ROW_CAP = 400;

function diffTable(serverText, incomingText) {
    const rows = lineDiff(serverText.split("\n"), incomingText.split("\n"));
    const shown = rows.slice(0, DIFF_ROW_CAP);
    const body = h("div", { class: "conf-diff" },
        ...shown.map((r) => h("div", { class: `conf-diff-row cd-${r.type}` },
            h("div", { class: "cd-cell cd-left" }, r.left ?? ""),
            h("div", { class: "cd-cell cd-right" }, r.right ?? ""))));
    if (rows.length > shown.length) {
        return frag(body, h("div", { class: "conf-diff-more" }, `+${rows.length - shown.length} more lines`));
    }
    return body;
}

// openConflictModal(payload, { onOverwrite, onLoadServer })
//   payload: { server_yaml, incoming_yaml, server_modified, server_version } (from the 409 body)
//   onOverwrite(): async, force-saves this tab's copy over the server's
//   onLoadServer(): async, discards this tab's pending edit and reloads the server copy
export function openConflictModal(name, payload, { onOverwrite, onLoadServer }) {
    const mine = profileVersion(name);
    const head = h("div", { class: "conf-diff-head" },
        h("div", { class: "conf-diff-col-label" },
            h("b", {}, "Server"), ` — saved ${fmtDateTime(payload.server_modified)} (${since(payload.server_modified)})`),
        h("div", { class: "conf-diff-col-label" },
            h("b", {}, "Your copy"), mine ? ` — opened ${fmtDateTime(mine.openedAt)} (${since(mine.openedAt)})` : ""));

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

    const node = frag(head, diffTable(payload.server_yaml, payload.incoming_yaml), footer);
    const handle = openModal({ title: `Profile "${name}" changed on server`, size: "large", node });
    return handle;
}
