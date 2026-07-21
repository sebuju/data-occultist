// profile_alert.js — a big red banner (reusing the ".startup-halt" shell every blocking
// overlay uses, see haltoverlay.js) for boot-time profile CHECKER problems: a node
// reference or a region/tell/readout field that doesn't exist. Fed by logstream.js off
// the `kind: "profile_check"` log-bar lines the checker publishes at boot (see
// oc.profile.checker + the lifespan loop in web/app.py). Unlike conn.js's offline
// overlay this never auto-retries (a stale YAML reference doesn't fix itself) — the
// user dismisses it after reading/fixing, or it clears when the game switches.

import { h } from "./dom.js";
import { createHaltOverlay } from "./haltoverlay.js";

let el = null, listEl = null;
const issues = new Map();   // msg -> {msg, level}

function ensureEl() {
    if (el) return;
    el = createHaltOverlay("profile-alert-overlay");
    listEl = h("ul", { class: "profile-alert-list" });
    el.replaceChildren(h("div", { class: "startup-halt-box" },
        h("h3", "Profile has errors"),
        h("p", "This game's profile references ids or fields the boot-time checker couldn't find. Fix them in the teach UI, then reload."),
        listEl,
        h("div", { class: "halt-actions" },
            h("button", { class: "startup-halt-retry", type: "button", onClick: dismiss }, "dismiss"))));
}

function render() {
    ensureEl();
    listEl.replaceChildren(...[...issues.values()].map((i) =>
        h("li", { class: `lvl-${i.level}` }, i.msg)));
    el.hidden = issues.size === 0;
}

function dismiss() { if (el) el.hidden = true; }

// Fed one checker line at a time (ev = {msg, level: "err"|"warn"}) as it streams in over
// the log bar — dedup on the message text so a reconnect's backfill replay doesn't double
// an entry already shown.
export function reportIssue(ev) {
    if (ev.level !== "err" && ev.level !== "warn") return;
    issues.set(ev.msg, ev);
    render();
}

// Called on a game switch (openLogStream) so a previous game's stale issues don't
// linger over the newly loaded one.
export function clearIssues() {
    issues.clear();
    if (el) el.hidden = true;
}
