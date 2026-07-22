// GraphModel: the editable structure behind the node view. It holds the full
// GameProfile and exposes node/edge derivation plus edit ops. Box data
// (regions/detect/states/preprocess/scroll) is never touched here — it's authored
// on the canvas — so saving preserves it.

import { DEFAULT_DETECT_THRESHOLD, SYNTH_DEFAULTS } from "../defaults.js";

let _fieldSeq = 1;

// Mint `${prefix}${_fieldSeq++}` skipping any id an `exists` check rejects. `exists` must cover
// EVERY pool the id could collide with (a shared FieldDef pool as well as the node's own list) —
// checking only the node's own list let two nodes mint the same field id and silently share one
// FieldDef (rules pipeline) once `addField` saw the id already "existed" and skipped creating it.
function _mint(prefix, exists) {
    let id;
    do { id = prefix + _fieldSeq++; } while (exists(id));
    return id;
}

// Re-seed the counter above the highest trailing `_<int>` suffix anywhere in the loaded profile.
// `_fieldSeq` is a module global that otherwise restarts at 1 every page load while the saved
// profile already holds ids far past that — new mints then collide with existing ones.
function _seedFieldSeq(profile) {
    let max = 0;
    const scan = (node) => {
        if (Array.isArray(node)) { for (const x of node) scan(x); return; }
        if (node && typeof node === "object") {
            for (const k in node) {
                const v = node[k];
                if (k === "id" && typeof v === "string") {
                    const m = /_(\d+)$/.exec(v);
                    if (m) { const n = +m[1]; if (n > max) max = n; }
                } else scan(v);
            }
        }
    };
    scan(profile);
    if (max + 1 > _fieldSeq) _fieldSeq = max + 1;
}

export class GraphModel {
    constructor() { this.profile = blank(""); this.sounds = []; this.shownSatellites = new Set(); this._imgSel = new Map(); }   // sounds: available trigger-sound filenames (fetched once); shownSatellites: ids of opt-in follower nodes (preview / vt-table) currently visible; _imgSel: transient (not saved) toast-image selected-text-line index, keyed "toastId#imgIdx"

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
        for (const x of this.profile.toasts) {
            x.sources = x.sources || [];   // wired {{token}} feeders (prefixed refs)
            x.texts = x.texts || [];       // styled rich-text blocks (the toast body)
            // generated hero/inline image specs (drawn server-side; message text painted on them)
            GraphModel._migrateToastImages(x);   // fold legacy hero/inline -> images[] (placement)
            if (x.show_icon === undefined) x.show_icon = true;   // draw the app-logo icon (default on)
            // migrate the legacy title/message pair into styled blocks the first time (texts empty):
            // title -> a "title"-styled block, message -> a default block. Clear the old fields so
            // `texts` is the single source of truth from here on.
            if (!x.texts.length && (x.title || x.message)) {
                if (x.title) x.texts.push({ content: x.title, style: "title", align: "", max_lines: 0 });
                if (x.message) x.texts.push({ content: x.message, style: "", align: "", max_lines: 0 });
                x.title = ""; x.message = "";
            }
        }
        this.profile.sounds = this.profile.sounds || [];   // browser-played sound nodes (trigger targets)
        // gates (boolean guards a trigger must satisfy) + routers (branch a live value to targets)
        this.profile.gates = this.profile.gates || [];
        for (const g of this.profile.gates) {
            g.source = g.source || ""; g.conds = g.conds || []; g.logic = g.logic || "or";
            g.negate = !!g.negate; if (g.enabled === undefined) g.enabled = true;
        }
        this.profile.routers = this.profile.routers || [];
        for (const r of this.profile.routers) {
            r.source = r.source || ""; r.branches = r.branches || [];
            for (const b of r.branches) { b.conds = b.conds || []; b.targets = b.targets || []; b.logic = b.logic || "or"; }
            if (r.enabled === undefined) r.enabled = true;
        }
        this.profile.dictionaries = this.profile.dictionaries || [];
        // taught cutout atlas: kind=glyph feeds post-OCR refinement, kind=symbol feeds whole-box
        // classification (`type: symbol` fields) — one atlas, two match pools (see atlas_match.py)
        this.profile.atlas = this.profile.atlas || [];
        this._renameHook = null;   // (rewrite) called on every id rename so cross-doc token refs repoint
        // a subset joins many sources, each carrying its own join config (JoinSource)
        for (const s of this.profile.subsets) {
            s.sources = s.sources || [];
            for (const src of s.sources) src.mode = src.mode || "join";   // join|exclude|mark|broadcast
            s.pivot = s.pivot || null;   // reshape flat name/value rows into wide rows (PivotSpec)
            s.sort = s.sort || [];
            // fold a legacy single-column sort into the multi-column list
            if (!s.sort.length && s.sort_by) { s.sort = [{ field: s.sort_by, desc: !!s.sort_desc }]; s.sort_by = ""; }
        }
        for (const pn of this.profile.producers) { pn.sources = pn.sources || []; pn.queue_mode = pn.queue_mode || "drop"; }   // items the node prices (empty = catalogue)
        for (const s of this.profile.file_sources) { s.match = s.match || []; s.fields = s.fields || []; s.roots = s.roots || []; }
        for (const t of this.profile.triggers) {
            t.watch = t.watch || []; t.targets = t.targets || [];
            t.readout_watch = t.readout_watch || [];
            t.register_watch = t.register_watch || [];
            t.gates = t.gates || [];   // value gates that must all pass for this trigger to fire
            if (t.throttle_ms === undefined) t.throttle_ms = null;
            if (t.settle_ms === undefined) t.settle_ms = null;
            if (t.settle_max_ms === undefined) t.settle_max_ms = null;
            if (t.ready_field === undefined) t.ready_field = "";
        }
        this.profile.actions = this.profile.actions || [];
        for (const x of this.profile.actions) {
            // legacy dataset-only `datasets: [<id>]` -> prefixed `sources: ["dataset:<id>"]` (twin of
            // the server _migrate_sources, for an in-memory profile that never round-tripped).
            if (!x.sources) x.sources = (x.datasets || []).map((d) => `dataset:${d}`);
            delete x.datasets;
            x.slots = x.slots || {};   // register id -> targeted readout keys (absent/[] = all)
            x.action = x.action || ""; x.dest = x.dest || ""; if (x.enabled == null) x.enabled = true;
            if (x.delay_ms == null) x.delay_ms = 0;        // wait this long after being fired
            if (x.repeat == null) x.repeat = 1;            // how many times to cue sound sources
            if (x.repeat_ms == null) x.repeat_ms = 300;    // gap between those cues
        }
        this.profile.registers = this.profile.registers || [];
        for (const r of this.profile.registers) {
            r.sources = r.sources || []; if (r.capacity == null) r.capacity = 1;
            if (r.aggregate == null) r.aggregate = ""; if (r.ignore_empty == null) r.ignore_empty = false;
            if (r.persist == null) r.persist = ""; if (r.enabled == null) r.enabled = true;
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
        _seedFieldSeq(this.profile);   // new mints must start above every id already in this profile
    }

