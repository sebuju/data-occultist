// Wires every floating panel's topbar toggle button (node map, node list, activity, inspector,
// stats, db-struct, toolbox, precap, live, edit-history), the generic shift-click "reset box"
// behavior shared by all of them, and the read-only window.__nodeHistory e2e introspection API.
// Split out of main.js; render/autosave stay in main and are imported back.
import { $, model, pos, nodeEls, nodeSizes, boot, setStatus } from "./state.js";
import { persist } from "./persist.js";
import { floatWins } from "./floatwin.js";
import { hist, undo, redo } from "./history.js";
import { createHistoryPanel } from "../history_panel.js";
import { vtableById, liveVTables, reapplyPersistedVTables } from "../vtable.js";
import { applySavedSize } from "./node_resize.js";
import {
    nmState, nlState, buildNodeMap, buildNodeList, setNodeMapVisible, setNodeListVisible,
} from "./panels/nodemap.js";
import { act, actState, buildActivity } from "./panels/activity.js";
import { inspWin, inspState, buildInspectorPanel } from "./panels/inspector.js";
import { statsWin, statsState, buildStats } from "./panels/stats.js";
import { dbWin, dbState, buildDBStruct } from "./panels/dbstruct.js";
import { tb, tbState, buildToolbox } from "./panels/toolbox.js";
import { themeState, buildTheme } from "./panels/theme.js";
import { pc, pcState, buildPrecap } from "./panels/precap.js";
import { liveWin, liveWinState, buildLiveWindow } from "./panels/livewin.js";
import { onOutside } from "../inputbus.js";
import { render, autosave } from "./main.js";

