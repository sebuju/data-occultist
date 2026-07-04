// GraphModel: the editable structure behind the node view. It holds the full
// GameProfile and exposes node/edge derivation plus edit ops. Box data
// (regions/detect/states/preprocess/scroll) is never touched here — it's authored
// on the canvas — so saving preserves it.

import { DEFAULT_DETECT_THRESHOLD } from "../defaults.js";

let _fieldSeq = 1;

export class GraphModel {
    constructor() { this.profile = blank(""); this.sounds = []; this.shownSatellites = new Set(); }   // sounds: available trigger-sound filenames (fetched once); shownSatellites: ids of opt-in follower nodes (preview / vt-table) currently visible

    load(profile) {
        this.profile = profile || blank("");
        this.profile.windows = this.profile.windows || [];
        this.profile.fields = this.profile.fields || [];
        this.profile.datasets = this.profile.datasets || [];
        this.profile.subsets = this.profile.subsets || [];
        this.profile.producers = this.profile.producers || [];
        this.profile.file_sources = this.profile.file_sources || [];
        this.profile.triggers = this.profile.triggers || [];
        this.profile.toasts = this.profile.toasts || [];   // OS-notification nodes (trigger targets)
        this.profile.sounds = this.profile.sounds || [];   // browser-played sound nodes (trigger targets)
        this.profile.dictionaries = this.profile.dictionaries || [];
        this.profile.glyphs = this.profile.glyphs || [];   // taught glyph atlas (post-OCR refinement)
        this._renameHook = null;   // (rewrite) called on every id rename so cross-doc token refs repoint
        // a subset joins many sources, each carrying its own join config (JoinSource)
        for (const s of this.profile.subsets) {
            s.sources = s.sources || [];
            s.sort = s.sort || [];
            // fold a legacy single-column sort into the multi-column list
            if (!s.sort.length && s.sort_by) { s.sort = [{ field: s.sort_by, desc: !!s.sort_desc }]; s.sort_by = ""; }
        }
        for (const pn of this.profile.producers) pn.sources = pn.sources || [];   // items the node prices (empty = catalogue)
        for (const s of this.profile.file_sources) { s.match = s.match || []; s.fields = s.fields || []; s.roots = s.roots || []; }
        for (const t of this.profile.triggers) {
            t.watch = t.watch || []; t.targets = t.targets || [];
            t.dataset_targets = t.dataset_targets || []; t.dataset_action = t.dataset_action || ""; t.dataset_dest = t.dataset_dest || "";
            t.readout_watch = t.readout_watch || []; t.readout_op = t.readout_op || "gte"; if (t.readout_value == null) t.readout_value = 0;
        }
        // Item children arrive HOISTED to the window (flat ``item_fields``/``item_tells``, each
        // with an ``item`` backref) so each is its own node. Fan them back onto each item's
        // ``fields``/``tells`` for the per-item editing logic, and drop the flat key so saving
        // re-nests (the backend re-hoists). ONE fan-in drives both child kinds.
        const fanIn = (w, flatKey, attr) => {
            if (Array.isArray(w[flatKey])) {
                const byItem = {};
                for (const c of w[flatKey]) { const { item, ...rest } = c; (byItem[item] = byItem[item] || []).push(rest); }
                for (const it of w.items) it[attr] = (it[attr] || []).concat(byItem[it.id] || []);
                delete w[flatKey];
            } else {
                for (const it of w.items) it[attr] = it[attr] || [];
            }
        };
        for (const w of this.profile.windows || []) {
            w.items = w.items || [];
            w.readouts = w.readouts || [];   // live, non-persisted scalars (health/bars/counters)
            fanIn(w, "item_fields", "fields");
            fanIn(w, "item_tells", "tells");
        }
    }

    // ---- taught glyph atlas (reference characters for post-OCR glyph refinement) ----
    glyphs() { return this.profile.glyphs || (this.profile.glyphs = []); }
    // alphabetical by char (case-insensitive, then case, then image) so the atlas list is ordered
    sortGlyphs() { this.glyphs().sort((a, b) => (a.char || "").localeCompare(b.char || "", undefined, { sensitivity: "base" }) || (a.char || "").localeCompare(b.char || "") || (a.image || "").localeCompare(b.image || "")); }
    addGlyph({ char = "", image, enabled = true }) { this.glyphs().push({ char, image, enabled }); this.sortGlyphs(); return this.glyphs().findIndex((g) => g.image === image); }
    addGlyphs(list) { for (const g of list) this.glyphs().push({ char: g.char || "", image: g.image, enabled: g.enabled !== false }); this.sortGlyphs(); }
    setGlyphChar(i, char) { const g = this.glyphs()[i]; if (g) { g.char = char; this.sortGlyphs(); } }
    setGlyphEnabled(i, on) { const g = this.glyphs()[i]; if (g) g.enabled = !!on; }
    removeGlyph(i) { this.glyphs().splice(i, 1); }

    // effective dataset id for a window (defaults to its own id)
    datasetOf(win) { return win.dataset || null; }
    // does this window HAVE a dataset at all? Only when EXPLICITLY pointed at one
    // (`win.dataset` set). A window with regions/items but no dataset produces records
    // that are DISCARDED — no implicit window-id dataset is minted. Wire the window's
    // out-port to a dataset node to give it one.
    _windowHasDataset(win) {
        return !!win.dataset;
    }

    // ---- datasets just receive/store rows; keys live on the items/windows ----
    datasetDef(id) { return (this.profile.datasets || []).find((d) => d.id === id) || null; }
    ensureDatasetDef(id) {
        let d = this.datasetDef(id);
        if (!d) { d = { id }; (this.profile.datasets = this.profile.datasets || []).push(d); }
        return d;
    }
    // how a key's many observations collapse to the displayed value
    datasetAggregate(id) { const d = this.datasetDef(id); return (d && d.aggregate) || "latest"; }
    setDatasetAggregate(id, agg) { this.ensureDatasetDef(id).aggregate = agg || "latest"; }
    // The field the dataset's 1->many collapse keys on: "" = inherit the window/item keys.
    datasetKeyField(id) { const d = this.datasetDef(id); return (d && d.key_field) || ""; }
    setDatasetKeyField(id, f) { const d = this.ensureDatasetDef(id); d.key_field = f || ""; d.key_fields = []; d.dedup = true; }
    // Whether the dataset does the 1->many collapse at all (false = keep every read as its own row).
    datasetDedup(id) { const d = this.datasetDef(id); return !d || d.dedup !== false; }
    setDatasetDedup(id, on) { this.ensureDatasetDef(id).dedup = !!on; }
    // ---- concat key: several fields combined into one identity, each part canonicalised ----
    // The fields the concat key combines (single-field / auto modes leave this empty).
    datasetKeyFields(id) { const d = this.datasetDef(id); return (d && d.key_fields) || []; }
    // The concat key's canonicalisation knobs (mirrors a subset join's JoinNorm; defaults match).
    datasetKeyNorm(id) {
        const d = this.datasetDef(id);
        const n = (d && d.key_norm) || {};
        return { case_insensitive: n.case_insensitive !== false, strip_punct: !!n.strip_punct,
            collapse_ws: n.collapse_ws !== false, strip_words: n.strip_words || [] };
    }
    // Which key mode the dataset is in — drives the "1 -> many" dropdown selection.
    datasetKeyMode(id) {
        const d = this.datasetDef(id);
        if (!d || d.dedup === false) return d && d.dedup === false ? "nodedup" : "auto";
        if ((d.key_fields || []).length) return "concat";
        if (d.key_field) return "single";
        return "auto";
    }
    // Switch the dataset's key mode. "single" is set by picking a field (setDatasetKeyField); this
    // handles the modeless options. Concat seeds an empty field list + default norm to fill in.
    setDatasetKeyMode(id, mode) {
        const d = this.ensureDatasetDef(id);
        if (mode === "nodedup") { d.dedup = false; return; }
        d.dedup = true; d.key_field = "";
        if (mode === "concat") {
            d.key_fields = d.key_fields || [];
            d.key_norm = d.key_norm || { case_insensitive: true, strip_punct: false, collapse_ws: true, strip_words: [] };
        } else { d.key_fields = []; }   // "auto"
    }
    // Add/remove one field from the concat key (order = insertion order = key part order).
    toggleDatasetKeyField(id, field) {
        const d = this.ensureDatasetDef(id); d.key_fields = d.key_fields || [];
        const i = d.key_fields.indexOf(field);
        if (i >= 0) d.key_fields.splice(i, 1); else d.key_fields.push(field);
    }
    // Patch one concat-key norm knob (case_insensitive / strip_punct / collapse_ws / strip_words).
    setDatasetKeyNorm(id, patch) {
        const d = this.ensureDatasetDef(id);
        d.key_norm = { ...this.datasetKeyNorm(id), ...patch };
    }
    // How a live run splits into batches: "run" (one per run) or "detection" (a new batch each
    // time the feeding window is freshly detected — transient per-event screens like relic offerings).
    datasetBatchMode(id) { const d = this.datasetDef(id); return (d && d.batch_mode) || "run"; }
    setDatasetBatchMode(id, m) { this.ensureDatasetDef(id).batch_mode = m === "detection" ? "detection" : "run"; }
    // Whether a run removes keys to mirror the game emptying out: "accumulate" (add/update only)
    // or "mirror" (a key gone from its visible scroll slice is removed — needs the window's scrollbar).
    datasetSyncMode(id) { const d = this.datasetDef(id); return (d && d.sync_mode) || "accumulate"; }
    setDatasetSyncMode(id, m) { this.ensureDatasetDef(id).sync_mode = m === "mirror" ? "mirror" : "accumulate"; }
    // SINGLE SOURCE OF TRUTH for every place a dataset id is stored, as live get/set accessors.
    // `decl: true` sites DECLARE a dataset's existence (a node literally IS this dataset);
    // ref sites merely point at one (a consumer). EVERYTHING that lists or renames datasets
    // derives from this one list — `datasets()`, `renameDataset()`, collision checks — so a
    // dataset can never desync into a duplicate. Adding a new node type that touches datasets
    // means adding ONE loop here; rename/listing then work automatically, no audit needed.
    _datasetSites() {
        const sites = [];
        for (const w of this.profile.windows)
            if (this._windowHasDataset(w))   // an empty window declares no dataset
                sites.push({ decl: true, get: () => this.datasetOf(w), set: (v) => { w.dataset = v; } });
        for (const d of this.profile.datasets || [])
            sites.push({ decl: true, get: () => d.id, set: (v) => { d.id = v; } });
        for (const pn of this.profile.producers || []) {
            sites.push({ decl: true, get: () => pn.dataset, set: (v) => { pn.dataset = v; } });
            (pn.sources || []).forEach((_, i) =>                            // priced-item sources are REFs
                sites.push({ decl: false, get: () => pn.sources[i], set: (v) => { pn.sources[i] = v; } }));
        }
        for (const s of this.profile.file_sources || [])                  // a source DECLARES its output dataset
            sites.push({ decl: true, get: () => s.dataset, set: (v) => { s.dataset = v; } });
        for (const s of this.profile.subsets || [])                       // each subset source is a REF
            (s.sources || []).forEach((_, i) =>
                sites.push({ decl: false, get: () => s.sources[i].dataset, set: (v) => { s.sources[i].dataset = v; } }));
        for (const t of this.profile.triggers || []) {                    // trigger dataset REFs
            (t.watch || []).forEach((_, i) =>                             // on_change watch
                sites.push({ decl: false, get: () => t.watch[i], set: (v) => { t.watch[i] = v; } }));
            (t.dataset_targets || []).forEach((_, i) =>                   // datasets it acts on
                sites.push({ decl: false, get: () => t.dataset_targets[i], set: (v) => { t.dataset_targets[i] = v; } }));
            sites.push({ decl: false, get: () => t.dataset_dest || "", set: (v) => { t.dataset_dest = v; } });   // clone/move dest
        }
        for (const d of this.profile.dictionaries || [])                  // a dictionary feed is a dataset REF
            (d.feeds || []).forEach((_, i) =>
                sites.push({ decl: false, get: () => d.feeds[i].dataset, set: (v) => { d.feeds[i].dataset = v; } }));
        return sites;
    }

