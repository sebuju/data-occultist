// Send-events row editor for an action node's "window:<id>" source (CLAUDE.md rule 7 — render AND
// wiring both live here, together, so this shape can't drift).
//
// One row = one InputEvent (models.py): a free-text token ("delay" | "key:<name>" |
// "mouse:<button>" | "scroll:<up|down>") + a record button that captures the NEXT keydown/
// mousedown into it (armCapture, key_capture.js — the same "click, then press" primitive the
// trigger's on_input button uses; typing is still how "delay"/"scroll:up"/"scroll:down" get set,
// since there's no key/mouse press to capture for those), a repeat count (hidden for "delay" — a
// wait fires once, never repeats), and a millisecond field (the gap BETWEEN repeats for a send
// row; the wait itself for a "delay" row). Sent server-side, in row order, to the action's bound
// window — see oc.collect.triggers.
import { h, frag, labAdd, trashBtn, iconBtn, REC } from "../dom.js";
import { wireArmedRemove } from "./rules_editor.js";
import { armCapture } from "./key_capture.js";

// N rows, each a free-text token input + record button + a repeat count (hidden for "delay") + a
// ms field + trash. `hint` matches the section label style every other section header uses
// (rulesSection/labAdd).
export function inputRows({ rows }) {
    return frag(
        labAdd("event", "sent, in order, to the bound window when this action fires",
            "ac-iaddrow", "add a row", true),
        h("div", { class: "ac-irows" },
            rows.map((ev, idx) => {
                const isDelay = ev.token === "delay";
                return h("div", { class: "ac-irow", dataset: { idx } },
                    h("input", { class: "gi ac-itok", type: "text", value: ev.token,
                        placeholder: "delay", spellcheck: false,
                        title: "delay | scroll:up | scroll:down | key:<name> | mouse:<left|right|middle|x1|x2>" }),
                    iconBtn(REC(), { cls: "ac-irec", title: "click, then press the key/mouse button to bind" }),
                    !isDelay && h("span", { class: "tg-secs" },
                        h("input", { class: "gi ac-irepeat", type: "number", min: "1", step: "1", value: ev.repeat ?? 1 }),
                        " x"),
                    h("span", { class: "tg-secs" },
                        h("input", { class: "gi ac-idelay", type: "number", min: "0", step: "10", value: ev.delay_ms ?? 0 }),
                        " ms"),
                    trashBtn({ cls: "ac-irmrow", title: "remove this row" }));
            })));
}

// Add/token/repeat/delay/remove — mirrors wireKeyRows/wireRegWriteRows (reg_slots.js). `after()`
// rebuilds so a token flip into/out of "delay" shows/hides the repeat field.
export function wireInputRows(scope, { add, removeRow, setToken, setRepeat, setDelay, after }) {
    scope.querySelector(".ac-iaddrow")?.addEventListener("click", () => { add(); after(); });
    scope.querySelectorAll(".ac-irow").forEach((row) => {
        const idx = +row.dataset.idx;
        row.querySelector(".ac-itok")?.addEventListener("change", (e) => { setToken(idx, e.target.value); after(); });
        row.querySelector(".ac-irec")?.addEventListener("click", (e) => {
            const btn = e.currentTarget;
            armCapture(btn, (token) => {
                const input = row.querySelector(".ac-itok");
                if (input) input.value = token;
                setToken(idx, token); after();
            });
        });
        row.querySelector(".ac-irepeat")?.addEventListener("change", (e) => { setRepeat(idx, e.target.value); });
        row.querySelector(".ac-idelay")?.addEventListener("change", (e) => { setDelay(idx, e.target.value); });
        wireArmedRemove(row, ".ac-irmrow", () => { removeRow(idx); after(); }, { pill: ".ac-irow" });
    });
}
