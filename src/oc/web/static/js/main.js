// Teach page: edit ONE window of a game. The game (process/title/fields/windows)
// is managed on the games page; here we draw boxes, suggest, preview, and save.
// Loaded as ui.html?game=<name>&window=<id>.
import * as api from "./api.js";
import { Overlay } from "./overlay.js";
import { EditorModel } from "./model.js";
import { collapse, h } from "./dom.js";
import { renderWindow } from "./panels/window.js";
import { renderStates } from "./panels/states.js";
import { renderBox } from "./panels/box.js";
import { renderBoxList } from "./panels/boxlist.js";
import { renderPreview } from "./panels/preview.js";
import { renderAppearance } from "./panels/appearance.js";
import { renderFields } from "./panels/fields.js";
import { initTitlebar } from "./titlebar.js";

initTitlebar();   // custom window chrome — no-op outside the desktop window

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const game = params.get("game") || "";
const model = new EditorModel();
let profile = null;                       // full profile (kept so save merges cleanly)
let lastPreview = { items: [], detections: [], cells: [] };   // cells feed the live key preview
const setStatus = (m) => { $("status").textContent = m; };

$("gameLabel").textContent = game || "(no game)";

const overlay = new Overlay($("canvas"), {
    onCreate: (geom) => { model.addBox(geom, "region"); refresh(); },
    onSelect: (id) => { model.selectedId = id; refresh(); },
    onChange: () => refresh(),
    onZoom: (s) => { $("zoomLabel").textContent = `${Math.round(s * 100)}%`; },
    onPick: (hex) => {
        model.preprocess.colors.push(hex);
        if (model.preprocess.mode === "none") model.preprocess.mode = "color";
        refresh();
        setStatus(`added text colour ${hex}`);
    },
});

// ---- grid preview ---------------------------------------------------------

function gridCells() {
    if (!$("gridPreview").checked || !model.grid.enabled) return [];
    const { rows, cols, rowStride, colStride } = model.grid;
    const cells = [];
    for (const b of model.regionBoxes())
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
                cells.push({ x: b.x + c * colStride, y: b.y + r * rowStride, w: b.w, h: b.h });
    return cells;
}

// ---- render ---------------------------------------------------------------

const ctx = {
    refresh,
    refreshOverlay: () => { overlay.setBoxes(model.boxes); overlay.setGridPreview(gridCells()); },
    refreshList: () => renderBoxList($("panel-boxlist"), model, ctx),
    pickColor: () => { overlay.setPick(true); setStatus("click the text colour in the image"); },
    previewCells: () => lastPreview.cells || [],   // last preview's per-cell reads (key preview)
};

function refresh() {
    overlay.setActive(model.selectedId);
    overlay.setBoxes(model.boxes);
    overlay.setGridPreview(gridCells());
    renderBox($("panel-box"), model, ctx);
    renderWindow($("panel-window"), model, ctx);
    renderFields($("panel-fields"), model, ctx);
    renderAppearance($("panel-appearance"), model, ctx);
    renderStates($("panel-states"), model, ctx);
    renderBoxList($("panel-boxlist"), model, ctx);
    autosave();
}

// ---- zoom + layer toggles -------------------------------------------------

$("zoomInBtn").addEventListener("click", () => overlay.zoom(1.25));
$("zoomOutBtn").addEventListener("click", () => overlay.zoom(0.8));
$("fitBtn").addEventListener("click", () => overlay.fit());
$("oneToOneBtn").addEventListener("click", () => overlay.setScale(1));
$("gridPreview").addEventListener("change", () => overlay.setGridPreview(gridCells()));

function applyPreviewLayers() {
    overlay.setPreview($("previewToggle").checked ? lastPreview.items : []);
    overlay.setDetections($("detectToggle").checked ? lastPreview.detections : []);
}
$("previewToggle").addEventListener("change", applyPreviewLayers);
$("detectToggle").addEventListener("change", applyPreviewLayers);

// ---- capture + stash ------------------------------------------------------

function showImage(url, status) {
    const img = new Image();
    img.onload = () => {
        overlay.setImage(img); overlay.setGridPreview(gridCells());
        lastPreview = { items: [], detections: [], cells: [] };
        overlay.setPreview([]); overlay.setDetections([]);
        $("panel-preview").replaceChildren();
        setStatus(status);
    };
    img.src = url;
}

