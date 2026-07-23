// One VTable per satellite host, shared by the trigger-history and readout-history satellites
// (rule 7): both mount a live, non-persisted records grid into a `.hist-host` scrollhost and want
// the same reuse/recreate lifecycle. Keyed by the satellite node id; recreated if the host element
// was rebuilt by a node re-render (host identity changed).
import { VTable } from "../vtable.js";

const _vts = new Map();   // satellite id -> VTable

export function satVT(key, host) {
    let vt = _vts.get(key);
    if (vt && vt.host === host) return vt;
    if (vt) vt.destroy();
    host.replaceChildren();
    vt = new VTable(host, key);
    _vts.set(key, vt);
    return vt;
}

// Every history satellite's rows arrive newest-first by "when" — the one shared convention, so
// it's defined once here instead of copied into each caller (rule 7).
const HIST_FIXED_SORT = { col: "when", dir: -1 };

// satVT + setData with the standard history fixedSort baked in — the call every history
// satellite should use instead of the bare setData (which would need the caret/no-click-sort
// convention copied into its own opts).
export function satVTData(key, host, COLS, rows, opts = {}) {
    return satVT(key, host).setData(COLS, rows, { fixedSort: HIST_FIXED_SORT, ...opts });
}
