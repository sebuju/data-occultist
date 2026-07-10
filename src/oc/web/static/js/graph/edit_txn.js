// THE one deferred-edit transaction. Moving, resizing, nudging or typing a box — and editing a
// node's config (rules, detector knobs, filters) — no longer writes the model / re-runs OCR on
// every keystroke. An edit opens a BATCH against one surface and only paints. Enter (or the ✓
// button) commits the whole batch, Escape (or ✕) reverts it, a pointerdown outside the owning
// surface commits it. So a burst of edits costs ONE model write pass, ONE autosave, ONE read
// settle (the 700ms scheduleWindowRead clock) and ONE undo step — instead of one of each per
// pixel moved or character typed.
//
// This matters beyond cost: a read settling mid-edit calls setNodeBusy, which sets `inert` on the
// node body — and `inert` force-blurs whatever is focused inside it. Editing a node used to kick
// the caret out of the input on every change. Deferring the read is what fixes that.
//
// One batch at a time, keyed by the surface: the overlay-registry key (`win:<id>` /
// `item:<w>:<i>` — which is also the node id) for boxes, `node:<id>` for a node's config.
// Beginning a batch on a DIFFERENT surface commits the previous one first, so an edit is never
// silently abandoned.
//
// Two draft styles, both supported:
//   - the model is the CLEAN state (canvas boxes): nothing is written until commit, so reverting
//     is just "rebuild from the model" (spec.restore). The drafts live here, and `applyPending`
//     re-stamps them onto any box list rebuilt from the model meanwhile — an async OCR read
//     landing mid-edit must not snap a dirty box back (the same hazard `Overlay._pendingBoxes`
//     guards one level down).
//   - the model is written LIVE (toast geometry, node config): the surface keeps its own snapshot
//     of the clean state and puts it back in `spec.restore`.
//
// A surface joins by handing in a `spec`:
//   host        element the floating ✓/✕ bar mounts into (must be a positioning context), or a
//               `() => element` thunk when the host is rebuilt during the batch (node cards are)
//   barClass    class for the bar element (default "rect-txn")
//   isOutside(t) does this pointerdown target mean "you left"?  -> commit
//   commit(drafts) write every draft, then run the surface's aftermath ONCE
//   restore()    put the surface back to the clean state
import { h, iconBtn, CHECK, XMARK } from "../dom.js";

let batch = null;   // { key, spec, boxes: Map<draftId, draft>, bar }

// A draft is a plain copy of whatever the surface handed in (never a live overlay box reference —
// the overlay rebuilds its box objects from the model on every refresh, so a reference would
// dangle). For boxes, `role`/`id` ride along because the model writers (persistWinBox /
// persistItem) dispatch on them.
const draftOf = (id, payload) => ({ ...payload, id });

// `armed`: a batch is open on this surface (it may hold nothing yet — a node arms on the first
// keystroke, before we know whether the value actually ends up different).
// `dirty`: that batch actually holds an uncommitted change. This is the one that gates the ✓/✕
// bar, the Enter/Escape capture, and Ctrl+Z's "drop the pending edit first".
export function armed(key = null) { return !!batch && (!key || batch.key === key); }
export function dirty(key = null) { return armed(key) && batch.boxes.size > 0; }
export function pendingFor(key) { return batch && batch.key === key ? batch.boxes : null; }

// Re-stamp the batch's drafts onto a freshly model-built box list. Called by refreshImageBoxes /
// refreshItemBoxes right before setBoxes, so ANY rebuild (an OCR read landing, a live-mode
// refresh, an undo restore) preserves the uncommitted geometry. Box-only: a config draft carries
// no geometry, so it is skipped.
export function applyPending(key, boxes) {
    const p = pendingFor(key);
    if (!p) return boxes;
    for (const b of boxes) {
        const d = p.get(b.id);
        if (d && typeof d.x === "number") { b.x = d.x; b.y = d.y; b.w = d.w; b.h = d.h; }
    }
    return boxes;
}

// Open a batch for `key`, building its spec lazily (only when a batch actually opens). A batch
// already open on this key is left alone; one on another key is COMMITTED first — "one surface at
// a time", never a silent discard.
export function begin(key, makeSpec) {
    if (batch && batch.key === key) return;
    commitIfDirty();
    batch = { key, spec: makeSpec(), boxes: new Map(), bar: null };
    document.addEventListener("keydown", onKey, true);       // capture: beat the graph's own Escape/undo handlers
    document.addEventListener("pointerdown", onDown, true);
}

// Record a draft as part of the open batch and reveal the ✓/✕ bar.
export function touch(id, payload) {
    if (!batch) return;
    batch.boxes.set(id, draftOf(id, payload));
    showBar();
}

