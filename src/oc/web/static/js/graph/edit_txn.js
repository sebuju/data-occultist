// THE one rect-edit transaction. Moving, resizing, nudging or typing a box no longer writes the
// model — it opens a BATCH against one drawing surface and only paints. Enter (or the ✓ button)
// commits the whole batch, Escape (or ✕) reverts it, a pointerdown outside the owning node commits
// it. So a burst of edits costs ONE model write pass, ONE autosave, ONE read settle (the 700ms
// scheduleWindowRead clock) and ONE undo step — instead of one of each per pixel moved.
//
// One batch at a time, keyed by the overlay-registry key (`win:<id>` / `item:<w>:<i>` — which is
// also the node id). Beginning a batch on a DIFFERENT surface commits the previous one first, so
// an edit is never silently abandoned.
//
// The model is the CLEAN state: nothing is written until commit, so reverting is just "rebuild the
// boxes from the model" (spec.restore). The drafts live here, and `applyPending` re-stamps them
// onto any box list rebuilt from the model meanwhile — an async OCR read landing mid-edit must not
// snap a dirty box back (the same hazard `Overlay._pendingBoxes` guards one level down).
//
// A surface joins by handing in a `spec`:
//   host        element the floating ✓/✕ bar mounts into (must be a positioning context)
//   isOutside(t) does this pointerdown target mean "you left"?  -> commit
//   commit(boxes) write every draft, then run the surface's aftermath ONCE
//   restore()    put the surface back to the clean state
import { h, iconBtn, CHECK, XMARK } from "../dom.js";

let batch = null;   // { key, spec, boxes: Map<boxId, draft>, bar }

// A draft is a plain geometry copy (never a live overlay box reference — the overlay rebuilds its
// box objects from the model on every refresh, so a reference would dangle). `role`/`id` ride along
// because the model writers (persistWinBox / persistItem) dispatch on them.
const draftOf = (id, box) => ({ id, role: box.role, x: box.x, y: box.y, w: box.w, h: box.h });

export function dirty(key = null) { return !!batch && (!key || batch.key === key); }
export function pendingFor(key) { return batch && batch.key === key ? batch.boxes : null; }

// Re-stamp the batch's drafts onto a freshly model-built box list. Called by refreshImageBoxes /
// refreshItemBoxes right before setBoxes, so ANY rebuild (an OCR read landing, a live-mode
// refresh, an undo restore) preserves the uncommitted geometry.
export function applyPending(key, boxes) {
    const p = pendingFor(key);
    if (!p) return boxes;
    for (const b of boxes) {
        const d = p.get(b.id);
        if (d) { b.x = d.x; b.y = d.y; b.w = d.w; b.h = d.h; }
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

// Record a box's current geometry as part of the open batch and reveal the ✓/✕ bar.
export function touch(id, box) {
    if (!batch) return;
    batch.boxes.set(id, draftOf(id, box));
    showBar();
}

export function commit() { resolve(true); }
export function revert() { resolve(false); }
export function commitIfDirty() { if (batch) resolve(true); }
export function revertIfDirty() { if (batch) resolve(false); }

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
    // stop the graph's own handlers (Escape disarms draw tools, Enter may submit an input) — while
    // a rect edit is pending those keys mean exactly one thing.
    ev.preventDefault(); ev.stopPropagation();
    resolve(ev.key === "Enter");
}

function onDown(ev) { if (batch?.spec.isOutside(ev.target)) commitIfDirty(); }

// The floating icon-only bar — mounted on the first touch(), so it exists ONLY while there is
// something to commit or cancel. The ✓ carries the pending count once more than one box is dirty.
function showBar() {
    if (!batch) return;
    const n = batch.boxes.size;
    if (!batch.bar) {
        batch.bar = h("div", { class: "rect-txn" },
            iconBtn(CHECK, { cls: "rect-txn-ok", title: "apply (Enter)", onClick: commit }),
            iconBtn(XMARK, { cls: "rect-txn-no", title: "discard (Escape)", onClick: revert }));
        batch.spec.host.appendChild(batch.bar);
    }
    const ok = batch.bar.querySelector(".rect-txn-ok");
    const cnt = ok.querySelector(".rect-txn-n");
    if (n > 1 && !cnt) ok.appendChild(h("span", { class: "rect-txn-n" }, String(n)));
    else if (cnt) cnt.textContent = n > 1 ? String(n) : "";
}
