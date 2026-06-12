// Backups browser: a modal listing a profile's snapshots (left) with a nodemap-style
// preview + info for the selected one (right). Restoring loads that backup as a new live
// save (the backend snapshots the current state first and leaves the chosen backup
// intact). Restore is an armed two-click button — no blocking confirm() dialog.

import * as api from "../api.js";
import { openModal } from "../modal.js";
import { esc } from "../dom.js";
import { renderMiniMap } from "./minimap.js";

const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const fmtSize = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n || 0} B`);

export function openBackupsModal(name, onRestored) {
  const node = document.createElement("div");
  node.className = "backups";
  node.innerHTML = `
    <div class="bk-list"><div class="muted bk-pad">loading…</div></div>
    <div class="bk-detail"><div class="muted bk-pad">select a backup to preview</div></div>`;
  const handle = openModal({ title: `backups · ${esc(name)}`, size: "large", node });
  const listEl = node.querySelector(".bk-list");
  const detailEl = node.querySelector(".bk-detail");

  api.backups.list(name).then((items) => {
    if (handle.signal.aborted) return;
    if (!items.length) { listEl.innerHTML = `<div class="muted bk-pad">no backups yet</div>`; return; }
    listEl.innerHTML = items.map(rowHtml).join("");
    listEl.querySelectorAll("[data-stamp]").forEach((el) =>
      el.addEventListener("click", () => select(el.dataset.stamp, el)));
  }).catch((e) => { listEl.innerHTML = `<div class="warn bk-pad">${esc(String(e.message || e))}</div>`; });

  let armed = null;   // stamp currently armed for restore (needs a 2nd click)

  async function select(stamp, rowEl) {
    listEl.querySelectorAll(".bk-row").forEach((r) => r.classList.toggle("sel", r === rowEl));
    armed = null;
    detailEl.innerHTML = `<div class="muted bk-pad">loading…</div>`;
    let profile;
    try { profile = await api.backups.get(name, stamp); }
    catch (e) { detailEl.innerHTML = `<div class="warn bk-pad">${esc(String(e.message || e))}</div>`; return; }
    if (handle.signal.aborted) return;

    detailEl.innerHTML = `
      <div class="bk-preview"></div>
      <div class="bk-info">${infoHtml(profile)}</div>
      <div class="bk-foot"><button class="bk-restore">restore this version</button></div>`;
    renderMiniMap(detailEl.querySelector(".bk-preview"), profile);

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
        handle.close();
      } catch (e) {
        btn.disabled = false; btn.classList.remove("armed"); armed = null;
        btn.textContent = `restore failed: ${String(e.message || e)}`;
      }
    });
  }

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
    <div class="bk-when">${esc(fmtDate(m.iso))}</div>
    <div class="bk-meta muted">${c.nodes || 0} nodes${summ ? ` · ${esc(summ)}` : ""} · ${fmtSize(m.size)}</div>
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
