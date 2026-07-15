// Game load/switch/create lifecycle, and the layout-persistence funnel that rides with it
// (collect/hydrate node-spatial layout + per-device viewport, table-widths store, the
// initPersist bootstrap incl. the save-conflict modal). Split out of main.js; render/autosave/
// refreshLive/finishBoot-adjacent main-owned helpers stay in main and are imported back.
import * as api from "../api.js";
import * as conn from "../conn.js";
import * as hub from "../hub.js";
import * as dsevents from "./dsevents.js";
import * as groups from "./groups.js";
import * as theme from "./theme.js";
import { refreshTheme } from "./panels/theme.js";
import * as prettyOverrides from "../pretty/overrides.js";
import { h } from "../dom.js";
import { log, timed } from "../log.js";
import {
    $, setStatus, model, pos, nodeEls, collapsed, view, selected, nodeSizes, openImages,
    imageCanvases, boot, nextFrame, flushBoot,
} from "./state.js";
import { drawEdges } from "./routing.js";
import { applyView, MIN_ZOOM } from "./camera.js";
import { floatWins } from "./floatwin.js";
import { clearGuides } from "./guides.js";
import { initPersist, persist } from "./persist.js";
import { setTableStore } from "./table.js";
import { setVTableStore } from "../vtable.js";
import { openConflictModal } from "./conflictmodal.js";
import { openLogStream } from "../logstream.js";
import { initFlow } from "./flow.js";
import { mountCanvasLayers } from "./edgecanvas.js";
import * as nodeTxn from "./node_txn.js";
import { closeImage, openImage, openAtlasImage, refreshCollisions, scheduleWindowRead } from "./imaging.js";
import { groupOrphanChildren } from "./item_wire.js";
import { seedSubsetSig, refreshChangedSubsetNodes } from "./subset_wire.js";
import { batchesState } from "./panels/datanodes.js";
import { syncLiveFromServer } from "./panels/livewin.js";
import { pushHistory, resetHistory } from "./history.js";
import { syncPrettyGame, refreshDirtyUI } from "./pretty_switch.js";
import { blockOverlay, bootSettle } from "./graph_boot.js";
import { render, autosave, refreshLive } from "./main.js";

// One-shot boot prefetch: every dataset detail + subset view fetched in a SINGLE /details request
// before the nodes are built, so each node renders from this map instead of firing its own fetch
// (collapses the per-node fan-out — and the same source dataset fetched once per consumer — into
// one request). Null except during a game load; the live path fetches per-node as before.
export let _bootDetails = null;
// Open/close reconciliation channel for window image canvases (set by hydrateNodeLayout from the
// restored layout; consumed + cleared by loadGame's reopen pass and by reconcileOpenImages).
let pendingOpenImages = [];

// Live node-layout state (positions/sizes/collapse/open-images) ↔ the profile. persist
// calls collectLayout() before every profile PUT, and loadGame calls hydrateLayout()
// after a load. Table column state is folded in by table.js via the injected store.
export function collectLayout() {
    const L = (model.profile.layout = model.profile.layout || {});
    const nodes = {};
    for (const [id, p] of pos) {
        if (!nodeEls.has(id)) continue;   // orphan coord (deleted/renamed node) — don't re-persist it
        const n = { x: p.x, y: p.y };
        const sz = nodeSizes.get(id);
        if (sz) {
            n.w = sz.w; n.h = sz.h;
            if (sz.custW !== undefined) n.custW = sz.custW;
            if (sz.custH !== undefined) n.custH = sz.custH;
            if (sz.softW !== undefined) n.softW = sz.softW;
            if (sz.softH !== undefined) n.softH = sz.softH;
        }
        if (collapsed.has(id)) n.collapsed = true;
        nodes[id] = n;
    }
    L.nodes = nodes;
    L.open_images = [...openImages];
    L.satellites = model.satelliteIds();       // which preview / vt-table followers are shown (opt-in)
    L.tables = L.tables || {};
    L.groups = groups.collect();
    L.super_groups = groups.collectSuper();   // groups-of-groups travel with the profile too
    L.sub_groups = groups.collectSub();        // groups-within-a-group travel with the profile too
    L.schemes = groups.collectSchemes();       // user-added colour schemes travel with the profile too
    const th = theme.collect();
    if (th) L.theme = th; else delete L.theme; // css-var overrides travel with the profile too (theme panel)
    // floating panels are NOT persisted (session-only) — drop any stale saved state so it's
    // cleaned from the profile on the next write.
    delete L.float_windows;
}
// Node-spatial layout ONLY (positions/sizes/collapse, groups, satellites, open-image LIST).
// SHARED by the initial load and by an undo/redo restore (CLAUDE.md rule 7) — everything here is
// in-history state the user asked to keep. Deliberately does NOT reset the floating panels (that's
// session-only, load path only): an undo must never yank the history panel itself shut.
export function hydrateNodeLayout() {
    pos.clear(); nodeSizes.clear(); collapsed.clear();
    const L = model.profile.layout || {};
    for (const [id, n] of Object.entries(L.nodes || {})) {
        if (Number.isFinite(n.x) && Number.isFinite(n.y)) pos.set(id, { x: n.x, y: n.y });
        // >0, not just finite: a legacy 0,0 (from the old zero-box settle bug) means "no saved
        // size" — storing it would block the real size from ever applying (0 is falsy downstream).
        if (n.w > 0 && n.h > 0) nodeSizes.set(id, { w: n.w, h: n.h, custW: n.custW, custH: n.custH, softW: n.softW, softH: n.softH });
        if (n.collapsed) collapsed.add(id);
    }
    pendingOpenImages = [...(L.open_images || [])];
    model.setSatellites(L.satellites);     // restore which preview / vt-table followers are shown
    groups.hydrateSchemes(L.schemes);      // user-added colour schemes (before any popover opens)
    groups.hydrate(L.groups);
    groups.hydrateSuper(L.super_groups);   // after groups (super groups reference group ids)
    groups.hydrateSub(L.sub_groups);       // after groups (sub groups reference a parent group + its nodes)
    theme.hydrate(L.theme);                // css-var overrides (after schemes, before the theme panel next shows)
    refreshTheme();                        // resync the theme panel's controls if it's already built
}
function hydrateLayout() {
    hydrateNodeLayout();
    // floating panels are session-only: never restored from the profile -> always start at their
    // defaults (all hidden). hydrate(undefined) resets each to its _default state. LOAD path only.
    for (const [, w] of floatWins()) w.hydrate(undefined);
}

