// GraphModel: the editable structure behind the node view. It holds the full
// GameProfile and exposes node/edge derivation plus edit ops. Box data
// (regions/detect/states/preprocess/scroll) is never touched here — it's authored
// on the canvas — so saving preserves it.

let _fieldSeq = 1;

export class GraphModel {
  constructor() { this.profile = blank(""); }

  load(profile) {
    this.profile = profile || blank("");
    this.profile.windows = this.profile.windows || [];
    this.profile.fields = this.profile.fields || [];
    this.profile.datasets = this.profile.datasets || [];
    this.profile.subsets = this.profile.subsets || [];
    this.profile.price_nodes = this.profile.price_nodes || [];
    this.profile.dictionaries = this.profile.dictionaries || [];
    // a view joins many datasets; fold a legacy single ``dataset`` into ``datasets``
    for (const s of this.profile.subsets) {
      s.datasets = s.datasets || [];
      if (s.dataset && !s.datasets.includes(s.dataset)) { s.datasets.unshift(s.dataset); s.dataset = ""; }
    }
  }

  // effective dataset id for a window (defaults to its own id)
  datasetOf(win) { return win.dataset || win.id; }

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
  // rename a dataset: move the def id and repoint every window that feeds it
  renameDataset(oldId, newId) {
    newId = (newId || "").trim();
    if (!newId || newId === oldId || this.datasetDef(newId)) return false;
    for (const w of this.profile.windows) {
      if (this.datasetOf(w) === oldId) w.dataset = newId;   // explicit, even if it was the default
    }
    const d = this.datasetDef(oldId);
    if (d) d.id = newId; else this.ensureDatasetDef(newId);
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
      for (const it of w.items || []) ns.push({ id: `item:${w.id}:${it.id}`, type: "item", ref: it, win: w });
    }
    for (const ds of this.datasets()) {
      ns.push({ id: `ds:${ds}`, type: "dataset", ref: ds });
      ns.push({ id: `bat:${ds}`, type: "batches", ref: ds });
    }
    for (const s of this.profile.subsets || []) ns.push({ id: `sub:${s.id}`, type: "subset", ref: s });
    for (const pn of this.profile.price_nodes || []) ns.push({ id: `price:${pn.id}`, type: "price", ref: pn });
    for (const d of this.profile.dictionaries || []) ns.push({ id: `dict:${d.id}`, type: "dictionary", ref: d });
    return ns;
  }

  edges() {
    const es = [];
    for (const w of this.profile.windows) {
      es.push({ from: "game", to: `win:${w.id}`, kind: "own" });
      es.push({ from: `win:${w.id}`, to: `prev:${w.id}`, kind: "img" });
      for (const r of w.regions || []) es.push({ from: `win:${w.id}`, to: `reg:${w.id}:${r.id}`, kind: "field" });
      for (const d of w.detect || []) es.push({ from: `win:${w.id}`, to: `det:${w.id}:${d.id}`, kind: "detect" });
      if (w.scroll && w.scroll.scrollbar) es.push({ from: `win:${w.id}`, to: `sb:${w.id}:scrollbar`, kind: "scrollbar" });
      for (const it of w.items || []) es.push({ from: `win:${w.id}`, to: `item:${w.id}:${it.id}`, kind: "item" });
      es.push({ from: `win:${w.id}`, to: `ds:${this.datasetOf(w)}`, kind: "data" });
    }
    for (const ds of this.datasets()) es.push({ from: `ds:${ds}`, to: `bat:${ds}`, kind: "data" });
    for (const s of this.profile.subsets || [])
      for (const ds of this.subsetInputs(s)) es.push({ from: `ds:${ds}`, to: `sub:${s.id}`, kind: "data" });
    // a price producer WRITES into its output dataset (producer -> dataset)
    for (const pn of this.profile.price_nodes || []) es.push({ from: `price:${pn.id}`, to: `ds:${pn.dataset}`, kind: "data" });
    for (const d of this.profile.dictionaries || []) es.push({ from: "game", to: `dict:${d.id}`, kind: "own" });
    return es;
  }

  fieldOf(win, region) {
    win.fields = win.fields || [];
    return win.fields.find((f) => f.id === region.field) || null;
  }

  datasets() {
    const set = new Set(this.profile.windows.map((w) => this.datasetOf(w)));
    (this.profile.datasets || []).forEach((d) => set.add(d.id));   // include standalone defs (clones)
    (this.profile.price_nodes || []).forEach((pn) => set.add(pn.dataset));   // producer outputs
    (this._extraDatasets || []).forEach((d) => set.add(d));
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
  setPriceDataset(id, ds) {
    const pn = this.priceNode(id);
    if (pn && ds) { pn.dataset = ds; this.ensureDatasetDef(ds); }
  }
  setPriceMode(id, mode) {
    const pn = this.priceNode(id);
    if (pn && (mode === "statistics" || mode === "orders")) pn.mode = mode;
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
    const name = opts.name || source.replace(/\.txt$/i, "") || id;
    this.profile.dictionaries.push({ id, name, enabled: true, source, terms: opts.terms || [] });
    return id;
  }
  removeDictionary(id) { this.profile.dictionaries = (this.profile.dictionaries || []).filter((d) => d.id !== id); }
  renameDictionary(oldId, newId) {
    newId = (newId || "").trim();
    const d = this.dictionary(oldId);
    if (!d || !newId || newId === oldId || this.dictionary(newId)) return false;
    d.id = newId;
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

  // ---- views: join one or more datasets, then filter/derive/sort ----------
  subsetDef(id) { return (this.profile.subsets || []).find((s) => s.id === id) || null; }
  // a view's source datasets (joined on join_field), in order
  subsetInputs(s) { return (s && s.datasets && s.datasets.length) ? s.datasets : (s && s.dataset ? [s.dataset] : []); }
  addSubset(ds) {
    let n = 1, id = `${ds}_view`;
    while (this.subsetDef(id)) id = `${ds}_view${++n}`;
    (this.profile.subsets = this.profile.subsets || []).push({
      id, dataset: "", datasets: [ds], join_field: "name",
      filters: [], derived: [], hidden_columns: [], enrich: [], sort_by: "", sort_desc: false, limit: 0,
    });
    return id;
  }
  removeSubset(id) { this.profile.subsets = (this.profile.subsets || []).filter((s) => s.id !== id); }
  renameSubset(oldId, newId) {
    newId = (newId || "").trim();
    if (!newId || newId === oldId || this.subsetDef(newId)) return false;
    this.subsetDef(oldId).id = newId;
    return true;
  }
  // add/remove a source dataset to a view (the join inputs)
  addSubsetInput(id, ds) {
    const s = this.subsetDef(id);
    if (!s || !ds) return false;
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
  // columns a view can reference: the fields of every joined dataset + derived names
  subsetColumns(id) {
    const s = this.subsetDef(id);
    if (!s) return [];
    const out = [];
    for (const ds of this.subsetInputs(s)) for (const f of this.datasetFields(ds)) if (!out.includes(f)) out.push(f);
    // price datasets aren't fed by windows, so expose their known snapshot columns
    for (const ds of this.subsetInputs(s))
      if ((this.profile.price_nodes || []).some((p) => p.dataset === ds))
        for (const c of ["name", "slug", "price_min", "price_median", "volume", "live_ask", "live_median", "live_sellers"]) if (!out.includes(c)) out.push(c);
    for (const d of s.derived || []) if (d.name && !out.includes(d.name)) out.push(d.name);
    return out;
  }
  addFilter(id) { (this.subsetDef(id).filters ||= []).push({ field: "", op: "contains", value: "" }); }
  removeFilter(id, i) { this.subsetDef(id).filters.splice(i, 1); }
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
    w.detect.push({ id, search: { x: box.x, y: box.y, w: box.w, h: box.h }, text: "", threshold: 0.8 });
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

  // ---- scrollbar (single box on the window's scroll config) ----------------

  setScrollbar(winId, box) {
    const w = this.window(winId);
    if (!w) return;
    w.scroll = w.scroll || { rows: 1, cols: 1 };
    w.scroll.scrollbar = { x: box.x, y: box.y, w: box.w, h: box.h };
  }
  scrollbar(winId) { const w = this.window(winId); return w && w.scroll && w.scroll.scrollbar; }
  setScrollbarOrientation(winId, o) { const w = this.window(winId); if (w && w.scroll) w.scroll.scrollbar_orientation = o; }
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
      detect: [{ id: id + "_a", search: { x: box.x, y: box.y, w: box.w, h: box.h }, text: "", threshold: 0.8 }] });
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
    if (!it || !f || !newId || it.fields.some((x) => x.id === newId)) return;
    const old = f.field;
    const fld = (w.fields || []).find((x) => x.id === old);
    if (fld && fld.id === old) fld.id = newId;
    // repoint tells that validate/locate on this field, else they reference a dead id
    // and silently reject every cell (the item stops detecting entirely)
    for (const t of it.tells || []) if (t.field === old) t.field = newId;
    // same for the record key — a stale part would silently drop every record
    if (it.key) it.key.fields = (it.key.fields || []).map((x) => (x === old ? newId : x));
    f.field = newId; f.id = newId;
  }

  // ---- record key (dedup identity) per item template -----------------------
  // null = inherit (window key, else default {fields:["name"]}). The KeyDef shape
  // mirrors the server: {fields:[...], sep, case_sensitive}.

  itemKey(winId, itemId) { const it = this.item(winId, itemId); return (it && it.key) || null; }
  // the key the item EFFECTIVELY uses (own -> window -> default), for display/preview
  effectiveItemKey(winId, itemId) {
    const w = this.window(winId);
    return this.itemKey(winId, itemId) || (w && w.key) || { fields: ["name"], sep: "|", case_sensitive: false };
  }
  ensureItemKey(winId, itemId) {
    const it = this.item(winId, itemId);
    if (!it) return null;
    if (!it.key) {
      const eff = this.effectiveItemKey(winId, itemId);
      it.key = { fields: [...(eff.fields || ["name"])], sep: eff.sep ?? "|", case_sensitive: !!eff.case_sensitive };
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
