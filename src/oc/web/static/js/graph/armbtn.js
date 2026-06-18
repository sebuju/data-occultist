// armbtn.js — the ONE armed two-click button (CLAUDE.md rule 2: no blocking confirm()).
//
// A destructive action's button arms on the first click (label swaps to a confirm prompt,
// gains the `.armed` danger style), fires only on a second click within `timeout`, and
// auto-disarms after that window. New destructive buttons are a CALL here, not another
// inline copy of the dataset.armed dance (rule 7).

// opts: { label, arm = "confirm?", title, cls, timeout = 2500, onFire }
// `onFire` may be async; while it runs the button is disabled + shows `busy`. On throw the
// label shows the error and disarms. Returns the <button>.
export function armedButton({ label, arm = "confirm?", title = "", cls = "",
                             busy = "…", timeout = 2500, onFire }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `armbtn ${cls}`.trim();
    btn.textContent = label;
    if (title) btn.title = title;
    let armed = false;
    let timer = null;
    const disarm = () => {
        armed = false;
        clearTimeout(timer);
        btn.dataset.armed = "0";
        btn.textContent = label;
    };
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!armed) {                       // first click arms; auto-disarm after the window
            armed = true;
            btn.dataset.armed = "1";
            btn.textContent = arm;
            clearTimeout(timer);
            timer = setTimeout(disarm, timeout);
            return;
        }
        clearTimeout(timer);
        armed = false;
        btn.dataset.armed = "0";
        btn.disabled = true;
        btn.textContent = busy;
        try {
            await onFire?.();
            btn.textContent = label;        // success -> back to resting label
        } catch (err) {
            btn.textContent = String(err?.message || err);
        } finally {
            btn.disabled = false;
        }
    });
    return btn;
}
