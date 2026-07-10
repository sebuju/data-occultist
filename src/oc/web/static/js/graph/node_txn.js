// A node's CONFIG edit as a deferred transaction, on the shared edit_txn primitive.
//
// The problem this solves: every config handler used to call `autosave(winId)` on each
// `input`/`change`. autosave -> scheduleWindowRead -> (700ms) -> refreshPreview/refreshDetect/
// runItemRead -> setNodeBusy -> `body.inert = true`. Per the HTML spec `inert` FORCE-BLURS the
// focused element, so the node you are typing in kicks your caret out and greys itself on every
// keystroke. Typing a detector's text or a rule's value was close to unusable.
//
// So: the handler still mutates the model LIVE (the in-node UI — rule traces, colour chips,
// derived column lists — must stay coherent as you type), but the EXPENSIVE aftermath (persist +
// OCR read + history entry) is stashed and run exactly once, on commit. The clean state is a
// snapshot taken before the first mutation; Escape / ✕ puts it back.
//
// Commit = ✓ / Enter / a pointerdown outside the card. Revert = ✕ / Escape (and Ctrl+Z, which
// history.js routes to edit_txn.revert first).
//
// A node joins by handing in a `spec`:
//   targets()  the live config objects this node's edits mutate (cloned as the clean state).
//              Several node types span TWO — a region/itemfield/readout edits both its own `ref`
//              and the window-level FieldDef that carries its rule pipeline. A target is either a
//              plain object (snapshot/restore the WHOLE object) or a `{ obj, keys }` slice, for
//              when only a few of a big object's own properties are editable here — the window
//              node edits `static_grid` on the window, and cloning the whole window would replace
//              its `items`/`regions` arrays and dangle every child node's `ref` into them.
//   rebuild()  put the card's DOM back in sync after a revert wrote the clean values back.
import * as txn from "./edit_txn.js";
import { nodeEls } from "./state.js";

const KEY = (id) => `node:${id}`;

let cur = null;   // { nodeId, spec, targets, snap, after: Map<tag, fn> }

// A pointerdown outside the card normally means "you left" -> commit. Some flows legitimately
// click elsewhere while an edit is still pending: the eyedropper arms on the node, but you
// complete the sample by clicking the WINDOW'S IMAGE CANVAS, which lives on a different node.
// Those flows register a guard here (imaging.js does, for `_pickTarget`) so the outside-click
// doesn't silently commit under them. Registration, not an import of imaging.js — this module
// sits below it and must stay free of the main.js <-> imaging.js cycle.
//
// A guard is handed the pointerdown TARGET and must claim only the click it actually consumes —
// a guard that merely answers "is a pick armed?" would swallow every outside-click for as long as
// the user leaves the eyedropper armed, and the edit could never be committed by clicking away.
const guards = [];
export function addOutsideGuard(fn) { guards.push(fn); }
const guarded = (target) => guards.some((g) => g(target));

// Run once after a commit's stashed aftermath, with the committing node's id. The aftermath calls
// autosave(), whose profile save (400ms) and window read (700ms) are DEBOUNCED to coalesce a burst
// of edits — but an explicit commit IS the end of the burst, so those waits are pure latency the
// user feels as "nothing happened yet". The hook flushes both immediately AND puts the node's
// loader up on the spot, so the commit is acknowledged in the same frame it is made rather than
// whenever some downstream fetch happens to spin a node (a window with no open image canvas runs
// no detect at all, and used to show nothing). Registered by main.js (which owns persist, the read
// clock and setNodeBusy), not imported here — same reason as the guards above.
// ONE slot, not a list: the hook WRAPS the aftermath (it must run it), so two hooks would run the
// save + read twice.
let commitHook = null;
export function setCommitHook(fn) { commitHook = fn; }

// `armed`: this node has an open transaction (snapshot taken). True from the first keystroke.
// `dirty`: its config actually DIFFERS from the snapshot right now.
export function armed(nodeId = null) { return nodeId ? txn.armed(KEY(nodeId)) : !!cur; }
export function dirty(nodeId = null) { return txn.dirty(nodeId ? KEY(nodeId) : null); }

// Structural equality against the snapshot. "Dirty" must mean the VALUE changed, not that a
// handler ran: typing a character and deleting it again leaves the config identical, and the node
// should go back to showing no ✓/✕ bar and commit nothing.
function equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
}

// A target's CURRENT value, shaped like its snapshot (a `{obj, keys}` slice compares only its keys).
const valueOf = (t) => (t.keys ? Object.fromEntries(t.keys.map((k) => [k, t.obj[k]])) : t);