export function initPanels() {
    // ---- node map (fixed overview / jump-to) ----------------------------------
    // A draggable, fixed-to-screen panel that mirrors the graph two ways: a scaled MINI-MAP
    // (nodes + connection lines + a viewport box) or a TEXT LIST built by walking the edges.
    // Clicking any node in either view smoothly pans+zooms to it. Visibility, position and
    // mode persist (global UI pref, not per-game).
    buildNodeMap();
    $("nodemapBtn")?.classList.toggle("active", nmState.visible);
    $("nodemapBtn")?.addEventListener("click", () => setNodeMapVisible(!nmState.visible, true));
    // (on-screen re-clamp + re-render on window resize is handled inside createFloatWin)

    buildNodeList();
    $("nodelistBtn")?.classList.toggle("active", nlState.visible);
    $("nodelistBtn")?.addEventListener("click", () => setNodeListVisible(!nlState.visible, true));

    buildActivity();
    $("activityBtn")?.classList.toggle("active", actState.visible);
    $("activityBtn")?.addEventListener("click", () => act.setVisible(!actState.visible, true));

    buildInspectorPanel();
    $("inspectorBtn")?.classList.toggle("active", inspState.visible);
    $("inspectorBtn")?.addEventListener("click", () => inspWin.setVisible(!inspState.visible, true));

    buildStats();
    $("statsBtn")?.classList.toggle("active", statsState.visible);
    $("statsBtn")?.addEventListener("click", () => statsWin.setVisible(!statsState.visible, true));

    buildDBStruct();
    $("dbstructBtn")?.classList.toggle("active", dbState.visible);
    $("dbstructBtn")?.addEventListener("click", () => dbWin.setVisible(!dbState.visible, true));

    // edit-history panel: the node graph's own history (independent of Pretty's). Reads the graph
    // `hist` instance; clicking a row travels there. Session-only geometry like the other panels.
    const histState = { visible: false, x: null, y: null, w: 300, h: null, collapsed: false };
    const histWin = createHistoryPanel({
        hist, id: "history", title: "edit history", state: histState,
        onPersist: () => persist.layout(),
        onShow: () => $("historyBtn")?.classList.toggle("active", true),
        onHide: () => $("historyBtn")?.classList.toggle("active", false),
    });
    $("historyBtn")?.classList.toggle("active", histState.visible);
    $("historyBtn")?.addEventListener("click", () => histWin.setVisible(!histState.visible, true));

    // read-only e2e introspection (playwright), same convention as window.__routes (routing.js).
    // `edit` drives the REAL funnel (model mutate + render + autosave -> pushHistory) so the test
    // exercises the production path, not the history engine in isolation.
    if (typeof window !== "undefined") {
        window.__nodeHistory = {
            state: () => ({ index: hist.index(), len: hist.entries().length, labels: hist.entries().map((e) => e.label) }),
            booting: () => boot.phase,
            datasets: () => model.datasets(),
            edit: (name) => { const id = model.addDataset(name || "e2e_ds"); render(); autosave(null); return id; },
            // layout edit through the REAL funnel (pos update + persist.layout -> recordHistory)
            nodePos: (id) => { const p = pos.get(id); return p ? { x: p.x, y: p.y } : null; },
            moveNode: (id, x, y) => { pos.set(id, { x, y }); render(); persist.layout(); },
            // node SIZE through the real funnel (nodeSizes + persist.layout -> record). offsetWidth/Height
            // are unscaled local layout px.
            nodeSize: (id) => { const el = nodeEls.get(id); return el ? { w: el.offsetWidth, h: el.offsetHeight } : null; },
            resizeNode: (id, w, h) => {
                nodeSizes.set(id, { w, h, custW: true, custH: true, softW: false, softH: false });
                const el = nodeEls.get(id); if (el) applySavedSize(el, nodeSizes.get(id));
                persist.layout();
            },
            // vttable column width through the real funnel: write the store, apply live, persist -> record.
            firstTable: () => { const v = liveVTables()[0]; return v && v.columns[0] ? { id: v.id, col: v.columns[0], width: v.widths[v.columns[0]] ?? null } : null; },
            tableWidth: (id, col) => { const v = vtableById(id); return v ? (v.widths[col] ?? null) : null; },
            tableDomWidth: (id, colName) => { const v = vtableById(id); if (!v) return null; const i = v.columns.indexOf(colName); const c = i >= 0 && v.head && v.head.children[i]; return c ? c.offsetWidth : null; },
            tableCols: (id) => { const v = vtableById(id); return v ? v.columns.slice() : null; },
            tableSort: (id) => { const v = vtableById(id); if (!v) return null; return { col: v.sortCol != null ? v.columns[v.sortCol] : null, dir: v.sortDir }; },
            // first VISIBLE row's value for a column — proves the ROWS actually reordered, not just the arrow
            tableFirstRow: (id, colName) => { const v = vtableById(id); if (!v || !v.filtered.length) return null; return v.filtered[0].values[colName] ?? null; },
            // await a server-mode table's in-flight window (sort/undo/redo refetch) before asserting
            tableIdle: (id) => { const v = vtableById(id); return v ? v.windowIdle() : Promise.resolve(); },
            setTableSort: (id, colName, dir) => {
                const v = vtableById(id); if (!v) return; const i = v.columns.indexOf(colName); if (i < 0) return;
                v.sortCol = i; v.sortDir = dir; v._renderHead(); v._saveSort();   // real sort-commit path (persists -> records)
                // array mode re-sorts in memory; server mode refetches window 0 — return the promise so
                // the e2e awaits the reorder before reading the first row.
                if (v.server) return v._reloadWindow();
                v._sortView(); v._render();
            },
            setTableWidth: (id, col, px) => {
                const L = (model.profile.layout = model.profile.layout || {});
                const t = (L.tables = L.tables || {}); const st = (t[id] = t[id] || {}); (st.widths = st.widths || {})[col] = px;
                reapplyPersistedVTables(); persist.layout();
            },
            undo: () => undo(), redo: () => redo(), jump: (i) => hist.jumpTo(i),
        };
    }

    buildToolbox();
    $("createBtn")?.classList.toggle("active", tbState.visible);
    $("createBtn")?.addEventListener("click", () => tb.setVisible(!tbState.visible, true));

    const themeWin = buildTheme();
    $("themeBtn")?.classList.toggle("active", themeState.visible);
    $("themeBtn")?.addEventListener("click", () => themeWin.setVisible(!themeState.visible, true));

    buildPrecap();
    buildLiveWindow();
    $("liveBtn").classList.toggle("active", liveWinState.visible);
    $("liveBtn").addEventListener("click", () => liveWin.setVisible(!liveWinState.visible, true));   // the panel's toggle drives live mode
    $("precapBtn").addEventListener("click", () => {
        if (!pcState.visible && !model.profile.name) { setStatus("load a game first"); return; }
        pc.setVisible(!pcState.visible, true);
    });

    // Shift-clicking a panel's topbar toggle resets that panel's box (size + position) instead
    // of toggling it. Capture phase so it can pre-empt the normal toggle handler above. If the
    // panel is already open we reset in place and suppress the toggle (which would hide it); if
    // it's closed/not-built we let the toggle open it, then reset on the next tick.
    const _PANEL_TOGGLES = { liveBtn: "live", precapBtn: "precap", createBtn: "toolbox", themeBtn: "graph-theme", nodemapBtn: "nodemap", nodelistBtn: "nodelist", activityBtn: "activity", inspectorBtn: "inspector", statsBtn: "stats", dbstructBtn: "dbstruct", historyBtn: "history" };
    for (const [btnId, panelId] of Object.entries(_PANEL_TOGGLES)) {
        $(btnId)?.addEventListener("click", (ev) => {
            if (!ev.shiftKey) return;
            const p = floatWins().get(panelId);
            if (p && p.state.visible) { ev.stopImmediatePropagation(); p.resetBox(); }
            else setTimeout(() => floatWins().get(panelId)?.resetBox(), 0);
        }, true);
    }

    // Narrow-window (<=600px) tools dropdown: the ☰ button toggles .open on .topbar-tools (CSS
    // turns that into a fixed dropdown under the bar). Close on outside click and after any tool
    // inside fires, so picking a tool doesn't leave the menu hanging open.
    const toolsBtn = $("toolsMenuBtn");
    const toolsBox = document.querySelector(".topbar-tools");
    if (toolsBtn && toolsBox) {
        const closeTools = () => toolsBox.classList.remove("open");
        toolsBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            toolsBox.classList.toggle("open");
        });
        toolsBox.addEventListener("click", (ev) => { if (ev.target.closest("button")) closeTools(); });
        onOutside(toolsBox, closeTools, { also: () => toolsBtn });
    }
}
