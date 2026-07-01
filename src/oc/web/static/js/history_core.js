// View-agnostic undo/redo engine — a linear stack of full-state SNAPSHOTS with per-entry
// labels, arbitrary jump-to-index, and a subscribe hook so a history PANEL can reconcile.
//
// The node graph and the Pretty studio each own ONE instance (their histories are independent):
// the caller supplies how to serialize its editable state (`snapshot`), how to load a snapshot
// back + re-render (`restore`), and an optional diff labeller. Everything else — the stack, the
// index, truncate-on-branch, the 200 cap, the re-entrancy guard — lives here once (CLAUDE.md
// rule 7: one primitive, two callers).
//
// Restoring is NON-DESTRUCTIVE: jumping to an older entry never drops the newer ones (they stay
// as redoable future); only a fresh EDIT made while parked in the past truncates the future.

export function createHistory({ snapshot, restore, label = null, cap = 200 }) {
    let stack = [];        // [{ snap: string, label: string, ts: number }]
    let index = -1;        // the entry we're currently parked on
    let restoring = false; // guard: a restore() re-renders + re-persists, which must not re-record
    const subs = new Set();
    const emit = () => { for (const f of subs) f(); };

    // Seed a fresh baseline (a game/doc just loaded). One entry, index 0 — nothing to undo to.
    function reset(lbl = "loaded") {
        stack = [{ snap: snapshot(), label: lbl, kind: "base", ts: Date.now() }];
        index = 0;
        emit();
    }

    // Record the current state as a new entry (called after every edit). No-op while restoring,
    // and skips an identical consecutive snapshot (a save that changed nothing).
    function push() {
        if (restoring) return;
        const snap = snapshot();
        if (index >= 0 && stack[index].snap === snap) return;
        const r = label ? label(index >= 0 ? stack[index].snap : null, snap) : { text: "edit", kind: "change" };
        stack = stack.slice(0, index + 1);      // parked in the past + edited -> drop the future
        stack.push({ snap, label: r.text, kind: r.kind, ts: Date.now() });
        if (stack.length > cap) stack.shift();
        index = stack.length - 1;
        emit();
    }

    // restore may be async (a node-view restore reopens image canvases) — hold the `restoring`
    // guard across the whole thing so nothing it triggers (re-render, re-persist, panel reopen)
    // records a phantom entry. Callers fire-and-forget; the panel re-renders on the trailing emit.
    async function applyAt(i) {
        index = i;
        restoring = true;
        try { await restore(stack[index].snap); } finally { restoring = false; }
        emit();
    }

    // undo/redo/jumpTo return the restore promise (a node-view restore is async) so callers can
    // await settle; the keybind/panel fire-and-forget.
    function undo() { if (index > 0) return applyAt(index - 1); }
    function redo() { if (index < stack.length - 1) return applyAt(index + 1); }
    // Travel to an arbitrary point (clicking a history row). Non-destructive.
    function jumpTo(i) { if (i >= 0 && i < stack.length && i !== index) return applyAt(i); }

    function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

    return {
        reset, push, undo, redo, jumpTo, subscribe,
        entries: () => stack,
        index: () => index,
        canUndo: () => index > 0,
        canRedo: () => index < stack.length - 1,
        get restoring() { return restoring; },
    };
}
