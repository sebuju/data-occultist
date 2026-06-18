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

export function makeReorderable(container, { itemSel, handleSel, axis = "y", onReorder }) {
  container.classList.add(axis === "x" ? "pw-ro-x" : "pw-ro-y");
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

    const clear = () => { for (const c of list) c.classList.remove("pw-ro-before", "pw-ro-after", "pw-ro-drag"); };
    const mark = (idx) => {
      clear();
      item.classList.add("pw-ro-drag");
      if (idx >= list.length) list[list.length - 1].classList.add("pw-ro-after");
      else list[idx].classList.add("pw-ro-before");
    };
    const targetFor = (x, y) => {
      for (let i = 0; i < list.length; i++) {
        const r = list[i].getBoundingClientRect();
        const mid = axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
        if ((axis === "x" ? x : y) < mid) return i;
      }
      return list.length;
    };
    const mv = (e) => {
      if (!started && Math.abs(e.clientX - sx) < THRESH && Math.abs(e.clientY - sy) < THRESH) return;
      started = true; target = targetFor(e.clientX, e.clientY); mark(target);
    };
    const up = () => {
      document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
      clear();
      if (started && target !== from && target !== from + 1) onReorder(from, target);   // before-self / after-self = no-op
    };
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  });
}
