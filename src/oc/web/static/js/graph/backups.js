// Backups browser: a modal listing a profile's snapshots (left) with a nodemap-style
// preview + info for the selected one (right). Restoring loads that backup as a new live
// save (the backend snapshots the current state first and leaves the chosen backup
// intact). Restore is an armed two-click button — no blocking confirm() dialog.

import * as api from "../api.js";
import { openModal } from "../modal.js";
import { h } from "../dom.js";
import { renderMiniMap } from "./minimap.js";
import { fmtDateTime, since } from "../datefmt.js";
import { liveAgo } from "../ago.js";
import { fmtBytes as fmtSize } from "../bytefmt.js";


// Render the backups browser INTO a host element. `signal` (e.g. a modal's
// AbortController signal) drops stale async work when the host goes away; `close`
// is invoked after a successful restore so the embedding surface can dismiss
// itself. Used both standalone (openBackupsModal) and as a settings-modal section.
export function buildBackups(host, name, { onRestored = null, signal = null, close = null } = {}) {
    host.classList.add("backups");
    const listEl = h("div", { class: "bk-list" }, h("div", { class: "muted bk-pad" }, "loading…"));
    const detailEl = h("div", { class: "bk-detail" }, h("div", { class: "muted bk-pad" }, "select a backup to preview"));
    host.replaceChildren(listEl, detailEl);

    // Lazy list: the server PARSES only the page it returns (counts need a YAML load), so
    // we fetch 10 newest on open and pull the next 10 as the user scrolls near the bottom.
    // A profile with hundreds of backups opens instantly instead of parsing them all.
    const PAGE = 10;
    let total = 0, loaded = 0, busy = false, end = false;
    function appendRows(items) {
        items.forEach((m) => {
            const row = rowNode(m);
            row.addEventListener("click", () => select(row.dataset.stamp, row));
            // the "ago" label ticks optimistically (1s) so it never sits stale while the modal is open
            const when = row.querySelector(".bk-when");
            if (when) liveAgo(when, m.iso);
            listEl.appendChild(row);
        });
    }
    async function loadMore() {
        if (busy || end) return;
        busy = true;
        try {
            const res = await api.backups.list(name, PAGE, loaded);
            if (signal?.aborted) return;
            // tolerate both the paged shape {total, items} and a bare array (older server)
            const items = Array.isArray(res) ? res.slice(loaded, loaded + PAGE) : (res.items || []);
            total = Array.isArray(res) ? res.length : (res.total || 0);
            if (loaded === 0) {
                if (!items.length) { listEl.replaceChildren(h("div", { class: "muted bk-pad" }, "no backups yet")); end = true; return; }
                listEl.replaceChildren();
            }
            appendRows(items);
            loaded += items.length;
            if (!items.length || loaded >= total) end = true;
        } catch (e) {
            if (loaded === 0) listEl.replaceChildren(h("div", { class: "warn bk-pad" }, String(e.message || e)));
        } finally { busy = false; }
    }
    listEl.addEventListener("scroll", () => {
        if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 48) loadMore();
    });
    loadMore();

    let armed = null;   // stamp currently armed for restore (needs a 2nd click)

    async function select(stamp, rowEl) {
        listEl.querySelectorAll(".bk-row").forEach((r) => r.classList.toggle("sel", r === rowEl));
        armed = null;
        detailEl.replaceChildren(h("div", { class: "muted bk-pad" }, "loading…"));
        let profile;
        try { profile = await api.backups.get(name, stamp); }
        catch (e) { detailEl.replaceChildren(h("div", { class: "warn bk-pad" }, String(e.message || e))); return; }
        if (signal?.aborted) return;

        const btn = h("button", { class: "bk-restore" }, "restore this version");
        detailEl.replaceChildren(
            h("div", { class: "bk-preview" }),
            h("div", { class: "bk-info" }, infoNode(profile)),
            h("div", { class: "bk-foot" }, btn),
        );
        // defer one frame so the freshly-inserted preview box has a measured size
        // (renderMiniMap reads getBoundingClientRect) before drawing into it.
        requestAnimationFrame(() => {
            if (signal?.aborted) return;
            const host = detailEl.querySelector(".bk-preview");
            if (host) renderMiniMap(host, profile);
        });

        btn.addEventListener("click", async () => {
            if (armed !== stamp) {   // first click arms; the label asks for confirmation
                armed = stamp;
                btn.textContent = "click again to restore";
                btn.classList.add("armed");
                return;
            }
            btn.disabled = true; btn.textContent = "restoring…";
            try {
                const restored = await api.backups.restore(name, stamp);
                onRestored?.(restored);
                close?.();
            } catch (e) {
                btn.disabled = false; btn.classList.remove("armed"); armed = null;
                btn.textContent = `restore failed: ${String(e.message || e)}`;
            }
        });
    }
}

// Standalone backups modal — thin wrapper over buildBackups.
export function openBackupsModal(name, onRestored) {
    const node = document.createElement("div");
    const handle = openModal({ title: `backups · ${name}`, size: "large", node });
    buildBackups(node, name, { onRestored, signal: handle.signal, close: handle.close });
    return handle;
}

function rowNode(m) {
    const c = m.counts || {};
    const summ = [
        c.windows ? `${c.windows} win` : null,
        c.datasets ? `${c.datasets} ds` : null,
        c.subsets ? `${c.subsets} subset` : null,
    ].filter(Boolean).join(" · ");
    return h("div", { class: "bk-row", dataset: { stamp: m.stamp } },
        h("div", { class: "bk-when", title: fmtDateTime(m.iso) }, since(m.iso)),
        h("div", { class: "bk-meta muted" },
            `${fmtDateTime(m.iso)} · ${c.nodes || 0} nodes${summ ? ` · ${summ}` : ""} · ${fmtSize(m.size)}`),
    );
}

function infoNode(profile) {
    const windows = profile.windows || [];
    const rows = [
        ["windows", windows.length],
        ["items", windows.reduce((a, w) => a + (w.items || []).length, 0)],
        ["datasets", (profile.datasets || []).length],
        ["subsets", (profile.subsets || []).length],
        ["producers", (profile.producers || []).length],
        ["dictionaries", (profile.dictionaries || []).length],
        ["placed nodes", Object.keys(profile.layout?.nodes || {}).length],
    ];
    return h("table", { class: "bk-info-tbl" },
        h("tbody", ...rows.map(([k, v]) =>
            h("tr", h("td", { class: "muted" }, k), h("td", String(v))))));
}