// Open/close window image canvases to match `pendingOpenImages` (set by hydrateNodeLayout from the
// restored layout). Used by an undo/redo restore so "which window images are open" travels with
// history. Must run AFTER render() so openImage can resolve each window node's live host.
export async function reconcileOpenImages() {
    const want = new Set(pendingOpenImages);
    pendingOpenImages = [];
    for (const winId of [...openImages]) if (!want.has(winId)) closeImage(winId);   // close the ones no longer wanted
    await Promise.all([...want].map((winId) =>
        (!openImages.has(winId) && model.window(winId) ? openImage(winId) : null)));
}

// Per-device viewport (canvas zoom/pan) ↔ the gitignored sidecar. Floating panels are not
// persisted at all now (session-only, all start hidden) — see hydrateLayout/collectLayout.
function collectLocal() {
    return { view: { panX: view.panX, panY: view.panY, zoom: view.zoom } };
}
function applyLocal(local) {
    if (local?.view && Number.isFinite(local.view.zoom)) {
        Object.assign(view, local.view);
        view.zoom = Math.max(MIN_ZOOM, view.zoom);   // restored manual zoom: lower bound only, no font cap
        applyView();
    }
}

// table.js persists its per-table widths/sort into the profile's layout (so they travel
// with the game), and a write schedules a layout save.
const _tableStore = {
    load: (id) => (model.profile.layout?.tables?.[id]) || {},
    save: (id, st) => {
        const L = (model.profile.layout = model.profile.layout || {});
        (L.tables = L.tables || {})[id] = st;
        persist.layout();
    },
};

// One-time bootstrap: wires the table-widths store, the persist funnel (incl. the save-conflict
// modal), and the game-select dropdown's change handler. Call once at startup.
export function initGameLifecycle() {
    setTableStore(_tableStore);
    setVTableStore(_tableStore);   // VTable persists its column widths the same way
    initPersist({
        model,
        collectLayout,
        collectLocal,
        // a pure layout move (drag/resize/collapse/group/open-image/satellite/table width) is an
        // undoable edit now, so the layout funnel records history too (config edits push via autosave).
        recordHistory: () => pushHistory(),
        onContentSaved: (err) => {
            if (err) { setStatus(err); return; }
            setStatus("saved ✓");
            refreshChangedSubsetNodes();   // backend now knows new/edited subsets -> fill ONLY those (no more 404)
        },
        // A save lost the race against a structural change made elsewhere (another tab, an
        // external edit) — show the conflict modal instead of silently clobbering it.
        onConflict: (payload, wasContent) => {
            const name = model.profile.name;
            openConflictModal(name, payload, {
                onOverwrite: () => persist.overwrite(wasContent),
                // Discard this tab's pending edit and reload the server's copy. loadGame's
                // `discard` flag skips persist.flush() (which would just resubmit the stale
                // edit and re-trigger this same conflict) in favour of dropping it outright.
                onLoadServer: () => loadGame(name, { discard: true }),
            });
        },
    });
    $("gameSelect").addEventListener("change", async (e) => {
        await loadGame(e.target.value);
        await bootSettle();   // let the reopened images' cached reads drain, then re-OCR fresh on edits
        finishBoot();
    });
}

