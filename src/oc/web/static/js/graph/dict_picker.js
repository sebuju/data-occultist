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
import { esc } from "../dom.js";

export function openDictionaryPicker({ used = new Set(), onPick, onCreate } = {}) {
    const node = document.createElement("div");
    node.className = "dpk";
    node.innerHTML = `
    <div class="dpk-new">
      <input class="dpk-name" placeholder="new dictionary name" autocomplete="off" spellcheck="false" />
      <button class="dpk-create">create blank</button>
    </div>
    <div class="dpk-sub muted">or reference an existing word list</div>
    <div class="dpk-list"><div class="muted dpk-pad">loading…</div></div>`;
    const handle = openModal({ title: "add dictionary", size: "medium", node });

    const listEl = node.querySelector(".dpk-list");
    const nameEl = node.querySelector(".dpk-name");
    const createEl = node.querySelector(".dpk-create");

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
        if (!items.length) { listEl.innerHTML = `<div class="muted dpk-pad">no term files yet — create one above</div>`; return; }
        listEl.innerHTML = items.map((it) => rowHtml(it, used.has(it.source))).join("");
        listEl.querySelectorAll("[data-source]").forEach((el) =>
            el.addEventListener("click", () => { handle.close(); onPick?.(el.dataset.source); }));
    }).catch((e) => { listEl.innerHTML = `<div class="warn dpk-pad">${esc(String(e.message || e))}</div>`; });

    return handle;
}

function rowHtml(it, inUse) {
    const n = it.count || 0;
    return `<div class="dpk-row" data-source="${esc(it.source)}">
    <span class="dpk-src">${esc(it.source)}</span>
    <span class="dpk-meta muted">${n} word${n === 1 ? "" : "s"}${inUse ? ` · <span class="dpk-used">in use</span>` : ""}</span>
  </div>`;
}