// Drop a draft again — the surface decided this edit is no longer a change (a node's config was
// typed back to its original value). With nothing left dirty the ✓/✕ bar goes away and Enter /
// Escape stop meaning "commit" / "revert", because there is nothing to commit or revert.
export function untouch(id) {
    if (!batch || !batch.boxes.delete(id)) return;
    if (!batch.boxes.size) { batch.bar?.remove(); batch.bar = null; }
    else showBar();   // refresh the pending count
}

export function commit() { resolve(true); }
export function revert() { resolve(false); }
export function commitIfDirty() { if (batch) resolve(true); }
export function revertIfDirty() { if (batch) resolve(false); }

// Tear the batch down without committing OR restoring. For when the thing being edited no longer
// exists: `model.load()` (undo/redo, loading a game) swaps out every config object, so the batch's
// drafts and snapshot point at objects nobody references any more. Committing them would write a
// dead value; restoring them would resurrect one. Drop the batch and let the reloaded model stand.
export function abandon() {
    if (!batch) return;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    batch.bar?.remove();
    batch = null;
}

// Re-mount the bar after the host element's children were replaced underneath us (a node card's
// `fillNode` does `div.replaceChildren(...)`, which throws the bar away). No-op when the bar is
// still attached — the `_LIVE_SECTIONS` node types only swap an inner section, so it survives.
export function reattach(key) {
    if (!batch || batch.key !== key || !batch.bar) return;
    const host = hostOf(batch.spec);
    if (host && batch.bar.parentNode !== host) host.appendChild(batch.bar);
}

const hostOf = (spec) => (typeof spec.host === "function" ? spec.host() : spec.host);

function resolve(apply) {
    const b = batch;
    if (!b) return;
    // Tear the batch down BEFORE running the spec: commit()/restore() both rebuild the surface's
    // boxes from the model, and applyPending must no longer re-stamp the drafts over them.
    batch = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    b.bar?.remove();
    if (apply) b.spec.commit(b.boxes); else b.spec.restore();
}

function onKey(ev) {
    if (ev.key !== "Enter" && ev.key !== "Escape") return;
    if (!batch?.boxes.size) return;   // batch open but nothing touched yet -> those keys still mean what they usually mean
    // stop the graph's own handlers (Escape disarms draw tools, Enter may submit an input) — while
    // an edit is pending those keys mean exactly one thing.
    ev.preventDefault(); ev.stopPropagation();
    // Blur FIRST, while the batch is still open. A focused <input> fires its `change` on blur, and
    // something is going to blur it either way (the commit's loader sets `inert`, which force-blurs
    // per spec). Let that `change` land in THIS batch: resolve first and it would instead open a
    // fresh one, popping the ✓/✕ bar straight back up on the node you just committed.
    document.activeElement?.blur?.();
    resolve(ev.key === "Enter");
}

// A pointerdown outside the surface commits — but NOT synchronously. A focused <input> only fires
// its `change` when it blurs, and the blur happens in the mousedown DEFAULT ACTION, i.e. after
// every pointerdown listener has run. Committing here and now would close the batch a beat before
// the edit it is supposed to carry even reaches the model; the late `change` would then open a
// FRESH batch and leave the ✓/✕ bar stranded on a node the user thought they had left.
//
// Yielding to a macrotask lets that blur -> change land in the still-open batch first. Re-check the
// key: if the click opened a batch on another surface meanwhile, `begin` already committed this one.
function onDown(ev) {
    if (!batch?.spec.isOutside(ev.target)) return;
    const key = batch.key;
    setTimeout(() => { if (batch?.key === key) commit(); }, 0);
}

// The floating icon-only bar — mounted on the first touch(), so it exists ONLY while there is
// something to commit or cancel. The ✓ carries the pending count once more than one draft is dirty.
function showBar() {
    if (!batch) return;
    const n = batch.boxes.size;
    if (!batch.bar) {
        const host = hostOf(batch.spec);
        if (!host) return;
        batch.bar = h("div", { class: batch.spec.barClass || "rect-txn" },
            iconBtn(CHECK, { cls: "rect-txn-ok", title: "apply (Enter)", onClick: commit }),
            iconBtn(XMARK, { cls: "rect-txn-no", title: "discard (Escape)", onClick: revert }));
        host.appendChild(batch.bar);
    }
    const ok = batch.bar.querySelector(".rect-txn-ok");
    const cnt = ok.querySelector(".rect-txn-n");
    if (n > 1 && !cnt) ok.appendChild(h("span", { class: "rect-txn-n" }, String(n)));
    else if (cnt) cnt.textContent = n > 1 ? String(n) : "";
}