    // ---- taught cutout atlas: kind=glyph (post-OCR refinement) + kind=symbol (whole-box
    // classification for `type: symbol` fields) share one list, teaching UI, and match kernel ----
    atlas() { return this.profile.atlas || (this.profile.atlas = []); }
    // grouped by kind (glyph before symbol) so the two pools stay visually separate in the list,
    // then alphabetical by label (case-insensitive, then case, then image)
    sortAtlas() {
        this.atlas().sort((a, b) =>
            (a.kind || "glyph").localeCompare(b.kind || "glyph")
            || (a.label || "").localeCompare(b.label || "", undefined, { sensitivity: "base" })
            || (a.label || "").localeCompare(b.label || "")
            || (a.image || "").localeCompare(b.image || ""));
    }
    addCutout({ label = "", image, enabled = true, kind = "glyph" }) {
        this.atlas().push({ label, image, enabled, kind }); this.sortAtlas();
        return this.atlas().findIndex((c) => c.image === image);
    }
    addCutouts(list, kind = "glyph") {
        for (const c of list) this.atlas().push({ label: c.label ?? c.char ?? "", image: c.image, enabled: c.enabled !== false, kind });
        this.sortAtlas();
    }
    setCutoutLabel(i, label) { const c = this.atlas()[i]; if (c) { c.label = label; this.sortAtlas(); } }
    setCutoutEnabled(i, on) { const c = this.atlas()[i]; if (c) c.enabled = !!on; }
    setCutoutKind(i, kind) { const c = this.atlas()[i]; if (c) { c.kind = kind; this.sortAtlas(); } }
    removeCutout(i) { this.atlas().splice(i, 1); }

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
    // Detection re-open grace (batch_mode: detection only): OCR read-opportunities the window may go
    // unread before the next read counts as a fresh detection (new batch). 0 = inherit the global
    // confirm_frames. Widen so a brief OCR dropout on a still-visible screen isn't a false re-open.
    datasetReopenGrace(id) { const d = this.datasetDef(id); return (d && d.reopen_grace) || 0; }
    setDatasetReopenGrace(id, n) { this.ensureDatasetDef(id).reopen_grace = Math.max(0, +n || 0); }
    // Whether a run removes keys to mirror the game emptying out: "accumulate" (add/update only)
    // or "mirror" (a key gone from its visible scroll slice is removed — needs the window's scrollbar).
    datasetSyncMode(id) { const d = this.datasetDef(id); return (d && d.sync_mode) || "accumulate"; }
    setDatasetSyncMode(id, m) { this.ensureDatasetDef(id).sync_mode = m === "mirror" ? "mirror" : "accumulate"; }
    // Rolling batch-retention window: keep the newest N batches, 0 = unlimited. Older batches are
    // COMPACTED (each key's old reads fold into one base event under this dataset's aggregate),
    // not deleted — so old keys and their sums/means survive, only per-read detail is lost.
    datasetKeepBatches(id) { const d = this.datasetDef(id); return (d && d.keep_batches) || 0; }
    setDatasetKeepBatches(id, n) { this.ensureDatasetDef(id).keep_batches = Math.max(0, +n || 0); }
    // Folding only makes sense where a key HAS many observations to collapse. With dedup off or
    // aggregate "all" every read is already its own row, so a fold could only delete — the knob
    // is hidden for those (the store refuses too, so a stale UI can't destroy anything).
    datasetCanCompact(id) {
        const d = this.datasetDef(id);
        return !!d && d.dedup !== false && this.datasetAggregate(id) !== "all";
    }
    // SINGLE SOURCE OF TRUTH for every place ANY graph id is stored, as live get/set (or dict
    // re-key/drop) sites tagged with the entity KIND(s) that may occupy them. Every rename
    // (`_repoint`) and delete (`_unwire`) derives from this ONE registry, and `_declIds` lists
    // declared ids (backs `datasets()`), so an id can never desync into an orphan or duplicate.
    //   - `decl:true` sites DECLARE an entity (a node literally IS this id); ref sites point at one.
    //   - `kinds` gates matching by entity kind instead of by prefix string, so a shared dataset/
    //     subset ref lists both, and a trigger target lists every node kind — no prefix filtering.
    //   - a prefixed-ref list ("dataset:x"/"register:y" in ONE array) is decoded ONCE below, so a
    //     NEW prefix — or a whole new sources[] holder — is covered by rename+delete for free (rule 7).
    // Adding a node type that references ids = adding ONE line here; nothing else needs an audit.
    _refModel() {
        const sites = [], lists = [];
        const scalar = (kinds, decl, get, set) => sites.push({ kinds, decl, get, set });

        // def rows: each entity's own id declares its kind
        const defs = [
            ["dataset", this.profile.datasets], ["subset", this.profile.subsets],
            ["producer", this.profile.producers], ["action", this.profile.actions],
            ["toast", this.profile.toasts], ["sound", this.profile.sounds],
            ["filesource", this.profile.file_sources], ["trigger", this.profile.triggers],
            ["register", this.profile.registers], ["dictionary", this.profile.dictionaries],
            ["process", this.profile.processes], ["window", this.profile.windows],
            ["gate", this.profile.gates], ["router", this.profile.routers],
        ];
        for (const [kind, arr] of defs)
            for (const o of arr || []) scalar([kind], true, () => o.id, (v) => { o.id = v; });

        // dataset FEEDER decls: another node asserts "I output this dataset"
        for (const w of this.profile.windows || [])
            if (this._windowHasDataset(w)) scalar(["dataset"], true, () => this.datasetOf(w), (v) => { w.dataset = v; });
        for (const p of this.profile.producers || []) scalar(["dataset"], true, () => p.dataset, (v) => { p.dataset = v; });
        for (const s of this.profile.file_sources || []) scalar(["dataset"], true, () => s.dataset, (v) => { s.dataset = v; });

        // scalar bare-id refs
        for (const r of this.profile.registers || []) scalar(["dataset"], false, () => r.persist || "", (v) => { r.persist = v; });
        for (const x of this.profile.actions || []) scalar(["dataset"], false, () => x.dest || "", (v) => { x.dest = v; });   // clone/move dest
        for (const r of this._dictRules()) scalar(["dictionary"], false, () => r.dict_id || "", (v) => { r.dict_id = v; });

        // bare-id LIST refs (registered once => enumerated AND pruned on delete)
        const bareList = (kinds, owners, pick, empty = (e) => !e) => {
            for (const o of owners || []) {
                const a = pick(o); if (!a) continue;
                a.forEach((_, i) => scalar(kinds, false, () => a[i], (v) => { a[i] = v; }));
                lists.push({ arr: () => pick(o), empty });
            }
        };
        bareList(["dataset"], this.profile.producers, (p) => p.sources);                                   // priced-item sources
        bareList(["dataset", "subset"], this.profile.triggers, (t) => t.watch);                            // on_change watch
        bareList(["producer", "action", "toast", "sound", "filesource", "router"], this.profile.triggers, (t) => t.targets);
        bareList(["gate"], this.profile.triggers, (t) => t.gates);
        bareList(["register"], this.profile.triggers, (t) => t.register_watch);
        bareList(["readout"], this.profile.triggers, (t) => t.readout_watch);
        bareList(["window"], [this.profile], () => this.profile.window_priority);                          // recognition order

        // object-field LIST refs (id lives in entry.dataset)
        const fieldList = (kinds, owners, pick) => {
            for (const o of owners || []) {
                const a = pick(o); if (!a) continue;
                a.forEach((e) => scalar(kinds, false, () => e.dataset, (v) => { e.dataset = v; }));
                lists.push({ arr: () => pick(o), empty: (e) => !e.dataset });
            }
        };
        fieldList(["dataset", "subset"], this.profile.subsets, (s) => s.sources);
        fieldList(["dataset"], this.profile.dictionaries, (d) => d.feeds);

        // prefixed-ref LISTS ("kind:id" in one array) — decode the kind ONCE, no per-kind filtering
        const prefixedList = (owners, pick) => {
            for (const o of owners || []) {
                const a = pick(o); if (!a) continue;
                a.forEach((ref, i) => {
                    const c = ref.indexOf(":"), kind = c < 0 ? "" : ref.slice(0, c);
                    if (!kind) return;
                    scalar([kind], false, () => a[i].slice(a[i].indexOf(":") + 1), (v) => { a[i] = `${kind}:${v}`; });
                });
                lists.push({ arr: () => pick(o), empty: (r) => !r.slice(r.indexOf(":") + 1) });
            }
        };
        prefixedList(this.profile.actions, (x) => x.sources);      // dataset: | register: | sound: | action:
        prefixedList(this.profile.toasts, (x) => x.sources);       // dataset: | subset: | readout:
        prefixedList(this.profile.registers, (x) => x.sources);    // readout:
        // process inputs (ProcessInput {ref,out}) — like prefixedList but the id lives in `.ref`, and a
        // register-slot ref carries a "#<key>" suffix (register:<id>#<key>); decode the kind, and for
        // register refs match/repoint the id BEFORE the "#" while preserving the suffix, so a register
        // rename moves "register:old#k" -> "register:new#k" and a register delete prunes it (blank id).
        const procRegId = (r) => { const rest = r.slice(r.indexOf(":") + 1), h = rest.indexOf("#"); return h < 0 ? rest : rest.slice(0, h); };
        // A register-slot ref ("register:<id>#<key>[@facet]") stored via get/set: BOTH parts repoint —
        // the <id> on a REGISTER rename, AND the <key> on a READOUT rename. A register key IS the id of
        // the readout that feeds the slot (a readout->process->register slot carries the readout id
        // through), so renaming the readout must move "register:reg#old" -> "register:reg#new" or the
        // ref points at a dead key: a gate over it silently never holds, a process input reads nothing.
        // The "@facet" tail (count-facet sources) is preserved. ONE decoder, shared by process input +
        // gate/router source (rule 7). Missing this key repoint was the recurring rename bug.
        const regRefSites = (get, set) => {
            const parse = () => {
                const r = get() || "", c = r.indexOf(":"), rest = c < 0 ? r : r.slice(c + 1);
                const h = rest.indexOf("#"), id = h < 0 ? rest : rest.slice(0, h);
                const tail = h < 0 ? "" : rest.slice(h + 1), a = tail.indexOf("@");
                return { id, key: a < 0 ? tail : tail.slice(0, a), facet: a < 0 ? "" : tail.slice(a), hasKey: h >= 0 };
            };
            const build = (id, key, facet, hasKey) => (id ? `register:${id}${hasKey ? `#${key}${facet}` : ""}` : "");
            scalar(["register"], false, () => parse().id,
                (v) => { const p = parse(); set(build(v, p.key, p.facet, p.hasKey)); });
            if (parse().hasKey)
                scalar(["readout"], false, () => parse().key,
                    // rename -> move the key; delete (blank) -> blank the WHOLE ref (a dead key is a
                    // dead slot, same as a register delete blanking its refs), never a malformed "#".
                    (v) => { const p = parse(); set(v ? build(p.id, v, p.facet, true) : ""); });
        };
        for (const p of this.profile.processes || []) {
            const a = p.sources; if (!a) continue;
            a.forEach((inp, i) => {
                const ref = inp.ref || ""; const c = ref.indexOf(":"); if (c < 0) return;
                const kind = ref.slice(0, c);
                if (kind === "register") {
                    regRefSites(() => a[i].ref, (v) => { a[i].ref = v; });
                } else {
                    scalar([kind], false, () => a[i].ref.slice(a[i].ref.indexOf(":") + 1), (v) => { a[i].ref = `${kind}:${v}`; });
                }
            });
            lists.push({ arr: () => p.sources, empty: (o) => !procRegId(o.ref || "") });
        }

        // gate/router SOURCE: one prefixed ref ("readout:<id>" | "register:<id>#<key>[@facet]"). A
        // register ref repoints BOTH id and key (regRefSites, same as the process input above); a
        // readout ref repoints the bare id. A router also holds per-branch bare-id target lists.
        const refField = (owner, get, set) => {
            const ref = get(); if (!ref) return;
            const c = ref.indexOf(":"); if (c < 0) return;
            const kind = ref.slice(0, c);
            if (kind === "register") {
                regRefSites(get, set);
            } else {
                scalar([kind], false, () => get().slice(get().indexOf(":") + 1), (v) => set(v ? `${kind}:${v}` : ""));
            }
        };
        for (const g of this.profile.gates || []) refField(g, () => g.source, (v) => { g.source = v; });
        for (const r of this.profile.routers || []) {
            refField(r, () => r.source, (v) => { r.source = v; });
            bareList(["producer", "action", "toast", "sound", "filesource"], r.branches, (b) => b.targets);
        }

        // dict-key sites (register slots) — re-key on rename, drop on delete
        const dictSite = (kinds, owner, key) => sites.push({
            kinds, decl: false, dict: true,
            hasKey: (id) => owner[key] && Object.prototype.hasOwnProperty.call(owner[key], id),
            rekey: (o, n) => { const mp = owner[key] || (owner[key] = {}); if (o in mp) { mp[n] = mp[o]; delete mp[o]; } },
            drop: (id) => { if (owner[key]) delete owner[key][id]; },
        });
        for (const x of this.profile.actions || []) dictSite(["register"], x, "slots");

        return { sites, lists };
    }

    // Repoint every ref of `kind` (and, when {decl:true}, its declaration too) from oldId -> newId.
    _repoint(kind, oldId, newId, { decl = false } = {}) {
        if (!oldId || !newId || oldId === newId) return;
        for (const st of this._refModel().sites) {
            if (!st.kinds.includes(kind)) continue;
            if (st.dict) { if (st.hasKey(oldId)) st.rekey(oldId, newId); }
            else if ((decl || !st.decl) && st.get() === oldId) st.set(newId);
        }
    }
    // Delete-twin: blank every ref/feeder of `kind` holding `id`, drop dict keys, then compact the
    // lists that a blank emptied (a "kind:" tail, a falsy id, an entry with no .dataset).
    _unwire(kind, id) {
        const { sites, lists } = this._refModel();
        for (const st of sites) {
            if (!st.kinds.includes(kind)) continue;
            if (st.dict) st.drop(id);
            else if (st.get() === id) st.set("");   // decl: unwire feeder; ref: emptied then pruned below
        }
        for (const l of lists) { const a = l.arr(); if (a) { const keep = a.filter((e) => !l.empty(e)); a.length = 0; a.push(...keep); } }
    }
    // Declared ids of one kind (declaration sites only) — the SSOT `datasets()` reads.
    _declIds(kind) {
        const out = new Set();
        for (const st of this._refModel().sites)
            if (st.decl && st.kinds.includes(kind)) { const v = st.get(); if (v) out.add(v); }
        return out;
    }

    // Cross-document rename notification. A graph id can be referenced OUTSIDE the profile — the
    // Pretty doc embeds ids inside {{token}} strings (dataset:/subset: heads, node: paths). Those
    // live in a separate lazily-loaded model, so the structured registry (_refModel) can't reach
    // them. Every rename* emits {kind, old, new, win?} here; ONE subscriber (main.js) funnels them
    // to the Pretty repoint endpoint. Wired via a hook so model.js stays UI-free.
    setRenameHook(fn) { this._renameHook = fn; }
    _emitRename(kind, oldId, newId, win) {
        if (this._renameHook && oldId && newId && oldId !== newId)
            try { this._renameHook({ kind, old: oldId, new: newId, win }); } catch { /* never fail a rename */ }
    }

    // Rename a dataset: repoint EVERY site (declarations + references) holding the old id, so
    // the old name cannot linger and resurface as a duplicate node.
    renameDataset(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.datasets().includes(newId)) return false;   // collision incl. disk/price/window
        this._repoint("dataset", oldId, newId, { decl: true });   // move def + feeder decls + every ref
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
        // a persisting register writes one row per wired readout, always shaped {name, value}.
        for (const r of this.profile.registers || [])
            if (r.persist === id) { out.add("name"); out.add("value"); }
        return [...out];
    }
    // Every window/producer/file-source/register currently pointing at this dataset — same
    // scan as datasetFields(), just for display/edit rather than column collection. `ref` is a
    // full-word-prefixed id ("window:<id>"/"producer:<id>"/"filesource:<id>"/"register:<id>"),
    // matching how RegisterDef/ToastDef name their sources (not the short node-id prefixes used
    // elsewhere).
    datasetSources(id) {
        const out = [];
        for (const w of this.profile.windows)
            if (this.datasetOf(w) === id) out.push({ kind: "window", id: w.id, ref: `window:${w.id}` });
        for (const s of this.profile.file_sources || [])
            if (s.dataset === id) out.push({ kind: "filesource", id: s.id, ref: `filesource:${s.id}` });
        for (const p of this.profile.producers || [])
            if (p.dataset === id) out.push({ kind: "producer", id: p.id, ref: `producer:${p.id}` });
        for (const r of this.profile.registers || [])
            if (r.persist === id) out.push({ kind: "register", id: r.id, ref: `register:${r.id}` });
        return out;
    }
    // Window/producer/file-source/register ids NOT currently pointing at this dataset (may be
    // unwired or wired elsewhere — picking one just repoints it, the same "last wire wins" the
    // drag path has).
    datasetFreeSources(id) {
        const out = [];
        for (const w of this.profile.windows)
            if (this.datasetOf(w) !== id) out.push({ kind: "window", id: w.id, ref: `window:${w.id}` });
        for (const s of this.profile.file_sources || [])
            if (s.dataset !== id) out.push({ kind: "filesource", id: s.id, ref: `filesource:${s.id}` });
        for (const p of this.profile.producers || [])
            if (p.dataset !== id) out.push({ kind: "producer", id: p.id, ref: `producer:${p.id}` });
        for (const r of this.profile.registers || [])
            if (r.persist !== id) out.push({ kind: "register", id: r.id, ref: `register:${r.id}` });
        return out;
    }
    // Wire an existing window/producer/file-source/register onto this dataset (the "+ add source"
    // select — the in-panel twin of dragging that node's out-port onto the dataset).
    addDatasetSource(id, ref) {
        const i = (ref || "").indexOf(":");
        if (i < 0) return false;
        const kind = ref.slice(0, i), rid = ref.slice(i + 1);
        if (kind === "window") this.setDataset(rid, id);
        else if (kind === "producer") this.setProducerDataset(rid, id);
        else if (kind === "filesource") this.setSourceDataset(rid, id);
        else if (kind === "register") this.setRegisterPersist(rid, id);
        else return false;
        return true;
    }
    // Unwire a chip. Windows have a real "no dataset" state (setDataset("") already supports it);
    // producers/file-sources/registers don't (their setters require a truthy target), so blank the
    // field directly — same "needs rewiring" state as any half-configured node.
    removeDatasetSource(id, ref) {
        const i = (ref || "").indexOf(":");
        if (i < 0) return;
        const kind = ref.slice(0, i), rid = ref.slice(i + 1);
        if (kind === "window") this.setDataset(rid, "");
        else if (kind === "producer") { const p = this.producerNode(rid); if (p) p.dataset = ""; }
        else if (kind === "filesource") { const s = this.fileSource(rid); if (s) s.dataset = ""; }
        else if (kind === "register") { const r = this.registerNode(rid); if (r) r.persist = ""; }
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
        if (id.startsWith("prodhist:")) return `producer:${id.slice(9)}`; // producer's recent-fetches history
        if (id.startsWith("prod:")) return `producer:${id.slice(5)}`;   // producer preview (inputs/schema/test)
        if (id.startsWith("hist:")) return `trigger:${id.slice(5)}`;    // trigger's recent-fires history
        if (id.startsWith("rohist:")) return `ro:${id.slice(7)}`;       // readout's recent-reads history
        if (id.startsWith("reghist:")) return `register:${id.slice(8)}`; // register's recent-pushes history
        if (id.startsWith("prochist:")) return `process:${id.slice(9)}`; // process's recent input/output history
        return null;
    }
    satelliteBonds() {
        return this.satelliteIds().map((s) => ({ leader: this.satelliteParent(s), follower: s })).filter((b) => b.leader);
    }

