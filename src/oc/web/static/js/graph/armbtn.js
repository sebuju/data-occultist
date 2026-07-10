// armbtn.js — the ONE armed two-click state machine (CLAUDE.md rule 2: no blocking confirm()).
//
// A destructive action arms on the first click (via onArm), fires only on a second click within
// `timeout` (via onFire), and auto-disarms after that window (via onDisarm) — same dance every
// destructive control in the UI needs, whether it's a button (armedButton, below) or a chip's
// trash icon (sources_input.js). New destructive controls call one of these, never another
// inline copy of the dataset.armed dance (rule 7).

// makeArmed({ onArm, onTimeout, onFire, timeout }) -> { trigger, disarm }
//   onArm()     called on the first click (arm)
//   onTimeout() called ONLY when the arm window expires with no second click — the caller resets
//               its "armed" visuals back to resting here. NOT called after a real fire; onFire
//               owns its own cleanup (it may want to show an error instead of the resting state).
//   onFire()    called on the second click within `timeout`; may be async and owns all UI cleanup
//               for the fire path (disarm the visuals itself — makeArmed won't touch them after).
//   trigger()   call from a click handler to advance the state machine
//   disarm()    force back to disarmed (e.g. a click elsewhere) without firing — runs onTimeout
export function makeArmed({ onArm, onTimeout, onFire, timeout = 2500 } = {}) {
    let armed = false;
    let timer = null;
    const disarm = () => {
        if (!armed) return;
        armed = false;
        clearTimeout(timer);
        onTimeout?.();
    };
    const trigger = async () => {
        if (!armed) {                       // first click arms; auto-disarm after the window
            armed = true;
            onArm?.();
            clearTimeout(timer);
            timer = setTimeout(disarm, timeout);
            return;
        }
        clearTimeout(timer);
        armed = false;
        await onFire?.();                   // onFire is responsible for its own visual cleanup
    };
    return { trigger, disarm };
}

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
    const armed = makeArmed({
        timeout,
        onArm: () => { btn.dataset.armed = "1"; btn.textContent = arm; },
        onTimeout: () => { btn.dataset.armed = "0"; btn.textContent = label; },
        onFire: async () => {
            btn.dataset.armed = "0";
            btn.disabled = true;
            btn.textContent = busy;
            try {
                await onFire?.();
                btn.textContent = label;    // success -> back to resting label
            } catch (err) {
                btn.textContent = String(err?.message || err);
            } finally {
                btn.disabled = false;
            }
        },
    });
    btn.addEventListener("click", (e) => { e.stopPropagation(); armed.trigger(); });
    return btn;
}