    // Repoint every reference site (consumers, not declarations) from oldId -> newId. Shared by
    // Cross-document rename notification. A graph id can be referenced OUTSIDE the profile — the
    // Pretty doc embeds ids inside {{token}} strings (dataset:/subset: heads, node: paths). Those
    // live in a separate lazily-loaded model, so structured repointing (_datasetSites/_repointTargets)
    // can't reach them. Every rename* emits {kind, old, new, win?} here; ONE subscriber (main.js)
    // funnels them to the Pretty repoint endpoint. Wired via a hook so model.js stays UI-free.
    setRenameHook(fn) { this._renameHook = fn; }
    _emitRename(kind, oldId, newId, win) {
        if (this._renameHook && oldId && newId && oldId !== newId)
            try { this._renameHook({ kind, old: oldId, new: newId, win }); } catch { /* never fail a rename */ }
    }

    // dataset AND subset renames: a subset.datasets entry can name either, and the ref site is
    // the same either way, so one helper keeps both rename paths complete.
    _repointRefs(oldId, newId) {
        for (const st of this._datasetSites()) if (!st.decl && st.get() === oldId) st.set(newId);
    }

    // SSOT for every site that REFERENCES a producer / file-source id — a trigger's `targets`
    // list is the only one. Mirrors _datasetSites: rename repoints through it, delete clears
    // through it, so a producer/source can never leave a dangling trigger wire on either path.
    _targetSites() {
        const sites = [];
        for (const t of this.profile.triggers || [])
            (t.targets || []).forEach((_, i) =>
                sites.push({ get: () => t.targets[i], set: (v) => { t.targets[i] = v; } }));
        return sites;
    }
    _repointTargets(oldId, newId) {
        for (const st of this._targetSites()) if (st.get() === oldId) st.set(newId);
    }
    // delete-twin of _repointTargets: blank every target holding `id`, then prune the empties.
    _dropTarget(id) {
        this._repointTargets(id, "");
        for (const t of this.profile.triggers || []) t.targets = (t.targets || []).filter(Boolean);
    }