const changed = (st) => st.targets.some((t, i) => !equal(valueOf(t), st.snap[i]));

// Clone a target's clean state. A `{ obj, keys }` slice clones only those own properties; a plain
// object clones wholesale.
const snapOf = (t) =>
    t.keys ? Object.fromEntries(t.keys.map((k) => [k, structuredClone(t.obj[k])]))
           : structuredClone(t);

// Put the clean state back IN PLACE, so every other reference to the live object (model indexes,
// node descriptors, the overlay) keeps pointing at the restored value rather than a stale husk.
// A slice assigns its keys back; a whole object is emptied first, so keys ADDED during the edit
// (a rule's `sep`, a colour list) don't survive the revert.
function putBack(t, snap) {
    if (!t || !snap) return;
    if (t.keys) { Object.assign(t.obj, snap); return; }
    for (const k of Object.keys(t)) delete t[k];
    Object.assign(t, snap);
}

// Open the batch for this node and snapshot its clean state — call BEFORE the handler mutates.
// A batch already open on this node is left alone (the snapshot must stay the pre-edit one); a
// batch open on any OTHER surface is committed first by txn.begin, so its aftermath lands.
export function arm(nodeId, makeSpec) {
    if (txn.armed(KEY(nodeId))) return;   // armed, not dirty: keep the ORIGINAL snapshot
    const st = { nodeId, spec: null, targets: [], snap: [], after: new Map() };
    txn.begin(KEY(nodeId), () => ({
        host: () => nodeEls.get(nodeId),          // thunk: fillNode replaces the card's children
        barClass: "node-txn",
        isOutside: (t) => !guarded(t) && !nodeEls.get(nodeId)?.contains(t),
        commit: () => {
            const fns = [...st.after.values()];
            const dirty = changed(st);            // compare BEFORE clearing `cur`
            if (cur === st) cur = null;           // clear BEFORE running: an aftermath may re-enter
            // No net change => no save, no OCR read, no history entry, no loader. A handler having
            // run is not a change; only a differing value is.
            if (!fns.length || !dirty) return;
            const runAftermath = () => { for (const f of fns) f(); };
            // The hook wraps the aftermath so it can light the loader BEFORE the work is queued,
            // then flush the debounces and drop the loader when the work settles.
            if (commitHook) commitHook(nodeId, runAftermath); else runAftermath();
        },
        restore: () => {
            const dirty = changed(st);
            if (cur === st) cur = null;
            if (!dirty) return;                   // nothing to put back; don't churn the node's DOM
            st.targets.forEach((t, i) => putBack(t, st.snap[i]));
            st.spec.rebuild();
        },
    }));
    // built after begin(), which has now committed any previous batch — so the snapshot below is
    // taken against a settled model, never one mid-teardown.
    st.spec = makeSpec();
    st.targets = st.spec.targets().filter((t) => t && (!t.keys || t.obj));
    st.snap = st.targets.map(snapOf);
    cur = st;
}

// Stash this node's expensive aftermath under `tag`; the last one per tag wins, so N keystrokes
// collapse to ONE save + ONE read. Not armed for this node (an immediate, non-OCR handler) =>
// run it now, unchanged.
//
// The ✓/✕ bar tracks the VALUE, not the keystroke: it appears the moment the config differs from
// the snapshot and disappears again the moment it matches (type a character, delete it — there is
// nothing to apply or discard, so nothing is offered). One draft id per node, since a node commits
// or reverts as a whole.
const DRAFT = "config";
export function defer(nodeId, tag, fn) {
    if (!cur || cur.nodeId !== nodeId) { fn(); return; }
    cur.after.set(tag, fn);
    if (changed(cur)) txn.touch(DRAFT, { nodeId }); else txn.untouch(DRAFT);
}

// `fillNode` does `div.replaceChildren(...)`, throwing the bar away. Call after any rebuild.
export function reattach(nodeId) { txn.reattach(KEY(nodeId)); }

// Land a pending edit before an action that a snapshot can't safely undo (a rename, a node
// add/delete, a `render()`), mirroring what the box surfaces already do before drawing a new box.
export function commitIfDirty() { txn.commitIfDirty(); }

// The model was replaced wholesale (model.load: undo/redo, loading a game). Every target and every
// snapshot now points at an orphaned object, so the batch can neither commit nor revert into the
// live model — and left armed, it would compare fresh edits against a dead baseline and decide
// nothing ever changed. Drop it; the next edit arms against the reloaded objects.
export function abandon() { cur = null; txn.abandon(); }
