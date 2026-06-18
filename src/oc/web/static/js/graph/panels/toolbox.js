// Node-creation toolbox floating panel — top-level node creation (window / price /
// trigger / dictionary) plus the window-collision cross-check. Extracted from main.js
// verbatim.
import * as api from "../../api.js";
import { esc, WARN, CAMERA } from "../../dom.js";
import { openModal } from "../../modal.js";
import { log, timed } from "../../log.js";
import { domToBlob } from "../../vendor/dom-to-image.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { openDictionaryPicker } from "../dict_picker.js";
import { nodemapShot } from "./nodemap.js";
import * as groups from "../groups.js";
import { $, setStatus, model } from "../state.js";
import { placeNewNode, render, autosave, panTo } from "../main.js";

// ---- node-creation toolbox ------------------------------------------------
// Top-level node creation (window / price / trigger / dictionary) lives in this floating
// panel instead of cluttering the game node. Each button mints a node, drops it in a free
// spot, and pans to it. Contextual creation (datasets/views via wire-drag, regions/items by
// drawing on a window image) stays where the context is.
const tbState = { visible: false, x: null, y: null, w: null, h: null };
let tb = null;

// `at` (optional world-coords {x,y}) is the spot the right-click add-node menu was opened at:
// the node spawns there and we skip the pan-to (it's already under the cursor). A toolbox-style
// call with no `at` lands at the viewport centre and pans to it. `group` (optional group id) is
// set when the menu was opened over a group's box -> the new node joins that group (added AFTER
// render(), which addToGroup needs for the node's live rect).
async function createWindowNode(at = null, group = null) {
    const id = model.addWindow();   // default id; renamed in the window node
    if (!id) return;
    // a brand-new window starts with NO image — clear any binding left over from a deleted
    // window that reused this id, so its button shows "capture" rather than a stale capture.
    try { if (model.profile.name) await api.bindCapture(model.profile.name, id, ""); } catch (e) { log(`unbind capture failed: ${e.message || e}`, "err"); }
    await placeNewNode(`win:${id}`, "window", null, at);
    render();   // window now in the DOM with its real height, so its bonded preview can stack right below it
    // the window's bonded preview node spawns directly BELOW the window (srcId stacks it there),
    // else ensurePositions() would drop it in the far COLX.preview column, leagues from its window.
    await placeNewNode(`prev:${id}`, "preview", `win:${id}`);
    render();
    if (group) groups.addToGroup(group, [`win:${id}`]);
    // a brand-new empty window has no image/regions/detect of its own and changes nothing
    // other windows read — autosave(false) so it never re-OCRs the open windows.
    autosave(false); if (!at) panTo(`win:${id}`);
}
async function createPriceNode(at = null, group = null) {
    const id = model.addPriceNode();   // independent producer -> "prices" dataset
    if (!id) return;
    await placeNewNode(`price:${id}`, "price", null, at); render();
    if (group) groups.addToGroup(group, [`price:${id}`]);
    autosave(false); if (!at) panTo(`price:${id}`);   // new node changes nothing open windows OCR
}
async function createTriggerNode(at = null, group = null) {
    const id = model.addTrigger();   // fires price-node sweeps on a condition
    if (!id) return;
    await placeNewNode(`trigger:${id}`, "trigger", null, at); render();
    if (group) groups.addToGroup(group, [`trigger:${id}`]);
    autosave(false); if (!at) panTo(`trigger:${id}`);   // new node changes nothing open windows OCR
}
function createDictionaryNode(at = null, group = null) {
    const place = async (id) => {
        await placeNewNode(`dict:${id}`, "dictionary", null, at); render();
        if (group) groups.addToGroup(group, [`dict:${id}`]);
        autosave(false); if (!at) panTo(`dict:${id}`);   // new node changes nothing open windows OCR
    };
    openDictionaryPicker({
        used: new Set((model.profile.dictionaries || []).map((d) => d.source)),
        // existing word file: re-use its node if already on the graph, else reference it
        // (fetch its terms so the new node shows them straight away).
        onPick: async (source) => {
            const existing = model.dictionaryBySource(source);
            if (existing) { panTo(`dict:${existing.id}`); return; }
            let terms = [];
            try { ({ terms } = await api.dictionaries.get(source)); } catch { /* missing file -> 0 terms */ }
            const id = model.addDictionary({ source, terms });
            if (id) await place(id);
        },
        onCreate: async (name) => {
            const id = model.addDictionary({ name });
            if (id) await place(id);
        },
    });
}

