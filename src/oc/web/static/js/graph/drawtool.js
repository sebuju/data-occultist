// The ONE source of truth for "which draw tool is armed" on a node canvas.
//
// A drawing surface (window image, item cutout, glyph atlas) holds a radio group of `.tool`
// buttons; the armed one carries `.active` and its `dataset.kind` names what a drag creates.
// Everything about drawing gates on that single fact:
//   - no tool armed  => the Overlay's `canCreate` is false => no crosshair, no new box, not even a
//     drag on the data_area/bbox backdrop (see overlay.js). Drawing is impossible until a tool is
//     picked, and stays impossible for any tool added later — a new tool is just another `.tool`
//     button, a new surface is just another `wireTools()` call. Nothing else to touch (rule 7).
//   - right-click / Escape / click outside every surface all route through `clearTools()`.
//
// The host element passed to `wireTools` is tagged `data-toolhost` so the central handlers can
// find every surface generically. Its `__toolChange` runs when the armed tool changes (incl. when
// cleared to null), letting a surface tear down transient UI (e.g. the glyph compose row).

// The armed tool kind for a surface, or null when none is picked.
export function toolKind(host) {
    return host?.querySelector(".tool.active")?.dataset.kind || null;
}

// Wire a surface's `.tool` buttons as a toggle radio group and return the pair every canvas hands
// to `new Overlay(...)`: `kindOf` (armed kind or null) and `canCreate` (drawing allowed only while
// a tool is armed). A second click on the armed tool disarms it. `onChange(kind|null)` fires on
// every arm/disarm — including a central clearTools() — so a surface can react (status, compose).
export function wireTools(host, { onChange } = {}) {
    if (!host) return { kindOf: () => null, canCreate: () => false };
    host.dataset.toolhost = "1";
    host.__toolChange = onChange || null;
    host.querySelectorAll(".tool").forEach((btn) => btn.addEventListener("click", () => {
        const wasActive = btn.classList.contains("active");
        host.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
        if (!wasActive) btn.classList.add("active");
        onChange?.(toolKind(host));
    }));
    return { kindOf: () => toolKind(host), canCreate: () => toolKind(host) !== null };
}

// Disarm the tool on every surface (optionally keeping the one whose surface is inside `exceptHost`,
// e.g. the node being focused). Fires each cleared surface's `__toolChange(null)`. Returns whether
// anything was actually cleared, so callers (Escape) can avoid swallowing the key otherwise.
export function clearTools(exceptHost = null) {
    let changed = false;
    for (const host of document.querySelectorAll("[data-toolhost]")) {
        if (exceptHost && (exceptHost === host || exceptHost.contains(host) || host.contains(exceptHost))) continue;
        const btn = host.querySelector(".tool.active");
        if (!btn) continue;
        btn.classList.remove("active");
        host.__toolChange?.(null);
        changed = true;
    }
    return changed;
}
