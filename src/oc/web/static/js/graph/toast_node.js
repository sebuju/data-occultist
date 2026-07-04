// Toast node: raises an OS desktop notification when fired. A trigger names this node's id in
// its `targets` (drag the trigger's fire-port here, or pick it in the trigger's "fires"), so any
// trigger condition can pop a Windows toast. The 🔔 test button pops it now with the current
// config. Every field maps to the ToastSpec the server-side notifier renders. Rendering only —
// wiring is in main.js (wireToast). Config persists in the profile YAML like any other node.
import { h, frag, labCell } from "../dom.js";
import { slideToggle } from "./node_parts.js";
import { iconFor } from "./node_icons.js";

const DURATIONS = [["short", "short"], ["long", "long"]];

export function toastParts(x, model) {
    const durOpt = ([v, l]) => h("option", { value: v, selected: v === (x.duration || "short") }, l);
    // live readout tokens the title/message can interpolate: {{health}} prints that readout's live
    // value when a trigger fires (mirrors the pretty side). Click a chip to insert its token.
    const ros = model && model.readouts ? model.readouts() : [];
    const roHint = ros.length ? frag(
        labCell("readouts", "click to insert a live-value token; it resolves when a trigger fires while a live session is running", true),
        h("div", { class: "tn-rotokens" },
            ros.map((v) => h("button", { class: "tn-rotoken", type: "button", dataset: { token: v.id },
                title: `insert {{${v.id}}}` }, `{{${v.id}}}`)))) : null;
    return {
        title: h("input", { class: "gi gi-id toastrename", value: x.id, title: "rename toast" }),
        body: frag(
            h("div", { class: "lab-grid" },
                labCell("title", "the toast's bold heading line — supports {{ro_1}} live-value tokens"),
                h("input", { class: "tn-title", value: x.title || "", placeholder: "Warframe" }),
                labCell("message", "the toast's body text — supports {{ro_1}} live-value tokens"),
                h("input", { class: "tn-message", value: x.message || "", placeholder: "e.g. health {{ro_1}}" }),
                roHint,
                labCell("app", "the notification's source label (its AppUserModelID)"),
                h("input", { class: "tn-app", value: x.app_name || "", placeholder: "data-occultist" }),
                labCell("duration", "how long the toast lingers before auto-dismissing"),
                h("select", { class: "tn-duration" }, DURATIONS.map(durOpt)),
                labCell("icon", "optional app-logo image path shown on the toast"),
                h("input", { class: "tn-icon", value: x.icon || "", placeholder: "(none)" }),
                labCell("attribution", "small attribution line under the body"),
                h("input", { class: "tn-attr", value: x.attribution || "", placeholder: "(none)" }),
                labCell("muted", "silence the toast's notification sound"),
                slideToggle({ on: !!x.muted, cls: "tn-muted", title: "silence the toast sound" })),
            h("div", { class: "gn-foot" },
                h("span", { class: "tn-prog muted" }, ""),
                // monochrome bell from the ONE icon source (not a colour emoji) + label
                h("button", { class: "tn-test", title: "pop this toast now" }, iconFor("toast"), "test"))),
    };
}
