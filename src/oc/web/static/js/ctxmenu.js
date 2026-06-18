// Shared right-click context menu. One floating menu at a time, positioned at the click
// point, clamped on-screen, dismissed on the next click anywhere / Escape. Both the graph
// node-view (add node) and pretty studio (add widget) build their right-click menus on this —
// do NOT fork a second copy — one shared primitive.

let _menu = null;
function closeContextMenu() {
    if (!_menu) return;
    _menu.remove(); _menu = null;
    document.removeEventListener("mousedown", _onOutside, true);
    document.removeEventListener("keydown", _onKey, true);
}
function _onOutside(e) { if (_menu && !_menu.contains(e.target)) closeContextMenu(); }
function _onKey(e) { if (e.key === "Escape") closeContextMenu(); }

// items: [{ icon?, title, tint?, onClick }]. clientX/clientY are viewport coords of the click;
// the menu opens there and an item's onClick fires after the menu closes. `tint` (a CSS colour,
// e.g. "var(--accent)") colours that row's icon AND label so each type reads in its own colour —
// the icon SVG tints via currentColor; with no tint the row falls back to muted icon / --text.
function openContextMenu(clientX, clientY, items) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "ctxmenu";
    menu.style.left = `${clientX}px`; menu.style.top = `${clientY}px`;
    for (const it of items) {
        const b = document.createElement("button");
        b.className = "ctx-item";
        if (it.tint) b.style.setProperty("--ctx-tint", it.tint);
        b.innerHTML = `<span class="ctx-ic">${it.icon || "▫"}</span><span class="ctx-lbl">${it.title}</span>`;
        b.addEventListener("click", () => { closeContextMenu(); it.onClick(); });
        menu.appendChild(b);
    }
    document.body.appendChild(menu);
    _menu = menu;
    const r = menu.getBoundingClientRect();   // keep fully on-screen
    if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 6}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 6}px`;
    // defer the dismiss listeners a tick so the opening click doesn't instantly close it
    setTimeout(() => { document.addEventListener("mousedown", _onOutside, true); document.addEventListener("keydown", _onKey, true); }, 0);
}
export { openContextMenu, closeContextMenu };
