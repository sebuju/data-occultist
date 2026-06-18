// Trigger node: fires its target price node(s) on a condition. `interval` fires every N
// seconds; `on_change` fires when a watched dataset gains rows (pricing just those, live);
// `manual` never auto-fires (the sweep button drives it). All config persists in the
// profile YAML. Targets are wired by dragging the out-port to a price node; watch datasets
// and targets can also be added from the dropdowns here. Rendering only — wiring is in main.js.
import { esc, TRASH, labCell } from "../dom.js";

const KINDS = [["interval", "interval (periodic)"], ["on_change", "on change (live)"], ["manual", "manual only"]];

// removable source pill — same look as a subset's join-source pills (.sv-input). `rmCls`
// is the wiring hook (tg-rmwatch / tg-rmtarget); `attr` carries the id back to the handler.
const srcChip = (val, attr, rmCls) =>
    `<span class="sv-input">${esc(val)}<button class="sv-rmin danger ${rmCls}" ${attr}="${esc(val)}" title="remove">${TRASH}</button></span>`;

// the pills + a "+ …" add-select that go in a watch/fires control cell.
const srcInputs = (chipsHtml, addCls, addOpts) =>
    `<div class="sv-inputs">${chipsHtml}<span class="sv-input sv-add"><select class="sv-addin ${addCls}">${addOpts}</select></span></div>`;

export function triggerParts(t, model) {
    const kind = KINDS.some(([v]) => v === t.kind) ? t.kind : "interval";
    const kopt = ([v, l]) => `<option value="${v}"${v === kind ? " selected" : ""}>${l}</option>`;

    const interval = kind === "interval"
        ? `${labCell("every", "seconds between automatic sweeps")}<span class="tg-secs"><input class="tg-interval" type="number" min="1" step="1" value="${t.interval_s || 300}" /> s</span>`
        : "";

    let watch = "";
    if (kind === "on_change") {
        const have = new Set(t.watch || []);
        // watch datasets OR subsets (a subset fires when any of its source datasets gains rows)
        const sources = [...model.datasets(), ...(model.profile.subsets || []).map((s) => s.id)];
        const opts = sources.filter((d) => !have.has(d)).map((d) => `<option>${esc(d)}</option>`).join("");
        watch = labCell("watch", "datasets or subsets; the trigger fires when one gains rows", true)
            + srcInputs(
                (t.watch || []).map((w) => srcChip(w, "data-ds", "tg-rmwatch")).join(""),
                "tg-addwatch",
                `<option value="">+ watch source</option>${opts}`,
            );
    }

    // targets: drag the out-port to a price node OR pick one here (same source-row UI as watch)
    const haveT = new Set(t.targets || []);
    const popts = (model.profile.price_nodes || []).map((p) => p.id)
        .filter((p) => !haveT.has(p)).map((p) => `<option>${esc(p)}</option>`).join("");
    const targets = labCell("fires", "price nodes this trigger fires", true)
        + srcInputs(
            (t.targets || []).map((p) => srcChip(p, "data-p", "tg-rmtarget")).join(""),
            "tg-addfire",
            `<option value="">+ fire target</option>${popts}`,
        );

    return {
        title: `<input class="gi gi-id tgrename" value="${esc(t.id)}" title="rename trigger" />`,
        body: `<div class="lab-grid">${labCell("kind", "how the trigger decides to fire")}<select class="tg-kind">${KINDS.map(kopt).join("")}</select>
      ${interval}${watch}${targets}
      ${labCell("progress", "what the current/last sweep is doing")}<span class="tg-prog muted">idle</span>
      ${labCell("last fired", "last time this trigger fired")}<span class="tg-last muted">never fired</span></div>
      <div class="gn-foot"><button class="tg-fire">↻ fire now</button></div>`,
        ports: `<span class="port out" title="drag to a price node this trigger should fire"></span>`
            + (kind === "on_change" ? `<span class="port pwatch" title="drag to a dataset or subset to watch for new rows"></span>` : ""),
    };
}
