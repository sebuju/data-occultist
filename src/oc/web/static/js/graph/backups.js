// Backups browser: a modal listing a profile's snapshots (left) with a nodemap-style
// preview + info for the selected one (right). Restoring loads that backup as a new live
// save (the backend snapshots the current state first and leaves the chosen backup
// intact). Restore is an armed two-click button — no blocking confirm() dialog.

import * as api from "../api.js";
import { openModal } from "../modal.js";
import { esc } from "../dom.js";
import { renderMiniMap } from "./minimap.js";
import { fmtDateTime, since } from "../datefmt.js";
import { liveAgo } from "../ago.js";

const fmtSize = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n || 0} B`);

// Render the backups browser INTO a host element. `signal` (e.g. a modal's
// AbortController signal) drops stale async work when the host goes away; `close`
// is invoked after a successful restore so the embedding surface can dismiss
// itself. Used both standalone (openBackupsModal) and as a settings-modal section.
export function buildBackups(host, name, { onRestored = null, signal = null, close = null } = {}) {
  host.classList.add("backups");
  host.innerHTML = `
    <div class="bk-list"><div class="muted bk-pad">loading…</div></div>
    <div class="bk-detail"><div class="muted bk-pad">select a backup to preview</div></div>`;
  const listEl = host.querySelector(".bk-list");
  const detailEl = host.querySelector(".bk-detail");

  // Lazy list: the server PARSES only the page it returns (counts need a YAML load), so
  // we fetch 10 newest on open and pull the next 10 as the user scrolls near the bottom.
  // A profile with hundreds of backups opens instantly instead of parsing them all.
  const PAGE = 10;
  let total = 0, loaded = 0, busy = false, end = false;
  function appendRows(items) {
    const tmp = document.createElement("div");
    tmp.innerHTML = items.map(rowHtml).join("");
    const rows = [...tmp.children];
    rows.forEach((row, idx) => {
      row.addEventListener("click", () => select(row.dataset.stamp, row));
      // the "ago" label ticks optimistically (1s) so it never sits stale while the modal is open
      const when = row.querySelector(".bk-when");
      if (when && items[idx]) liveAgo(when, items[idx].iso);
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
        if (!items.length) { listEl.innerHTML = `<div class="muted bk-pad">no backups yet</div>`; end = true; return; }
        listEl.innerHTML = "";
      }
      appendRows(items);
      loaded += items.length;
      if (!items.length || loaded >= total) end = true;
    } catch (e) {
      if (loaded === 0) listEl.innerHTML = `<div class="warn bk-pad">${esc(String(e.message || e))}</div>`;
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
    detailEl.innerHTML = `<div class="muted bk-pad">loading…</div>`;
    let profile;
    try { profile = await api.backups.get(name, stamp); }
    catch (e) { detailEl.innerHTML = `<div class="warn bk-pad">${esc(String(e.message || e))}</div>`; return; }
    if (signal?.aborted) return;

    detailEl.innerHTML = `
      <div class="bk-preview"></div>
      <div class="bk-info">${infoHtml(profile)}</div>
      <div class="bk-foot"><button class="bk-restore">restore this version</button></div>`;
    // defer one frame so the freshly-inserted preview box has a measured size
    // (renderMiniMap reads getBoundingClientRect) before drawing into it.
    requestAnimationFrame(() => {
      if (signal?.aborted) return;
      const host = detailEl.querySelector(".bk-preview");
      if (host) renderMiniMap(host, profile);
    });

    const btn = detailEl.querySelector(".bk-restore");
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
  const handle = openModal({ title: `backups · ${esc(name)}`, size: "large", node });
  buildBackups(node, name, { onRestored, signal: handle.signal, close: handle.close });
  return handle;
}

function rowHtml(m) {
  const c = m.counts || {};
  const summ = [
    c.windows ? `${c.windows} win` : null,
    c.datasets ? `${c.datasets} ds` : null,
    c.subsets ? `${c.subsets} view` : null,
  ].filter(Boolean).join(" · ");
  return `<div class="bk-row" data-stamp="${esc(m.stamp)}">
    <div class="bk-when" title="${esc(fmtDateTime(m.iso))}">${esc(since(m.iso))}</div>
    <div class="bk-meta muted">${esc(fmtDateTime(m.iso))} · ${c.nodes || 0} nodes${summ ? ` · ${esc(summ)}` : ""} · ${fmtSize(m.size)}</div>
  </div>`;
}

function infoHtml(profile) {
  const windows = profile.windows || [];
  const rows = [
    ["windows", windows.length],
    ["items", windows.reduce((a, w) => a + (w.items || []).length, 0)],
    ["datasets", (profile.datasets || []).length],
    ["subsets", (profile.subsets || []).length],
    ["price nodes", (profile.price_nodes || []).length],
    ["dictionaries", (profile.dictionaries || []).length],
    ["placed nodes", Object.keys(profile.layout?.nodes || {}).length],
  ];
  return `<table class="bk-info-tbl"><tbody>${rows
    .map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("")}</tbody></table>`;
}