$("captureBtn").addEventListener("click", async () => {
    setStatus("capturing…");
    try {
        const { url, name } = await api.capture(game);
        showImage(url, "captured");
        await api.bindCapture(game, model.windowId, name);  // newest becomes this window's image
        refreshCaptures();   // reflect it in the picker if it's open
    } catch (e) { setStatus(String(e.message || e)); }
});

// ---- capture picker: tabbed Live (stashes) | Precaptures (frames by session) ----
const capPop = $("capPop"), capPickBtn = $("capPickerBtn");
const capLive = $("capLive"), capPrecap = $("capPrecap");
const CAP_THUMBS = 40;   // cap thumbnails per session (a session can hold hundreds of frames)

function openCapPicker(on) {
    const show = on === undefined ? capPop.hidden : on;
    capPop.hidden = !show;
    capPickBtn.classList.toggle("open", show);
    if (show) (capPrecap.hidden ? renderCapLive() : renderCapPrecap());   // refresh the visible tab
}
capPickBtn.addEventListener("click", () => openCapPicker());
document.addEventListener("click", (e) => { if (!capPop.hidden && !e.target.closest(".cap-picker")) openCapPicker(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !capPop.hidden) openCapPicker(false); });
for (const t of capPop.querySelectorAll(".cap-tab")) {
    t.addEventListener("click", () => {
        for (const x of capPop.querySelectorAll(".cap-tab")) x.classList.toggle("active", x === t);
        const live = t.dataset.tab === "live";
        capLive.hidden = !live; capPrecap.hidden = live;
        live ? renderCapLive() : renderCapPrecap();
    });
}

function capItem(url, label, onPick) {
    const it = document.createElement("button");
    it.type = "button"; it.className = "cap-item"; it.title = label;
    const img = new Image(); img.loading = "lazy"; img.src = url; img.alt = "";
    const cap = document.createElement("span"); cap.textContent = label;
    it.append(img, cap);
    it.addEventListener("click", onPick);
    return it;
}

async function renderCapLive() {
    const names = await api.listCaptures(game).catch(() => []);
    capLive.replaceChildren();
    if (!names.length) { capLive.replaceChildren(h("div", { class: "cap-empty" }, "no stashed captures")); return; }
    for (const n of names) {
        capLive.appendChild(capItem(api.captureUrl(game, n), n.replace(/\.jpg$/, ""), () => {
            showImage(api.captureUrl(game, n), `loaded ${n}`);
            api.bindCapture(game, model.windowId, n).catch((e) => setStatus(String(e.message || e)));   // a stash binds to the window
            openCapPicker(false);
        }));
    }
}

async function renderCapPrecap() {
    capPrecap.replaceChildren(h("div", { class: "cap-empty" }, "loading…"));
    const r = await api.precapture.sessions(game).catch(() => ({ sessions: [] }));
    const sessions = r.sessions || [];
    capPrecap.replaceChildren();
    if (!sessions.length) { capPrecap.replaceChildren(h("div", { class: "cap-empty" }, "no precapture sessions")); return; }
    for (const s of sessions) {
        const shown = Math.min(s.frames || 0, CAP_THUMBS);
        const more = (s.frames || 0) > shown ? ` · +${s.frames - shown} more` : "";
        const grid = h("div", { class: "cap-grid" });
        for (let i = 0; i < shown; i++) {
            const url = api.precaptureFrameUrl(game, s.id, i);
            grid.appendChild(capItem(url, `#${i}`, () => {   // a precapture frame loads as the image (no bind)
                showImage(url, `loaded ${s.label || s.id} #${i}`);
                openCapPicker(false);
            }));
        }
        capPrecap.appendChild(h("div", { class: "cap-grp" },
            h("div", { class: "cap-grp-h" }, `${s.label || s.id} · ${s.frames || 0}f${more}`),
            grid));
    }
}

// kept name for callers: refresh whichever tab is showing (if the picker is open)
function refreshCaptures() { if (!capPop.hidden) (capPrecap.hidden ? renderCapLive() : renderCapPrecap()); }

async function loadBound(windowId) {
    try {
        const v = (await api.getBindings(game))[windowId];
        const name = Array.isArray(v) ? v[0] : v;   // bindings are lists now (pages); show the first
        if (name) showImage(api.captureUrl(game, name), `loaded ${name}`);
    } catch { /* no binding yet */ }
}

