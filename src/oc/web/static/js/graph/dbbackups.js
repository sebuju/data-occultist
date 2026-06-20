// Database-backups browser: a modal listing a game's SQLite-store snapshots (left) with a
// meta panel + armed restore for the selected one (right), and a "backup now" button. The
// twin of backups.js (which versions the PROFILE); this versions the DATA. Restore snapshots
// the current state first server-side and announces the change so panels refetch. Restore is
// the shared armed two-click button (armbtn.js) — no blocking confirm() (CLAUDE.md rule 2).

import * as api from "../api.js";
import { openModal } from "../modal.js";
import { h } from "../dom.js";
import { fmtDateTime, since } from "../datefmt.js";
import { liveAgo } from "../ago.js";
import { armedButton } from "./armbtn.js";

const fmtSize = (n) =>
    (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
        : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n || 0} B`);

// Render the DB-backups browser into `host`. `signal` drops stale async work when the host
// goes away; `onRestored` fires after a successful restore (e.g. to refresh the DB panel).
export function buildDbBackups(host, game, { onRestored = null, signal = null } = {}) {
    host.classList.add("dbbk");
    const nowBtn = h("button", { class: "dbbk-now" }, "backup now");
    const statEl = h("span", { class: "dbbk-stat muted" });
    const listEl = h("div", { class: "bk-list" }, h("div", { class: "muted bk-pad" }, "loading…"));
    const detailEl = h("div", { class: "bk-detail" }, h("div", { class: "muted bk-pad" }, "select a backup to preview"));
    host.replaceChildren(
        h("div", { class: "dbbk-bar" }, nowBtn, statEl),
        h("div", { class: "backups" }, listEl, detailEl),
    );

    const byStamp = new Map();   // stamp -> meta (the list carries everything the detail shows)

    function rowNode(m) {
        const summ = `${m.datasets || 0} ds · ${m.events || 0} events`;
        return h("div", { class: "bk-row", dataset: { stamp: m.stamp } },
            h("div", { class: "bk-when", title: fmtDateTime(m.iso) },
                since(m.iso),
                m.reason ? h("span", { class: "bk-reason" }, m.reason) : null),
            h("div", { class: "bk-meta muted" }, `${fmtDateTime(m.iso)} · ${summ} · ${fmtSize(m.size)}`),
        );
    }

    function renderList(items) {
        byStamp.clear();
        if (!items.length) {
            listEl.replaceChildren(h("div", { class: "muted bk-pad" }, "no backups yet"));
            return;
        }
        listEl.replaceChildren();
        items.forEach((m) => {
            const row = rowNode(m);
            byStamp.set(m.stamp, m);
            row.addEventListener("click", () => select(m.stamp, row));
            const when = row.querySelector(".bk-when");
            if (when) liveAgo(when, m.iso);   // ticks 1s so it never sits stale while open
            listEl.appendChild(row);
        });
    }

    async function load() {
        try {
            const res = await api.dbbackups.list(game);
            if (signal?.aborted) return;
            renderList(res.items || []);
        } catch (e) {
            listEl.replaceChildren(h("div", { class: "warn bk-pad" }, String(e.message || e)));
        }
    }

    function select(stamp, rowEl) {
        listEl.querySelectorAll(".bk-row").forEach((r) => r.classList.toggle("sel", r === rowEl));
        const m = byStamp.get(stamp);
        if (!m) return;
        const rows = [
            ["reason", m.reason || "—"],
            ["datasets", m.datasets || 0],
            ["events", m.events || 0],
            ["last seen", m.last_seen ? fmtDateTime(m.last_seen) : "—"],
            ["size", fmtSize(m.size)],
            ["taken", fmtDateTime(m.iso)],
        ];
        const foot = h("div", { class: "bk-foot" });
        detailEl.replaceChildren(
            h("div", { class: "bk-info" },
                h("table", { class: "bk-info-tbl" },
                    h("tbody", ...rows.map(([k, v]) =>
                        h("tr", h("td", { class: "muted" }, k), h("td", String(v))))))),
            foot,
        );
        const restore = armedButton({
            label: "restore this version", arm: "click again to restore", cls: "bk-restore",
            busy: "restoring…", title: "overwrite the live store with this snapshot",
            onFire: async () => {
                await api.dbbackups.restore(game, stamp);
                onRestored?.();
                await load();                       // counts/sizes shifted (current was snapshotted)
                statEl.textContent = `restored ${since(m.iso)}`;
            },
        });
        foot.append(restore);
    }

    nowBtn.addEventListener("click", async () => {
        nowBtn.disabled = true;
        const prev = nowBtn.textContent;
        nowBtn.textContent = "backing up…";
        try {
            const res = await api.dbbackups.create(game);
            if (signal?.aborted) return;
            renderList(res.items || []);
            statEl.textContent = res.created ? "backed up just now" : "nothing to back up";
        } catch (e) {
            statEl.textContent = String(e.message || e);
        } finally {
            nowBtn.disabled = false;
            nowBtn.textContent = prev;
        }
    });

    load();
}

// Standalone DB-backups modal — thin wrapper over buildDbBackups.
export function openDbBackupsModal(game, onRestored) {
    const node = document.createElement("div");
    const handle = openModal({ title: `database backups · ${game}`, size: "data", node });
    buildDbBackups(node, game, { onRestored, signal: handle.signal });
    return handle;
}