export async function refreshGames(select) {
    const names = await api.listProfiles();
    $("gameSelect").replaceChildren(...names.map((n) => h("option", n)));
    if (select && names.includes(select)) $("gameSelect").value = select;
}

// Node view live-data refresh is PUSH-driven: the shared dataset-change bus (dsevents) calls
// scheduleRefreshLive on every write (live collection, sweeps, commits, edits, restores), so
// node tables update the instant a dataset's ledger changes — no per-beat /api/flow poll. The
// server coalesces ~1s/dataset and the client debounces the burst, so a heavy sweep refetches
// at most ~once/second. A slow interval (FLOW_FALLBACK_MS) is a safety net for missed events /
// reconnect gaps only, NOT the mechanism. (An earlier version polled /api/flow every hub beat;
// that ran even at idle and, with the old full-state read, was the page's heaviest request.)

export async function loadGame(name, { discard = false } = {}) {
    if (!name) return;
    boot.phase = true;   // reopened images read the server OCR cache (no engine touch) until the load settles
    document.body.classList.add("booting");   // freeze all CSS motion but the veil spinner while it covers the screen (overlays.css)
    // `discard` is the conflict modal's "load server" path: the model still holds an
    // unsaved edit that just lost a 409. persist.flush() would resubmit it and hit the
    // SAME conflict again (infinite loop) — drop it instead, unflushed, and let the
    // normal load below (model.load below replaces the profile wholesale) adopt the
    // server's copy.
    if (discard) persist.discardPending();
    else await persist.flush();   // commit any pending save before switching games
    const done = timed(`load game ${name}`);
    let opened;
    try {
        opened = await persist.open(name);
    } catch (e) {
        done(String(e.message || e), "err");
        if (!conn.isOnline()) return;   // server unreachable -> conn's offline overlay owns the screen
        // a real load failure (e.g. a 500 while the server is restarting): block with a card the
        // user can act on instead of leaving a half-loaded graph and a lone log line.
        blockOverlay({
            title: `Couldn't load ${name}`,
            lines: [{ text: String(e.message || e) },
                { text: "The server may be restarting. Retry the load, or reload the page.", muted: true }],
            actions: [
                { label: "retry", primary: true, run: () => loadGame(name) },
                { label: "reload page", run: () => location.reload() },
            ],
        });
        return;
    }
    const { profile, local, migrated } = opened;
    done();
    nodeTxn.abandon();   // a pending edit belongs to the OUTGOING profile's objects — drop it, don't carry it across
    model.load(profile);
    seedSubsetSig();        // baseline subset defs so an unrelated save recomputes NO subset (only new/edited ones diff)
    nodeEls.clear();
    $("gnodes").replaceChildren();
    for (const winId of [...imageCanvases.keys()]) closeImage(winId);
    batchesState.clear();   // batches render inline per node; drop stale selection state
    selected.clear();       // drop any multi-selection from the previous game
    clearGuides();          // wipe alignment guides drawn against the outgoing game's nodes
    hydrateLayout();        // restore node positions/sizes/collapse/open-images from the profile
    applyLocal(local);      // restore canvas zoom/pan + minimap from the per-device sidecar
    // Prefetch every node's data in ONE request before building the nodes, so each node renders
    // from `_bootDetails` instead of firing its own fetch (and a dataset feeding many views is
    // fetched once, not once per consumer). Best-effort: on failure nodes fall back to per-node fetch.
    try {
        // Bound the boot prefetch: a huge/slow dataset must not hold the whole boot. If it doesn't
        // land fast, give up the batch and let each node lazy-fetch its own data after render.
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 6000);
        try { _bootDetails = await api.flowDetails(name, model.datasets(), (model.profile.subsets || []).map((s) => s.id), ac.signal); }
        finally { clearTimeout(to); }
    } catch { _bootDetails = null; }
    log(`[diag] render start t=${performance.now().toFixed(1)} boot=${boot.phase}`, "dim");
    { const d = timed("render"); render(); d(); }   // diagnostic: which boot phase actually eats the wall-time
    log(`[diag] render end / overrides start t=${performance.now().toFixed(1)}`, "dim");
    { const d = timed("apply overrides"); await prettyOverrides.initOverrides(name); d(); }   // layer this game's transient pretty overrides onto the model
    log(`[diag] overrides end t=${performance.now().toFixed(1)}`, "dim");
    refreshDirtyUI();
    syncPrettyGame(name);
    // reopen saved images (canvas lives in node); awaited so boot can tell when the
    // initial image loads (and the detects they fire) have actually started. MUST run BEFORE
    // grouping orphans: grouping a NEW orphan child persists the layout, and collectLayout
    // writes open_images from the live `openImages` set — if the canvases aren't open yet that
    // set is empty and we'd save open_images:[], stranding every window's canvas on next load.
    {
        // Stagger the per-window canvas/overlay builds (each openImage's SYNCHRONOUS prefix)
        // across frames instead of firing all of them in one synchronous burst — that burst
        // was the main-thread freeze that made the concurrent overrides/bindings fetches look
        // slow (their continuations queued behind it). openImage is still CALLED immediately
        // each iteration (so its image load starts right away, concurrent with the others) —
        // only the wait between calls is deferred to the next paint.
        // Every window's image opens on boot (buildNode used to do this unconditionally per
        // window — see its `if (!boot.phase) openImage(...)` guard); iterate ALL windows here,
        // not just `pendingOpenImages` (that list is the undo/redo restore channel — see
        // reconcileOpenImages — and can legitimately lag a window added since the last save).
        const d = timed("open images");
        const opens = [openAtlasImage()];   // separate function/branch (fillNode's "atlas" case), same gate+stagger
        await nextFrame();
        for (const w of model.profile.windows) {
            opens.push(openImage(w.id));
            await nextFrame();
        }
        await Promise.all(opens);
        d();
    }
    pendingOpenImages = [];
    _bootDetails = null;   // node build (+ its queued refreshes) consumed it; live refreshes fetch fresh
    groupOrphanChildren("itemfield");   // pull each item's field nodes into the item's group (idempotent)
    groupOrphanChildren("itemtell");    // …and its tell nodes
    drawEdges();                        // reflect any new group membership in the routing
    resetHistory();   // fresh undo/redo baseline for this game
    if (migrated) persist.layout();   // lock in node layout imported from legacy localStorage
    refreshLive();
    syncLiveFromServer();   // adopt a server collector still running from before a page reload (toggle reflects it)
    openLogStream(name);   // mirror server activity (trigger watches/fires, API fetches) into the log bar
    dsevents.setGame(name);   // (re)point the shared dataset-change bus (drives node refresh + flow blobs)
    initFlow(name);   // (re)point the flow-blob stream at this game (clears any prior blobs)
    mountCanvasLayers();   // mount the edge/group canvas renderer once (idempotent)
    hub.kick();   // new game -> beat the hub so every panel re-reflects its state now
    setStatus(`loaded ${name}`);
}

