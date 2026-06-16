// Data table bound to a dataset/subset. Columns are configured per-column (enable + rename);
// optional sort; optional pagination with page buttons (off = just show up to the cap, no
// footer text). Header rebuilds only on column change; rows reconcile against a reused <tr>
// pool (rule 1) and are capped (rule 4).

import { resolveRows, columnsOf, dataKeyForBinding } from "../binding.js";
import { keySubscription, el, humanize } from "./util.js";

const ROW_CAP = 200;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function cmp(a, b) {
  const na = num(a), nb = num(b);
  if (na != null && nb != null) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

export default {
  type: "table",
  title: "Table",
  icon: "▦",
  defaults: () => ({ binding: { src: "dataset", id: "" },
    config: { columns: [], pageSize: 50, paging: false, sortField: "", sortDesc: false }, w: 420, h: 260 }),
  create(host, widget, ctx) {
    host.className = "pw-table";
    const table = el("table", "pw-tbl");
    const colg = el("colgroup");
    const thead = el("thead"); const headRow = el("tr");
    const tbody = el("tbody");
    table.appendChild(colg); thead.appendChild(headRow); table.appendChild(thead); table.appendChild(tbody);
    // footer pager (only shown when paging is on)
    const foot = el("div", "pw-tbl-foot");
    const prev = el("button", "pw-pg", "‹"); const lbl = el("span", "pw-pg-lbl"); const next = el("button", "pw-pg", "›");
    foot.append(prev, lbl, next);
    host.append(table, foot);
    let page = 0;
    prev.addEventListener("click", () => { if (page > 0) { page--; render(); } });
    next.addEventListener("click", () => { page++; render(); });   // clamped in render

    const sub = keySubscription(ctx, render);
    let cols = [];

    // ONLY columns present in the data are ever shown — config is an OVERRIDE map keyed by
    // column name (hide via enabled:false, or set label/width). Columns not in the data are
    // never rendered, so stale config from a previous source can't show as "fake columns".
    function resolveCols(rows) {
      const byKey = new Map((widget.config.columns || []).map((c) => [c.key, c]));
      const out = [];
      for (const k of columnsOf(rows)) {
        const c = byKey.get(k);
        if (c && c.enabled === false) continue;
        out.push({ key: k, label: (c && c.label) || humanize(k), width: c && c.width });
      }
      return out;
    }
    function syncHead(next2) {
      const sig = next2.map((c) => `${c.key}${c.label}`).join("|");
      if (sig === cols._sig) return;
      cols = next2; cols._sig = sig;
      headRow.textContent = ""; colg.textContent = "";
      for (const c of cols) {
        headRow.appendChild(el("th", null, c.label));
        const col = el("col"); if (c.width) col.style.width = `${c.width}%`; colg.appendChild(col);
      }
    }
    const rowEls = [];
    function render() {
      const c = widget.config;
      let rows = resolveRows(ctx, widget.binding);
      if (c.sortField) rows = [...rows].sort((a, b) => cmp(a[c.sortField], b[c.sortField]) * (c.sortDesc ? -1 : 1));
      syncHead(resolveCols(rows));

      const ps = c.pageSize || 50;
      let view;
      if (c.paging) {
        const pages = Math.max(1, Math.ceil(rows.length / ps));
        page = Math.min(Math.max(0, page), pages - 1);
        view = rows.slice(page * ps, page * ps + ps).slice(0, ROW_CAP);
        foot.hidden = false;
        lbl.textContent = `${page + 1}/${pages}`;
        prev.disabled = page <= 0; next.disabled = page >= pages - 1;
      } else {
        view = rows.slice(0, Math.min(ps, ROW_CAP));   // paging off -> page size acts as the row limit
        foot.hidden = true;
      }

      while (rowEls.length > view.length) tbody.removeChild(rowEls.pop());
      while (rowEls.length < view.length) { const tr = el("tr"); tbody.appendChild(tr); rowEls.push(tr); }
      for (let i = 0; i < view.length; i++) {
        const tr = rowEls[i], row = view[i];
        while (tr.children.length > cols.length) tr.removeChild(tr.lastChild);
        while (tr.children.length < cols.length) tr.appendChild(el("td"));
        cols.forEach((col, j) => {
          const v = row[col.key];
          const txt = v == null ? "" : String(v);
          if (tr.children[j].textContent !== txt) tr.children[j].textContent = txt;
        });
      }
    }

    sub.sync([dataKeyForBinding(widget.binding)]);
    render();
    return { update: render, destroy: sub.destroy };
  },
};
