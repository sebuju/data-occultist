// Process node body: a standalone rules-pipeline node + per-input KEY MANGLER (see ProcessDef).
// It applies ONE FieldRule pipeline to every wired input's value, and renames each input's key on
// the way out. It exists to consolidate the identical rules section otherwise copy-pasted across
// many readouts' fields, and to re-key inputs into whatever a downstream register/consumer expects.
//
// STRUCTURE only (render); wiring lives in io_wire.js (wireProcess), like every other node body.
// The body is: a value-TYPE toggle, the INPUTS key-mangler (one row per single-key input:
// `inputKey → [output-key field]`, blank output = keep the input key), and the shared rules-pipeline
// editor (rule 7 — the same `rulesSection`/`wireFieldRules` the readout/region nodes use, bound to
// the ProcessDef). Each input is ONE key: a readout, or a register slot. Live input/output is shown
// in the opt-in "raw" satellite (process_history_node.js), not the body.
import { h, frag, kv, subhead, gspan, trashBtn, PLUS } from "../dom.js";
import { rulesSection } from "./node_parts.js";

export function processParts(x, model) {
    const typeSel = h("select", { class: "pr-type", dataset: { k: "type" }, title: "value type carried into the rules pipeline: gates which rules apply (a number-only rule is ignored for text) and coerces the final value" },
        [["text", "text"], ["number", "number"]].map(([v, t]) =>
            h("option", { value: v, selected: (x.type || "text") === v }, (x.type || "text") === v ? `<${t}>` : t)));

    // one row per single-key input: [inputKey chip → output-key field] + remove. The chip carries
    // data-node so a click pans to the source node (the generic .sv-input[data-node] handler), and
    // the input key doubles as the output field's placeholder (blank output = keep the input key).
    const rows = model.processSources(x.id).map((s) => {
        const inKey = s.kind === "register" ? (s.key || s.id) : s.id;
        const desc = `${s.kind}: ${s.id}${s.key ? ` · ${s.key}` : ""}`;
        return h("div", { class: "pr-maprow" },
            h("span", { class: "sv-input pr-inkey", dataset: s.node ? { node: s.node } : null, title: `input key from ${desc}` },
                h("span", { class: "sv-value" }, inKey)),
            h("span", { class: "rule-arrow muted" }, "→"),
            h("input", { class: "pr-out", dataset: { ref: s.ref }, value: s.out || "", placeholder: inKey, title: "output key — blank keeps the input key" }),
            trashBtn({ cls: "pr-rmin", dataset: { val: s.ref }, title: "remove input" }));
    });
    // "+ add input" rides the "inputs" subheading as an icon (matching the rules subhead's add
    // button) — a transparent native <select> overlaid on a PLUS glyph (the mb-add pattern), whose
    // candidates come from the ONE shared truth (readouts + register slots; no all-keys, no process).
    const cands = model.sourceCandidates("process", x.id);
    const addSel = h("select", { class: "pr-addin", title: "add an input: a readout, or a register slot" },
        h("option", { value: "" }, "add input…"),
        ...cands.map((c) => h("option", { value: c.ref }, c.label)));
    const addBtn = h("div", { class: "frule-btns" },
        h("span", { class: "pr-inadd", title: "add an input" }, PLUS(), addSel));

    const body = frag(
        kv("type", typeSel),
        subhead("inputs", addBtn, "each input is one key — its value runs the rules below; the field renames the key downstream (blank = keep the input key)"),
        gspan("pr-inputs", ...rows),
        rulesSection(x, "prset", null));
    return {
        title: h("input", { class: "gi gi-id prrename", value: x.id, title: "rename process" }),
        body,
        ports: frag(
            h("span", { class: "port in", title: "drag a readout here to feed its value through the rules (register slots are added from the + input picker)" }),
            h("span", { class: "port out", title: "drag to a register to send the processed, re-keyed values" })),
    };
}
