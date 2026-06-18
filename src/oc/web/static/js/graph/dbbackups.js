// Database-backups browser: a modal listing a game's SQLite-store snapshots (left) with a
// meta panel + armed restore for the selected one (right), and a "backup now" button. The
// twin of backups.js (which versions the PROFILE); this versions the DATA. Restore snapshots
// the current state first server-side and announces the change so panels refetch. Restore is
// the shared armed two-click button (armbtn.js) — no blocking confirm() (CLAUDE.md rule 2).

import * as api from "../api.js";
import { openModal } from "../modal.js";
import { esc } from "../dom.js";
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
    host.innerHTML = `
    <div class="dbbk-bar"><button class="dbbk-now">backup now</button><span class="dbbk-stat muted"></span></div>
    <div class="backups">
      <div class="bk-list"><div class="muted bk-pad">loading…</div></div>
      <div class="bk-detail"><div class="muted bk-pad">select a backup to preview</div></div>
    </div>`;
    const listEl = host.querySelector(".bk-list");
    const detailEl = host.querySelector(".bk-detail");
    const statEl = host.querySelector(".dbbk-stat");
    const nowBtn = host.querySelector(".dbbk-now");

    const byStamp = new Map();   // stamp -> meta (the list carries everything the detail shows)
    let armedStamp = null;

    function rowHtml(m) {
        const summ = `${m.datasets || 0} ds · ${m.events || 0} events`;
        const tag = m.reason ? `<span class="bk-reason">${esc(m.reason)}</span>` : "";
        return `<div class="bk-row" data-stamp="${esc(m.stamp)}">
      <div class="bk-when" title="${esc(fmtDateTime(m.iso))}">${esc(since(m.iso))}${tag}</div>
      <div class="bk-meta muted">${esc(fmtDateTime(m.iso))} · ${summ} · ${fmtSize(m.size)}</div>
    </div>`;
    }

    function renderList(items) {
        byStamp.clear();
        armedStamp = null;
        if (!items.length) {
            listEl.innerHTML = `<div class="muted bk-pad">no backups yet</div>`;
            return;
        }
        const tmp = document.createElement("div");
        tmp.innerHTML = items.map(rowHtml).join("");
        listEl.innerHTML = "";
        [...tmp.children].forEach((row, i) => {
            const m = items[i];
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
            listEl.innerHTML = `<div class="warn bk-pad">${esc(String(e.message || e))}</div>`;
        }
    }

    function select(stamp, rowEl) {
        listEl.querySelectorAll(".bk-row").forEach((r) => r.classList.toggle("sel", r === rowEl));
        armedStamp = null;
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
        detailEl.innerHTML = `
      <div class="bk-info"><table class="bk-info-tbl"><tbody>${rows
            .map(([k, v]) => `<tr><td class="muted">${k}</td><td>${esc(String(v))}</td></tr>`).join("")}</tbody></table></div>
      <div class="bk-foot"></div>`;
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
        detailEl.querySelector(".bk-foot").append(restore);
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
    const handle = openModal({ title: `database backups · ${esc(game)}`, size: "data", node });
    buildDbBackups(node, game, { onRestored, signal: handle.signal });
    return handle;
}
