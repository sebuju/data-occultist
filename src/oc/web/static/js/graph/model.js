// GraphModel: the editable structure behind the node view. It holds the full
// GameProfile and exposes node/edge derivation plus edit ops. Box data
// (regions/detect/states/preprocess/scroll) is never touched here — it's authored
// on the canvas — so saving preserves it.

import { DEFAULT_DETECT_THRESHOLD } from "../defaults.js";

let _fieldSeq = 1;

export class GraphModel {
    constructor() { this.profile = blank(""); this.sounds = []; }   // sounds: available trigger-sound filenames (fetched once)

    load(profile) {
        this.profile = profile || blank("");
        this.profile.windows = this.profile.windows || [];
        this.profile.fields = this.profile.fields || [];
        this.profile.datasets = this.profile.datasets || [];
        this.profile.subsets = this.profile.subsets || [];
        this.profile.price_nodes = this.profile.price_nodes || [];
        this.profile.triggers = this.profile.triggers || [];
        this.profile.dictionaries = this.profile.dictionaries || [];
        // a subset joins many datasets; fold a legacy single ``dataset`` into ``datasets``
        for (const s of this.profile.subsets) {
            s.datasets = s.datasets || [];
            if (s.dataset && !s.datasets.includes(s.dataset)) { s.datasets.unshift(s.dataset); s.dataset = ""; }
            s.sort = s.sort || [];
            // fold a legacy single-column sort into the multi-column list
            if (!s.sort.length && s.sort_by) { s.sort = [{ field: s.sort_by, desc: !!s.sort_desc }]; s.sort_by = ""; }
        }
        for (const pn of this.profile.price_nodes) pn.sources = pn.sources || [];   // items the node prices (empty = catalogue)
        for (const t of this.profile.triggers) { t.watch = t.watch || []; t.targets = t.targets || []; if (t.volume == null) t.volume = 1; }
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
            fanIn(w, "item_fields", "fields");
            fanIn(w, "item_tells", "tells");
        }
    }

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
    setDatasetKeyField(id, f) { const d = this.ensureDatasetDef(id); d.key_field = f || ""; d.dedup = true; }
    // Whether the dataset does the 1->many collapse at all (false = keep every read as its own row).
    datasetDedup(id) { const d = this.datasetDef(id); return !d || d.dedup !== false; }
    setDatasetDedup(id, on) { this.ensureDatasetDef(id).dedup = !!on; }
    // How a live run splits into batches: "run" (one per run) or "detection" (a new batch each
    // time the feeding window is freshly detected — transient per-event screens like relic offerings).
    datasetBatchMode(id) { const d = this.datasetDef(id); return (d && d.batch_mode) || "run"; }
    setDatasetBatchMode(id, m) { this.ensureDatasetDef(id).batch_mode = m === "detection" ? "detection" : "run"; }
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
        for (const pn of this.profile.price_nodes || []) {
            sites.push({ decl: true, get: () => pn.dataset, set: (v) => { pn.dataset = v; } });
            (pn.sources || []).forEach((_, i) =>                            // priced-item sources are REFs
                sites.push({ decl: false, get: () => pn.sources[i], set: (v) => { pn.sources[i] = v; } }));
        }
        for (const s of this.profile.subsets || []) {                     // subset inputs are REFs
            sites.push({ decl: false, get: () => s.dataset, set: (v) => { s.dataset = v; } });   // legacy single
            (s.datasets || []).forEach((_, i) =>
                sites.push({ decl: false, get: () => s.datasets[i], set: (v) => { s.datasets[i] = v; } }));
        }
        for (const t of this.profile.triggers || [])                      // on_change watch are REFs
            (t.watch || []).forEach((_, i) =>
                sites.push({ decl: false, get: () => t.watch[i], set: (v) => { t.watch[i] = v; } }));
        return sites;
    }

    // Repoint every reference site (consumers, not declarations) from oldId -> newId. Shared by
    // dataset AND subset renames: a subset.datasets entry can name either, and the ref site is
    // the same either way, so one helper keeps both rename paths complete.
    _repointRefs(oldId, newId) {
        for (const st of this._datasetSites()) if (!st.decl && st.get() === oldId) st.set(newId);
    }

    // Rename a dataset: repoint EVERY site (declarations + references) holding the old id, so
    // the old name cannot linger and resurface as a duplicate node.
    renameDataset(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.datasets().includes(newId)) return false;   // collision incl. disk/price/window
        for (const st of this._datasetSites()) if (st.get() === oldId) st.set(newId);
        if (!this.datasetDef(newId)) this.ensureDatasetDef(newId);   // a def must exist for the new name
        if (this._extraDatasets) this._extraDatasets = this._extraDatasets.filter((x) => x !== oldId);   // drop stale disk entry
        return true;
    }
    // field ids available to a dataset = the fields of every window feeding it
    datasetFields(id) {
        const out = new Set();
        for (const w of this.profile.windows) {
            if (this.datasetOf(w) !== id) continue;
            for (const f of w.fields || []) out.add(f.id);
        }
        return [...out];
    }

    // ---- nodes / edges ------------------------------------------------------

    nodes() {
        const ns = [{ id: "game", type: "game", ref: this.profile }];
        for (const w of this.profile.windows) {
            ns.push({ id: `win:${w.id}`, type: "window", ref: w });
            ns.push({ id: `prev:${w.id}`, type: "preview", ref: w });
            for (const r of w.regions || []) ns.push({ id: `reg:${w.id}:${r.id}`, type: "region", ref: r, win: w, field: this.fieldOf(w, r) });
            for (const d of w.detect || []) ns.push({ id: `det:${w.id}:${d.id}`, type: "detect", ref: d, win: w });
            if (w.scroll && w.scroll.scrollbar) ns.push({ id: `sb:${w.id}:scrollbar`, type: "scrollbar", ref: w.scroll, win: w });
            for (const it of w.items || []) {
                ns.push({ id: `item:${w.id}:${it.id}`, type: "item", ref: it, win: w });
                for (const f of it.fields || []) ns.push({ id: `fld:${w.id}:${it.id}:${f.id}`, type: "itemfield", ref: f, win: w, item: it, field: this.fieldOf(w, f) });
                for (const t of it.tells || []) ns.push({ id: `tell:${w.id}:${it.id}:${t.id}`, type: "itemtell", ref: t, win: w, item: it });
            }
        }
        for (const ds of this.datasets()) ns.push({ id: `ds:${ds}`, type: "dataset", ref: ds });
        for (const s of this.profile.subsets || []) ns.push({ id: `sub:${s.id}`, type: "subset", ref: s });
        for (const pn of this.profile.price_nodes || []) ns.push({ id: `price:${pn.id}`, type: "price", ref: pn });
        for (const t of this.profile.triggers || []) ns.push({ id: `trigger:${t.id}`, type: "trigger", ref: t });
        for (const d of this.profile.dictionaries || []) ns.push({ id: `dict:${d.id}`, type: "dictionary", ref: d });
        return ns;
    }

    edges() {
        const es = [];
        for (const w of this.profile.windows) {
            es.push({ from: "game", to: `win:${w.id}`, kind: "own" });
            es.push({ from: `win:${w.id}`, to: `prev:${w.id}`, kind: "img" });
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
            if (this._windowHasDataset(w))   // no dataset node/wire until the window produces data
                es.push({ from: `win:${w.id}`, to: `ds:${this.datasetOf(w)}`, kind: "data" });
        }
        for (const s of this.profile.subsets || [])
            for (const inp of this.subsetInputs(s)) {
                // an input can be a dataset OR another subset — pick the right source node
                const from = this.subsetDef(inp) ? `sub:${inp}` : `ds:${inp}`;
                es.push({ from, to: `sub:${s.id}`, kind: "data" });
            }
        // a price producer WRITES into its output dataset (producer -> dataset), and READS its
        // item list from any wired source dataset/subset (source -> producer); empty = whole catalogue.
        for (const pn of this.profile.price_nodes || []) {
            es.push({ from: `price:${pn.id}`, to: `ds:${pn.dataset}`, kind: "data" });
            for (const src of pn.sources || []) {
                if (src === pn.dataset) continue;   // never wire a node to its own output
                const from = this.subsetDef(src) ? `sub:${src}` : `ds:${src}`;
                es.push({ from, to: `price:${pn.id}`, kind: "data" });
            }
        }
        // a trigger FIRES its target price nodes (trigger -> price); an on_change trigger also
        // WATCHES datasets — the dashed line leaves the trigger's watch port and reaches OUT to the
        // dataset/subset it wakes on (trigger -> watched), so both control lines emanate from the trigger.
        for (const t of this.profile.triggers || []) {
            for (const pid of t.targets || []) if (this.priceNode(pid)) es.push({ from: `trigger:${t.id}`, to: `price:${pid}`, kind: "trigger" });
            if (t.kind === "on_change")
                for (const w of t.watch || []) {
                    const to = this.subsetDef(w) ? `sub:${w}` : `ds:${w}`;
                    es.push({ from: `trigger:${t.id}`, to, kind: "watch" });
                }
        }
        for (const d of this.profile.dictionaries || []) es.push({ from: "game", to: `dict:${d.id}`, kind: "own" });
        return es;
    }

    fieldOf(win, region) {
        win.fields = win.fields || [];
        return win.fields.find((f) => f.id === region.field) || null;
    }

    datasets() {
        const set = new Set();
        for (const st of this._datasetSites()) if (st.decl) { const v = st.get(); if (v) set.add(v); }   // declaration sites only
        (this._extraDatasets || []).forEach((d) => set.add(d));   // names found on disk
        return [...set];
    }

    // ---- price producers: write market snapshots into an output dataset ------
    priceNode(id) { return (this.profile.price_nodes || []).find((p) => p.id === id) || null; }
    addPriceNode(dataset = "prices") {
        this.profile.price_nodes = this.profile.price_nodes || [];
        let n = 1, id = "price";
        while (this.priceNode(id)) id = `price_${++n}`;
        this.ensureDatasetDef(dataset);
        this.profile.price_nodes.push({ id, type: "warframe_market", mode: "statistics", dataset, throttle: 0.4, enabled: true });
        return id;
    }
    removePriceNode(id) { this.profile.price_nodes = (this.profile.price_nodes || []).filter((p) => p.id !== id); }
    renamePriceNode(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.priceNode(newId)) return false;
        this.priceNode(oldId).id = newId;
        return true;
    }
    setPriceDataset(id, ds) {
        const pn = this.priceNode(id);
        if (pn && ds) { pn.dataset = ds; this.ensureDatasetDef(ds); }
    }
    setPriceMode(id, mode) {
        const pn = this.priceNode(id);
        if (pn && (mode === "statistics" || mode === "orders")) pn.mode = mode;
    }
    // a node's priced-item sources (datasets/subsets). Empty = the whole catalogue. A node may
    // not source its own output dataset (a self-loop). Returns true when the wire was added.
    addPriceSource(id, ds) {
        const pn = this.priceNode(id);
        if (!pn || !ds || ds === pn.dataset) return false;
        pn.sources = pn.sources || [];
        if (pn.sources.includes(ds)) return false;
        pn.sources.push(ds);
        return true;
    }
    removePriceSource(id, ds) { const pn = this.priceNode(id); if (pn) pn.sources = (pn.sources || []).filter((d) => d !== ds); }
    // datasets + subsets a price node can still add as a priced-item source (minus current ones
    // and its own output dataset) — feeds the same chip/add-select input the subset uses.
    priceJoinable(pn) {
        const cur = new Set(pn.sources || []);
        const out = [];
        for (const d of this.datasets()) if (!cur.has(d) && d !== pn.dataset) out.push(d);
        for (const s of this.profile.subsets || []) if (!cur.has(s.id)) out.push(s.id);
        return out;
    }
    // which source column names the item to price (resolved to a market slug). Default "name".
    setPriceSourceField(id, f) { const pn = this.priceNode(id); if (pn) pn.source_field = f || "name"; }
    // columns available across a price node's source datasets/subsets (for the name-field picker)
    priceSourceColumns(pn) {
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
        this.profile.triggers.push({ id, kind, interval_s: 300, watch: [], targets: [], enabled: true, sound: "", volume: 1 });
        return id;
    }
    removeTrigger(id) { this.profile.triggers = (this.profile.triggers || []).filter((t) => t.id !== id); }
    renameTrigger(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.trigger(newId)) return false;
        this.trigger(oldId).id = newId;
        return true;
    }
    setTriggerKind(id, kind) { const t = this.trigger(id); if (t && ["interval", "on_change", "manual"].includes(kind)) t.kind = kind; }
    setTriggerInterval(id, s) { const t = this.trigger(id); const v = parseFloat(s); if (t && v > 0) t.interval_s = v; }
    setTriggerSound(id, v) { const t = this.trigger(id); if (t) t.sound = v || ""; }
    setTriggerVolume(id, v) { const t = this.trigger(id); const n = parseFloat(v); if (t && !Number.isNaN(n)) t.volume = Math.max(0, Math.min(1, n)); }
    addTriggerTarget(id, pid) {
        const t = this.trigger(id);
        if (!t || !pid || !this.priceNode(pid)) return false;
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
        const name = opts.name || source.replace(/\.txt$/i, "") || id;
        this.profile.dictionaries.push({ id, name, enabled: true, source, terms: opts.terms || [] });
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

    // duplicate a dataset's definition under a fresh id; a window can then be wired to it
    cloneDataset(id) {
        let n = 2, newId = `${id}-copy`;
        while (this.datasets().includes(newId)) newId = `${id}-copy${n++}`;
        (this.profile.datasets = this.profile.datasets || []).push({ id: newId });
        return newId;
    }
    removeDatasetDef(id) { this.profile.datasets = (this.profile.datasets || []).filter((d) => d.id !== id); }

    // mint a fresh empty dataset (e.g. dragging a producer's wire onto empty canvas)
    addDataset(base = "dataset") {
        let n = 1, id = base;
        while (this.datasets().includes(id)) id = `${base}_${++n}`;
        this.ensureDatasetDef(id);
        return id;
    }

    // ---- subsets: join one or more datasets, then filter/derive/sort ----------
    subsetDef(id) { return (this.profile.subsets || []).find((s) => s.id === id) || null; }
    // a subset's source datasets (joined on join_field), in order
    subsetInputs(s) { return (s && s.datasets && s.datasets.length) ? s.datasets : (s && s.dataset ? [s.dataset] : []); }
    // `ds` (optional) seeds the subset's first input + name. Omitted (e.g. minted from the
    // canvas add-node menu) -> a standalone, input-less subset named "subset" the user wires later.
    addSubset(ds = null) {
        const base = ds ? `${ds}_view` : "subset";
        let n = 1, id = base;
        while (this.subsetDef(id)) id = ds ? `${ds}_view${++n}` : `subset_${++n}`;
        (this.profile.subsets = this.profile.subsets || []).push({
            id, dataset: "", datasets: ds ? [ds] : [], join_field: "name",
            filters: [], derived: [], hidden_columns: [], enrich: [], sort: [], sort_by: "", sort_desc: false, latest_batch: false, limit: 0,
        });
        return id;
    }
    removeSubset(id) { this.profile.subsets = (this.profile.subsets || []).filter((s) => s.id !== id); }
    renameSubset(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.subsetDef(newId)) return false;
        this.subsetDef(oldId).id = newId;
        this._repointRefs(oldId, newId);   // a subset can feed another subset — repoint those inputs too
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
        s.datasets = s.datasets || [];
        if (s.datasets.includes(ds)) return false;
        s.datasets.push(ds);
        return true;
    }
    removeSubsetInput(id, ds) {
        const s = this.subsetDef(id);
        if (s) s.datasets = (s.datasets || []).filter((d) => d !== ds);
    }
    setJoinField(id, field) { const s = this.subsetDef(id); if (s) s.join_field = field || "name"; }
    // how a dataset input's MANY observations collapse to one value when THIS subset reads it
    subsetAggregate(id) { const s = this.subsetDef(id); return (s && s.aggregate) || "latest"; }
    setSubsetAggregate(id, agg) { const s = this.subsetDef(id); if (s) s.aggregate = agg || "latest"; }
    // only pull rows from each source's most recent collection batch (applied first)
    setSubsetLatestBatch(id, on) { const s = this.subsetDef(id); if (s) s.latest_batch = !!on; }
    // cap the number of result rows (0 = no limit)
    setSubsetLimit(id, n) { const s = this.subsetDef(id); if (s) s.limit = Math.max(0, Math.floor(+n || 0)); }
    // swap one of a subset's source inputs for another (the row-select edit), preserving order
    replaceSubsetInput(id, oldDs, newDs) {
        const s = this.subsetDef(id);
        if (!s || oldDs === newDs) return false;
        if (!this.addSubsetInput(id, newDs)) return false;   // refuses cycles/dupes/self
        // addSubsetInput appended newDs; drop oldDs and move newDs into oldDs's slot
        s.datasets = s.datasets || [];
        const i = s.datasets.indexOf(oldDs);
        s.datasets = s.datasets.filter((d) => d !== oldDs && d !== newDs);
        if (i >= 0) s.datasets.splice(i, 0, newDs); else s.datasets.push(newDs);
        return true;
    }
    // columns a subset can reference: every input's columns + this subset's derived names. A
    // dataset input contributes its window fields (+ known price columns); a SUBSET input
    // contributes its own output columns (recursively, so an upstream subset's derived columns
    // are visible downstream). `_seen` guards against an input cycle.
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
            this.datasetFields(inp).forEach(add);
            // price datasets aren't fed by windows, so expose their known snapshot columns
            if ((this.profile.price_nodes || []).some((p) => p.dataset === inp))
                ["name", "slug", "price_min", "price_median", "volume", "live_ask", "live_median", "live_sellers"].forEach(add);
        }
        for (const d of s.derived || []) if (d.name) add(d.name);
        return out;
    }
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
    removeWindow(id) { this.profile.windows = this.profile.windows.filter((w) => w.id !== id); }
    window(id) { return this.profile.windows.find((w) => w.id === id); }
    // whether the live view attempts this window (default true)
    setWindowLive(id, on) { const w = this.window(id); if (w) w.live = !!on; }

    renameWindow(oldId, newId) {
        const w = this.window(oldId);
        if (!w || !newId || this.profile.windows.some((x) => x.id === newId)) return false;
        w.id = newId;
        return true;
    }

    addField(winId, id) {
        const w = this.window(winId);
        if (!w) return;
        w.fields = w.fields || [];
        const fid = id || `field_${_fieldSeq++}`;
        if (!w.fields.some((f) => f.id === fid))
            w.fields.push({ id: fid, type: "text", extract: "whole", separator: "/", learn: false, fuzzy: 0.82 });
    }
    removeField(winId, fid) {
        const w = this.window(winId);
        if (w) w.fields = (w.fields || []).filter((f) => f.id !== fid);
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
        const fld = this.fieldOf(w, r);
        if (fld && fld.id === r.field) { fld.id = newId; r.field = newId; }
        r.id = newId;
        return true;
    }
    regions(winId) { const w = this.window(winId); return (w && w.regions) || []; }

    // ---- detect (window-detect landmarks) -----------------------------------

    addDetect(winId, box) {
        const w = this.window(winId);
        if (!w) return null;
        w.detect = w.detect || [];
        let id = "detect_" + _fieldSeq++;
        while (w.detect.some((d) => d.id === id)) id = "detect_" + _fieldSeq++;
        w.detect.push({ id, search: { x: box.x, y: box.y, w: box.w, h: box.h }, text: "", threshold: DEFAULT_DETECT_THRESHOLD });
        return id;
    }
    detect(winId, id) { const w = this.window(winId); return w && (w.detect || []).find((d) => d.id === id); }
    setDetectBox(winId, id, box) { const d = this.detect(winId, id); if (d) d.search = { x: box.x, y: box.y, w: box.w, h: box.h }; }
    removeDetect(winId, id) { const w = this.window(winId); if (w) w.detect = (w.detect || []).filter((d) => d.id !== id); }
    renameDetect(winId, id, newId) {
        const w = this.window(winId);
        const d = this.detect(winId, id);
        if (!w || !d || !newId || (w.detect || []).some((x) => x.id === newId)) return false;
        d.id = newId;
        return true;
    }
    detects(winId) { const w = this.window(winId); return (w && w.detect) || []; }
    // how a window's detectors combine: "all" (AND, default) or "any" (OR)
    detectMode(winId) { const w = this.window(winId); return (w && w.detect_mode) || "all"; }
    setDetectMode(winId, mode) { const w = this.window(winId); if (w) w.detect_mode = mode === "any" ? "any" : "all"; }
    // per-detector polarity: negate=true requires the landmark ABSENT (window fails if found)
    setDetectNegate(winId, id, neg) { const d = this.detect(winId, id); if (d) d.negate = !!neg; }

    // ---- scrollbar (single box on the window's scroll config) ----------------

    setScrollbar(winId, box) {
        const w = this.window(winId);
        if (!w) return;
        w.scroll = w.scroll || { rows: 1, cols: 1 };
        w.scroll.scrollbar = { x: box.x, y: box.y, w: box.w, h: box.h };
    }
    scrollbar(winId) { const w = this.window(winId); return w && w.scroll && w.scroll.scrollbar; }
    setScrollbarOrientation(winId, o) { const w = this.window(winId); if (w && w.scroll) w.scroll.scrollbar_orientation = o; }
    setScrollAutoscroll(winId, on) { const w = this.window(winId); if (!w) return; w.scroll = w.scroll || { rows: 1, cols: 1 }; w.scroll.autoscroll = !!on; }
    setScrollClicks(winId, n) { const w = this.window(winId); if (!w) return; w.scroll = w.scroll || { rows: 1, cols: 1 }; w.scroll.scroll_clicks = n; }
    removeScrollbar(winId) { const w = this.window(winId); if (w && w.scroll) delete w.scroll.scrollbar; }

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
            box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, align: "center", priority: 0, fields: [], tells: [] });
        return id;
    }
    setItemPriority(winId, id, priority) { const it = this.item(winId, id); if (it) it.priority = priority | 0; }
    // Move an item up/down the priority order (dir -1/+1) and renumber every item's priority
    // to match its new rank — top = 0. Renumbering keeps the list dense and contiguous so the
    // window node's order list stays a faithful 1:1 view of priority.
    moveItemPriority(winId, id, dir) {
        const w = this.window(winId);
        if (!w || !w.items) return;
        const order = [...w.items].sort((a, b) => (a.priority || 0) - (b.priority || 0));
        const i = order.findIndex((x) => x.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        order.forEach((it, k) => { it.priority = k; });   // top of the list -> priority 0
    }
    setWindowStaticGrid(winId, on) { const w = this.window(winId); if (w) w.static_grid = !!on; }
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
        if (fld && fld.id === old) fld.id = newId;
        // repoint tells that validate/locate on this field, else they reference a dead id
        // and silently reject every cell (the item stops detecting entirely)
        for (const t of it.tells || []) if (t.field === old) t.field = newId;
        // same for the record key — a stale part would silently drop every record
        if (it.key) it.key.fields = (it.key.fields || []).map((x) => (x === old ? newId : x));
        f.field = newId; f.id = newId;
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
            field, color: null, tolerance: 60, template: null, threshold: 0.5, locate: first });
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