// ---- suggest --------------------------------------------------------------

function previewItems(cells) {
    const { rowStride, colStride } = model.grid;
    const items = [];
    for (const c of cells)
        for (const rb of model.regionBoxes()) {
            const fv = c.fields[rb.field];
            if (fv) items.push({ x: rb.x + c.col * colStride, y: rb.y + c.row * rowStride, w: rb.w, h: rb.h, text: fv.value, confidence: fv.confidence });
        }
    return items;
}

function applySuggestion(s) {
    model.ensureField("name");
    const nf = model.fields.find((f) => f.id === "name");
    if (nf) nf.learn = true;
    model.key = { fields: ["name"], sep: "|", case_sensitive: false };
    model.boxes = model.boxes.filter((b) => b.role !== "region");
    const nameBox = model.addBox({ ...s.region }, "region");
    nameBox.field = "name";
    for (const part of s.parts || []) {
        const b = model.addBox({ ...part.box }, "region");
        b.field = part.field;
        model.ensureField(part.field);
        const f = model.fields.find((x) => x.id === part.field);
        if (f && part.type) f.type = part.type;
    }
    model.grid = { enabled: true, rows: s.grid.rows, cols: s.grid.cols, rowStride: s.grid.row_stride, colStride: s.grid.col_stride };
}

$("suggestBtn").addEventListener("click", async () => {
    setStatus("analysing…");
    try {
        const sb = model.boxes.find((b) => b.role === "search");
        const s = await api.suggest(game, sb ? { x: sb.x, y: sb.y, w: sb.w, h: sb.h } : null);
        if (!s.ok) { setStatus(`suggest: ${s.reason || "nothing found"}`); return; }
        applySuggestion(s);
        lastPreview = { items: [], detections: s.detections || [], cells: [] };
        $("detectToggle").checked = true;
        refresh();
        applyPreviewLayers();
        setStatus(`suggested ${s.grid.rows}×${s.grid.cols} · e.g. ${(s.samples || []).slice(0, 3).join(", ")}`);
    } catch (e) { setStatus(String(e.message || e)); }
});

// ---- preview --------------------------------------------------------------

$("previewBtn").addEventListener("click", async () => {
    setStatus("reading…");
    try {
        const res = await api.preview(model.toProfile());
        lastPreview = { items: previewItems(res.cells), detections: res.detections || [], cells: res.cells };
        applyPreviewLayers();
        const fieldIds = [...new Set(model.regionBoxes().map((b) => b.field).filter(Boolean))];
        renderPreview($("panel-preview"), res.cells, fieldIds);
        renderWindow($("panel-window"), model, ctx);   // refresh the live key preview
        const low = res.cells.reduce((n, c) => n + Object.values(c.fields).filter((f) => f.confidence < 0.5).length, 0);
        setStatus(`preview: ${res.cells.length} cells, ${low} low-conf`);
    } catch (e) { setStatus(String(e.message || e)); }
});

// ---- autosave (no save button; persists after every change) ----------------

let saveT = null;
let loaded = false;
function autosave() {
    if (!game || !loaded) return;
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
        try { await api.saveProfile(model.toProfile()); setStatus(`saved ${game}/${model.windowId}`); }
        catch (e) { setStatus(String(e.message || e)); }
    }, 600);
}

// ---- window switching + init ----------------------------------------------

function loadWindow(windowId) {
    model.fromProfile(profile, windowId);
    refresh();
    loadBound(windowId);   // auto-load the stash bound to this window
}

$("windowSelect").addEventListener("change", (e) => loadWindow(e.target.value));

async function init() {
    if (!game) { setStatus("no game in URL"); return; }
    // declutter: collapse the secondary panels by default
    ["Text appearance", "States", "boxes", "preview"].forEach((k) => collapse(k, true));
    try {
        profile = await api.getProfile(game);
    } catch {
        setStatus(`no profile ${game}`); return;
    }
    const windows = (profile.windows || []).map((w) => w.id);
    const want = params.get("window") || windows[0] || "equipment";
    $("windowSelect").replaceChildren(...(windows.length
        ? windows.map((w) => h("option", { selected: w === want }, w))
        : [h("option", want)]));
    await refreshCaptures();
    loadWindow(want);   // also auto-loads the window's bound stash
    loaded = true;      // enable autosave only after the initial load
    setStatus(`editing ${game} / ${want}`);
}

init();