async function createDatasetNode(at = null, group = null) {
    const ds = model.addDataset();   // fresh empty dataset; producers wired to it later
    if (!ds) return;
    await placeNewNode(`ds:${ds}`, "dataset", null, at); render();
    if (group) groups.addToGroup(group, [`ds:${ds}`]);
    autosave(false); if (!at) panTo(`ds:${ds}`);   // empty dataset changes nothing open windows OCR
}
async function createSubsetNode(at = null, group = null) {
    const id = model.addSubset();   // input-less view; user wires a source dataset/view after
    if (!id) return;
    await placeNewNode(`sub:${id}`, "subset", null, at); render();
    if (group) groups.addToGroup(group, [`sub:${id}`]);
    autosave(false); if (!at) panTo(`sub:${id}`);   // empty view changes nothing open windows OCR
}

function buildToolbox() {
    if (tb) return;
    tb = createFloatWin({
        // autoFit:false -> let the CSS `#toolbox { height:auto }` size it: the body is a static
        // button list, so the panel always hugs every button exactly (the shared fitHeight rounds
        // to a fixed px height that can land 1px short -> a stray scrollbar).
        id: "toolbox", title: "toolbox", state: tbState, bothAxes: true, autoFit: false,
        onShow: () => $("createBtn")?.classList.toggle("active", true),
        onHide: () => $("createBtn")?.classList.toggle("active", false),
        onPersist: () => persist.layout(),
    });
    // Node creation (window / price / trigger / dictionary) moved to the canvas right-click
    // add-node menu (see main.js); the toolbox keeps the cross-cutting tools.
    tb.body.innerHTML = `<div class="tb-list">
    <button class="tb-btn" data-create="collisions" title="run each window's bound image through every window's detectors — report which windows false-match each other">${WARN} check window collisions</button>
    <button class="tb-btn" data-create="shot-canvas" title="render the WHOLE node canvas (every node/edge/group, any zoom) to a PNG, stashed under .trash/">${CAMERA} screenshot canvas</button>
    <button class="tb-btn" data-create="shot-viewport" title="capture just the CURRENT on-screen view (current pan/zoom) to a PNG, stashed under .trash/">${CAMERA} screenshot viewport</button>
    <button class="tb-btn" data-create="shot-nodemap" title="render the node MAP (minimap overview) to a PNG sized so the smallest label is 13px, stashed under .trash/">${CAMERA} screenshot node map</button>
  </div>`;
    tb.body.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-create]");
        if (!b) return;
        if (!model.profile.name) { setStatus("load a game first"); return; }
        if (b.dataset.create === "collisions") runCollisionCheck();
        else if (b.dataset.create === "shot-canvas") screenshotCanvas();
        else if (b.dataset.create === "shot-viewport") screenshotViewport();
        else if (b.dataset.create === "shot-nodemap") screenshotNodemap();
    });
}

// Verdict copy + class for the collision report. One source of truth for both.
const COLLIDE_VERDICTS = {
    ok:            ["✓ ok",            "conf-ok",   "only this window matched its image"],
    collision:     [`${WARN} collision`, "conf-warn", "another window also fully matched — ambiguous"],
    misclassified: ["✗ misclassified", "conf-bad",  "another window WINS the tie-break — classify picks the wrong one"],
    self_no_match: ["✗ self no-match",  "conf-bad",  "this window's own image doesn't match it — detectors too strict/disabled"],
    no_image:      ["– no image",       "muted",     "no bound capture to test — open the window node and bind one"],
};

