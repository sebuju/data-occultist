// Icon-picker modal: pick one of the app's already-imported icons (a shared gallery, not a
// filesystem search) for a toast node's app-logo `icon` field. "Add a new icon" is a native file
// input that uploads and copies the image into managed storage (icons.py) — after that it's just
// another gallery tile.
import * as api from "../api.js";
import { h } from "../dom.js";
import { openModal } from "../modal.js";

// `onPick(absolutePath)` fires when the user picks a stored icon or finishes an upload.
export function openIconPickerModal(onPick) {
    const grid = h("div", { class: "icon-gallery" }, h("div", { class: "find-status muted" }, "loading…"));
    const fileIn = h("input", { class: "icon-upload-in", type: "file", accept: "image/*" });
    const wrap = h("div", { class: "icon-picker" }, grid,
        h("div", { class: "icon-upload-row" },
            h("label", { class: "icon-upload-btn" }, "add a new icon…", fileIn)));

    const handle = openModal({ title: "pick an icon", size: "large", node: wrap });
    const choose = (path) => { onPick(path); handle.close(); };

    const tile = (name, path) => {
        const b = h("button", { class: "icon-tile", title: name },
            h("img", { src: api.icons.fileUrl(name), alt: "" }),
            h("span", { class: "icon-tile-name" }, name));
        b.addEventListener("click", () => choose(path));
        return b;
    };

    const loadGallery = () => api.icons.list(handle.signal).then((r) => {
        const list = r.icons || [];
        if (!list.length) { grid.replaceChildren(h("div", { class: "find-status muted" }, "no icons yet — add one below")); return; }
        grid.replaceChildren(...list.map((c) => tile(c.name, c.path)));
    }).catch((e) => {
        if (e.name === "AbortError") return;
        grid.replaceChildren(h("div", { class: "find-status muted" }, String(e.message || e)));
    });

    fileIn.addEventListener("change", async () => {
        const file = fileIn.files && fileIn.files[0];
        if (!file) return;
        try { const r = await api.icons.upload(file, handle.signal); choose(r.path); }
        catch (e) { if (e.name !== "AbortError") grid.replaceChildren(h("div", { class: "find-status muted" }, `upload failed: ${e.message || e}`)); }
    });

    loadGallery();
}
