// Preview panel: tabular view of what OCR read from each cell — raw text, the
// extracted value, and confidence. Complements the on-canvas read-out chips.
import { fieldset, mount, esc } from "../dom.js";

function confClass(c) { return c >= 0.8 ? "ok" : c >= 0.5 ? "warn" : "bad"; }

export function renderPreview(container, cells, fieldIds) {
    if (!cells || !cells.length) { container.replaceChildren(); return; }
    const head = `<th>cell</th>` + fieldIds.map((f) => `<th>${esc(f)}</th>`).join("");
    const rows = cells.map((c) => {
        const tds = fieldIds.map((fid) => {
            const fv = c.fields[fid];
            if (!fv) return "<td>—</td>";
            const val = fv.value === null || fv.value === "" ? "∅" : fv.value;
            return `<td class="conf-${confClass(fv.confidence)}" title="raw: ${esc(fv.raw)}">${esc(val)} <span class="muted">${Math.round(fv.confidence * 100)}%</span></td>`;
        }).join("");
        return `<tr><td class="muted">${c.row},${c.col}</td>${tds}</tr>`;
    }).join("");

    const fs = fieldset(`Preview — what OCR reads (${cells.length} cells)`, `
    <p class="hint">Hover a value to see the raw OCR text. Green ≥80%, amber ≥50%, red below.</p>
    <div class="records"><table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
  `, "preview");
    mount(container, fs);
}
