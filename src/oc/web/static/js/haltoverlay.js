// haltoverlay.js — the ONE full-screen ".startup-halt" shell every blocking/alerting
// overlay builds on (offline banner in conn.js, profile-error banner in profile_alert.js).
// Owns only the shell (create-once, append-to-body, hidden by default); each caller fills
// its own box contents via replaceChildren and controls its own show/hide policy.

export function createHaltOverlay(extraClass = "") {
    const el = document.createElement("div");
    el.className = extraClass ? `startup-halt ${extraClass}` : "startup-halt";
    el.hidden = true;
    document.body.appendChild(el);
    return el;
}
