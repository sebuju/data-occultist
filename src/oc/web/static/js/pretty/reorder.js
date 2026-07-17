// ONE drag-to-reorder primitive, shared by every reorderable list in the pretty UI (table
// column headers AND the inspector's column rows — rule 7). Mouse-based to match the
// dragresize convention (no HTML5 DnD). The caller passes the item + handle selectors, the
// axis, and `onReorder(from, insertBefore)` which mutates the model; the visible order then
// comes back through the caller's own re-render. This primitive only paints an insertion
// marker while dragging — it never reorders the real DOM, so nothing desyncs.

const THRESH = 4;

// Move arr[from] so it lands just before ORIGINAL index `insertBefore` (0..len). Mutates+returns.
export function arrayMove(arr, from, insertBefore) {
    if (from < 0 || from >= arr.length) return arr;
    const [it] = arr.splice(from, 1);
    arr.splice(from < insertBefore ? insertBefore - 1 : insertBefore, 0, it);
    return arr;
}

// Rewrite a sparse column-config array into an explicit list matching `orderedKeys`, keeping
// each key's existing {enabled,label,width}. Config entries whose key isn't in orderedKeys
// (e.g. a column hidden or absent from the current data) are appended so nothing is lost.
export function orderColumns(config, orderedKeys) {
    const byKey = new Map((config || []).map((c) => [c.key, c]));
    const next = orderedKeys.map((k) => byKey.get(k) || { key: k, enabled: true });
    for (const c of (config || [])) if (!orderedKeys.includes(c.key)) next.push(c);
    return next;
}

// Upsert a per-column override into a sparse column-config array: patch the entry for `key`
// (creating an enabled one if it's absent). Shared by the inspector's show/label/width
// controls AND the table header's drag-resize (rule 7). Mutates `config`, returns it.
export function setColumnProp(config, key, patch) {
    let e = config.find((c) => c.key === key);
    if (!e) { e = { key, enabled: true }; config.push(e); }
    Object.assign(e, patch);
    return config;
}

export function makeReorderable(container, { itemSel, handleSel, axis = "y", onReorder }) {
    container.classList.add(axis === "x" ? "pw-ro-x" : axis === "wrap" ? "pw-ro-wrap" : "pw-ro-y");
    container.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        const handle = handleSel ? ev.target.closest(handleSel) : ev.target;
        if (!handle || !container.contains(handle)) return;
        const item = handle.closest(itemSel);
        if (!item || item.parentElement !== container) return;
        ev.preventDefault(); ev.stopPropagation();   // don't also start the widget frame drag

        const list = [...container.children].filter((c) => c.matches(itemSel));
        const from = list.indexOf(item);
        const sx = ev.clientX, sy = ev.clientY;
        let started = false, target = from;

        const clear = () => {
            for (const c of list) c.classList.remove("pw-ro-before", "pw-ro-after", "pw-ro-drag");
            if (container._roCaret) container._roCaret.hidden = true;
        };
        // wrap: an absolute caret bar drawn at the gap (unambiguous across wrapped rows).
        // x/y: the edge box-shadow on the neighbour cell (unchanged).
        const caretEl = () => {
            if (!container._roCaret) {
                container._roCaret = document.createElement("div");
                container._roCaret.className = "pw-ro-caret";
                container.appendChild(container._roCaret);
            }
            return container._roCaret;
        };
        const mark = (idx) => {
            clear();
            item.classList.add("pw-ro-drag");
            if (idx >= list.length) list[list.length - 1].classList.add("pw-ro-after");
            else list[idx].classList.add("pw-ro-before");
        };
        // wrap: draw the caret at a specific cell edge (left before the cell, right after it) so
        // it lands right next to the cursor even at a row boundary. `side` 0 = left edge, 1 = right.
        const markCaret = (k, side) => {
            clear();
            item.classList.add("pw-ro-drag");
            const cr = container.getBoundingClientRect();
            const r = list[k].getBoundingClientRect();
            const caret = caretEl();
            caret.style.left = `${(side ? r.right : r.left) - cr.left + container.scrollLeft - 1}px`;
            caret.style.top = `${r.top - cr.top + container.scrollTop}px`;
            caret.style.height = `${r.height}px`;
            caret.hidden = false;
        };
        // x/y: first item whose axis-midpoint the cursor is before (else the end).
        const targetFor = (x, y) => {
            for (let i = 0; i < list.length; i++) {
                const r = list[i].getBoundingClientRect();
                const mid = axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
                if ((axis === "x" ? x : y) < mid) return i;
            }
            return list.length;
        };
        // wrap: pick the cell whose CENTRE is nearest the cursor in 2-D, then insert before it
        // (cursor left of its centre) or after it (cursor right). Robust across wrapped rows —
        // returns the target index and paints the caret on the chosen edge of that cell.
        const wrapPick = (x, y) => {
            let k = 0, bestD = Infinity;
            for (let i = 0; i < list.length; i++) {
                const r = list[i].getBoundingClientRect();
                const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                const d = (x - cx) ** 2 + (y - cy) ** 2;
                if (d < bestD) { bestD = d; k = i; }
            }
            const r = list[k].getBoundingClientRect();
            const side = x < r.left + r.width / 2 ? 0 : 1;
            markCaret(k, side);
            return k + side;
        };
        const mv = (e) => {
            if (!started && Math.abs(e.clientX - sx) < THRESH && Math.abs(e.clientY - sy) < THRESH) return;
            started = true;
            if (axis === "wrap") { target = wrapPick(e.clientX, e.clientY); }
            else { target = targetFor(e.clientX, e.clientY); mark(target); }
        };
        const up = () => {
            document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
            clear();
            if (started && target !== from && target !== from + 1) onReorder(from, target);   // before-self / after-self = no-op
        };
        document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
}
