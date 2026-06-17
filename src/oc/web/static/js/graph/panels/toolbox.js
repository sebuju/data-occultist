// Node-creation toolbox floating panel — top-level node creation (window / price /
// trigger / dictionary) plus the window-collision cross-check. Extracted from main.js
// verbatim.
import * as api from "../../api.js";
import { esc, WARN } from "../../dom.js";
import { openModal } from "../../modal.js";
import { log, timed } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { openDictionaryPicker } from "../dict_picker.js";
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
  autosave(); if (!at) panTo(`win:${id}`);
}
async function createPriceNode(at = null, group = null) {
  const id = model.addPriceNode();   // independent producer -> "prices" dataset
  if (!id) return;
  await placeNewNode(`price:${id}`, "price", null, at); render();
  if (group) groups.addToGroup(group, [`price:${id}`]);
  autosave(); if (!at) panTo(`price:${id}`);
}
async function createTriggerNode(at = null, group = null) {
  const id = model.addTrigger();   // fires price-node sweeps on a condition
  if (!id) return;
  await placeNewNode(`trigger:${id}`, "trigger", null, at); render();
  if (group) groups.addToGroup(group, [`trigger:${id}`]);
  autosave(); if (!at) panTo(`trigger:${id}`);
}
function createDictionaryNode(at = null, group = null) {
  const place = async (id) => {
    await placeNewNode(`dict:${id}`, "dictionary", null, at); render();
    if (group) groups.addToGroup(group, [`dict:${id}`]);
    autosave(); if (!at) panTo(`dict:${id}`);
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

function buildToolbox() {
  if (tb) return;
  tb = createFloatWin({
    id: "toolbox", title: "toolbox", state: tbState, bothAxes: true,
    onShow: () => $("createBtn")?.classList.toggle("active", true),
    onHide: () => $("createBtn")?.classList.toggle("active", false),
    onPersist: () => persist.layout(),
  });
  // Node creation (window / price / trigger / dictionary) moved to the canvas right-click
  // add-node menu (see main.js); the toolbox keeps the cross-cutting tools.
  tb.body.innerHTML = `<div class="tb-list">
    <button class="tb-btn" data-create="collisions" title="run each window's bound image through every window's detectors — report which windows false-match each other">${WARN} check window collisions</button>
  </div>`;
  tb.body.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-create]");
    if (!b) return;
    if (!model.profile.name) { setStatus("load a game first"); return; }
    if (b.dataset.create === "collisions") runCollisionCheck();
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

export {
  tb, tbState, createWindowNode, createPriceNode, createTriggerNode,
  createDictionaryNode, buildToolbox, COLLIDE_VERDICTS, collisionReportHTML,
  runCollisionCheck,
};
