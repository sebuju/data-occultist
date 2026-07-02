// Dictionary picker modal: opening "+ dictionary" no longer drops a blank node
// straight onto the canvas — it offers the shared term files under
// config/dictionaries/ (name + word count) to reference, plus a field to create a
// brand-new one. Same modal chrome as the rest (backups, captures).
//
// Callbacks: onPick(source) references an existing file; onCreate(name) makes a fresh
// blank dictionary. `used` is the set of sources already on the graph — those rows are
// tagged and re-selecting one just pans to the existing node (handled by the caller).

import * as api from "../api.js";
import { openModal } from "../modal.js";
import { h } from "../dom.js";

export function openDictionaryPicker({ used = new Set(), onPick, onCreate } = {}) {
    const node = document.createElement("div");
    node.className = "dpk";
    const nameEl = h("input", { class: "dpk-name", placeholder: "new dictionary name", autocomplete: "off" });
    const createEl = h("button", { class: "dpk-create" }, "create blank");
    const listEl = h("div", { class: "dpk-list" }, h("div", { class: "muted dpk-pad" }, "loading…"));
    node.replaceChildren(
        h("div", { class: "dpk-new" }, nameEl, createEl),
        h("div", { class: "dpk-sub muted" }, "or reference an existing word list"),
        listEl,
    );
    const handle = openModal({ title: "add dictionary", size: "medium", node });

    const create = () => {
        const name = nameEl.value.trim();
        if (!name) { nameEl.focus(); return; }
        handle.close();
        onCreate?.(name);
    };
    createEl.addEventListener("click", create);
    nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
    nameEl.focus();

    api.dictionaries.list().then((items) => {
        if (handle.signal.aborted) return;
        if (!items.length) { listEl.replaceChildren(h("div", { class: "muted dpk-pad" }, "no term files yet — create one above")); return; }
        listEl.replaceChildren(...items.map((it) => rowNode(it, used.has(it.source), handle, onPick)));
    }).catch((e) => { listEl.replaceChildren(h("div", { class: "warn dpk-pad" }, String(e.message || e))); });

    return handle;
}

function rowNode(it, inUse, handle, onPick) {
    const n = it.count || 0;
    return h("div", {
        class: "dpk-row", dataset: { source: it.source },
        onClick: () => { handle.close(); onPick?.(it.source); },
    },
        h("span", { class: "dpk-src" }, it.source),
        h("span", { class: "dpk-meta muted" },
            `${n} word${n === 1 ? "" : "s"}`,
            inUse ? " · " : null,
            inUse ? h("span", { class: "dpk-used" }, "in use") : null,
        ),
    );
}