function collisionReportHTML(data) {
    const wins = data.windows || [];
    if (!wins.length) return `<p class="muted" style="padding:12px">no windows to check</p>`;
    const bad = wins.filter((w) => w.verdict !== "ok" && w.verdict !== "no_image").length;
    const head = bad
        ? `<p class="conf-warn" style="margin:0 0 8px">${bad} window(s) collide — a frame could classify to the wrong window.</p>`
        : `<p class="conf-ok" style="margin:0 0 8px">no collisions — every window matches only its own image.</p>`;
    const rows = wins.map((w) => {
        const [label, cls, tip] = COLLIDE_VERDICTS[w.verdict] || ["?", "muted", ""];
        // for a colliding/misclassified window, show WHICH windows also matched + their detector scores
        const offenders = (w.matches || []).filter((m) => m.matched && m.window !== w.window);
        const detail = offenders.map((m) => {
            const dets = (m.detectors || []).map((d) =>
                `<span class="cc-det ${d.matched ? "conf-ok" : "conf-bad"}">${esc(d.id)} ${Math.round((d.score || 0) * 100)}%/${Math.round((d.threshold || 0) * 100)}%${d.read ? ` "${esc(d.read)}"` : ""}</span>`).join(" ");
            return `<div class="cc-off">↳ also matched <b>${esc(m.window)}</b> ${dets}</div>`;
        }).join("");
        const win = w.winner && w.winner !== w.window ? ` <span class="muted">→ classifies as ${esc(w.winner)}</span>` : "";
        return `<div class="cc-row">
      <div class="cc-head"><span class="${cls}" title="${esc(tip)}">${label}</span> <b>${esc(w.window)}</b>${win}
        ${w.capture ? `<span class="muted cc-cap">${esc(w.capture)}</span>` : ""}</div>
      ${detail}</div>`;
    }).join("");
    return `<div class="cc-wrap">${head}<div class="cc-list">${rows}</div></div>`;
}

async function runCollisionCheck() {
    if (!model.profile.name) { setStatus("load a game first"); return; }
    const m = openModal({ title: "window collisions", size: "medium",
        html: `<p class="muted" style="padding:12px">checking…</p>` });
    const body = m.body || m.el?.querySelector(".modal-body");
    const done = timed("collision check");
    try {
        const data = await api.detectCollisions(model.profile.name, m.signal);   // GET; whole-profile cross-check
        done();
        if (body) body.innerHTML = collisionReportHTML(data);
    } catch (e) {
        if (e.name === "AbortError") return;   // modal closed mid-fetch
        done(String(e.message || e), "err");
        if (body) body.innerHTML = `<p class="conf-bad" style="padding:12px">${esc(String(e.message || e))}</p>`;
    }
}

// ---- whole-canvas screenshot ----------------------------------------------
// Render the ENTIRE node graph (every placed node, regardless of the current pan/zoom)
// to a PNG and stash it under the repo's .trash/. The canvas is plain DOM, so we lean on
// the vendored dom-to-image. We DON'T touch the live #gworld transform: dom-to-image
// clones the subtree offscreen, and we hand the clone a fresh transform that shifts the
// graph's bounding box to the origin at scale 1 — so the output is the whole map, not the
// on-screen viewport.
const SHOT_MARGIN = 40;   // breathing room (world px) around the content
const SHOT_SCALE = 2;     // output pixel-ratio — crisp without ballooning huge graphs

// Tight bounding box of everything ACTUALLY rendered in the world layer — node elements
// plus group + supergroup boxes (so their title bands / labels are included). We measure
// the live DOM (offsetLeft/Top/Width/Height are world coords — transform-independent), NOT
// the `pos` map: that map carries stale/zero-size phantom entries (e.g. unplaced view nodes)
// far from the real cluster, which would inflate the box into huge empty bands. Zero-size
// elements are skipped for the same reason.
function graphBBox() {
    const world = $("gworld");
    if (!world) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    // supergroup + group boxes first (they back the nodes), then the nodes themselves
    for (const el of world.querySelectorAll("#sgroups > *, #ggroups > *, #gnodes > *")) {
        if (el.hidden) continue;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) continue;   // phantom / unrendered -> ignore
        const x = el.offsetLeft, y = el.offsetTop;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
        any = true;
    }
    if (!any) return null;   // nothing rendered
    return { minX: minX - SHOT_MARGIN, minY: minY - SHOT_MARGIN,
                      w: (maxX - minX) + SHOT_MARGIN * 2, h: (maxY - minY) + SHOT_MARGIN * 2 };
}

