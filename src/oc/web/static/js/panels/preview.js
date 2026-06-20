// Preview panel: tabular view of what OCR read from each cell — raw text, the
// extracted value, and confidence. Complements the on-canvas read-out chips.
import { fieldset, mount, h, frag } from "../dom.js";

function confClass(c) { return c >= 0.8 ? "ok" : c >= 0.5 ? "warn" : "bad"; }

export function renderPreview(container, cells, fieldIds) {
    if (!cells || !cells.length) { container.replaceChildren(); return; }
    const head = h("tr", h("th", "cell"), fieldIds.map((f) => h("th", f)));
    const rows = cells.map((c) => h("tr",
        h("td", { class: "muted" }, `${c.row},${c.col}`),
        fieldIds.map((fid) => {
            const fv = c.fields[fid];
            if (!fv) return h("td", "—");
            const val = fv.value === null || fv.value === "" ? "∅" : fv.value;
            return h("td", { class: `conf-${confClass(fv.confidence)}`, title: `raw: ${fv.raw}` },
                val, " ", h("span", { class: "muted" }, `${Math.round(fv.confidence * 100)}%`));
        }),
    ));

    const body = frag(
        h("p", { class: "hint" }, "Hover a value to see the raw OCR text. Green ≥80%, amber ≥50%, red below."),
        h("div", { class: "records" },
            h("table", { class: "grid-table" },
                h("thead", head),
                h("tbody", rows))),
    );
    const fs = fieldset(`Preview — what OCR reads (${cells.length} cells)`, body, "preview");
    mount(container, fs);
}