// Boot is over: run the ONE deferred layout pass and fire the held-back fetches. Both boot-end
// sites (initial page load + game switch) call this so they never drift (rule 7). Edge routing AND
// group boxes are skipped all through boot (behind the veil) — this is where they get their single
// real pass, so the graph is correct the instant the veil drops.
export function finishBoot() {
    boot.phase = false;
    document.body.classList.remove("booting");   // veil is about to drop -> let CSS motion run again
    drawEdges();            // routing was frozen throughout boot (routing.js) -> the one real pass now
    groups.renderGroups();  // group boxes were skipped throughout boot -> hug members once now
    flushBoot();            // fire the summary/register/preview fetches deferred during boot
    refreshCollisions();    // the one real cross-window check, skipped per-image during boot (imaging.js)
    // every open overlay's ResizeObserver re-fit was skipped per-image during boot (overlay.js) ->
    // fit each once now, off the veil's critical path. Batched read-then-write (measureFit/applyFit,
    // not fit()): looping fit()'s interleaved read+write per overlay forces up to N layouts
    // (read dirties nothing, but the WRITE after each read dirties layout for the NEXT read) —
    // reading every overlay's width first, then writing every scale, costs one forced layout total.
    const measured = [];
    for (const c of imageCanvases.values()) measured.push([c.overlay, c.overlay?.measureFit?.()]);
    for (const [overlay, avail] of measured) overlay?.applyFit?.(avail);
    // every window's rule_trace was skipped per-image during boot (imaging.js) -> one coalesced
    // pass per open window now, when the OCR item/read pool is free instead of starved.
    for (const winId of imageCanvases.keys()) {
        if (winId !== "atlas") scheduleWindowRead(winId, { trace: true, preview: false });
    }
}

// Mint a blank game profile. Called from the settings modal's "new game" section.
export function createGame(name) {
    name = (name || "").trim();
    if (!name) { setStatus("enter a name"); return false; }
    nodeTxn.abandon();   // a pending edit belongs to the OUTGOING profile's objects
    model.load({ name, process_names: [], window_title_hint: null, fields: [], windows: [] });
    pos.clear(); nodeEls.clear(); $("gnodes").replaceChildren();
    render(); autosave(null);
    refreshGames(name);
    return true;
}