    // ---- nodes / edges ------------------------------------------------------

    nodes() {
        const ns = [{ id: "game", type: "game", ref: this.profile }];
        // standalone cutout-atlas node (its own image surface; teaches glyph refinement + symbol classification)
        ns.push({ id: "atlas", type: "atlas", ref: this.profile });
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
            for (const v of w.readouts || []) {
                ns.push({ id: `ro:${w.id}:${v.id}`, type: "readout", ref: v, win: w, field: this.readoutField(w, v) });
                // read-history satellite (opt-in): recent reads + per-rule trace, non-persisted — a
                // standard vttable grid (kind "readouthistory"). See readout_history_node.js.
                if (this.satelliteOn(`rohist:${w.id}:${v.id}`))
                    ns.push({ id: `rohist:${w.id}:${v.id}`, type: "vttable", ref: { kind: "readouthistory", win: w.id, id: v.id } });
            }
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
            // fetch-history satellite (opt-in): recent sweeps, non-persisted — a vttable grid (kind
            // "producerhistory"). See producer_history_node.js.
            if (this.satelliteOn(`prodhist:${pn.id}`)) ns.push({ id: `prodhist:${pn.id}`, type: "vttable", ref: { kind: "producerhistory", id: pn.id } });
        }
        for (const s of this.profile.file_sources || []) {
            ns.push({ id: `src:${s.id}`, type: "filesource", ref: s });
            if (this.satelliteOn(`vt:src:${s.id}`)) ns.push({ id: `vt:src:${s.id}`, type: "vttable", ref: { kind: "source", id: s.id } });
            if (this.satelliteOn(`vtd:src:${s.id}`)) ns.push({ id: `vtd:src:${s.id}`, type: "vttable", ref: { kind: "sourcedismissed", id: s.id } });
        }
        for (const t of this.profile.triggers || []) {
            ns.push({ id: `trigger:${t.id}`, type: "trigger", ref: t });
            // history satellite (opt-in): recent fires (why/what), non-persisted — a standard vttable
            // grid (kind "triggerhistory"), so it resizes like every other node. See history_node.js.
            if (this.satelliteOn(`hist:${t.id}`)) ns.push({ id: `hist:${t.id}`, type: "vttable", ref: { kind: "triggerhistory", id: t.id } });
        }
        // gate: a boolean guard a trigger must satisfy before it fires (tests one live value).
        for (const x of this.profile.gates || []) ns.push({ id: `gate:${x.id}`, type: "gate", ref: x });
        // router: branches a live value to different targets (first matching branch wins).
        for (const x of this.profile.routers || []) ns.push({ id: `router:${x.id}`, type: "router", ref: x });
        for (const x of this.profile.toasts || []) ns.push({ id: `toast:${x.id}`, type: "toast", ref: x });
        for (const x of this.profile.sounds || []) ns.push({ id: `sound:${x.id}`, type: "sound", ref: x });
        for (const x of this.profile.actions || []) ns.push({ id: `action:${x.id}`, type: "action", ref: x });
        // in-memory keyed map fed by readouts (never persisted). Id prefix is `register:` — NOT
        // `reg:`, which _TYPE_BY_PREFIX already maps to a region node.
        for (const x of this.profile.registers || []) {
            ns.push({ id: `register:${x.id}`, type: "register", ref: x });
            // push-history satellite (opt-in): recent writes into the held map, non-persisted — a
            // standard vttable grid (kind "registerhistory"). See register_history_node.js.
            if (this.satelliteOn(`reghist:${x.id}`))
                ns.push({ id: `reghist:${x.id}`, type: "vttable", ref: { kind: "registerhistory", id: x.id } });
        }
        // standalone rules-pipeline node fed by readouts/registers/processes (never persisted). Id
        // prefix `process:` — distinct from every existing prefix (see _TYPE_BY_PREFIX).
        for (const x of this.profile.processes || []) {
            ns.push({ id: `process:${x.id}`, type: "process", ref: x });
            // input/output-history satellite (opt-in): key + input + per-rule trace + output, non-
            // persisted — a standard vttable grid (kind "processhistory"). See process_history_node.js.
            if (this.satelliteOn(`prochist:${x.id}`))
                ns.push({ id: `prochist:${x.id}`, type: "vttable", ref: { kind: "processhistory", id: x.id } });
        }
        for (const d of this.profile.dictionaries || []) ns.push({ id: `dict:${d.id}`, type: "dictionary", ref: d });
        return ns;
    }

    // One id/ref -> graph node id resolver, shared by the edge builder below AND every wired-
    // source chip list (sourcesInput's click-to-focus). Handles both prefixed refs
    // ("window:<id>"/"readout:<id>"/..., as toastSources/registerSources/datasetSources parse
    // them) and bare ids (subset join sources, producer sources, dictionary feeds, action
    // datasets, trigger targets/watch — all un-prefixed dataset/subset/producer/file-source/
    // toast/sound/action/readout ids). Returns null if ref resolves to no node (stale/dangling id).
    refNode(ref) {
        if (!ref) return null;
        const i = ref.indexOf(":");
        const prefix = i < 0 ? "" : ref.slice(0, i);
        const bare = i < 0 ? ref : ref.slice(i + 1);
        switch (prefix) {
            case "window": return `win:${bare}`;
            case "filesource": return `src:${bare}`;
            case "producer": return `producer:${bare}`;
            case "register": return `register:${bare.split("#")[0]}`;   // register:<id>#<key> -> the register node
            case "process": return `process:${bare}`;
            case "dataset": return `ds:${bare}`;
            case "subset": return `sub:${bare}`;
            case "sound": return `sound:${bare}`;
            case "action": return `action:${bare}`;
            case "readout": { const site = this.readoutSite(bare); return site ? `ro:${site.win}:${bare}` : null; }
        }
        // bare id: try every kind a wired-source chip can point at, same precedence the edge
        // builder used inline before this was extracted.
        if (this.subsetDef(ref)) return `sub:${ref}`;
        if (this.datasets().includes(ref)) return `ds:${ref}`;
        if (this.producerNode(ref)) return `producer:${ref}`;
        if (this.fileSource(ref)) return `src:${ref}`;
        if (this.toastNode(ref)) return `toast:${ref}`;
        if (this.soundNode(ref)) return `sound:${ref}`;
        if (this.actionNode(ref)) return `action:${ref}`;
        if (this.processNode(ref)) return `process:${ref}`;
        if (this.gateNode(ref)) return `gate:${ref}`;
        if (this.routerNode(ref)) return `router:${ref}`;
        const site = this.readoutSite(ref);
        return site ? `ro:${site.win}:${ref}` : null;
    }

    edges() {
        const es = [];
        es.push({ from: "game", to: "atlas", kind: "own" });   // cutout-atlas node hangs off the game node
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
            for (const v of w.readouts || []) {
                es.push({ from: `win:${w.id}`, to: `ro:${w.id}:${v.id}`, kind: "field" });
                // read-history satellite: dotted "img" edge readout -> its recent-reads grid (opt-in)
                if (this.satelliteOn(`rohist:${w.id}:${v.id}`))
                    es.push({ from: `ro:${w.id}:${v.id}`, to: `rohist:${w.id}:${v.id}`, kind: "img" });
            }
            if (this._windowHasDataset(w))   // no dataset node/wire until the window produces data
                es.push({ from: `win:${w.id}`, to: `ds:${this.datasetOf(w)}`, kind: "data" });
        }
        for (const s of this.profile.subsets || [])
            for (const inp of this.subsetInputs(s)) {
                // an input can be a dataset OR another subset — refNode picks the right source node
                const from = this.refNode(inp);
                if (from) es.push({ from, to: `sub:${s.id}`, kind: "data" });
            }
        // a producer WRITES into its output dataset (producer -> dataset, only once wired), and READS
        // its item list from any wired source dataset/subset (source -> producer); empty = whole catalogue.
        for (const pn of this.profile.producers || []) {
            if (pn.dataset) es.push({ from: `producer:${pn.id}`, to: `ds:${pn.dataset}`, kind: "data" });
            for (const src of pn.sources || []) {
                if (src === pn.dataset) continue;   // never wire a node to its own output
                const from = this.refNode(src);
                if (from) es.push({ from, to: `producer:${pn.id}`, kind: "data" });
            }
            if (this.satelliteOn(`prod:${pn.id}`)) es.push({ from: `producer:${pn.id}`, to: `prod:${pn.id}`, kind: "img" });
            if (this.satelliteOn(`prodhist:${pn.id}`)) es.push({ from: `producer:${pn.id}`, to: `prodhist:${pn.id}`, kind: "img" });
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
                const to = this.refNode(pid);
                if (to) es.push({ from: `trigger:${t.id}`, to, kind: "trigger" });
            }
            // a gate this trigger must satisfy (trigger -> gate). The gate reads its own tested value
            // from a readout/register (source -> gate, drawn in the gates loop below).
            for (const gid of t.gates || [])
                if (this.gateNode(gid)) es.push({ from: `trigger:${t.id}`, to: `gate:${gid}`, kind: "gate" });
            if (t.kind === "on_change" || t.kind === "on_any_change" || t.kind === "on_new_batch" || t.kind === "on_ready")
                for (const w of t.watch || []) {
                    const to = this.refNode(w);
                    if (to) es.push({ from: `trigger:${t.id}`, to, kind: "watch" });
                }
            // an on_readout trigger WATCHES live readouts — dashed line to each watched var node
            if (t.kind === "on_readout")
                for (const vid of t.readout_watch || []) {
                    const to = this.refNode(vid);
                    if (to) es.push({ from: `trigger:${t.id}`, to, kind: "watch" });
                }
            // an on_register trigger WATCHES register(s) — dashed line to each watched register node
            if (t.kind === "on_register")
                for (const rid of t.register_watch || []) {
                    if (this.registerNode(rid)) es.push({ from: `trigger:${t.id}`, to: `register:${rid}`, kind: "watch" });
                }
            // history satellite: dotted "img" edge trigger -> its recent-fires grid (opt-in)
            if (this.satelliteOn(`hist:${t.id}`)) es.push({ from: `trigger:${t.id}`, to: `hist:${t.id}`, kind: "img" });
        }
        // a gate READS the live value it tests from a readout/register (source -> gate); the
        // trigger(s) it gates wire IN from above (trigger -> gate).
        for (const g of this.profile.gates || []) {
            const from = this.refNode(g.source);
            if (from) es.push({ from, to: `gate:${g.id}`, kind: "data" });
        }
        // a router READS its tested value from a readout/register (source -> router) and, per branch,
        // FIRES that branch's targets (router -> target) when the branch's conds match.
        for (const r of this.profile.routers || []) {
            const from = this.refNode(r.source);
            if (from) es.push({ from, to: `router:${r.id}`, kind: "data" });
            for (const b of r.branches || [])
                for (const tid of b.targets || []) {
                    const to = this.refNode(tid);
                    if (to) es.push({ from: `router:${r.id}`, to, kind: "trigger" });
                }
        }
        // an action node ACTS ON its dataset AND register sources, CUES its sound sources and FIRES
        // its chained action sources (all control, hence kind "trigger"), and WRITES into its
        // clone/move destination dataset (action -> dest, the only data edge here).
        for (const x of this.profile.actions || []) {
            for (const s of this.actionSources(x.id)) {
                const to = this.refNode(s.ref);   // ds: / register: / sound: / action:
                if (to) es.push({ from: `action:${x.id}`, to, kind: "trigger" });
            }
            if (x.dest && (x.action || "").match(/^(clone|move)_/)) es.push({ from: `action:${x.id}`, to: `ds:${x.dest}`, kind: "data" });
        }
        // a toast READS its wired sources' live values as {{tokens}} (readout/dataset/subset -> toast)
        for (const x of this.profile.toasts || [])
            for (const s of this.toastSources(x.id)) {
                const from = this.refNode(s.ref);
                if (from) es.push({ from, to: `toast:${x.id}`, kind: "data" });
            }
        // a register HOLDS its wired readouts' live values (readout -> register), and — when
        // `persist` names a dataset — ALSO writes the held map there (register -> dataset), so
        // that state becomes joinable/excludable like any other dataset.
        for (const x of this.profile.registers || []) {
            for (const s of this.registerSources(x.id)) {
                const from = this.refNode(s.ref);   // a readout OR a process feeds a register
                if (from) es.push({ from, to: `register:${x.id}`, kind: "data" });
            }
            if (x.persist) es.push({ from: `register:${x.id}`, to: `ds:${x.persist}`, kind: "data" });
            // push-history satellite: dotted "img" edge register -> its recent-pushes grid (opt-in)
            if (this.satelliteOn(`reghist:${x.id}`)) es.push({ from: `register:${x.id}`, to: `reghist:${x.id}`, kind: "img" });
        }
        // a process APPLIES its rules pipeline to every wired input (readout/register/process ->
        // process), key preserved, and its output feeds another process or a register (that wire is
        // drawn from the consumer's own sources, above / below).
        for (const x of this.profile.processes || []) {
            for (const s of this.processSources(x.id)) {
                const from = this.refNode(s.ref);   // readout:/register:(#key)/process: source -> process
                if (from) es.push({ from, to: `process:${x.id}`, kind: "data" });
            }
            // input/output-history satellite: dotted "img" edge process -> its recent-fires grid (opt-in)
            if (this.satelliteOn(`prochist:${x.id}`)) es.push({ from: `process:${x.id}`, to: `prochist:${x.id}`, kind: "img" });
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
        const set = this._declIds("dataset");   // every declared dataset id (window/producer/source feeders + defs)
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
                 key_transform: "slugify", key_encode: true, catalogue: null, root: "", explode: [],
                 row_filter: [], fields: [] };
    }
    _blankCatalogue() {
        return { url: "", items_path: "data", name_path: "", key_path: "", fuzzy: 0.9, ttl_days: 7, suffix_hints: [] };
    }
    removeProducer(id) { this.profile.producers = (this.profile.producers || []).filter((p) => p.id !== id); this._unwire("producer", id); }
    renameProducer(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.producerNode(newId)) return false;
        this._repoint("producer", oldId, newId, { decl: true });   // def id + any trigger target
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
    // what to do when fired while already sweeping: drop (ignore) | latest (coalesce newest) | queue (FIFO).
    setProducerQueueMode(id, m) { const pn = this.producerNode(id); if (pn) pn.queue_mode = ["drop", "latest", "queue"].includes(m) ? m : "drop"; }
    setProducerEnabled(id, on) { const pn = this.producerNode(id); if (pn) pn.enabled = !!on; }

    // ---- http spec mutators (one per teachable knob; no knob without a setter) ----
    _http(id) { const pn = this.producerNode(id); return pn && pn.http ? pn.http : null; }
    setHttpMethod(id, m) { const s = this._http(id); if (s) s.request.method = m || "GET"; }
    setHttpUrl(id, u) { const s = this._http(id); if (s) s.request.url = u || ""; }
    setHttpTimeout(id, t) { const s = this._http(id); if (s) s.request.timeout = Math.max(0, parseFloat(t) || 0); }
    // id of a <script id="…"> tag to pull JSON out of, for sites with no JSON API of their own
    // (e.g. a Next.js __NEXT_DATA__ hydration blob). Blank = parse the response body as JSON.
    setHttpHtmlExtract(id, v) { const s = this._http(id); if (s) s.request.html_extract = v || ""; }
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
    // The HttpFilter list an edit targets: a field's ARRAY reduction (`i` = field index), or the
    // producer's ROW filter (`i == null`). One resolver so both filter editors share the mutators
    // (and the in/nin value coercion) instead of forking a near-copy per list.
    _filterList(id, i) {
        const s = this._http(id);
        if (!s) return null;
        if (i == null) return (s.row_filter ||= []);
        return (s.fields[i] && s.fields[i].array) ? s.fields[i].array.filter : null;
    }
    addHttpFilter(id, i = null) { const l = this._filterList(id, i); if (l) l.push({ path: "", op: "eq", value: "" }); }
    removeHttpFilter(id, i, fi) { const l = this._filterList(id, i); if (l) l.splice(fi, 1); }
    setHttpFilter(id, i, fi, patch) {
        const flt = (this._filterList(id, i) || [])[fi];
        if (!flt) return;
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
    // optional: a NESTED array column to source items from instead of a top-level scalar — every
    // element's `source_field` value, deduped across every row. Blank = source_field is a plain column.
    setProducerSourceArray(id, v) { const pn = this.producerNode(id); if (pn) pn.source_array = v || ""; }
    // output column the fetched item's identity is written under (per-item, non-explode only).
    // "" -> falls back to source_field; set when the source names the item differently than the
    // dataset's own key field (e.g. a distinct-by view exposes `item` while the dataset keys `name`).
    setProducerIdentityField(id, v) { const pn = this.producerNode(id); if (pn) pn.identity_field = v || ""; }
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
        this.profile.triggers.push({ id, kind, interval_s: 300, watch: [], targets: [], enabled: true, readout_watch: [], register_watch: [], gates: [], throttle_ms: null, settle_ms: null, settle_max_ms: null, ready_field: "" });
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
    setTriggerKind(id, kind) { const t = this.trigger(id); if (t && ["interval", "true_interval", "on_change", "on_any_change", "on_new_batch", "on_app_start", "on_capture", "on_live_start", "on_live_stop", "on_readout", "on_register", "on_ready", "manual"].includes(kind)) t.kind = kind; }
    setTriggerInterval(id, s) { const t = this.trigger(id); const v = parseFloat(s); if (t && v > 0) t.interval_s = v; }
    // minimum ms between fires — empty/invalid clears it (null = no throttle).
    setTriggerThrottle(id, v) { const t = this.trigger(id); if (!t) return; const n = parseFloat(v); t.throttle_ms = (v === "" || v == null || Number.isNaN(n) || n <= 0) ? null : n; }
    // trailing-settle debounce (ms) — empty/invalid clears it (null = fire immediately).
    setTriggerSettle(id, v) { const t = this.trigger(id); if (!t) return; const n = parseFloat(v); t.settle_ms = (v === "" || v == null || Number.isNaN(n) || n <= 0) ? null : n; }
    // settle deadline cap (ms) — empty/invalid clears it (null = no cap).
    setTriggerSettleMax(id, v) { const t = this.trigger(id); if (!t) return; const n = parseFloat(v); t.settle_max_ms = (v === "" || v == null || Number.isNaN(n) || n <= 0) ? null : n; }
    // on_ready completeness column — the visible subset field that must be filled on every row.
    setTriggerReadyField(id, v) { const t = this.trigger(id); if (!t) return; t.ready_field = (v || "").trim(); }
    addTriggerTarget(id, pid) {
        const t = this.trigger(id);
        // a target is a price node (sweep), a file source (read), a toast (notify), a sound (play), an action (dataset op), OR a router (branch) — accept any id
        if (!t || !pid || !(this.producerNode(pid) || this.fileSource(pid) || this.toastNode(pid) || this.soundNode(pid) || this.actionNode(pid) || this.routerNode(pid))) return false;
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

    // ---- on_register: watch register(s); the fire condition now lives on the wired gate(s) ----
    addTriggerRegisterWatch(id, reg) {
        const t = this.trigger(id);
        if (!t || !reg || !this.registerNode(reg)) return false;
        t.register_watch = t.register_watch || [];
        if (t.register_watch.includes(reg)) return false;
        t.register_watch.push(reg);
        return true;
    }
    removeTriggerRegisterWatch(id, reg) {
        const t = this.trigger(id);
        if (!t) return;
        t.register_watch = (t.register_watch || []).filter((r) => r !== reg);
    }
    // ---- trigger gates: value guards that must ALL pass for the trigger to fire (see GateDef) ----
    addTriggerGate(id, gid) {
        const t = this.trigger(id);
        if (!t || !gid || !this.gateNode(gid)) return false;
        t.gates = t.gates || [];
        if (t.gates.includes(gid)) return false;
        t.gates.push(gid);
        return true;
    }
    removeTriggerGate(id, gid) { const t = this.trigger(id); if (t) t.gates = (t.gates || []).filter((g) => g !== gid); }

    // ---- gate / router nodes: value guards (gate) + value branches (router) ----
    // A gate tests ONE live value (a readout, or a register slot) against an ordered condition list
    // combined by and/or, optionally negated; a trigger lists the gates it must satisfy. A router
    // tests one live value and, per branch (first match wins), fires that branch's targets.
    gateNode(id) { return (this.profile.gates || []).find((g) => g.id === id) || null; }
    routerNode(id) { return (this.profile.routers || []).find((r) => r.id === id) || null; }
    gates() { return (this.profile.gates || []).map((g) => g.id); }
    routers() { return (this.profile.routers || []).map((r) => r.id); }
    // Reverse lookups: which triggers a gate/router is wired TO (the trigger owns the ref, so the
    // gate/router body shows its destination by scanning triggers). Editing them writes back through
    // addTriggerGate/addTriggerTarget so there is one source of truth (the trigger).
    gateTriggers(gid) { return (this.profile.triggers || []).filter((t) => (t.gates || []).includes(gid)).map((t) => t.id); }
    routerTriggers(rid) { return (this.profile.triggers || []).filter((t) => (t.targets || []).includes(rid)).map((t) => t.id); }
    addGate() {
        this.profile.gates = this.profile.gates || [];
        let n = 1, id = "gate";
        while (this.gateNode(id)) id = `gate_${++n}`;
        this.profile.gates.push({ id, source: "", conds: [], logic: "or", negate: false, enabled: true });
        return id;
    }
    addRouter() {
        this.profile.routers = this.profile.routers || [];
        let n = 1, id = "router";
        while (this.routerNode(id)) id = `router_${++n}`;
        this.profile.routers.push({ id, source: "", branches: [{ conds: [], logic: "or", targets: [] }], enabled: true });
        return id;
    }
    removeGate(id) { this.profile.gates = (this.profile.gates || []).filter((g) => g.id !== id); this._unwire("gate", id); }
    removeRouter(id) { this.profile.routers = (this.profile.routers || []).filter((r) => r.id !== id); this._unwire("router", id); }
    renameGate(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.gateNode(newId)) return false;
        this._repoint("gate", oldId, newId, { decl: true });   // def id + any trigger's gates list
        this._emitRename("gate", oldId, newId);
        return true;
    }
    renameRouter(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.routerNode(newId)) return false;
        this._repoint("router", oldId, newId, { decl: true });   // def id + any trigger target
        this._emitRename("router", oldId, newId);
        return true;
    }
    // ---- gate config ----
    setGateSource(id, ref) { const g = this.gateNode(id); if (g) g.source = ref || ""; }
    setGateLogic(id, v) { const g = this.gateNode(id); if (g) g.logic = (v === "and") ? "and" : "or"; }
    setGateNegate(id, on) { const g = this.gateNode(id); if (g) g.negate = !!on; }
    addGateCond(id) { const g = this.gateNode(id); if (g) { g.conds = g.conds || []; g.conds.push({ when: "always", arg: "" }); } }
    removeGateCond(id, idx) { const g = this.gateNode(id); if (g && g.conds) g.conds.splice(idx, 1); }
    setGateCondWhen(id, idx, when) { const g = this.gateNode(id); const c = g && g.conds && g.conds[idx]; if (c) c.when = when; }
    setGateCondArg(id, idx, arg) { const g = this.gateNode(id); const c = g && g.conds && g.conds[idx]; if (c) c.arg = arg ?? ""; }
    // ---- router config ----
    setRouterSource(id, ref) { const r = this.routerNode(id); if (r) r.source = ref || ""; }
    _branch(id, bi) { const r = this.routerNode(id); return (r && r.branches && r.branches[bi]) || null; }
    addRouterBranch(id) { const r = this.routerNode(id); if (r) { r.branches = r.branches || []; r.branches.push({ conds: [], logic: "or", targets: [] }); } }
    removeRouterBranch(id, bi) { const r = this.routerNode(id); if (r && r.branches) r.branches.splice(bi, 1); }
    setRouterBranchLogic(id, bi, v) { const b = this._branch(id, bi); if (b) b.logic = (v === "and") ? "and" : "or"; }
    addRouterBranchCond(id, bi) { const b = this._branch(id, bi); if (b) { b.conds = b.conds || []; b.conds.push({ when: "always", arg: "" }); } }
    removeRouterBranchCond(id, bi, ci) { const b = this._branch(id, bi); if (b && b.conds) b.conds.splice(ci, 1); }
    setRouterBranchCondWhen(id, bi, ci, w) { const b = this._branch(id, bi); const c = b && b.conds && b.conds[ci]; if (c) c.when = w; }
    setRouterBranchCondArg(id, bi, ci, a) { const b = this._branch(id, bi); const c = b && b.conds && b.conds[ci]; if (c) c.arg = a ?? ""; }
    addRouterTarget(id, bi, targetId) {
        const b = this._branch(id, bi);
        // a branch target is a producer/file source/toast/sound/action (same set a trigger fires) — validate + dedupe
        if (!b || !targetId || !(this.producerNode(targetId) || this.fileSource(targetId) || this.toastNode(targetId) || this.soundNode(targetId) || this.actionNode(targetId))) return false;
        b.targets = b.targets || [];
        if (b.targets.includes(targetId)) return false;
        b.targets.push(targetId);
        return true;
    }
    removeRouterTarget(id, bi, targetId) { const b = this._branch(id, bi); if (b) b.targets = (b.targets || []).filter((p) => p !== targetId); }

    // ---- action nodes: clear / clone / move a dataset's data when fired (a trigger target) ----
    static ACTION_KINDS = ["", "clear", "compact", "clone_batches", "clone_resolved", "move_batches", "move_resolved"];
    actionNode(id) { return (this.profile.actions || []).find((x) => x.id === id) || null; }
    addAction() {
        this.profile.actions = this.profile.actions || [];
        let n = 1, id = "action";
        while (this.actionNode(id)) id = `action_${++n}`;
        this.profile.actions.push({ id, action: "", sources: [], slots: {}, dest: "",
            delay_ms: 0, repeat: 1, repeat_ms: 300, enabled: true });
        return id;
    }
    removeAction(id) { this.profile.actions = (this.profile.actions || []).filter((x) => x.id !== id); this._unwire("action", id); }
    renameAction(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.actionNode(newId)) return false;
        this._repoint("action", oldId, newId, { decl: true });   // def id + any trigger target
        return true;
    }
    setActionKind(id, v) { const x = this.actionNode(id); if (x && GraphModel.ACTION_KINDS.includes(v)) x.action = v; }
    // Wired sources as prefixed refs "dataset:<id>" / "register:<id>" (mirrors registerSources). -> {kind,id,ref}.
    actionSources(id) {
        const x = this.actionNode(id);
        return ((x && x.sources) || []).map((ref) => {
            const i = ref.indexOf(":");
            return i < 0 ? { kind: "", id: ref, ref } : { kind: ref.slice(0, i), id: ref.slice(i + 1), ref };
        }).filter((s) => s.kind && s.id);
    }
    // Add a target by prefixed ref — a DATASET/REGISTER the op runs on, a SOUND to cue, or another
    // ACTION to fire downstream (chaining). Validates the kind + that the target exists; a chain
    // that would close a cycle (or point at itself) is refused here, and the server guards too.
    addActionSource(id, ref) {
        const x = this.actionNode(id);
        if (!x || !ref) return false;
        const i = ref.indexOf(":");
        const kind = i < 0 ? "" : ref.slice(0, i), rid = i < 0 ? ref : ref.slice(i + 1);
        const ok = (kind === "dataset" && this.datasets().includes(rid))
            || (kind === "register" && !!this.registerNode(rid))
            || (kind === "sound" && !!this.soundNode(rid))
            || (kind === "action" && !!this.actionNode(rid) && rid !== id && !this._actionReaches(rid, id));
        if (!ok) return false;
        x.sources = x.sources || [];
        if (x.sources.includes(ref)) return false;
        x.sources.push(ref);
        return true;
    }
    removeActionSource(id, ref) {
        const x = this.actionNode(id);
        if (!x) return;
        x.sources = (x.sources || []).filter((r) => r !== ref);
        // dropping a register source prunes its slot targeting (orphan entry otherwise)
        if (ref.startsWith("register:") && x.slots) delete x.slots[ref.slice("register:".length)];
    }
    // Targeted readout keys for one register source ([] / absent = all of that register's keys).
    actionSlots(id, regId) { const x = this.actionNode(id); return (x && x.slots && x.slots[regId]) || []; }
    // Narrow (or reset to "all") a register source's targeted keys. Storing [] when the set covers
    // every wired key (or is empty) is the canonical "all" — keeps YAML clean and avoids drift.
    setActionSlots(id, regId, keys) {
        const x = this.actionNode(id);
        if (!x) return;
        x.slots = x.slots || {};
        const uniq = [...new Set(keys || [])];
        const all = this.registerKeys(regId);
        if (!uniq.length || (uniq.length === all.length && all.every((k) => uniq.includes(k)))) delete x.slots[regId];
        else x.slots[regId] = uniq;
    }
    setActionDest(id, v) { const x = this.actionNode(id); if (x) x.dest = v || ""; }
    // Does the chain starting at `from` reach `target`? Guards addActionSource from closing a cycle
    // (a -> b -> a would cascade forever were the server not also guarding).
    _actionReaches(from, target) {
        const seen = new Set();
        const walk = (aid) => {
            if (aid === target) return true;
            if (seen.has(aid)) return false;
            seen.add(aid);
            return this.actionSources(aid).some((s) => s.kind === "action" && walk(s.id));
        };
        return walk(from);
    }
    // Timing knobs — ALL scheduling is server-side (a backgrounded tab throttles timers but not its
    // SSE cue delivery), so these are plain persisted numbers the browser never acts on itself.
    setActionDelay(id, v) { const x = this.actionNode(id); if (x) x.delay_ms = Math.max(0, Math.round(Number(v) || 0)); }
    setActionRepeat(id, v) { const x = this.actionNode(id); if (x) x.repeat = Math.max(1, Math.round(Number(v) || 1)); }
    setActionRepeatMs(id, v) { const x = this.actionNode(id); if (x) x.repeat_ms = Math.max(10, Math.round(Number(v) || 300)); }
    cloneAction(id) { this.profile.actions = this.profile.actions || []; return this._cloneById(this.profile.actions, id, (x) => !!this.actionNode(x)); }

    // ---- register nodes: in-memory keyed map holding wired readouts' live values (optionally
    // ALSO mirrored to a dataset via `persist` — see RegisterDef) ----
    registerNode(id) { return (this.profile.registers || []).find((x) => x.id === id) || null; }
    registers() { return (this.profile.registers || []).map((x) => x.id); }
    addRegister() {
        this.profile.registers = this.profile.registers || [];
        let n = 1, id = "register";
        while (this.registerNode(id)) id = `register_${++n}`;
        this.profile.registers.push({ id, sources: [], title: "", enabled: true, persist: "", capacity: 1, aggregate: "", ignore_empty: false });
        return id;
    }
    // unwire action "register:" sources + slot targeting AND on_register trigger watch + key
    // conditions (else a dangling ref/edge) — all through the one registry.
    removeRegister(id) {
        this.profile.registers = (this.profile.registers || []).filter((x) => x.id !== id);
        this._unwire("register", id);
    }
    renameRegister(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.registerNode(newId)) return false;
        this._repoint("register", oldId, newId, { decl: true });   // def id + action sources/slots + trigger watch/conds
        this._emitRename("register", oldId, newId);
        return true;
    }
    // Parse a prefixed-ref sources[] array ("kind:id" per entry) -> [{kind,id,ref}], dropping any
    // entry with no kind or id. The ONE parse every prefixed-source list (register/toast/process)
    // shares — a new sources holder calls this, it doesn't re-inline the split (rule 7).
    static _parseRefs(sources) {
        return (sources || []).map((ref) => {
            const i = ref.indexOf(":");
            return i < 0 ? { kind: "", id: ref, ref } : { kind: ref.slice(0, i), id: ref.slice(i + 1), ref };
        }).filter((s) => s.kind && s.id);
    }
    // The source KINDS each consumer node type accepts — the ONE truth every "+ add source" picker
    // reads (and the port-drop targets agree with). Declaring a new wireable pairing = one edit here,
    // not a hand-rolled candidate list per node (rule 7). `register_key` = a single register slot
    // (register:<id>#<key>), the process key-mangler's single-key unit.
    static SOURCE_KINDS = {
        register: ["readout", "process"],
        process: ["readout", "register_key"],
        toast: ["readout", "dataset", "subset"],
        gate: ["readout", "register_key", "register_count"],
        router: ["readout", "register_key", "register_count"],
    };
    // The count-facet suffixes a `register_count` source offers per key: each counts over the key's
    // ring of recent values (register:<id>#<key>@<facet>) so a numeric gate op tests HOW MANY values
    // the key holds, not its single exposed value. count = held depth; nonblank = the actual (non-
    // blank) values; distinct = unique values. Backend: TriggerRunner._facet_count.
    static REGISTER_COUNT_FACETS = [["count", "count"], ["nonblank", "actual"], ["distinct", "distinct"]];
    // Addable source candidates for a consumer node, derived from SOURCE_KINDS + the consumer's
    // already-wired refs. -> [{ref,label,kind}]. Every picker calls this so the listings can't drift
    // from what's actually wireable (e.g. a register's "+" now lists processes, not only readouts).
    sourceCandidates(consumerType, consumerId) {
        const kinds = GraphModel.SOURCE_KINDS[consumerType] || [];
        const wired = new Set(this._wiredRefs(consumerType, consumerId));
        const out = [];
        const add = (ref, label, kind) => { if (!wired.has(ref)) out.push({ ref, label, kind }); };
        for (const kind of kinds) {
            if (kind === "readout") for (const v of this.readouts()) add(`readout:${v.id}`, `readout: ${v.id}`, kind);
            else if (kind === "process") for (const pid of this.processes()) { if (pid !== consumerId) add(`process:${pid}`, `process: ${pid}`, kind); }
            else if (kind === "register_key") for (const rg of this.registers()) for (const k of this.registerKeys(rg)) add(`register:${rg}#${k}`, `register: ${rg} · ${k}`, kind);
            else if (kind === "register_count") for (const rg of this.registers()) for (const k of this.registerKeys(rg)) for (const [f, lbl] of GraphModel.REGISTER_COUNT_FACETS) add(`register:${rg}#${k}@${f}`, `register: ${rg} · ${k} · #${lbl}`, kind);
            else if (kind === "register") for (const rg of this.registers()) add(`register:${rg}`, `register: ${rg}`, kind);
            else if (kind === "dataset") for (const ds of this.datasets()) add(`dataset:${ds}`, `dataset: ${ds}`, kind);
            else if (kind === "subset") for (const s of (this.profile.subsets || [])) add(`subset:${s.id}`, `subset: ${s.id}`, kind);
        }
        return out;
    }
    // The refs a consumer already has wired (excluded from candidates) — reads each consumer's own
    // parsed sources, so it tracks whatever shape that node stores (strings vs ProcessInput objects).
    _wiredRefs(consumerType, id) {
        if (consumerType === "register") return this.registerSources(id).map((s) => s.ref);
        if (consumerType === "process") return this.processSources(id).map((s) => s.ref);
        if (consumerType === "toast") return this.toastSources(id).map((s) => s.ref);
        return [];
    }
    // Wired readout feeders as prefixed refs "readout:<id>" (mirrors toastSources). -> {kind,id,ref}.
    registerSources(id) { return GraphModel._parseRefs(this.registerNode(id)?.sources); }
    // The full ordered key set a register holds from its WIRING alone: each wired readout's id, plus
    // each wired process's declared output keys. Deduped, first-wins order. The ONE truth every
    // register key list reads (register cells, trigger conditions, action slots, register_key
    // candidates) — was 5 diverging copies of a readout-only filter that dropped process keys (rule 7).
    registerKeys(id) {
        const keys = [];
        for (const s of this.registerSources(id)) {
            if (s.kind === "readout") keys.push(s.id);
            else if (s.kind === "process") keys.push(...this.processOutputKeys(s.id));
        }
        return [...new Set(keys)];
    }
    addRegisterSource(id, ref) {
        const x = this.registerNode(id);
        if (!x || !ref) return false;
        x.sources = x.sources || [];
        if (x.sources.includes(ref)) return false;
        x.sources.push(ref);
        return true;
    }
    removeRegisterSource(id, ref) { const x = this.registerNode(id); if (x) x.sources = (x.sources || []).filter((r) => r !== ref); }
    // ALSO mirror the held map into a dataset (see RegisterDef.persist) — same shape as
    // setProducerDataset/setSourceDataset: a truthy target wires it, ensuring the dataset exists.
    setRegisterPersist(id, ds) {
        const x = this.registerNode(id);
        if (x && ds) { x.persist = ds; this.ensureDatasetDef(ds); }
    }
    // How many recent values to hold per key (ring depth). Coerce like the trigger interval:
    // parse int, floor at 1 (blank/garbage -> 1).
    setRegisterCapacity(id, v) {
        const x = this.registerNode(id);
        if (!x) return;
        const n = parseInt(v, 10);
        x.capacity = (Number.isNaN(n) || n < 1) ? 1 : n;
    }
    // How a key's ring collapses to the ONE exposed/persisted value. "" (the `<latest>` option) or
    // any unknown mode -> the ring tail; else a fold from the REG_AGGREGATES roster (register_node.js)
    // — min/max/avg/median/stable/quality/... Only offered when capacity > 1.
    setRegisterAggregate(id, v) { const x = this.registerNode(id); if (x) x.aggregate = v === "latest" ? "" : (v || ""); }
    // The fold's per-mode tuning knob (RegisterDef.aggregate_arg) — 0 = that mode's own default.
    // Parse float, floor at 0 (blank/garbage/negative -> 0, "use the default").
    setRegisterAggregateArg(id, v) {
        const x = this.registerNode(id);
        if (!x) return;
        const n = parseFloat(v);
        x.aggregate_arg = (Number.isNaN(n) || n < 0) ? 0 : n;
    }
    // Ignore null / empty reads instead of writing them to a keyslot.
    setRegisterIgnoreEmpty(id, on) { const x = this.registerNode(id); if (x) x.ignore_empty = !!on; }

    // ---- process nodes: standalone rules pipeline applied to wired inputs, key-preserved
    // (consolidates the identical rules section otherwise copy-pasted across readouts — see ProcessDef) ----
    processNode(id) { return (this.profile.processes || []).find((x) => x.id === id) || null; }
    processes() { return (this.profile.processes || []).map((x) => x.id); }
    addProcess() {
        this.profile.processes = this.profile.processes || [];
        let n = 1, id = "process";
        while (this.processNode(id)) id = `process_${++n}`;
        this.profile.processes.push({ id, type: "text", sources: [], rules: [], enabled: true });
        return id;
    }
    // unwire nothing points AT a process today (its output is read by consumers' own sources, which
    // the registry repoints), so delete just drops the def + any dangling ref via the one registry.
    removeProcess(id) {
        this.profile.processes = (this.profile.processes || []).filter((x) => x.id !== id);
        this._unwire("process", id);
    }
    renameProcess(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.processNode(newId)) return false;
        this._repoint("process", oldId, newId, { decl: true });   // def id + every consumer's "process:" source
        this._emitRename("process", oldId, newId);
        return true;
    }
    // Wired single-key inputs as {kind,id,key?,ref,out} — each is a ProcessInput {ref,out}. Parses the
    // ref via the shared prefixed-ref parse (rule 7), splits a register slot's "#<key>" into id+key,
    // and carries the output-key rename `out` (blank = keep the input key). `ref` stays the full ref.
    processSources(id) {
        return ((this.processNode(id)?.sources) || []).map((inp) => {
            const [p] = GraphModel._parseRefs([inp.ref]);
            if (!p) return null;
            const s = { ...p, out: inp.out || "" };
            if (s.kind === "register") { const h = s.id.indexOf("#"); if (h >= 0) { s.key = s.id.slice(h + 1); s.id = s.id.slice(0, h); } }
            return s;
        }).filter(Boolean);
    }
    addProcessSource(id, ref) {
        const x = this.processNode(id);
        if (!x || !ref) return false;
        x.sources = x.sources || [];
        if (x.sources.some((s) => s.ref === ref)) return false;
        x.sources.push({ ref, out: "" });
        return true;
    }
    removeProcessSource(id, ref) { const x = this.processNode(id); if (x) x.sources = (x.sources || []).filter((s) => s.ref !== ref); }
    // The output keys a process emits — one per input: its `out` rename, or the input's own key when
    // blank (mirrors process_node.js inKey + the output field placeholder). Lets a downstream register
    // scaffold a cell per process key from the wiring alone, before any data flows.
    processOutputKeys(id) {
        return this.processSources(id).map((s) => s.out || (s.kind === "register" ? (s.key || s.id) : s.id));
    }
    // Set an input's output-key rename (the key mangler). Blank -> keep the input key.
    setProcessSourceOut(id, ref, out) { const x = this.processNode(id); const s = x && (x.sources || []).find((s) => s.ref === ref); if (s) s.out = (out || "").trim(); }
    // Value type carried into the rules pipeline (gates which rules apply + final coercion) — text | number.
    setProcessType(id, t) { const x = this.processNode(id); if (x) x.type = t === "number" ? "number" : "text"; }

    // ---- toasts: raise an OS notification when fired (a trigger target) -------
    toastNode(id) { return (this.profile.toasts || []).find((x) => x.id === id) || null; }
    addToast() {
        this.profile.toasts = this.profile.toasts || [];
        let n = 1, id = "toast";
        while (this.toastNode(id)) id = `toast_${++n}`;
        this.profile.toasts.push({ id, title: "", message: "", app_name: "data-occultist",
            duration: "short", icon: "", attribution: "", muted: false, enabled: true, sources: [] });
        return id;
    }
    removeToast(id) { this.profile.toasts = (this.profile.toasts || []).filter((x) => x.id !== id); this._unwire("toast", id); }
    // A toast's wired {{token}} feeders are prefixed refs — "readout:<id>" | "dataset:<id>" |
    // "subset:<id>", one per connected node. `toastSources` parses them to {kind, id, ref}; the UI
    // builds token chips + edges from this, and ONLY these sources drive the suggestion chips.
    toastSources(id) { return GraphModel._parseRefs(this.toastNode(id)?.sources); }
    addToastSource(id, ref) {
        const x = this.toastNode(id);
        if (!x || !ref) return false;
        x.sources = x.sources || [];
        if (x.sources.includes(ref)) return false;
        x.sources.push(ref);
        return true;
    }
    removeToastSource(id, ref) { const x = this.toastNode(id); if (x) x.sources = (x.sources || []).filter((r) => r !== ref); }
    // ---- toast rich-text blocks (the styled body) ----------------------------
    toastTexts(id) { const x = this.toastNode(id); return (x && x.texts) || []; }
    addToastText(id) { const x = this.toastNode(id); if (!x) return; x.texts = x.texts || []; x.texts.push({ content: "", style: "", align: "", max_lines: 0 }); }
    removeToastText(id, i) { const x = this.toastNode(id); if (x && x.texts) x.texts.splice(i, 1); }
    moveToastText(id, i, dir) {
        const x = this.toastNode(id); if (!x || !x.texts) return false;
        const j = i + dir; if (j < 0 || j >= x.texts.length) return false;
        [x.texts[i], x.texts[j]] = [x.texts[j], x.texts[i]]; return true;
    }
    setToastText(id, i, key, val) {
        const x = this.toastNode(id); const b = x && x.texts && x.texts[i]; if (!b) return;
        if (key === "max_lines") b.max_lines = Math.max(0, parseInt(val, 10) || 0);
        else if (["content", "style", "align"].includes(key)) b[key] = val ?? "";
    }
    // ---- toast generated images (a LIST; each has its own placement: hero|inline|none) --------
    static _toastImageDefault(w = 364, h = 160) {
        return { placement: "inline", width: w, height: h, bg_type: "solid",
            color1: "#0a3d62", color2: "#061826", angle: 90, texts: [] };
    }
    // Migrate the legacy fixed hero/inline objects into the images list (once, when absent).
    static _migrateToastImages(x) {
        if (Array.isArray(x.images)) return;
        x.images = [];
        for (const which of ["hero", "inline"]) {
            const im = x[which];
            if (im && typeof im === "object") {
                const { enabled, ...rest } = im;
                x.images.push({ ...rest, placement: enabled ? which : "none" });
            }
        }
        delete x.hero; delete x.inline;
    }
    toastImages(id) { const x = this.toastNode(id); return (x && x.images) || []; }
    toastImage(id, i) { const x = this.toastNode(id); return x && x.images && x.images[+i]; }
    addToastImage(id) { const x = this.toastNode(id); if (x) { x.images = x.images || []; x.images.push(GraphModel._toastImageDefault()); } }
    removeToastImage(id, i) { const x = this.toastNode(id); if (x && x.images) x.images.splice(+i, 1); }
    setToastImageProp(id, i, key, val) {
        const im = this.toastImage(id, i); if (!im) return;
        if (key === "placement") im.placement = ["hero", "inline", "none"].includes(val) ? val : "none";
        else if (["width", "height", "angle"].includes(key)) im[key] = Math.max(0, parseInt(val, 10) || 0);
        else if (key === "unit") im.unit = val === "pct" ? "pct" : "px";
        else if (["bg_type", "color1", "color2"].includes(key)) im[key] = val ?? "";
    }
    static _toastTextDefault() {
        return { content: "", x: 12, y: 12, size: 20, color: "#ffffff", align: "tl",
            width: 120, height: 28, bg_color: "", wrap: true, overflow: false,
            disable_if_empty: false, disable_if_anchor_disabled: false,
            match_w: "", match_h: "", match_w_pct: 100, match_h_pct: 100,
            font_family: "", bold: false, italic: false, underline: false,
            border: { w: 0, color: "#ffffff", style: "solid" }, border_sides: {},
            anchor: { to: "", corner: "tl", target: "tl" }, z_index: 0 };
    }
    // which element field(s) each inspector row owns — a row's reset button restores exactly these
    // to their _toastTextDefault value (keys mirror the row labels in imageTextInspector). Resetting
    // `background` sets bg_color back to "" which drops the box entirely (no bg drawn).
    static _toastTextResetGroups() {
        return { position: ["x", "y"], anchor: ["anchor"], dimension: ["width", "height"],
            match: ["match_w", "match_h", "match_w_pct", "match_h_pct"], content: ["content"],
            font: ["size", "font_family", "bold", "italic", "underline", "wrap", "overflow"],
            cond: ["disable_if_empty", "disable_if_anchor_disabled"], layer: ["z_index"],
            align: ["align"], text: ["color"], background: ["bg_color"],
            border: ["border", "border_sides"] };
    }
    // reset one inspector row's field(s) on element j back to the element defaults.
    resetToastImageTextRow(id, i, j, rowKey) {
        const im = this.toastImage(id, i); const t = im && im.texts && im.texts[j]; if (!t) return;
        const keys = GraphModel._toastTextResetGroups()[rowKey]; if (!keys) return;
        const d = GraphModel._toastTextDefault();
        for (const k of keys) t[k] = JSON.parse(JSON.stringify(d[k]));
    }
    addToastImageText(id, i) {
        const im = this.toastImage(id, i); if (!im) return;
        im.texts = im.texts || [];
        // seed the new element from the previous one's style, nudged down a line; content empty.
        const prev = im.texts[im.texts.length - 1];
        const t = GraphModel._toastTextDefault();
        if (prev) Object.assign(t, {
            x: prev.x, y: (prev.y || 0) + (prev.height || prev.size || 20) + 4,
            size: prev.size, color: prev.color, align: prev.align,
            width: prev.width || 120, height: prev.height || 28, bg_color: prev.bg_color || "",
            wrap: prev.wrap !== false, font_family: prev.font_family || "",
            bold: !!prev.bold, italic: !!prev.italic, underline: !!prev.underline,
        });
        im.texts.push(t);
    }
    removeToastImageText(id, i, j) { const im = this.toastImage(id, i); if (im && im.texts) im.texts.splice(j, 1); }
    // duplicate element j, inserting the copy right after it (returns the copy's index).
    cloneToastImageText(id, i, j) {
        const im = this.toastImage(id, i); if (!im || !im.texts || !im.texts[j]) return null;
        im.texts.splice(j + 1, 0, JSON.parse(JSON.stringify(im.texts[j])));
        return j + 1;
    }
    setToastImageText(id, i, j, key, val) {
        const im = this.toastImage(id, i); const t = im && im.texts && im.texts[j]; if (!t) return;
        if (["x", "y", "size", "width", "height", "z_index"].includes(key)) t[key] = parseInt(val, 10) || 0;
        else if (["match_w_pct", "match_h_pct"].includes(key)) t[key] = Math.max(1, parseInt(val, 10) || 100);
        else if (["wrap", "overflow", "bold", "italic", "underline", "disable_if_empty", "disable_if_anchor_disabled"].includes(key)) t[key] = !!val;
        else if (["content", "color", "align", "bg_color", "font_family", "match_w", "match_h"].includes(key)) t[key] = val ?? "";
    }
    // per-side border: `side` "" = the base (all sides), else "t"/"r"/"b"/"l" overrides that side.
    setToastImageBorder(id, i, j, side, key, val) {
        const im = this.toastImage(id, i); const t = im && im.texts && im.texts[j]; if (!t) return;
        t.border = t.border || { w: 0, color: "#ffffff", style: "solid" };
        t.border_sides = t.border_sides || {};
        const tgt = side ? (t.border_sides[side] = t.border_sides[side] || { w: 0, color: "#ffffff", style: "solid" }) : t.border;
        if (key === "w") tgt.w = Math.max(0, parseInt(val, 10) || 0);
        else if (key === "color") tgt.color = val || "#ffffff";
        else if (key === "style") tgt.style = ["solid", "dashed", "dotted"].includes(val) ? val : "solid";
    }
    setToastImageAnchor(id, i, j, key, val) {
        const im = this.toastImage(id, i); const t = im && im.texts && im.texts[j]; if (!t) return;
        t.anchor = t.anchor || { to: "", corner: "tl", target: "tl" };
        if (key === "to") t.anchor.to = val ?? "";
        else if (key === "corner" || key === "target") t.anchor[key] = val || "tl";
    }
    // Flip an image between px and % units, rewriting every element's x/y/width/height so the
    // on-screen design is preserved (x/width scale by the image width, y/height by its height).
    convertToastImageUnit(id, i, newUnit) {
        const im = this.toastImage(id, i); if (!im) return;
        newUnit = newUnit === "pct" ? "pct" : "px";
        const cur = im.unit === "pct" ? "pct" : "px";
        if (newUnit === cur) { im.unit = newUnit; return; }
        const W = Math.max(1, im.width || 1), H = Math.max(1, im.height || 1);
        const conv = (v, dim) => newUnit === "pct" ? Math.round((v || 0) / dim * 100) : Math.round((v || 0) / 100 * dim);
        for (const t of (im.texts || [])) {
            t.x = conv(t.x, W); t.width = t.width ? conv(t.width, W) : t.width;
            t.y = conv(t.y, H); t.height = t.height ? conv(t.height, H) : t.height;
        }
        im.unit = newUnit;
    }
    // Which text line the image editor's mini-inspector currently edits (transient UI state, never
    // saved). Clamped to the texts list; null when the image has no text lines. `setToastImageSel`
    // stores the raw index; the getter resolves the effective (clamped) selection.
    toastImageSel(id, i) {
        const im = this.toastImage(id, i); const n = (im && im.texts && im.texts.length) || 0;
        if (!n) return null;
        const key = `${id}#${i}`;
        if (!this._imgSel.has(key)) return null;   // never touched -> nothing selected on load
        const raw = this._imgSel.get(key);
        if (raw == null) return null;           // explicitly deselected (picker "(none)")
        return Math.max(0, Math.min(n - 1, raw));
    }
    setToastImageSel(id, i, j) { this._imgSel.set(`${id}#${i}`, j == null ? null : Math.max(0, j | 0)); }
    renameToast(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.toastNode(newId)) return false;
        this._repoint("toast", oldId, newId, { decl: true });   // def id + any trigger target
        return true;
    }
    static TOAST_DURATIONS = ["short", "long"];
    // scalar props: title | message | app_name | icon | attribution (text) | duration (short|long) | muted | enabled (bool)
    setToastProp(id, key, val) {
        const x = this.toastNode(id); if (!x) return;
        if (key === "muted" || key === "enabled" || key === "show_icon" || key === "accumulate") x[key] = !!val;
        else if (key === "duration") x.duration = GraphModel.TOAST_DURATIONS.includes(val) ? val : "short";
        else if (key === "accumulate_cap") x.accumulate_cap = Math.max(1, +val || 1);
        else if (["title", "message", "app_name", "icon", "attribution", "replace_key"].includes(key)) x[key] = val ?? "";
    }

    // ---- sounds: play an audio file (in the browser) when fired (a trigger target) ----
    soundNode(id) { return (this.profile.sounds || []).find((x) => x.id === id) || null; }
    // A fresh sound node opens in GENERATOR mode (a seeded cue + the inline forge) rather than
    // file mode: the sounds authored here are generated ones, and an empty file picker is a dead
    // end until you go find the dropdown. Half volume — a fire cue at unity is a jump-scare.
    addSound() {
        this.profile.sounds = this.profile.sounds || [];
        let n = 1, id = "sound";
        while (this.soundNode(id)) id = `sound_${++n}`;
        this.profile.sounds.push({ id, file: "", synth: GraphModel.defaultSynth(), volume: 0.5, enabled: true });
        return id;
    }
    removeSound(id) { this.profile.sounds = (this.profile.sounds || []).filter((x) => x.id !== id); this._unwire("sound", id); }
    renameSound(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.soundNode(newId)) return false;
        this._repoint("sound", oldId, newId, { decl: true });   // def id + any trigger target
        return true;
    }
    // Picking ANY file entry — including "none" — leaves generator mode: a node still holding a
    // synth renders as `[generator]` (soundParts), so keeping the cue around made "none" look like
    // it did nothing. Generator mode is re-entered through the [generator] option.
    setSoundFile(id, v) { const x = this.soundNode(id); if (x) { x.file = v || ""; x.synth = null; } }
    setSoundVolume(id, v) { const x = this.soundNode(id); const n = parseFloat(v); if (x && !Number.isNaN(n)) x.volume = Math.max(0, Math.min(1, n)); }
    // ---- generated cues: a synth spec set INSTEAD of a file (the node's inline "forge") ----
    // a fresh cue: a short rising blip you then reshape. Points are 0..1 (t across the length, p
    // pitch). Every knob comes from the ONE default table (defaults.js, mirroring SynthDef) so a
    // new cue and an old cue that omits a knob start from exactly the same sound.
    static defaultSynth() {
        return { ...SYNTH_DEFAULTS, points: [{ t: 0, p: 0.5 }, { t: 0.15, p: 0.9 }, { t: 1, p: 0.72 }], crush: 18 };
    }
    // flip a sound node into generator mode: seed a default spec if it has none, drop any file
    enableSoundSynth(id) { const x = this.soundNode(id); if (!x) return; if (!x.synth) x.synth = GraphModel.defaultSynth(); x.file = ""; return x.synth; }
    setSoundSynth(id, spec) { const x = this.soundNode(id); if (x) { x.synth = spec; x.file = ""; } }
    clearSoundSynth(id) { const x = this.soundNode(id); if (x) x.synth = null; }

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
    removeFileSource(id) { this.profile.file_sources = (this.profile.file_sources || []).filter((s) => s.id !== id); this._unwire("filesource", id); }
    renameFileSource(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.fileSource(newId)) return false;
        this._repoint("filesource", oldId, newId, { decl: true });   // def id + any trigger target
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
    // Every `dictionary` RULE that pins a dictionary (its `dict_id`) — the single place dict ids
    // are referenced now that dictionary config lives on the rule, so remove/rename repoint
    // through here. dict_id is a soft ref; the resolver falls back to the pooled default when it
    // points at nothing.
    _dictRules() {
        return (this.profile.windows || []).flatMap((w) => w.fields || [])
            .flatMap((f) => (f.rules || []).filter((r) => r.then === "dictionary"));
    }
    removeDictionary(id) {
        this.profile.dictionaries = (this.profile.dictionaries || []).filter((d) => d.id !== id);
        this._unwire("dictionary", id);   // pinned rules -> pooled (dict_id blanked)
    }
    renameDictionary(oldId, newId) {
        newId = (newId || "").trim();
        const d = this.dictionary(oldId);
        if (!d || !newId || newId === oldId || this.dictionary(newId)) return false;
        this._repoint("dictionary", oldId, newId, { decl: true });   // def id + every pinned rule
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
    // datasets that could feed this dictionary (all datasets minus the ones already wired) — the
    // candidate list for the sources-input "+ source" select
    dictFeedable(id) {
        const fed = new Set(this.dictFeeds(id).map((f) => f.dataset));
        return this.datasets().filter((ds) => !fed.has(ds));
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
    cloneToast(id) { this.profile.toasts = this.profile.toasts || []; return this._cloneById(this.profile.toasts, id, (x) => !!this.toastNode(x)); }
    cloneSound(id) { this.profile.sounds = this.profile.sounds || []; return this._cloneById(this.profile.sounds, id, (x) => !!this.soundNode(x)); }
    cloneGate(id) { this.profile.gates = this.profile.gates || []; return this._cloneById(this.profile.gates, id, (x) => !!this.gateNode(x)); }
    cloneRouter(id) { this.profile.routers = this.profile.routers || []; return this._cloneById(this.profile.routers, id, (x) => !!this.routerNode(x)); }
    cloneRegister(id) { this.profile.registers = this.profile.registers || []; return this._cloneById(this.profile.registers, id, (x) => !!this.registerNode(x)); }
    cloneProcess(id) { this.profile.processes = this.profile.processes || []; return this._cloneById(this.profile.processes, id, (x) => !!this.processNode(x)); }
    removeDatasetDef(id) { this.profile.datasets = (this.profile.datasets || []).filter((d) => d.id !== id); }

    // Unwire every site holding a removed dataset/subset id (declarations AND references) and
    // prune the now-empty list entries — the inverse of renameDataset's repoint sweep. SHARED by
    // dataset and subset deletion: a subset id lives in the very same ref sites a dataset does, so
    // one sweep keeps every connected party (window/producer/source/subset/trigger) consistent.
    _unwireDataset(id) {
        this._unwire("dataset", id);   // blank every feeder/ref holding this dataset id, then prune the emptied lists
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
    // a fresh JoinSource with sane defaults (joins on `name`, INHERITS the dataset's own
    // many->one policy, optional/outer, plain join)
    _newSource(ds) {
        return { dataset: ds, join_field: "name", aggregate: "", required: false, mode: "join",
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
            filters: [], derived: [], hidden_columns: [], enrich: [], sort: [], sort_by: "", sort_desc: false,
            latest_batch: false, pivot: null, limit: 0,
        });
        return id;
    }
    // Delete a subset: drop its def, then unwire it from every connected party. A subset can feed
    // other subsets, producers, and trigger watches (the same ref sites a dataset uses), so removal
    // must clear those refs or they dangle to a node that no longer exists.
    removeSubset(id) {
        this.profile.subsets = (this.profile.subsets || []).filter((s) => s.id !== id);
        this._unwire("subset", id);   // subset ids live in the shared dataset/subset ref sites
    }
    renameSubset(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || this.subsetDef(newId)) return false;
        this._repoint("subset", oldId, newId, { decl: true });   // def id + every subset ref (a subset can feed another)
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
    // how this source combines beyond a plain key-matched join — see JoinSource in models.py:
    //   join (default) | exclude (anti-join, drops matching keys) | mark (semi-join, annotates
    //   without multiplying rows) | broadcast (merges onto every output row, unkeyed)
    setSourceMode(id, ds, mode) { const src = this.subsetSource(id, ds); if (src) src.mode = mode || "join"; }
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
    // how THIS source's MANY observations collapse to one value when the subset reads it.
    // "" = inherit the source dataset's own policy (must round-trip, so never coerce it away).
    sourceAggregate(id, ds) { const src = this.subsetSource(id, ds); return (src && src.aggregate) || ""; }
    setSourceAggregate(id, ds, agg) { const src = this.subsetSource(id, ds); if (src) src.aggregate = agg || ""; }
    // what a blank (inherit) source aggregate actually resolves to — the dataset's own policy
    sourceAggregateEffective(id, ds) { return this.sourceAggregate(id, ds) || this.datasetAggregate(ds); }
    // only pull rows from each source's most recent collection batch (applied first)
    setSubsetLatestBatch(id, on) { const s = this.subsetDef(id); if (s) s.latest_batch = !!on; }
    // ---- pivot: reshape joined flat name/value rows into wide rows by shared id-prefix -----
    // (PivotSpec in models.py) — applied right after the join, before filter/derive/sort.
    pivotEnabled(id) { return !!(this.subsetDef(id) || {}).pivot; }
    subsetPivot(id) {
        const p = (this.subsetDef(id) || {}).pivot;
        return p || { name_field: "name", value_field: "value", key_column: "slot", attributes: [] };
    }
    setSubsetPivotEnabled(id, on) {
        const s = this.subsetDef(id);
        if (!s) return;
        s.pivot = on ? this.subsetPivot(id) : null;
    }
    setSubsetPivotField(id, field, value) {
        const s = this.subsetDef(id);
        if (!s || !s.pivot) return;
        s.pivot[field] = value || "";
    }
    // parse the free-typed suffix box (space/comma separated) into a deduped list, mirroring
    // setSourceStripWords — the taught vocabulary lives in profile data, never hardcoded
    setSubsetPivotAttributes(id, str) {
        const s = this.subsetDef(id);
        if (!s || !s.pivot) return;
        s.pivot.attributes = [...new Set(String(str || "").split(/[\s,]+/).filter(Boolean))];
    }
    // cap the number of result rows (0 = no limit)
    setSubsetLimit(id, n) { const s = this.subsetDef(id); if (s) s.limit = Math.max(0, Math.floor(+n || 0)); }
    setSubsetDistinct(id, on) { const s = this.subsetDef(id); if (s) s.distinct = !!on; }
    toggleDistinctColumn(id, col) {
        const s = this.subsetDef(id); if (!s) return;
        s.distinct_by ||= [];
        const i = s.distinct_by.indexOf(col);
        if (i >= 0) s.distinct_by.splice(i, 1); else s.distinct_by.push(col);
    }
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
        this._unwire("window", id);   // drop its window_priority entry (else a stale id resurfaces on reuse)
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
        this._repoint("window", oldId, newId, { decl: true });   // def id + its window_priority entry
        this._emitRename("window", oldId, newId);
        return true;
    }

    // `id`, when passed, MUST already be free of `w.fields` (see `_mint` callers below) — a
    // colliding id here silently reuses the existing FieldDef instead of creating one, so two
    // nodes end up sharing one `rules` pipeline object.
    addField(winId, id) {
        const w = this.window(winId);
        if (!w) return;
        w.fields = w.fields || [];
        const fid = id || _mint("field_", (x) => w.fields.some((f) => f.id === x));
        if (!w.fields.some((f) => f.id === fid))
            w.fields.push({ id: fid, type: "text", rules: [] });   // value processing is authored as rules
    }
    // ---- regions (drawn on the window image) --------------------------------

    // Create a region from a fraction box; also creates its linked field. Returns id.
    // A region's id IS its linked field id (one FieldDef, not two), so minting must dodge BOTH
    // pools (`w.regions` for the node id, `w.fields` for the FieldDef) or a fresh region can land
    // on an existing field id and silently inherit that field's rules (see `addField` above).
    addRegion(winId, box) {
        const w = this.window(winId);
        if (!w) return null;
        w.regions = w.regions || [];
        w.fields = w.fields || [];
        const id = _mint("field_", (x) => w.regions.some((r) => r.id === x) || w.fields.some((f) => f.id === x));
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
    // Readout ids are GLOBAL (checked across every window, see `renameReadout` below) — minting
    // must match that scope, and the linked field id must dodge `w.fields` — else a fresh readout
    // can collide with another readout's id (cross-window bleed) or share a FieldDef with an
    // existing field/region/readout (settings bleed onto a node the user never touched).
    addReadout(winId, box) {
        const w = this.window(winId);
        if (!w) return null;
        w.readouts = w.readouts || [];
        w.fields = w.fields || [];
        const id = _mint("ro_", (x) => this.readouts().some((v) => v.id === x));
        const fid = _mint("rof_", (x) => w.fields.some((f) => f.id === x));
        w.readouts.push({ id, box: { x: box.x, y: box.y, w: box.w, h: box.h }, field: fid, enabled: true });
        this.addField(winId, fid);
        const f = (w.fields || []).find((x) => x.id === fid);
        if (f) { f.type = "number"; f.min_confidence = 0.7; }   // readouts: numbers, 0.7 conf floor by default
        return id;
    }
    readout(winId, vid) { const w = this.window(winId); return w && (w.readouts || []).find((v) => v.id === vid); }
    setReadoutBox(winId, vid, box) { const v = this.readout(winId, vid); if (v) v.box = { x: box.x, y: box.y, w: box.w, h: box.h }; }
    setReadoutEnabled(winId, vid, on) { const v = this.readout(winId, vid); if (v) v.enabled = !!on; }
    // ---- testing-inspector feed configs (all OPTIONAL; absent until the user edits one) ----
    // Each config rides the def it feeds, so a rename carries it along instead of needing another
    // repoint site (rule 5). `patch` is a partial TestFeedDef; an all-default patch REMOVES the
    // block so an untouched profile stays free of empty `test:` noise.
    static _TEST_KEYS = ["mode", "type", "value", "pool", "min", "max", "step", "integer"];
    static _testEmpty(t) {
        // `enabled: false` is itself configuration (a deliberately muted row), so a block carrying
        // only that is NOT empty — otherwise muting a stock row would silently un-mute on save.
        return !t || (t.enabled !== false && (t.mode || "fixed") === "fixed" && !t.type && !t.value
            && !t.pool && !t.min && !t.max && !t.step && !t.integer);
    }
    static _testPatch(cur, patch) {
        const out = {};
        for (const k of GraphModel._TEST_KEYS) {
            const v = patch[k] !== undefined ? patch[k] : (cur || {})[k];
            if (v !== undefined && v !== null && v !== "" && v !== false) out[k] = v;
        }
        // enabled is the one flag whose FALSE is the meaningful state; true is the default the
        // model fills back in, so it's only written when off.
        const en = patch.enabled !== undefined ? patch.enabled : (cur || {}).enabled;
        if (en === false) out.enabled = false;
        return out;
    }
    readoutTest(winId, vid) { return this.readout(winId, vid)?.test || null; }
    setReadoutTest(winId, vid, patch) {
        const v = this.readout(winId, vid);
        if (!v) return;
        const next = GraphModel._testPatch(v.test, patch);
        if (GraphModel._testEmpty(next)) delete v.test; else v.test = next;
    }
    datasetTest(ds, col) { return this.datasetDef(ds)?.test_row?.[col] || null; }
    setDatasetTest(ds, col, patch) {
        const d = this.datasetDef(ds);
        if (!d) return;
        const next = GraphModel._testPatch(d.test_row && d.test_row[col], patch);
        if (GraphModel._testEmpty(next)) { if (d.test_row) delete d.test_row[col]; }
        else { d.test_row = d.test_row || {}; d.test_row[col] = next; }
        if (d.test_row && !Object.keys(d.test_row).length) delete d.test_row;
    }
    // Panel-level knobs (one optional block on the profile).
    testing() { return this.profile.testing || null; }
    setTesting(patch) {
        const t = { loop_ms: 500, garble: false, garble_pct: 20, include_datasets: false,
                    ...(this.profile.testing || {}), ...patch };
        // back to stock -> drop the block entirely rather than persist defaults
        if (t.loop_ms === 500 && !t.garble && t.garble_pct === 20 && !t.include_datasets) delete this.profile.testing;
        else this.profile.testing = t;
    }
    // Rename a readout: its id IS its identity (like every other node — no separate name). Ids are
    // GLOBAL (model.readouts() spans all windows, the toast token {{id}} is global), so uniqueness
    // is checked across every window. Repoints the refs that key off the id: {{id}} tokens in a
    // toast's title/message/attribution and each trigger's readout_watch. Returns true on success.
    // Every token-bearing string on a toast, as {get,set} accessors — the legacy title/message/
    // attribution PLUS each rich-text block's content. Rename/remove of a readout rewrite tokens
    // through this ONE list so a new text surface can never be missed (rule 7).
    _toastTokenSites(t) {
        const sites = [
            { get: () => t.title, set: (v) => { t.title = v; } },
            { get: () => t.message, set: (v) => { t.message = v; } },
            { get: () => t.attribution, set: (v) => { t.attribution = v; } },
        ];
        (t.texts || []).forEach((b, i) =>
            sites.push({ get: () => t.texts[i].content, set: (v) => { t.texts[i].content = v; } }));
        (t.images || []).forEach((im, k) =>
            (im.texts || []).forEach((b, i) =>
                sites.push({ get: () => t.images[k].texts[i].content, set: (v) => { t.images[k].texts[i].content = v; } })));
        return sites;
    }
    renameReadout(winId, vid, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === vid || this.readouts().some((v) => v.id === newId)) return false;
        const v = this.readout(winId, vid);
        if (!v) return false;
        v.id = newId;   // the readout id lives on the window (not a top-level def) — move it directly
        this._repoint("readout", vid, newId);   // toast/register "readout:" sources + trigger readout_watch
        this._rewriteReadoutTokens(vid, newId);   // {{readout:vid}} / legacy {{vid}} tokens in toast text
        return true;
    }
    removeReadout(winId, vid) {
        const w = this.window(winId);
        if (!w) return;
        const v = this.readout(winId, vid);
        w.readouts = (w.readouts || []).filter((x) => x.id !== vid);
        // drop the linked field if nothing else uses it
        if (v && v.field && !this._fieldUsed(w, v.field)) w.fields = (w.fields || []).filter((f) => f.id !== v.field);
        this._unwire("readout", vid);   // toast/register "readout:" sources + trigger readout_watch
        this._rewriteReadoutTokens(vid, null);   // strip its now-dead tokens from toast text
    }
    // Rewrite (newId set) or strip (newId null) a readout's {{readout:id}} / legacy {{id}} tokens
    // across every toast text surface — the token-string twin of the structured _repoint/_unwire
    // above (tokens are substring edits, not whole-value id slots, so they live outside the registry).
    _rewriteReadoutTokens(vid, newId) {
        const esc = vid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rePref = new RegExp("\\{\\{\\s*readout:\\s*" + esc + "\\s*(\\|[^}]*)?\\}\\}", "g");
        const reBare = new RegExp("\\{\\{\\s*" + esc + "\\s*\\}\\}", "g");
        for (const t of this.profile.toasts || [])
            for (const st of this._toastTokenSites(t)) {
                const s = st.get();
                if (typeof s !== "string" || !s.includes("{{")) continue;
                st.set(newId
                    ? s.replace(rePref, (_m, agg) => `{{readout:${newId}${agg || ""}}}`).replace(reBare, `{{readout:${newId}}}`)
                    : s.replace(rePref, "").replace(reBare, ""));
            }
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
        const id = _mint("detect_", (x) => host.detect.some((d) => d.id === x));
        // game gate detectors default to the cheap COLOUR kind (no OCR); window detectors
        // stay text by default. A colour detector seeds an empty colour (sample it on the image).
        const base = { id, search: { x: box.x, y: box.y, w: box.w, h: box.h }, threshold: DEFAULT_DETECT_THRESHOLD };
        host.detect.push(winId === "game" ? { ...base, colors: [""], tolerance: 32 } : { ...base, text: "" });
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
    addScrollSample(winId, sample) {  // { file, rows, pos, conf, px }
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
        const id = _mint("state_", (x) => w.states.some((s) => s.id === x));
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
        const id = _mint("item_", (x) => w.items.some((it) => it.id === x));
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
    // OCR preprocess (Text appearance): mode none/color/threshold/invert, taught colours +
    // tolerance for `color`, upscale for small text. ONE holder-based core (rule 7) shared by
    // the window (WindowDef.preprocess) and the per-readout override (FieldDef.preprocess);
    // lazily defaulted so an old profile without the block gets one on first edit.
    _ppOf(holder) {
        if (!holder) return null;
        holder.preprocess = holder.preprocess || { mode: "none", colors: [], tolerance: 60, scale: 1.0, min_frac: 0 };
        return holder.preprocess;
    }
    // Resolve a readout's linked FieldDef by readout id (the per-readout preprocess holder).
    readoutFieldOf(winId, roId) {
        const w = this.window(winId);
        return this.readoutField(w, (w?.readouts || []).find((r) => r.id === roId));
    }
    preprocess(winId) { return this._ppOf(this.window(winId)); }             // window holder
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
    // Same id-IS-the-field-id shape as `addRegion` — must dodge both `it.fields` (this item's list)
    // and `w.fields` (the FieldDef pool) or a fresh item-field can share a FieldDef with an
    // unrelated field/region/readout.
    addItemField(winId, itemId, box) {
        const it = this.item(winId, itemId);
        if (!it) return null;
        it.fields = it.fields || [];
        const w = this.window(winId);
        w.fields = w.fields || [];
        const id = _mint("field_", (x) => it.fields.some((f) => f.id === x) || w.fields.some((f) => f.id === x));
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
        const id = _mint("tell_", (x) => it.tells.some((t) => t.id === x));
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
