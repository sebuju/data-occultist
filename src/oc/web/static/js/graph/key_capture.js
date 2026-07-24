// The ONE "click, then press a key/mouse button" capture primitive (rule 7) — arms `btn` (a
// `.armed` CSS hook, disabled while armed), listens for the NEXT keydown/mousedown (Escape
// cancels), translates it into the "key:<name>"/"mouse:<left|right|middle|x1|x2>" token
// vocabulary, and hands the token to `onCapture`. Suppresses the captured event + the following
// contextmenu (a captured right-click shouldn't also pop the page's menu). Was inline in
// io_wire.js's trigger `on_input` button-listen wiring; a second caller (the action node's
// send-events row, input_rows.js) needing the identical capture-and-translate dance is what
// pulled it out here instead of a copy.
//
// Named-key translation matches the SAME token vocabulary oc.input.win32_hook's _key_name
// produces (VK-derived), so a browser-captured bind matches the live hook's events.
// Letters/digits/punctuation already agree (both lowercase the printable char).
const NAMED_KEYS = {
    Escape: "esc", " ": "space", ArrowLeft: "left", ArrowUp: "up", ArrowRight: "right",
    ArrowDown: "down", PageUp: "pageup", PageDown: "pagedown",
};
const MOD_KEYS = { Control: "ctrl", Shift: "shift", Alt: "alt", Meta: "win" };
const MOUSE_NAMES = { 0: "left", 1: "middle", 2: "right", 3: "x1", 4: "x2" };

export function armCapture(btn, onCapture) {
    btn.classList.add("armed");
    btn.disabled = true;
    const finish = (token) => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("mousedown", onMouse, true);
        document.removeEventListener("contextmenu", onCtx, true);
        btn.classList.remove("armed");
        btn.disabled = false;
        if (token) onCapture(token);
    };
    const onKey = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.key === "Escape") return finish(null);
        if (MOD_KEYS[ev.key]) return;   // a bare modifier arms the chord but isn't itself the button
        finish(`key:${NAMED_KEYS[ev.key] || ev.key.toLowerCase()}`);
    };
    const onMouse = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        finish(`mouse:${MOUSE_NAMES[ev.button] || "left"}`);
    };
    const onCtx = (ev) => ev.preventDefault();   // suppress the right-click menu while armed
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onMouse, true);
    document.addEventListener("contextmenu", onCtx, true);
}