function graphBg() {
    return getComputedStyle($("graph")).getPropertyValue("--bg").trim() || "#1c1e23";
}

// Render `node` to a PNG with `opts` and stash it under .trash/ (view tags the filename).
// Shared by both screenshot buttons — the only difference is WHAT/HOW they render.
async function stashShot(view, node, opts) {
    const done = timed("screenshot");
    try {
        const blob = await domToBlob(node, { scale: SHOT_SCALE, backgroundColor: graphBg(), ...opts });
        const { path } = await api.stashScreenshot(model.profile.name, blob, view);
        done();
        setStatus(`saved ${path}`);
    } catch (e) {
        done(String(e.message || e), "err");
        setStatus(`screenshot failed: ${e.message || e}`);
    }
}

// Whole graph: render #gworld with the live pan/zoom overridden to a 1:1 transform that shifts
// the content bounding box to the origin, sized to the full span — so every node is captured.
async function screenshotCanvas() {
    if (!model.profile.name) { setStatus("load a game first"); return; }
    const world = $("gworld");
    const box = graphBBox();
    if (!world || !box) { setStatus("nothing to screenshot — no placed nodes"); return; }
    await stashShot("canvas", world, {
        width: box.w, height: box.h,
        style: { transform: `translate(${-box.minX}px, ${-box.minY}px)`, transformOrigin: "0 0" },
    });
}

// Current view: render the #graph viewport as-is (it clips to the visible area at the live
// pan/zoom). Floating panels are siblings of #graph, not children, so they don't appear.
async function screenshotViewport() {
    if (!model.profile.name) { setStatus("load a game first"); return; }
    const graph = $("graph");
    if (!graph) { setStatus("no canvas to screenshot"); return; }
    await stashShot("viewport", graph, {});
}

// Node map: the minimap SVG overview, sized so the smallest label is 13px (nodemapShot solves
// the scale and returns a SELF-CONTAINED svg — inline styles + bg). Rasterised via <img>+canvas,
// NOT domToBlob: its foreignObject path doesn't render a nested inline <svg>'s children.
async function screenshotNodemap() {
    if (!model.profile.name) { setStatus("load a game first"); return; }
    const shot = nodemapShot({ floor: 13 });
    if (!shot) { setStatus("nothing to screenshot — no nodes"); return; }
    const done = timed("screenshot");
    try {
        const blob = await svgToPngBlob(shot.svg, shot.W, shot.H);
        const { path } = await api.stashScreenshot(model.profile.name, blob, "nodemap");
        done();
        setStatus(`saved ${path}`);
    } catch (e) {
        done(String(e.message || e), "err");
        setStatus(`screenshot failed: ${e.message || e}`);
    }
}

// Rasterise a self-contained SVG string to a PNG Blob through an <img> + canvas. The SVG must
// carry its own xmlns + styling (the document's CSS doesn't reach an <img>-loaded SVG).
function svgToPngBlob(svg, W, H) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement("canvas");
            cv.width = Math.max(1, Math.round(W)); cv.height = Math.max(1, Math.round(H));
            cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
            URL.revokeObjectURL(url);
            cv.toBlob((b) => b ? resolve(b) : reject(new Error("canvas toBlob failed")), "image/png");
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG failed to load as image")); };
        img.src = url;
    });
}

export {
    tb, tbState, createWindowNode, createPriceNode, createTriggerNode,
    createDictionaryNode, createDatasetNode, createSubsetNode,
    buildToolbox, COLLIDE_VERDICTS, collisionReportHTML,
    runCollisionCheck,
};