    // Rename a dataset: repoint EVERY site (declarations + references) holding the old id, so
    // the old name cannot linger and resurface as a duplicate node.
    renameDataset(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.datasets().includes(newId)) return false;   // collision incl. disk/price/window
        for (const st of this._datasetSites()) if (st.get() === oldId) st.set(newId);
        if (!this.datasetDef(newId)) this.ensureDatasetDef(newId);   // a def must exist for the new name
        if (this._extraDatasets) this._extraDatasets = this._extraDatasets.filter((x) => x !== oldId);   // drop stale disk entry
        this._emitRename("dataset", oldId, newId);
        return true;
    }
    // field ids available to a dataset = the fields of every window feeding it
    // every column a dataset's records can carry — from ALL its feeders: window fields, file-source
    // fields, and producer output columns. (Was windows-only, so producer/source-fed datasets
    // offered no key field to pick.)
    datasetFields(id) {
        const out = new Set();
        for (const w of this.profile.windows) {
            if (this.datasetOf(w) !== id) continue;
            for (const f of w.fields || []) out.add(f.id);
        }
        for (const s of this.profile.file_sources || []) {
            if (s.dataset !== id) continue;
            for (const f of s.fields || []) out.add(f.id);
        }
        for (const p of this.profile.producers || []) {
            if (p.dataset !== id) continue;
            this.producerColumns(p).forEach((c) => out.add(c));
        }
        return [...out];
    }
    // The output columns a producer writes — ONE source of truth for the key picker and the
    // subset column list (a producer dataset isn't fed by windows, so its columns can't be read
    // off a schema). An http node writes each mapped out_field; per-item mode also injects `name`
    // (the source item), so prepend it unless the mapping already declares a `name` column (list
    // mode names it itself). Editing the mapping immediately surfaces/removes downstream columns.
    producerColumns(pn) {
        if (!pn) return [];
        const fields = (pn.http && pn.http.fields) || [];
        const cols = fields.map((f) => f.out_field).filter(Boolean);
        return cols.includes("name") ? cols : ["name", ...cols];
    }

    // ---- satellites (opt-in follower nodes) ---------------------------------
    // A satellite is a companion node bonded to a parent by a dotted "img" edge — it follows the
    // parent in/out of groups and is never grouped alone (like the window's preview). Two kinds:
    //   • preview  — id `prev:<winId>`        parent `win:<winId>`     (window's live-read node)
    //   • vt-table — id `vt:ds:<ds>`/`vt:sub:<id>`/`vt:src:<id>`  parent `ds:<ds>`/`sub:<id>`/`src:<id>`
    //                (a dataset/subset's records grid, or a file source's parse preview)
    // Visibility is opt-in (the user toggles each on) and rides the layout sidecar, never the yaml.
    satelliteOn(id) { return this.shownSatellites.has(id); }
    toggleSatellite(id) { const on = !this.shownSatellites.has(id); if (on) this.shownSatellites.add(id); else this.shownSatellites.delete(id); return on; }
    setSatellites(arr) { this.shownSatellites = new Set(Array.isArray(arr) ? arr : []); }
    satelliteIds() { return [...this.shownSatellites]; }
    // Parent node id a satellite is bonded to (so groups keep them together).
    satelliteParent(id) {
        if (id.startsWith("vtd:")) return id.slice(4);   // dismissed-rows preview (file source)
        if (id.startsWith("vt:")) return id.slice(3);
        if (id.startsWith("prev:")) return `win:${id.slice(5)}`;
        if (id.startsWith("prod:")) return `producer:${id.slice(5)}`;   // producer preview (inputs/schema/test)
        return null;
    }
    satelliteBonds() {
        return this.satelliteIds().map((s) => ({ leader: this.satelliteParent(s), follower: s })).filter((b) => b.leader);
    }

    // ---- nodes / edges ------------------------------------------------------

    nodes() {
        const ns = [{ id: "game", type: "game", ref: this.profile }];
        // standalone glyph-atlas node (its own image surface; teaches post-OCR glyph refinement)
        ns.push({ id: "glyphs", type: "glyphs", ref: this.profile });
        for (const w of this.profile.windows) {
            ns.push({ id: `win:${w.id}`, type: "window", ref: w });
            if (this.satelliteOn(`prev:${w.id}`)) ns.push({ id: `prev:${w.id}`, type: "preview", ref: w });
            for (const r of w.regions || []) ns.push({ id: `reg:${w.id}:${r.id}`, type: "region", ref: r, win: w, field: this.fieldOf(w, r) });
            for (const d of w.detect || []) ns.push({ id: `det:${w.id}:${d.id}`, type: "detect", ref: d, win: w });
            if (w.scroll && w.scroll.scrollbar) ns.push({ id: `sb:${w.id}:scrollbar`, type: "scrollbar", ref: w.scroll, win: w });
            for (const it of w.items || []) {
                ns.push({ id: `item:${w.id}:${it.id}`, type: "item", ref: it, win: w });
                for (const f of it.fields || []) ns.push({ id: `fld:${w.id}:${it.id}:${f.id}`, type: "itemfield", ref: f, win: w, item: it, field: this.fieldOf(w, f) });
                for (const t of it.tells || []) ns.push({ id: `tell:${w.id}:${it.id}:${t.id}`, type: "itemtell", ref: t, win: w, item: it });
            }
            // A readout is ONE node: it owns its box + source + (for ocr) its read config inline,
            // like a region node. The linked FieldDef rides along as `field` for the config editor.
            for (const v of w.readouts || [])
                ns.push({ id: `ro:${w.id}:${v.id}`, type: "readout", ref: v, win: w, field: this.readoutField(w, v) });
        }
        for (const ds of this.datasets()) {
            ns.push({ id: `ds:${ds}`, type: "dataset", ref: ds });
            if (this.satelliteOn(`vt:ds:${ds}`)) ns.push({ id: `vt:ds:${ds}`, type: "vttable", ref: { kind: "dataset", ds } });
        }
        for (const s of this.profile.subsets || []) {
            ns.push({ id: `sub:${s.id}`, type: "subset", ref: s });
            if (this.satelliteOn(`vt:sub:${s.id}`)) ns.push({ id: `vt:sub:${s.id}`, type: "vttable", ref: { kind: "subset", id: s.id } });
        }
        for (const pn of this.profile.producers || []) {
            ns.push({ id: `producer:${pn.id}`, type: "producer", ref: pn });
            if (this.satelliteOn(`prod:${pn.id}`)) ns.push({ id: `prod:${pn.id}`, type: "vttable", ref: { kind: "producer", id: pn.id, dataset: pn.dataset } });
        }
        for (const s of this.profile.file_sources || []) {
            ns.push({ id: `src:${s.id}`, type: "filesource", ref: s });
            if (this.satelliteOn(`vt:src:${s.id}`)) ns.push({ id: `vt:src:${s.id}`, type: "vttable", ref: { kind: "source", id: s.id } });
            if (this.satelliteOn(`vtd:src:${s.id}`)) ns.push({ id: `vtd:src:${s.id}`, type: "vttable", ref: { kind: "sourcedismissed", id: s.id } });
        }
        for (const t of this.profile.triggers || []) ns.push({ id: `trigger:${t.id}`, type: "trigger", ref: t });
        for (const x of this.profile.toasts || []) ns.push({ id: `toast:${x.id}`, type: "toast", ref: x });
        for (const x of this.profile.sounds || []) ns.push({ id: `sound:${x.id}`, type: "sound", ref: x });
        for (const d of this.profile.dictionaries || []) ns.push({ id: `dict:${d.id}`, type: "dictionary", ref: d });
        return ns;
    }

    edges() {
        const es = [];
        es.push({ from: "game", to: "glyphs", kind: "own" });   // glyph-atlas node hangs off the game node
        for (const w of this.profile.windows) {
            es.push({ from: "game", to: `win:${w.id}`, kind: "own" });   // game node owns each window
            if (this.satelliteOn(`prev:${w.id}`)) es.push({ from: `win:${w.id}`, to: `prev:${w.id}`, kind: "img" });
            for (const r of w.regions || []) {
                es.push({ from: `win:${w.id}`, to: `reg:${w.id}:${r.id}`, kind: "field" });
            }
            for (const d of w.detect || []) es.push({ from: `win:${w.id}`, to: `det:${w.id}:${d.id}`, kind: "detect" });
            if (w.scroll && w.scroll.scrollbar) es.push({ from: `win:${w.id}`, to: `sb:${w.id}:scrollbar`, kind: "scrollbar" });
            for (const it of w.items || []) {
                es.push({ from: `win:${w.id}`, to: `item:${w.id}:${it.id}`, kind: "item" });
                for (const f of it.fields || []) {
                    es.push({ from: `item:${w.id}:${it.id}`, to: `fld:${w.id}:${it.id}:${f.id}`, kind: "field" });
                }
                for (const t of it.tells || []) es.push({ from: `item:${w.id}:${it.id}`, to: `tell:${w.id}:${it.id}:${t.id}`, kind: "tell" });
            }
            for (const v of w.readouts || [])
                es.push({ from: `win:${w.id}`, to: `ro:${w.id}:${v.id}`, kind: "field" });
            if (this._windowHasDataset(w))   // no dataset node/wire until the window produces data
                es.push({ from: `win:${w.id}`, to: `ds:${this.datasetOf(w)}`, kind: "data" });
        }
        for (const s of this.profile.subsets || [])
            for (const inp of this.subsetInputs(s)) {
                // an input can be a dataset OR another subset — pick the right source node
                const from = this.subsetDef(inp) ? `sub:${inp}` : `ds:${inp}`;
                es.push({ from, to: `sub:${s.id}`, kind: "data" });
            }
        // a producer WRITES into its output dataset (producer -> dataset, only once wired), and READS
        // its item list from any wired source dataset/subset (source -> producer); empty = whole catalogue.
        for (const pn of this.profile.producers || []) {
            if (pn.dataset) es.push({ from: `producer:${pn.id}`, to: `ds:${pn.dataset}`, kind: "data" });
            for (const src of pn.sources || []) {
                if (src === pn.dataset) continue;   // never wire a node to its own output
                const from = this.subsetDef(src) ? `sub:${src}` : `ds:${src}`;
                es.push({ from, to: `producer:${pn.id}`, kind: "data" });
            }
            if (this.satelliteOn(`prod:${pn.id}`)) es.push({ from: `producer:${pn.id}`, to: `prod:${pn.id}`, kind: "img" });
        }
        // a trigger FIRES its target price nodes (trigger -> price); an on_change trigger also
        // WATCHES datasets — the dashed line leaves the trigger's watch port and reaches OUT to the
        // dataset/subset it wakes on (trigger -> watched), so both control lines emanate from the trigger.
        // a file source WRITES parsed rows into its output dataset (source -> dataset)
        for (const s of this.profile.file_sources || [])
            if (s.dataset) es.push({ from: `src:${s.id}`, to: `ds:${s.dataset}`, kind: "data" });
        for (const t of this.profile.triggers || []) {
            // a target is a price node (sweep) or a file source (read) — wire to whichever owns the id
            for (const pid of t.targets || []) {
                if (this.producerNode(pid)) es.push({ from: `trigger:${t.id}`, to: `producer:${pid}`, kind: "trigger" });
                else if (this.fileSource(pid)) es.push({ from: `trigger:${t.id}`, to: `src:${pid}`, kind: "trigger" });
                else if (this.toastNode(pid)) es.push({ from: `trigger:${t.id}`, to: `toast:${pid}`, kind: "trigger" });
                else if (this.soundNode(pid)) es.push({ from: `trigger:${t.id}`, to: `sound:${pid}`, kind: "trigger" });
            }
            if (t.kind === "on_change")
                for (const w of t.watch || []) {
                    const to = this.subsetDef(w) ? `sub:${w}` : `ds:${w}`;
                    es.push({ from: `trigger:${t.id}`, to, kind: "watch" });
                }
            // an on_readout trigger WATCHES live readouts — dashed line to each watched var node
            if (t.kind === "on_readout")
                for (const vid of t.readout_watch || []) {
                    const site = this.readoutSite(vid);
                    if (site) es.push({ from: `trigger:${t.id}`, to: `ro:${site.win}:${vid}`, kind: "watch" });
                }
            // a dataset-action trigger ACTS ON its dataset targets (trigger -> dataset)
            for (const ds of t.dataset_targets || [])
                es.push({ from: `trigger:${t.id}`, to: `ds:${ds}`, kind: "trigger" });
        }
        for (const d of this.profile.dictionaries || []) {
            es.push({ from: "game", to: `dict:${d.id}`, kind: "own" });
            for (const fd of d.feeds || [])   // a dataset PUSHES its column values in as terms
                if (fd.dataset) es.push({ from: `ds:${fd.dataset}`, to: `dict:${d.id}`, kind: "data" });
        }
        // vt-table satellites: a dotted "img" edge from the dataset/subset to its records grid (opt-in)
        for (const ds of this.datasets()) if (this.satelliteOn(`vt:ds:${ds}`)) es.push({ from: `ds:${ds}`, to: `vt:ds:${ds}`, kind: "img" });
        for (const s of this.profile.subsets || []) if (this.satelliteOn(`vt:sub:${s.id}`)) es.push({ from: `sub:${s.id}`, to: `vt:sub:${s.id}`, kind: "img" });
        for (const s of this.profile.file_sources || []) if (this.satelliteOn(`vt:src:${s.id}`)) es.push({ from: `src:${s.id}`, to: `vt:src:${s.id}`, kind: "img" });
        for (const s of this.profile.file_sources || []) if (this.satelliteOn(`vtd:src:${s.id}`)) es.push({ from: `src:${s.id}`, to: `vtd:src:${s.id}`, kind: "img" });
        return es;
    }

    fieldOf(win, region) {
        win.fields = win.fields || [];
        return win.fields.find((f) => f.id === region.field) || null;
    }

    // SINGLE SOURCE OF TRUTH for every place a FIELD id is referenced within a window (rule 7).
    // A field id names a schema column, so it is pointed at by the region/item-field that reads
    // it, the tells that validate on it, AND — critically — every RECORD KEY that includes it
    // (window default key, each item's own key, and the dataset's key_field override). A rename
    // that misses any of these leaves a key part pointing at a dead id, and CLAUDE.md's rule holds:
    // a record with any key part unread is dropped → every record silently vanishes / the ledger
    // re-keys to NULL. Both field-rename paths (region node + item-field node) route through here
    // so they can never diverge again. Caller renames the FieldDef itself + the node-id twin.
    _repointField(win, oldFid, newFid) {
        if (!win || !oldFid || oldFid === newFid) return;
        const swap = (arr) => (arr || []).map((x) => (x === oldFid ? newFid : x));
        for (const r of win.regions || []) if (r.field === oldFid) r.field = newFid;   // grid region → field link
        for (const it of win.items || []) {
            for (const f of it.fields || []) if (f.field === oldFid) f.field = newFid;  // item field → field link
            for (const t of it.tells || []) if (t.field === oldFid) t.field = newFid;   // text tell validates on it
            if (it.key) it.key.fields = swap(it.key.fields);                            // per-item record key
        }
        if (win.key) win.key.fields = swap(win.key.fields);                             // window default key (items inherit)
        // dataset key_field override — for every dataset this window feeds (several windows can share one)
        const d = this.datasetDef(this.datasetOf(win));
        if (d && d.key_field === oldFid) d.key_field = newFid;
    }

    datasets() {
        const set = new Set();
        for (const st of this._datasetSites()) if (st.decl) { const v = st.get(); if (v) set.add(v); }   // declaration sites only
        (this._extraDatasets || []).forEach((d) => set.add(d));   // names found on disk
        return [...set];
    }

    // ---- producers: fetch external data into an output dataset ----------------
    producerNode(id) { return (this.profile.producers || []).find((p) => p.id === id) || null; }
    // a fresh producer is born UNWIRED — no output dataset (the user drags its out-port to one,
    // or onto empty canvas to mint one). Never auto-create/attach a dataset here.
    addProducer(dataset = "", type = "http") {
        this.profile.producers = this.profile.producers || [];
        let n = 1, id = "producer";
        while (this.producerNode(id)) id = `producer_${++n}`;
        if (dataset) this.ensureDatasetDef(dataset);
        const pn = { id, type, mode: "", dataset, throttle: 0.4, enabled: true, sources: [] };
        if (type === "http") pn.http = this._blankHttp();
        this.profile.producers.push(pn);
        return id;
    }
    // A fresh http spec: no request, slugify keys, no mapping, per-item mode (empty explode) —
    // the user teaches it all in the UI.
    _blankHttp() {
        return { request: { method: "GET", url: "", headers: {}, query: {}, timeout: 30 },
                 key_transform: "slugify", key_encode: true, catalogue: null, root: "", explode: [], fields: [] };
    }
    _blankCatalogue() {
        return { url: "", items_path: "data", name_path: "", key_path: "", fuzzy: 0.9, ttl_days: 7, suffix_hints: [] };
    }
    removeProducer(id) { this.profile.producers = (this.profile.producers || []).filter((p) => p.id !== id); this._dropTarget(id); }
    renameProducer(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.producerNode(newId)) return false;
        this.producerNode(oldId).id = newId;
        this._repointTargets(oldId, newId);   // a trigger may target this producer — carry its wire
        this._emitRename("producer", oldId, newId);
        return true;
    }
    // the producer backend (registry._PRODUCER): currently just http. Switching it rebuilds the node.
    setProducerType(id, type) {
        const pn = this.producerNode(id);
        if (!pn || !type) return;
        pn.type = type;
        if (type === "http" && !pn.http) pn.http = this._blankHttp();
    }
    setProducerDataset(id, ds) {
        const pn = this.producerNode(id);
        if (pn && ds) { pn.dataset = ds; this.ensureDatasetDef(ds); }
    }
    // status-label only (no behaviour) — shown in the node so a sweep's progress copy reads sensibly.
    setProducerMode(id, mode) { const pn = this.producerNode(id); if (pn) pn.mode = mode || ""; }
    setProducerThrottle(id, v) { const pn = this.producerNode(id); if (pn) pn.throttle = Math.max(0, parseFloat(v) || 0); }
    setProducerEnabled(id, on) { const pn = this.producerNode(id); if (pn) pn.enabled = !!on; }

    // ---- http spec mutators (one per teachable knob; no knob without a setter) ----
    _http(id) { const pn = this.producerNode(id); return pn && pn.http ? pn.http : null; }
    setHttpMethod(id, m) { const s = this._http(id); if (s) s.request.method = m || "GET"; }
    setHttpUrl(id, u) { const s = this._http(id); if (s) s.request.url = u || ""; }
    setHttpTimeout(id, t) { const s = this._http(id); if (s) s.request.timeout = Math.max(0, parseFloat(t) || 0); }
    // headers/query are maps; the panel rebuilds the whole {k:v} from its rows on each edit.
    setProducerMap(id, kind, obj) { const s = this._http(id); if (s && (kind === "headers" || kind === "query")) s.request[kind] = obj || {}; }
    setHttpKeyTransform(id, m) {
        const s = this._http(id); if (!s) return;
        s.key_transform = m;
        if (m === "catalogue" && !s.catalogue) s.catalogue = this._blankCatalogue();
    }
    setHttpKeyEncode(id, on) { const s = this._http(id); if (s) s.key_encode = !!on; }
    setHttpRoot(id, r) { const s = this._http(id); if (s) s.root = r || ""; }
    // list-mode explode paths (nested arrays expanded into one row each). Non-empty -> list mode.
    addHttpExplode(id) { const s = this._http(id); if (s) (s.explode = s.explode || []).push(""); }
    removeHttpExplode(id, i) { const s = this._http(id); if (s && s.explode) s.explode.splice(i, 1); }
    setHttpExplode(id, i, v) { const s = this._http(id); if (s && s.explode && i < s.explode.length) s.explode[i] = v || ""; }
    setHttpCatalogue(id, patch) {
        const s = this._http(id); if (!s) return;
        s.catalogue = Object.assign(s.catalogue || this._blankCatalogue(), patch);
    }
    // response field mapping (each row = one output column)
    addHttpField(id) { const s = this._http(id); if (s) s.fields.push({ out_field: "", path: "", template: "", type: "text", required: false }); }
    removeHttpField(id, i) { const s = this._http(id); if (s) s.fields.splice(i, 1); }
    setHttpField(id, i, patch) { const s = this._http(id); if (s && s.fields[i]) Object.assign(s.fields[i], patch); }
    toggleHttpFieldArray(id, i, on) {
        const s = this._http(id); if (!s || !s.fields[i]) return;
        s.fields[i].array = on ? { filter: [], pluck: "", agg: "min", depth: 5 } : null;
    }
    setHttpFieldArray(id, i, patch) { const s = this._http(id); if (s && s.fields[i] && s.fields[i].array) Object.assign(s.fields[i].array, patch); }
    addHttpFilter(id, i) { const s = this._http(id); if (s && s.fields[i] && s.fields[i].array) s.fields[i].array.filter.push({ path: "", op: "eq", value: "" }); }
    removeHttpFilter(id, i, fi) { const s = this._http(id); if (s && s.fields[i] && s.fields[i].array) s.fields[i].array.filter.splice(fi, 1); }
    setHttpFilter(id, i, fi, patch) {
        const s = this._http(id); if (!s || !s.fields[i] || !s.fields[i].array) return;
        const flt = s.fields[i].array.filter[fi]; if (!flt) return;
        Object.assign(flt, patch);
        // in/nin take a list; split a comma string so the spec matches how the server evaluates it.
        if ((flt.op === "in" || flt.op === "nin") && typeof flt.value === "string") {
            flt.value = flt.value.split(",").map((x) => x.trim()).filter(Boolean);
        } else if (flt.op !== "in" && flt.op !== "nin" && Array.isArray(flt.value)) {
            flt.value = flt.value.join(", ");
        }
    }
    // an http node's item sources (datasets/subsets) — the names it fetches. A node may not
    // source its own output dataset (a self-loop). Returns true when the wire was added.
    addProducerSource(id, ds) {
        const pn = this.producerNode(id);
        if (!pn || !ds || ds === pn.dataset) return false;
        pn.sources = pn.sources || [];
        if (pn.sources.includes(ds)) return false;
        pn.sources.push(ds);
        return true;
    }
    removeProducerSource(id, ds) { const pn = this.producerNode(id); if (pn) pn.sources = (pn.sources || []).filter((d) => d !== ds); }
    // datasets + subsets a producer can still add as a priced-item source (minus current ones
    // and its own output dataset) — feeds the same chip/add-select input the subset uses.
    producerJoinable(pn) {
        const cur = new Set(pn.sources || []);
        const out = [];
        for (const d of this.datasets()) if (!cur.has(d) && d !== pn.dataset) out.push(d);
        for (const s of this.profile.subsets || []) if (!cur.has(s.id)) out.push(s.id);
        return out;
    }
    // which source column names the item (fed to the URL template / catalogue resolver). Default "name".
    setProducerSourceField(id, f) { const pn = this.producerNode(id); if (pn) pn.source_field = f || "name"; }
    // columns available across a producer's source datasets/subsets (for the name-field picker)
    producerSourceColumns(pn) {
        const out = [];
        const add = (c) => { if (c && !out.includes(c)) out.push(c); };
        for (const src of (pn.sources || [])) {
            if (this.subsetDef(src)) this.subsetColumns(src).forEach(add);
            else this.datasetFields(src).forEach(add);
        }
        return out;
    }

    // ---- triggers: fire price-node sweeps on a condition ---------------------
    trigger(id) { return (this.profile.triggers || []).find((t) => t.id === id) || null; }
    addTrigger(kind = "interval") {
        this.profile.triggers = this.profile.triggers || [];
        let n = 1, id = "trigger";
        while (this.trigger(id)) id = `trigger_${++n}`;
        this.profile.triggers.push({ id, kind, interval_s: 300, watch: [], targets: [], enabled: true, dataset_targets: [], dataset_action: "", dataset_dest: "" });
        return id;
    }
    removeTrigger(id) { this.profile.triggers = (this.profile.triggers || []).filter((t) => t.id !== id); }
    renameTrigger(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.trigger(newId)) return false;
        this.trigger(oldId).id = newId;
        this._emitRename("trigger", oldId, newId);
        return true;
    }
    setTriggerKind(id, kind) { const t = this.trigger(id); if (t && ["interval", "on_change", "on_app_start", "on_capture", "on_live_start", "on_live_stop", "on_readout", "manual"].includes(kind)) t.kind = kind; }
    setTriggerInterval(id, s) { const t = this.trigger(id); const v = parseFloat(s); if (t && v > 0) t.interval_s = v; }
    addTriggerTarget(id, pid) {
        const t = this.trigger(id);
        // a target is a price node (sweep), a file source (read), a toast (notify), OR a sound (play) — accept any id
        if (!t || !pid || !(this.producerNode(pid) || this.fileSource(pid) || this.toastNode(pid) || this.soundNode(pid))) return false;
        t.targets = t.targets || [];
        if (t.targets.includes(pid)) return false;
        t.targets.push(pid);
        return true;
    }
    removeTriggerTarget(id, pid) { const t = this.trigger(id); if (t) t.targets = (t.targets || []).filter((p) => p !== pid); }
    addTriggerWatch(id, ds) {
        const t = this.trigger(id);
        if (!t || !ds) return false;
        t.watch = t.watch || [];
        if (t.watch.includes(ds)) return false;
        t.watch.push(ds);
        return true;
    }
    removeTriggerWatch(id, ds) { const t = this.trigger(id); if (t) t.watch = (t.watch || []).filter((d) => d !== ds); }

    // ---- on_readout: watch live readouts + a threshold condition ----
    addTriggerReadoutWatch(id, vid) {
        const t = this.trigger(id);
        if (!t || !vid) return false;
        t.readout_watch = t.readout_watch || [];
        if (t.readout_watch.includes(vid)) return false;
        t.readout_watch.push(vid);
        return true;
    }
    removeTriggerReadoutWatch(id, vid) { const t = this.trigger(id); if (t) t.readout_watch = (t.readout_watch || []).filter((v) => v !== vid); }
    static TRIGGER_READOUT_OPS = ["gte", "lte", "gt", "lt", "eq", "ne", "crosses_up", "crosses_down"];
    setTriggerReadoutOp(id, op) { const t = this.trigger(id); if (t && GraphModel.TRIGGER_READOUT_OPS.includes(op)) t.readout_op = op; }
    setTriggerReadoutValue(id, v) { const t = this.trigger(id); const n = parseFloat(v); if (t && !Number.isNaN(n)) t.readout_value = n; }

    // ---- dataset actions: a trigger can clear / clone / move a dataset's data ----
    static TRIGGER_DS_ACTIONS = ["", "clear", "clone_batches", "clone_resolved", "move_batches", "move_resolved"];
    addTriggerDataset(id, ds) {
        const t = this.trigger(id);
        if (!t || !ds || !this.datasets().includes(ds)) return false;
        t.dataset_targets = t.dataset_targets || [];
        if (t.dataset_targets.includes(ds)) return false;
        t.dataset_targets.push(ds);
        return true;
    }
    removeTriggerDataset(id, ds) { const t = this.trigger(id); if (t) t.dataset_targets = (t.dataset_targets || []).filter((d) => d !== ds); }
    setTriggerDatasetAction(id, v) { const t = this.trigger(id); if (t && GraphModel.TRIGGER_DS_ACTIONS.includes(v)) t.dataset_action = v; }
    setTriggerDatasetDest(id, v) { const t = this.trigger(id); if (t) t.dataset_dest = v || ""; }

    // ---- toasts: raise an OS notification when fired (a trigger target) -------
    toastNode(id) { return (this.profile.toasts || []).find((x) => x.id === id) || null; }
    addToast() {
        this.profile.toasts = this.profile.toasts || [];
        let n = 1, id = "toast";
        while (this.toastNode(id)) id = `toast_${++n}`;
        this.profile.toasts.push({ id, title: "", message: "", app_name: "data-occultist",
            duration: "short", icon: "", attribution: "", muted: false, enabled: true });
        return id;
    }
    removeToast(id) { this.profile.toasts = (this.profile.toasts || []).filter((x) => x.id !== id); this._dropTarget(id); }
    renameToast(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.toastNode(newId)) return false;
        this.toastNode(oldId).id = newId;
        this._repointTargets(oldId, newId);   // a toast id can be a trigger target — carry its wire
        return true;
    }
    static TOAST_DURATIONS = ["short", "long"];
    // scalar props: title | message | app_name | icon | attribution (text) | duration (short|long) | muted | enabled (bool)
    setToastProp(id, key, val) {
        const x = this.toastNode(id); if (!x) return;
        if (key === "muted" || key === "enabled") x[key] = !!val;
        else if (key === "duration") x.duration = GraphModel.TOAST_DURATIONS.includes(val) ? val : "short";
        else if (["title", "message", "app_name", "icon", "attribution"].includes(key)) x[key] = val ?? "";
    }

    // ---- sounds: play an audio file (in the browser) when fired (a trigger target) ----
    soundNode(id) { return (this.profile.sounds || []).find((x) => x.id === id) || null; }
    addSound() {
        this.profile.sounds = this.profile.sounds || [];
        let n = 1, id = "sound";
        while (this.soundNode(id)) id = `sound_${++n}`;
        this.profile.sounds.push({ id, file: "", volume: 1, enabled: true });
        return id;
    }
    removeSound(id) { this.profile.sounds = (this.profile.sounds || []).filter((x) => x.id !== id); this._dropTarget(id); }
    renameSound(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.soundNode(newId)) return false;
        this.soundNode(oldId).id = newId;
        this._repointTargets(oldId, newId);   // a sound id can be a trigger target — carry its wire
        return true;
    }
    setSoundFile(id, v) { const x = this.soundNode(id); if (x) x.file = v || ""; }
    setSoundVolume(id, v) { const x = this.soundNode(id); const n = parseFloat(v); if (x && !Number.isNaN(n)) x.volume = Math.max(0, Math.min(1, n)); }

    // ---- file sources: parse a game log/config file into a dataset -----------
    fileSource(id) { return (this.profile.file_sources || []).find((s) => s.id === id) || null; }
    addFileSource(dataset = "") {
        this.profile.file_sources = this.profile.file_sources || [];
        let n = 1, id = "source";
        while (this.fileSource(id)) id = `source_${++n}`;
        if (dataset) this.ensureDatasetDef(dataset);
        this.profile.file_sources.push({ id, format: "log_lines", path: "", filename: "", roots: [],
            dataset, watch: "manual", throttle_s: 1, tail: true, tail_lines: 200, match: [], fields: [], enabled: true });
        return id;
    }
    removeFileSource(id) { this.profile.file_sources = (this.profile.file_sources || []).filter((s) => s.id !== id); this._dropTarget(id); }
    renameFileSource(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.fileSource(newId)) return false;
        this.fileSource(oldId).id = newId;
        this._repointTargets(oldId, newId);   // a source id can be a trigger target — carry its wire
        return true;
    }
    setSourceDataset(id, ds) { const s = this.fileSource(id); if (s && ds) { s.dataset = ds; this.ensureDatasetDef(ds); } }
    setSourceFormat(id, fmt) {
        const s = this.fileSource(id); if (!s || !fmt) return;
        s.format = fmt;
        // document formats extract ONLY by path; line formats use after/between/column/whole. Keep
        // each field's method valid for the new format so the parser doesn't silently skip it.
        const isDoc = fmt !== "log_lines";
        for (const f of s.fields || []) {
            if (isDoc) f.method = "path";
            else if (f.method === "path") f.method = "after";
        }
    }
    // simple scalar props: path | filename | watch | throttle_s | tail | line_position
    setSourceProp(id, key, val) {
        const s = this.fileSource(id); if (!s) return;
        if (key === "throttle_s") { const v = parseFloat(val); if (v >= 0) s.throttle_s = v; }
        else if (key === "tail") s.tail = !!val;
        else if (key === "line_position") s.line_position = !!val;
        else if (key === "watch") s.watch = val === "on_change" ? "on_change" : "manual";
        else if (key === "path" || key === "filename") s[key] = val || "";
    }
    // ---- a source's line filters (match clauses) -----------------------------
    addSourceMatch(id) { const s = this.fileSource(id); if (s) { s.match = s.match || []; s.match.push({ op: "contains", text: "", case_sensitive: false }); } }
    removeSourceMatch(id, i) { const s = this.fileSource(id); if (s && s.match) s.match.splice(i, 1); }
    setSourceMatch(id, i, key, val) {
        const s = this.fileSource(id); const m = s && s.match && s.match[i]; if (!m) return;
        if (key === "case_sensitive") m.case_sensitive = !!val; else m[key] = val ?? "";
    }
    // ---- a source's extraction fields ----------------------------------------
    addSourceField(id) {
        const s = this.fileSource(id); if (!s) return;
        s.fields = s.fields || [];
        let n = s.fields.length + 1, fid = `field${n}`;
        while (s.fields.some((f) => f.id === fid)) fid = `field${++n}`;
        // log formats default to an after-anchor pull; document formats to a path lookup
        const isDoc = s.format !== "log_lines";
        s.fields.push({ id: fid, method: isDoc ? "path" : "after", anchor: "", end: "", stop: "",
            delim: " ", index: 0, path: "", type: "text", strip: true, required: true });
    }
    removeSourceField(id, i) { const s = this.fileSource(id); if (s && s.fields) s.fields.splice(i, 1); }
    // Merge auto-resolved fields into a source, NEVER removing existing ones. Skip a suggestion whose
    // extraction already exists (same path, or same column delim+index) so re-running doesn't pile up
    // dupes; append the rest, suffixing any id that collides with an existing field. Returns the count
    // actually added.
    mergeSourceFields(id, fields) {
        const s = this.fileSource(id);
        if (!s || !Array.isArray(fields)) return 0;
        s.fields = s.fields || [];
        const sig = (f) => f.method === "path" ? `path:${f.path || ""}`
            : f.method === "column" ? `col:${f.delim ?? " "}:${f.index ?? 0}`
                : `${f.method}:${f.anchor || ""}:${f.end || ""}:${f.stop || ""}`;
        const haveSig = new Set(s.fields.map(sig));
        const haveId = new Set(s.fields.map((f) => f.id));
        let added = 0;
        for (const f of fields) {
            if (haveSig.has(sig(f))) continue;   // same column already extracted -> skip
            let fid = f.id || "field"; const base = fid; let n = 1;
            while (haveId.has(fid)) fid = `${base}_${++n}`;
            haveId.add(fid); haveSig.add(sig(f));
            s.fields.push({ ...f, id: fid });
            added++;
        }
        return added;
    }
    setSourceFieldProp(id, i, key, val) {
        const s = this.fileSource(id); const f = s && s.fields && s.fields[i]; if (!f) return;
        if (key === "index") { const v = parseInt(val, 10); f.index = Number.isNaN(v) ? 0 : v; }
        else if (key === "strip" || key === "required") f[key] = !!val;
        else f[key] = val ?? "";
    }

    // ---- dictionaries: game-level word lists for fuzzy OCR matching ----------
    dictionary(id) { return (this.profile.dictionaries || []).find((d) => d.id === id) || null; }
    dictionaryBySource(source) { return (this.profile.dictionaries || []).find((d) => d.source === source) || null; }
    // Add a dictionary node. `opts` may pin an existing term file (`source` + its
    // `terms`/`name`); without one it defaults a fresh file named after the id.
    addDictionary(opts = {}) {
        this.profile.dictionaries = this.profile.dictionaries || [];
        let id = opts.id;
        if (!id) { let n = 1; do { id = `dict_${n++}`; } while (this.dictionary(id)); }
        else if (this.dictionary(id)) return false;
        // terms live in config/dictionaries/<source>; default the filename to the id
        const source = opts.source || `${id}.txt`;
        this.profile.dictionaries.push({ id, enabled: true, source, terms: opts.terms || [] });
        return id;
    }
    // Every FieldDef that pins a dictionary — the single place dict ids are referenced, so
    // remove/rename repoint through here (a field's `dictionary` is a soft ref; the resolver
    // already falls back to the pooled default when it points at nothing).
    _dictFields() { return (this.profile.windows || []).flatMap((w) => w.fields || []); }
    removeDictionary(id) {
        this.profile.dictionaries = (this.profile.dictionaries || []).filter((d) => d.id !== id);
        for (const f of this._dictFields()) if (f.dictionary === id) f.dictionary = "";   // pinned field -> pooled
    }
    renameDictionary(oldId, newId) {
        newId = (newId || "").trim();
        const d = this.dictionary(oldId);
        if (!d || !newId || newId === oldId || this.dictionary(newId)) return false;
        d.id = newId;
        for (const f of this._dictFields()) if (f.dictionary === oldId) f.dictionary = newId;   // keep pins pointing at it
        return true;
    }
    setDictionaryTerms(id, terms) { const d = this.dictionary(id); if (d) d.terms = terms; }

    // ---- dictionary feeds: a dataset pushes its column values in as terms ----
    // Non-empty feeds => the term list is DERIVED (pulled from the datasets, deduped on save),
    // not hand-typed. The pull runs server-side (oc.learn.dict_feed) on save / on data change.
    dictFeeds(id) { const d = this.dictionary(id); return (d && d.feeds) || []; }
    dictFeed(id, ds) { return this.dictFeeds(id).find((f) => f.dataset === ds) || null; }
    // whether this dictionary pulls its terms from any dataset (drives the read-only textarea hint)
    dictIsFed(id) { return this.dictFeeds(id).some((f) => f.dataset); }
    // Wire a dataset -> dictionary: add a feed (no columns picked yet -> pulls nothing until chosen).
    addDictFeed(id, ds) {
        const d = this.dictionary(id); if (!d || !ds) return false;
        d.feeds = d.feeds || [];
        if (d.feeds.some((f) => f.dataset === ds)) return false;   // already fed by it
        d.feeds.push({ dataset: ds, columns: [] });
        return true;
    }
    removeDictFeed(id, ds) {
        const d = this.dictionary(id); if (!d) return;
        d.feeds = (d.feeds || []).filter((f) => f.dataset !== ds);
    }
    // columns of one feed pulled into the dictionary (each selected column's values become terms)
    dictFeedColumns(id, ds) { const f = this.dictFeed(id, ds); return (f && f.columns) || []; }
    toggleDictFeedColumn(id, ds, col) {
        const f = this.dictFeed(id, ds); if (!f) return;
        f.columns = f.columns || [];
        const i = f.columns.indexOf(col);
        if (i >= 0) f.columns.splice(i, 1); else f.columns.push(col);
    }

    // duplicate a dataset's definition under a fresh id; a window can then be wired to it
    cloneDataset(id) {
        let n = 2, newId = `${id}-copy`;
        while (this.datasets().includes(newId)) newId = `${id}-copy${n++}`;
        (this.profile.datasets = this.profile.datasets || []).push({ id: newId });
        return newId;
    }

    // Deep-copy an entry in `list` under a fresh non-colliding id (`<id>-copy`, `-copy2`, …).
    // ONE cloner for every id-keyed node kind (rule 7): the clone is a full independent copy of
    // the model object, so editing it never touches the original. Returns the new id (or null).
    _cloneById(list, id, has) {
        const src = (list || []).find((x) => x.id === id);
        if (!src) return null;
        const copy = structuredClone(src);
        let n = 2, nid = `${id}-copy`;
        while (has(nid)) nid = `${id}-copy${n++}`;
        copy.id = nid;
        list.push(copy);
        return nid;
    }
    cloneWindow(id) { return this._cloneById(this.profile.windows, id, (x) => !!this.window(x)); }
    cloneSubset(id) { this.profile.subsets = this.profile.subsets || []; return this._cloneById(this.profile.subsets, id, (x) => !!this.subsetDef(x)); }
    cloneProducer(id) { this.profile.producers = this.profile.producers || []; return this._cloneById(this.profile.producers, id, (x) => !!this.producerNode(x)); }
    cloneTrigger(id) { this.profile.triggers = this.profile.triggers || []; return this._cloneById(this.profile.triggers, id, (x) => (this.profile.triggers || []).some((t) => t.id === x)); }
    cloneFileSource(id) { this.profile.file_sources = this.profile.file_sources || []; return this._cloneById(this.profile.file_sources, id, (x) => !!this.fileSource(x)); }
    cloneDictionary(id) { this.profile.dictionaries = this.profile.dictionaries || []; return this._cloneById(this.profile.dictionaries, id, (x) => !!this.dictionary(x)); }
    removeDatasetDef(id) { this.profile.datasets = (this.profile.datasets || []).filter((d) => d.id !== id); }

    // Unwire every site holding a removed dataset/subset id (declarations AND references) and
    // prune the now-empty list entries — the inverse of renameDataset's repoint sweep. SHARED by
    // dataset and subset deletion: a subset id lives in the very same ref sites a dataset does, so
    // one sweep keeps every connected party (window/producer/source/subset/trigger) consistent.
    _unwireDataset(id) {
        for (const st of this._datasetSites()) if (st.get() === id) st.set("");   // decl: unwire feeder; ref: emptied
        for (const pn of this.profile.producers || []) pn.sources = (pn.sources || []).filter(Boolean);
        for (const s of this.profile.subsets || []) s.sources = (s.sources || []).filter((src) => src.dataset);
        for (const t of this.profile.triggers || []) {
            t.watch = (t.watch || []).filter(Boolean);
            t.dataset_targets = (t.dataset_targets || []).filter(Boolean);   // _datasetSites() blanked the deleted id
        }
        if (this._extraDatasets) this._extraDatasets = this._extraDatasets.filter((x) => x !== id);
    }

    // Fully delete a dataset: drop its def AND unwire every feeder/reference still holding
    // the id, so datasets() (and the server's used_datasets) can't re-derive the node.
    removeDataset(id) {
        this.removeDatasetDef(id);   // drop the def object first...
        this._unwireDataset(id);     // ...then unwire every remaining holder
    }

    // mint a fresh empty dataset (e.g. dragging a producer's wire onto empty canvas)
    addDataset(base = "dataset") {
        let n = 1, id = base;
        while (this.datasets().includes(id)) id = `${base}_${++n}`;
        this.ensureDatasetDef(id);
        return id;
    }

    // ---- subsets: join one or more datasets, then filter/derive/sort ----------
    subsetDef(id) { return (this.profile.subsets || []).find((s) => s.id === id) || null; }
    // a subset's source dataset/subset ids (each source joins on its own field), in order
    subsetInputs(s) { return (s && s.sources || []).map((src) => src.dataset).filter(Boolean); }
    // the JoinSource entry for one input id (its per-source join_field/norm/aggregate/required)
    subsetSource(id, ds) { const s = this.subsetDef(id); return s ? (s.sources || []).find((src) => src.dataset === ds) || null : null; }
    // a fresh JoinSource with sane defaults (joins on `name`, latest, optional/outer)
    _newSource(ds) {
        return { dataset: ds, join_field: "name", aggregate: "latest", required: false,
            join_norm: { case_insensitive: true, strip_punct: false, collapse_ws: true, strip_words: [] } };
    }
    // `ds` (optional) seeds the subset's first input + name. Omitted (e.g. minted from the
    // canvas add-node menu) -> a standalone, input-less subset named "subset" the user wires later.
    addSubset(ds = null) {
        const base = ds ? `${ds}_view` : "subset";
        let n = 1, id = base;
        while (this.subsetDef(id)) id = ds ? `${ds}_view${++n}` : `subset_${++n}`;
        (this.profile.subsets = this.profile.subsets || []).push({
            id, sources: ds ? [this._newSource(ds)] : [],
            filters: [], derived: [], hidden_columns: [], enrich: [], sort: [], sort_by: "", sort_desc: false, latest_batch: false, limit: 0,
        });
        return id;
    }
    // Delete a subset: drop its def, then unwire it from every connected party. A subset can feed
    // other subsets, producers, and trigger watches (the same ref sites a dataset uses), so removal
    // must clear those refs or they dangle to a node that no longer exists.
    removeSubset(id) {
        this.profile.subsets = (this.profile.subsets || []).filter((s) => s.id !== id);
        this._unwireDataset(id);
    }
    renameSubset(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.subsetDef(newId)) return false;
        this.subsetDef(oldId).id = newId;
        this._repointRefs(oldId, newId);   // a subset can feed another subset — repoint those inputs too
        this._emitRename("subset", oldId, newId);
        return true;
    }
    // does subset `fromId` use `targetId` as a (transitive) input? Used to refuse cycles.
    subsetReaches(fromId, targetId) {
        const seen = new Set();
        const stack = [fromId];
        while (stack.length) {
            const cur = stack.pop();
            if (cur === targetId) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            const sd = this.subsetDef(cur);
            if (sd) for (const inp of this.subsetInputs(sd)) stack.push(inp);
        }
        return false;
    }
    // add/remove a source (dataset OR another subset) to a subset's join inputs. Refuses self-
    // reference and any cycle (would loop forever when computing the subset).
    addSubsetInput(id, ds) {
        const s = this.subsetDef(id);
        if (!s || !ds || ds === id) return false;
        if (this.subsetDef(ds) && this.subsetReaches(ds, id)) return false;   // ds already depends on id -> cycle
        s.sources = s.sources || [];
        if (s.sources.some((src) => src.dataset === ds)) return false;
        s.sources.push(this._newSource(ds));
        return true;
    }
    removeSubsetInput(id, ds) {
        const s = this.subsetDef(id);
        if (s) s.sources = (s.sources || []).filter((src) => src.dataset !== ds);
    }
    // ---- per-source join config (each input carries its own) ----------------
    // "" = this source does NOT join (its rows stack standalone); else it joins on that column
    setSourceJoinField(id, ds, field) { const src = this.subsetSource(id, ds); if (src) src.join_field = field || ""; }
    // required = key must be present in this source (inner-style); optional = outer gap-fill
    setSourceRequired(id, ds, on) { const src = this.subsetSource(id, ds); if (src) src.required = !!on; }
    // join_norm: how THIS source's join value is canonicalised before matching (bridges near-match keys)
    sourceJoinNorm(id, ds) {
        const n = (this.subsetSource(id, ds) || {}).join_norm || {};
        return { case_insensitive: n.case_insensitive !== false, strip_punct: !!n.strip_punct,
            collapse_ws: n.collapse_ws !== false, strip_words: n.strip_words || [] };
    }
    setSourceJoinNorm(id, ds, patch) { const src = this.subsetSource(id, ds); if (src) src.join_norm = { ...this.sourceJoinNorm(id, ds), ...patch }; }
    // parse the free-typed words box (space/comma separated) into a deduped list
    setSourceStripWords(id, ds, str) {
        const words = [...new Set(String(str || "").split(/[\s,]+/).filter(Boolean))];
        this.setSourceJoinNorm(id, ds, { strip_words: words });
    }
    // how THIS source's MANY observations collapse to one value when the subset reads it
    sourceAggregate(id, ds) { const src = this.subsetSource(id, ds); return (src && src.aggregate) || "latest"; }
    setSourceAggregate(id, ds, agg) { const src = this.subsetSource(id, ds); if (src) src.aggregate = agg || "latest"; }
    // only pull rows from each source's most recent collection batch (applied first)
    setSubsetLatestBatch(id, on) { const s = this.subsetDef(id); if (s) s.latest_batch = !!on; }
    // cap the number of result rows (0 = no limit)
    setSubsetLimit(id, n) { const s = this.subsetDef(id); if (s) s.limit = Math.max(0, Math.floor(+n || 0)); }
    // swap one of a subset's source inputs for another (the row-select edit), preserving order +
    // the slot's per-source join config (only the dataset id changes)
    replaceSubsetInput(id, oldDs, newDs) {
        const s = this.subsetDef(id);
        if (!s || oldDs === newDs) return false;
        if (newDs === id) return false;
        if (this.subsetDef(newDs) && this.subsetReaches(newDs, id)) return false;   // cycle
        s.sources = s.sources || [];
        if (s.sources.some((src) => src.dataset === newDs)) return false;           // dupe
        const src = s.sources.find((x) => x.dataset === oldDs);
        if (!src) return false;
        src.dataset = newDs;
        return true;
    }
    // columns a subset can reference: every input's columns + this subset's derived names. A
    // dataset input contributes its feeders' columns (datasetFields: windows/sources/producers); a
    // SUBSET input contributes its own output columns (recursively, so an upstream subset's derived
    // columns are visible downstream). `_seen` guards against an input cycle.
    subsetColumns(id, _seen) {
        const s = this.subsetDef(id);
        if (!s) return [];
        _seen = _seen || new Set();
        if (_seen.has(id)) return [];
        _seen.add(id);
        const out = [];
        const add = (c) => { if (c && !out.includes(c)) out.push(c); };
        for (const inp of this.subsetInputs(s)) {
            if (this.subsetDef(inp)) { this.subsetColumns(inp, _seen).forEach(add); continue; }   // subset input
            this.datasetFields(inp).forEach(add);   // includes producer/source columns now
        }
        for (const d of s.derived || []) if (d.name) add(d.name);
        return out;
    }
    // the columns ONE input (dataset or subset) contributes — used to pick that source's join field
    inputColumns(id) { return this.subsetDef(id) ? this.subsetColumns(id) : this.datasetFields(id); }
    // sources a subset can still add as an input: datasets + OTHER subsets, minus its current
    // inputs, itself, and any subset that already depends on it (would form a cycle).
    joinableInputs(s) {
        const inputs = this.subsetInputs(s);
        const out = [];
        for (const d of this.datasets()) if (!inputs.includes(d)) out.push(d);
        for (const o of this.profile.subsets || [])
            if (o.id !== s.id && !inputs.includes(o.id) && !this.subsetReaches(o.id, s.id)) out.push(o.id);
        return out;
    }
    addFilter(id) { (this.subsetDef(id).filters ||= []).push({ field: "", op: "contains", value: "" }); }
    removeFilter(id, i) { this.subsetDef(id).filters.splice(i, 1); }
    // multi-column sort (primary first), applied before limit
    addSort(id) { (this.subsetDef(id).sort ||= []).push({ field: "", desc: false }); }
    removeSort(id, i) { const s = this.subsetDef(id); if (s && s.sort) s.sort.splice(i, 1); }
    addDerived(id) { (this.subsetDef(id).derived ||= []).push({ name: "", template: "" }); }
    removeDerived(id, i) { this.subsetDef(id).derived.splice(i, 1); }
    // hide/show a result column (toggle membership of hidden_columns)
    toggleHiddenColumn(id, col) {
        const s = this.subsetDef(id); if (!s) return;
        s.hidden_columns ||= [];
        const i = s.hidden_columns.indexOf(col);
        if (i >= 0) s.hidden_columns.splice(i, 1); else s.hidden_columns.push(col);
    }

    // ---- edit ops -----------------------------------------------------------

    addWindow(id) {
        if (!id) { let n = 1; do { id = `window_${n++}`; } while (this.profile.windows.some((w) => w.id === id)); }
        else if (this.profile.windows.some((w) => w.id === id)) return false;
        this.profile.windows.push({ id, dataset: null, fields: [], detect: [], states: [], regions: [] });
        return id;
    }
    removeWindow(id) {
        this.profile.windows = this.profile.windows.filter((w) => w.id !== id);
        // prune the priority entry too — renameWindow repoints it, so delete must drop it (else a
        // stale id lingers in window_priority and resurfaces if the id is ever reused)
        this.profile.window_priority = (this.profile.window_priority || []).filter((x) => x !== id);
    }
    window(id) { return this.profile.windows.find((w) => w.id === id); }
    // The single "follow the lines" resolver: which window's detect/OCR an edit can change.
    // Returns the owning window id for any window-structural node (the window itself, or any
    // region/detect/scrollbar/item/field/tell/preview under it), or null for a data-plane /
    // game node (ds/sub/producer/src/trigger/dict) or a bare id with no live window. This is
    // the ONLY place an edit maps to a re-fire scope — drives every autosave refresh (main.js).
    windowOf(id) {
        if (!id || typeof id !== "string") return null;
        if (this.window(id)) return id;                  // a bare window id resolves to itself
        const m = /^(?:win|prev|reg|det|sb|item|fld|tell|ro):([^:]+)/.exec(id);
        return m && this.window(m[1]) ? m[1] : null;     // validate the window still exists
    }
    // whether the live view attempts this window (default true)
    setWindowLive(id, on) { const w = this.window(id); if (w) w.live = !!on; }

    // ---- window recognition priority (game node) ----------------------------
    // The live-toggled windows in classify order. Stored on profile.window_priority as an
    // ordered id list; only `live` windows are shown/kept (a window turned live-off drops out,
    // turned live-on re-appears at the end). Ids in window_priority come first (in order), then
    // any live window not yet listed, in profile order.
    liveWindowsInPriority() {
        const order = this.profile.window_priority || [];
        const rank = new Map(order.map((id, i) => [id, i]));
        return this.profile.windows
            .filter((w) => w.live !== false)
            .sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
    }
    // Persist the current live-window order back to window_priority (live ids only).
    _syncWindowPriority() { this.profile.window_priority = this.liveWindowsInPriority().map((w) => w.id); }
    // Move a live window up (-1) / down (+1) in the priority list, then re-persist the order.
    moveWindowPriority(id, dir) {
        const wins = this.liveWindowsInPriority();
        const i = wins.findIndex((w) => w.id === id);
        const j = i + (dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= wins.length) return false;
        [wins[i], wins[j]] = [wins[j], wins[i]];
        this.profile.window_priority = wins.map((w) => w.id);
        return true;
    }

    renameWindow(oldId, newId) {
        const w = this.window(oldId);
        if (!w || !newId || this.profile.windows.some((x) => x.id === newId)) return false;
        w.id = newId;
        // repoint any priority entry so the order survives a rename
        this.profile.window_priority = (this.profile.window_priority || []).map((id) => id === oldId ? newId : id);
        this._emitRename("window", oldId, newId);
        return true;
    }

    addField(winId, id) {
        const w = this.window(winId);
        if (!w) return;
        w.fields = w.fields || [];
        const fid = id || `field_${_fieldSeq++}`;
        if (!w.fields.some((f) => f.id === fid))
            w.fields.push({ id: fid, type: "text", extract: "whole", separator: "/", fuzzy: 0.82 });
    }
    // ---- regions (drawn on the window image) --------------------------------

    // Create a region from a fraction box; also creates its linked field. Returns id.
    addRegion(winId, box) {
        const w = this.window(winId);
        if (!w) return null;
        w.regions = w.regions || [];
        let id = "field_" + _fieldSeq++;
        while (w.regions.some((r) => r.id === id)) id = "field_" + _fieldSeq++;
        w.regions.push({ id, box: { x: box.x, y: box.y, w: box.w, h: box.h }, field: id });
        this.addField(winId, id);
        return id;
    }
    region(winId, regId) { const w = this.window(winId); return w && (w.regions || []).find((r) => r.id === regId); }
    setRegionBox(winId, regId, box) {
        const r = this.region(winId, regId);
        if (r) r.box = { x: box.x, y: box.y, w: box.w, h: box.h };
    }
    removeRegion(winId, regId) {
        const w = this.window(winId);
        if (!w) return;
        const r = this.region(winId, regId);
        w.regions = (w.regions || []).filter((x) => x.id !== regId);
        // drop the field if no other region uses it
        if (r && !w.regions.some((x) => x.field === r.field)) w.fields = (w.fields || []).filter((f) => f.id !== r.field);
    }
    renameRegion(winId, regId, newId) {
        const w = this.window(winId);
        const r = this.region(winId, regId);
        if (!w || !r || !newId || w.regions.some((x) => x.id === newId)) return false;
        const oldField = r.field;
        const fld = this.fieldOf(w, r);
        // rename the FieldDef + repoint EVERY reference to it (region link, tells, keys, dataset
        // key_field) through the shared helper — not just this region's own link.
        if (fld && fld.id === oldField) { fld.id = newId; this._repointField(w, oldField, newId); this._emitRename("field", oldField, newId, winId); }
        r.id = newId;
        return true;
    }
    regions(winId) { const w = this.window(winId); return (w && w.regions) || []; }

    // ---- readouts (live, non-persisted values drawn on the window image) ----
    // A readout OCRs its box into an ephemeral value that is NEVER stored, reusing a FieldDef
    // for the read config (inline on the one readout node, like a region). Mirrors regions.

    readoutField(w, v) { return (w && v) ? (w.fields || []).find((f) => f.id === v.field) || null : null; }

    // Create a readout from a fraction box; also creates its linked (number) field. Returns id.
    addReadout(winId, box) {
        const w = this.window(winId);
        if (!w) return null;
        w.readouts = w.readouts || [];
        let id = "ro_" + _fieldSeq++;
        while (w.readouts.some((v) => v.id === id)) id = "ro_" + _fieldSeq++;
        const fid = "rof_" + _fieldSeq++;
        w.readouts.push({ id, box: { x: box.x, y: box.y, w: box.w, h: box.h }, field: fid, enabled: true });
        this.addField(winId, fid);
        const f = (w.fields || []).find((x) => x.id === fid);
        if (f) f.type = "number";   // readouts read numbers by default (health/counters)
        return id;
    }
    readout(winId, vid) { const w = this.window(winId); return w && (w.readouts || []).find((v) => v.id === vid); }
    setReadoutBox(winId, vid, box) { const v = this.readout(winId, vid); if (v) v.box = { x: box.x, y: box.y, w: box.w, h: box.h }; }
    setReadoutEnabled(winId, vid, on) { const v = this.readout(winId, vid); if (v) v.enabled = !!on; }
    // Rename a readout: its id IS its identity (like every other node — no separate name). Ids are
    // GLOBAL (model.readouts() spans all windows, the toast token {{id}} is global), so uniqueness
    // is checked across every window. Repoints the refs that key off the id: {{id}} tokens in a
    // toast's title/message/attribution and each trigger's readout_watch. Returns true on success.
    renameReadout(winId, vid, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === vid || this.readouts().some((v) => v.id === newId)) return false;
        const v = this.readout(winId, vid);
        if (!v) return false;
        v.id = newId;
        const re = new RegExp("\\{\\{\\s*" + vid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\}\\}", "g");
        for (const t of this.profile.toasts || [])
            for (const k of ["title", "message", "attribution"])
                if (typeof t[k] === "string" && t[k].includes("{{")) t[k] = t[k].replace(re, `{{${newId}}}`);
        for (const t of this.profile.triggers || [])
            t.readout_watch = (t.readout_watch || []).map((x) => (x === vid ? newId : x));
        return true;
    }
    removeReadout(winId, vid) {
        const w = this.window(winId);
        if (!w) return;
        const v = this.readout(winId, vid);
        w.readouts = (w.readouts || []).filter((x) => x.id !== vid);
        // drop the linked field if nothing else uses it
        if (v && v.field && !this._fieldUsed(w, v.field)) w.fields = (w.fields || []).filter((f) => f.id !== v.field);
        // clear any trigger watch pointing at this readout (no dangling wire) — SSOT list
        for (const t of this.profile.triggers || []) t.readout_watch = (t.readout_watch || []).filter((x) => x !== vid);
        // strip its now-dead {{vid}} tokens from toast text (the readout they printed is gone) —
        // the delete-twin of renameReadout's repoint, so a removed readout never leaves a live token
        const re = new RegExp("\\{\\{\\s*" + vid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\}\\}", "g");
        for (const t of this.profile.toasts || [])
            for (const k of ["title", "message", "attribution"])
                if (typeof t[k] === "string" && t[k].includes("{{")) t[k] = t[k].replace(re, "");
    }
    // Every readout across all windows, for trigger-watch listing: {id, win}.
    readouts() {
        const out = [];
        for (const w of this.profile.windows || [])
            for (const v of w.readouts || []) out.push({ id: v.id, win: w.id });
        return out;
    }
    readoutSite(vid) { return this.readouts().find((v) => v.id === vid) || null; }

    // ---- detect (a window's recognition landmarks) --------------------------
    // Detectors live on a window; the image/box machinery passes the window id through.

    _detectHost(winId) { return this.window(winId); }

    addDetect(winId, box) {
        const host = this._detectHost(winId);
        if (!host) return null;
        host.detect = host.detect || [];
        let id = "detect_" + _fieldSeq++;
        while (host.detect.some((d) => d.id === id)) id = "detect_" + _fieldSeq++;
        // game gate detectors default to the cheap COLOUR kind (no OCR); window detectors
        // stay text by default. A colour detector seeds an empty colour (sample it on the image).
        const base = { id, search: { x: box.x, y: box.y, w: box.w, h: box.h }, threshold: DEFAULT_DETECT_THRESHOLD };
        host.detect.push(winId === "game" ? { ...base, color: "", tolerance: 32 } : { ...base, text: "" });
        return id;
    }
    detect(winId, id) { const h = this._detectHost(winId); return h && (h.detect || []).find((d) => d.id === id); }
    setDetectBox(winId, id, box) { const d = this.detect(winId, id); if (d) d.search = { x: box.x, y: box.y, w: box.w, h: box.h }; }
    removeDetect(winId, id) { const h = this._detectHost(winId); if (h) h.detect = (h.detect || []).filter((d) => d.id !== id); }
    renameDetect(winId, id, newId) {
        const host = this._detectHost(winId);
        const d = this.detect(winId, id);
        if (!host || !d || !newId || (host.detect || []).some((x) => x.id === newId)) return false;
        d.id = newId;
        return true;
    }
    detects(winId) { const h = this._detectHost(winId); return (h && h.detect) || []; }
    // how a window's detectors combine: "all" (AND, default) or "any" (OR).
    detectMode(winId) { const h = this._detectHost(winId); return (h && h.detect_mode) || "all"; }
    setDetectMode(winId, mode) { const h = this._detectHost(winId); if (h) h.detect_mode = mode === "any" ? "any" : "all"; }
    // per-detector polarity: negate=true requires the landmark ABSENT (window fails if found)
    setDetectNegate(winId, id, neg) { const d = this.detect(winId, id); if (d) d.negate = !!neg; }

    // ---- scrollbar (single box on the window's scroll config) ----------------

    setScrollbar(winId, box) {
        const w = this.window(winId);
        if (!w) return;
        w.scroll = w.scroll || { rows: 1, cols: 1 };
        // Locked once calibration cutouts exist: each cutout embeds a crop taken at the box's
        // origin, so moving the box silently invalidates every sample (thumb px shifts by the
        // move → row offsets misread by a constant). Remove the cutouts to move the box.
        if (this.scrollbarLocked(winId)) return;
        w.scroll.scrollbar = { x: box.x, y: box.y, w: box.w, h: box.h };
    }
    scrollbar(winId) { const w = this.window(winId); return w && w.scroll && w.scroll.scrollbar; }
    scrollbarLocked(winId) {
        const w = this.window(winId);
        return !!(w && w.scroll && w.scroll.scrollbar && (w.scroll.calib_samples || []).length);
    }
    setScrollbarOrientation(winId, o) { const w = this.window(winId); if (w && w.scroll) w.scroll.scrollbar_orientation = o; }
    setScrollAutoscroll(winId, on) { const w = this.window(winId); if (!w) return; w.scroll = w.scroll || { rows: 1, cols: 1 }; w.scroll.autoscroll = !!on; }
    setScrollClicks(winId, n) { const w = this.window(winId); if (!w) return; w.scroll = w.scroll || { rows: 1, cols: 1 }; w.scroll.scroll_clicks = n; }
    // ---- scroll calibration (cutout samples; no live learning) --------------
    _scrollOf(winId) { const w = this.window(winId); if (!w) return null; w.scroll = w.scroll || { rows: 1, cols: 1 }; return w.scroll; }
    addScrollSample(winId, sample) {  // { img, rows, pos, conf }
        const sc = this._scrollOf(winId); if (!sc) return;
        (sc.calib_samples = sc.calib_samples || []).push(sample);
    }
    removeScrollSample(winId, i) {
        const sc = this._scrollOf(winId); if (!sc || !sc.calib_samples) return;
        sc.calib_samples.splice(i, 1);
    }
    moveScrollSample(winId, from, to) {  // reorder by drag
        const sc = this._scrollOf(winId); const a = sc && sc.calib_samples; if (!a) return;
        if (from < 0 || from >= a.length || to < 0 || to >= a.length) return;
        a.splice(to, 0, a.splice(from, 1)[0]);
    }
    setScrollSampleRows(winId, i, rows) {
        const sc = this._scrollOf(winId); const s = sc && sc.calib_samples && sc.calib_samples[i];
        if (s) s.rows = Math.max(0, Math.round(+rows) || 0);
    }
    // Fit gain = rows of content per full thumb travel = slope of (rows vs pos), least squares
    // through the samples that have a pos. Returns the gain (and stores it), or null if <2 usable.
    learnScrollGain(winId) {
        const sc = this._scrollOf(winId); if (!sc) return null;
        const fail = () => { delete sc.calib_gain; return null; };   // not enough/ill-posed -> uncalibrated
        const pts = (sc.calib_samples || []).filter((s) => s.pos != null).map((s) => [+s.pos, +s.rows]);
        if (pts.length < 2) return fail();
        const n = pts.length;
        const sx = pts.reduce((a, [x]) => a + x, 0), sy = pts.reduce((a, [, y]) => a + y, 0);
        const sxx = pts.reduce((a, [x]) => a + x * x, 0), sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) < 1e-9) return fail();
        const slope = (n * sxy - sx * sy) / denom;
        if (!(slope > 0)) return fail();
        sc.calib_gain = Math.round(slope * 10) / 10;
        return sc.calib_gain;
    }
    // Killing the scrollbar node removes the whole calibration with it — the cutouts and gain
    // are crops of THIS box, meaningless without it (and they'd lock a future redraw out).
    removeScrollbar(winId) {
        const w = this.window(winId);
        if (!w || !w.scroll) return;
        delete w.scroll.scrollbar;
        delete w.scroll.calib_samples;
        delete w.scroll.calib_gain;
    }

    // ---- data area (bounds OCR) ---------------------------------------------

    setDataArea(winId, box) { const w = this.window(winId); if (w) w.data_area = { x: box.x, y: box.y, w: box.w, h: box.h }; }
    dataArea(winId) { const w = this.window(winId); return w && w.data_area; }

    // ---- states (gate when data is extracted) -------------------------------

    addState(winId, box) {
        const w = this.window(winId);
        if (!w) return null;
        w.states = w.states || [];
        let id = "state_" + _fieldSeq++;
        while (w.states.some((s) => s.id === id)) id = "state_" + _fieldSeq++;
        w.states.push({ id, kind: "ordering", valid_for_save: true,
            detect: [{ id: id + "_a", search: { x: box.x, y: box.y, w: box.w, h: box.h }, text: "", threshold: DEFAULT_DETECT_THRESHOLD }] });
        return id;
    }
    state(winId, id) { const w = this.window(winId); return w && (w.states || []).find((s) => s.id === id); }
    states(winId) { const w = this.window(winId); return (w && w.states) || []; }
    setStateBox(winId, id, box) {
        const s = this.state(winId, id);
        if (s && s.detect && s.detect[0]) s.detect[0].search = { x: box.x, y: box.y, w: box.w, h: box.h };
    }
    removeState(winId, id) { const w = this.window(winId); if (w) w.states = (w.states || []).filter((s) => s.id !== id); }

    // ---- item templates (a cell matched across the data area) ---------------
    // Geometry: `box` and `cutout_box` are WINDOW fractions; each field/tell `box`
    // is 0..1 WITHIN the cell (`box`). The UI does the cutout<->window mapping.

    items(winId) { const w = this.window(winId); return (w && w.items) || []; }
    item(winId, id) { const w = this.window(winId); return w && (w.items || []).find((it) => it.id === id); }

    addItem(winId, { cutout, cutout_box, box }) {
        const w = this.window(winId);
        if (!w) return null;
        w.items = w.items || [];
        let id = "item_" + _fieldSeq++;
        while (w.items.some((it) => it.id === id)) id = "item_" + _fieldSeq++;
        const cell = box || cutout_box;
        w.items.push({ id, cutout: cutout || null, cutout_box: cutout_box || null,
            box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, align: "center", priority: 0,
            min_cover_x: 0.75, min_cover_y: 0.75, fields: [], tells: [] });
        return id;
    }
    setItemPriority(winId, id, priority) { const it = this.item(winId, id); if (it) it.priority = priority | 0; }
    // Terminator flag: when this template is detected it marks the END of the list — every record
    // positioned after it is discarded (an unowned/"no more results" placeholder). Scroll datasets only.
    setItemTerminator(winId, id, on) { const it = this.item(winId, id); if (it) it.terminator = !!on; }
    // Min coverage on one axis ("x"/"y"): the fraction of the cell that must sit inside the data
    // area for the record to be stored — clamped 0..1. A row scrolled off past this is dismissed.
    setItemCover(winId, id, axis, frac) {
        const it = this.item(winId, id);
        if (it) it["min_cover_" + axis] = Math.max(0, Math.min(1, +frac || 0));
    }
    // Move an item up/down the displayed order (dir -1/+1, where the list shows HIGHEST
    // priority first) and renumber every item's priority to match its new rank. Renumbering
    // keeps the list dense and contiguous so the window node's order list stays a faithful
    // 1:1 view of priority: top of the list = highest number; bottom = 0 (the base cell).
    moveItemPriority(winId, id, dir) {
        const w = this.window(winId);
        if (!w || !w.items) return;
        const order = [...w.items].sort((a, b) => (b.priority || 0) - (a.priority || 0));   // highest first (display order)
        const i = order.findIndex((x) => x.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        const n = order.length;
        order.forEach((it, k) => { it.priority = n - 1 - k; });   // top -> highest priority, bottom -> 0 (base)
    }
    setWindowStaticGrid(winId, on) { const w = this.window(winId); if (w) w.static_grid = !!on; }
    // Window-level OCR preprocess (Text appearance): mode none/color/threshold/invert,
    // taught colours + tolerance for `color`, upscale for small text. Lazily defaulted so
    // an old profile without the block gets one on first edit.
    preprocess(winId) {
        const w = this.window(winId);
        if (!w) return null;
        w.preprocess = w.preprocess || { mode: "none", colors: [], tolerance: 60, scale: 1.0 };
        return w.preprocess;
    }
    setPreprocessMode(winId, mode) { const pp = this.preprocess(winId); if (pp) pp.mode = mode; }
    setPreprocessTolerance(winId, t) { const pp = this.preprocess(winId); if (pp) pp.tolerance = t; }
    setPreprocessScale(winId, s) { const pp = this.preprocess(winId); if (pp) pp.scale = s; }
    addPreprocessColor(winId, hex) { const pp = this.preprocess(winId); if (pp && !pp.colors.includes(hex)) pp.colors.push(hex); }
    removePreprocessColor(winId, i) { const pp = this.preprocess(winId); if (pp) pp.colors.splice(i, 1); }
    removeItem(winId, id) {
        const w = this.window(winId);
        if (!w) return;
        const it = this.item(winId, id);
        w.items = (w.items || []).filter((x) => x.id !== id);
        // drop fields no longer used by any item field
        for (const f of (it && it.fields) || [])
            if (!this._fieldUsed(w, f.field)) w.fields = (w.fields || []).filter((x) => x.id !== f.field);
    }
    renameItem(winId, id, newId) {
        const w = this.window(winId);
        const it = this.item(winId, id);
        if (!w || !it || !newId || w.items.some((x) => x.id === newId)) return false;
        it.id = newId;
        this._emitRename("item", id, newId, winId);
        return true;
    }
    setItemBox(winId, id, box) { const it = this.item(winId, id); if (it) it.box = { x: box.x, y: box.y, w: box.w, h: box.h }; }

    _fieldUsed(w, fieldId) {
        return (w.items || []).some((it) => (it.fields || []).some((f) => f.field === fieldId));
    }

    // fields inside an item (cell-relative box). Also creates the schema FieldDef.
    addItemField(winId, itemId, box) {
        const it = this.item(winId, itemId);
        if (!it) return null;
        it.fields = it.fields || [];
        let id = "field_" + _fieldSeq++;
        while (it.fields.some((f) => f.id === id)) id = "field_" + _fieldSeq++;
        it.fields.push({ id, box: { x: box.x, y: box.y, w: box.w, h: box.h }, field: id });
        this.addField(winId, id);
        return id;
    }
    itemField(winId, itemId, fid) { const it = this.item(winId, itemId); return it && (it.fields || []).find((f) => f.id === fid); }
    setItemFieldBox(winId, itemId, fid, box) { const f = this.itemField(winId, itemId, fid); if (f) f.box = { x: box.x, y: box.y, w: box.w, h: box.h }; }
    setItemFieldTell(winId, itemId, fid, val) { const f = this.itemField(winId, itemId, fid); if (f) f.tell = !!val; }
    setItemFieldTellConf(winId, itemId, fid, conf) { const f = this.itemField(winId, itemId, fid); if (f) f.tell_conf = conf; }
    setItemFieldTellAllowText(winId, itemId, fid, val) { const f = this.itemField(winId, itemId, fid); if (f) f.tell_allow_text = !!val; }
    setItemFieldLocate(winId, itemId, fid, val) { const f = this.itemField(winId, itemId, fid); if (f) f.locate = !!val; }
    setItemFieldAlign(winId, itemId, fid, align) { const f = this.itemField(winId, itemId, fid); if (f) f.align = align; }
    setItemFieldAlignX(winId, itemId, fid, alignX) { const f = this.itemField(winId, itemId, fid); if (f) f.align_x = alignX; }
    removeItemField(winId, itemId, fid) {
        const it = this.item(winId, itemId);
        const f = this.itemField(winId, itemId, fid);
        if (it) it.fields = (it.fields || []).filter((x) => x.id !== fid);
        const w = this.window(winId);
        if (f && w && !this._fieldUsed(w, f.field)) w.fields = (w.fields || []).filter((x) => x.id !== f.field);
        // a key part pointing at a dead field would drop every record — prune it
        if (f && it && it.key) {
            it.key.fields = (it.key.fields || []).filter((x) => x !== f.field);
            if (!it.key.fields.length) it.key.fields = [(it.fields[0] && it.fields[0].field) || "name"];
        }
    }
    renameItemField(winId, itemId, fid, newId) {
        const it = this.item(winId, itemId);
        const f = this.itemField(winId, itemId, fid);
        const w = this.window(winId);
        if (!it || !f || !newId || it.fields.some((x) => x.id === newId)) return false;
        const old = f.field;
        const fld = (w.fields || []).find((x) => x.id === old);
        if (fld && fld.id === old) { fld.id = newId; this._emitRename("field", old, newId, winId); }
        // repoint EVERY reference to this field (this item's tells + key, the WINDOW default key
        // items inherit, the dataset key_field, sibling regions/item-fields) through the shared
        // helper — a missed key part silently drops every record (see _repointField).
        this._repointField(w, old, newId);
        f.id = newId;   // the item-field NODE id tracks its field (f.field moved via _repointField)
        return true;
    }

    // ---- record key (dedup identity) per item template -----------------------
    // null = inherit (window key, else default {fields:["name"]}). The KeyDef shape
    // mirrors the server: {fields:[...], sep, case_sensitive}.

    itemKey(winId, itemId) { const it = this.item(winId, itemId); return (it && it.key) || null; }
    // the key the item EFFECTIVELY uses (own -> window -> FIRST field), for display/preview.
    // Never an imaginary "name": with no explicit key it defaults to the item's first field,
    // and to an EMPTY key (no fields yet) when the item has none — the UI shows a dash.
    effectiveItemKey(winId, itemId) {
        const it = this.item(winId, itemId), w = this.window(winId);
        const explicit = (it && it.key) || (w && w.key);
        if (explicit) return explicit;
        const first = it && it.fields && it.fields[0] && it.fields[0].field;
        return { fields: first ? [first] : [], sep: "|", case_sensitive: false };
    }
    ensureItemKey(winId, itemId) {
        const it = this.item(winId, itemId);
        if (!it) return null;
        if (!it.key) {
            const eff = this.effectiveItemKey(winId, itemId);
            it.key = { fields: [...(eff.fields || [])], sep: eff.sep ?? "|", case_sensitive: !!eff.case_sensitive };
        }
        return it.key;
    }
    clearItemKey(winId, itemId) { const it = this.item(winId, itemId); if (it) delete it.key; }

    // tells inside an item (cell-relative box). kind: filled|text|color|template.
    addItemTell(winId, itemId, kind, box) {
        const it = this.item(winId, itemId);
        if (!it) return null;
        it.tells = it.tells || [];
        let id = "tell_" + _fieldSeq++;
        while (it.tells.some((t) => t.id === id)) id = "tell_" + _fieldSeq++;
        const first = !it.tells.length;
        const k = kind || "filled";
        // a text tell defaults to the field it's drawn over (else the first field), so it
        // actually validates something instead of silently rejecting every cell.
        let field = null;
        if (k === "text") {
            const inside = (it.fields || []).find((f) => {
                const cx = f.box.x + f.box.w / 2, cy = f.box.y + f.box.h / 2;
                return box.x <= cx && cx <= box.x + box.w && box.y <= cy && cy <= box.y + box.h;
            });
            field = (inside && inside.field) || (it.fields[0] && it.fields[0].field) || null;
        }
        it.tells.push({ id, box: { x: box.x, y: box.y, w: box.w, h: box.h }, kind: k,
            field, color: null, tolerance: 60, width: 0.2, template: null, margin: 0.25, threshold: 0.5, locate: first });
        return id;
    }
    itemTell(winId, itemId, tid) { const it = this.item(winId, itemId); return it && (it.tells || []).find((t) => t.id === tid); }
    setItemTellBox(winId, itemId, tid, box) { const t = this.itemTell(winId, itemId, tid); if (t) t.box = { x: box.x, y: box.y, w: box.w, h: box.h }; }
    setItemTellProp(winId, itemId, tid, key, value) { const t = this.itemTell(winId, itemId, tid); if (t) t[key] = value; }
    // Rename a tell. Tell ids aren't referenced anywhere else (unlike fields, which the key
    // and other tells point at), so the rename is self-contained — just guard collisions.
    renameItemTell(winId, itemId, tid, newId) {
        const it = this.item(winId, itemId);
        const t = this.itemTell(winId, itemId, tid);
        if (!it || !t || !newId || (it.tells || []).some((x) => x.id === newId)) return false;
        t.id = newId;
        return true;
    }
    removeItemTell(winId, itemId, tid) { const it = this.item(winId, itemId); if (it) it.tells = (it.tells || []).filter((t) => t.id !== tid); }

    // Wire a window to a dataset (drag-connect). "" => back to default (own id).
    setDataset(winId, ds) {
        const w = this.window(winId);
        if (w) w.dataset = ds && ds !== w.id ? ds : null;
    }

    noteDatasets(names) { this._extraDatasets = names || []; }
}

function blank(name) {
    return { name, process_names: [], window_title_hint: null, fields: [], windows: [], datasets: [], dictionaries: [] };
}
