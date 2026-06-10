// GraphModel: the editable structure behind the node view. It holds the full
// GameProfile and exposes node/edge derivation plus edit ops. Box data
// (regions/anchors/states/preprocess/scroll) is never touched here — it's authored
// on the canvas — so saving preserves it.

let _fieldSeq = 1;

export class GraphModel {
  constructor() { this.profile = blank(""); }

  load(profile) {
    this.profile = profile || blank("");
    this.profile.windows = this.profile.windows || [];
    this.profile.fields = this.profile.fields || [];
  }

  // effective dataset id for a window (defaults to its own id)
  datasetOf(win) { return win.dataset || win.id; }

  // ---- nodes / edges ------------------------------------------------------

  nodes() {
    const ns = [{ id: "game", type: "game", ref: this.profile }];
    for (const w of this.profile.windows) {
      ns.push({ id: `win:${w.id}`, type: "window", ref: w });
      for (const r of w.regions || []) ns.push({ id: `reg:${w.id}:${r.id}`, type: "region", ref: r, win: w, field: this.fieldOf(w, r) });
      for (const a of w.anchors || []) ns.push({ id: `anc:${w.id}:${a.id}`, type: "anchor", ref: a, win: w });
      if (w.scroll && w.scroll.scrollbar) ns.push({ id: `sb:${w.id}:scrollbar`, type: "scrollbar", ref: w.scroll, win: w });
      for (const it of w.items || []) ns.push({ id: `item:${w.id}:${it.id}`, type: "item", ref: it, win: w });
    }
    for (const ds of this.datasets()) ns.push({ id: `ds:${ds}`, type: "dataset", ref: ds });
    return ns;
  }

  edges() {
    const es = [];
    for (const w of this.profile.windows) {
      es.push({ from: "game", to: `win:${w.id}`, kind: "own" });
      for (const r of w.regions || []) es.push({ from: `win:${w.id}`, to: `reg:${w.id}:${r.id}`, kind: "field" });
      for (const a of w.anchors || []) es.push({ from: `win:${w.id}`, to: `anc:${w.id}:${a.id}`, kind: "anchor" });
      if (w.scroll && w.scroll.scrollbar) es.push({ from: `win:${w.id}`, to: `sb:${w.id}:scrollbar`, kind: "scrollbar" });
      for (const it of w.items || []) es.push({ from: `win:${w.id}`, to: `item:${w.id}:${it.id}`, kind: "item" });
      es.push({ from: `win:${w.id}`, to: `ds:${this.datasetOf(w)}`, kind: "data" });
    }
    return es;
  }

  fieldOf(win, region) {
    win.fields = win.fields || [];
    return win.fields.find((f) => f.id === region.field) || null;
  }

  datasets() {
    const set = new Set(this.profile.windows.map((w) => this.datasetOf(w)));
    (this._extraDatasets || []).forEach((d) => set.add(d));
    return [...set];
  }

  // ---- edit ops -----------------------------------------------------------

  addWindow(id) {
    if (!id || this.profile.windows.some((w) => w.id === id)) return false;
    this.profile.windows.push({ id, dataset: null, fields: [], anchors: [], states: [], regions: [] });
    return true;
  }
  removeWindow(id) { this.profile.windows = this.profile.windows.filter((w) => w.id !== id); }
  window(id) { return this.profile.windows.find((w) => w.id === id); }

  renameWindow(oldId, newId) {
    const w = this.window(oldId);
    if (w && newId && !this.profile.windows.some((x) => x.id === newId)) w.id = newId;
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
    if (!w || !r || !newId || w.regions.some((x) => x.id === newId)) return;
    const fld = this.fieldOf(w, r);
    if (fld && fld.id === r.field) { fld.id = newId; r.field = newId; }
    r.id = newId;
  }
  regions(winId) { const w = this.window(winId); return (w && w.regions) || []; }

  // ---- anchors (window-detect landmarks) ----------------------------------

  addAnchor(winId, box) {
    const w = this.window(winId);
    if (!w) return null;
    w.anchors = w.anchors || [];
    let id = "detect_" + _fieldSeq++;
    while (w.anchors.some((a) => a.id === id)) id = "detect_" + _fieldSeq++;
    w.anchors.push({ id, search: { x: box.x, y: box.y, w: box.w, h: box.h }, text: "", threshold: 0.8 });
    return id;
  }
  anchor(winId, id) { const w = this.window(winId); return w && (w.anchors || []).find((a) => a.id === id); }
  setAnchorBox(winId, id, box) { const a = this.anchor(winId, id); if (a) a.search = { x: box.x, y: box.y, w: box.w, h: box.h }; }
  removeAnchor(winId, id) { const w = this.window(winId); if (w) w.anchors = (w.anchors || []).filter((a) => a.id !== id); }
  anchors(winId) { const w = this.window(winId); return (w && w.anchors) || []; }

  // ---- scrollbar (single box on the window's scroll config) ----------------

  setScrollbar(winId, box) {
    const w = this.window(winId);
    if (!w) return;
    w.scroll = w.scroll || { rows: 1, cols: 1, dedup_field: this.keyOf(w) };
    w.scroll.scrollbar = { x: box.x, y: box.y, w: box.w, h: box.h };
  }
  keyOf(w) { return (w.scroll && w.scroll.dedup_field) || "name"; }
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
      anchors: [{ id: id + "_a", search: { x: box.x, y: box.y, w: box.w, h: box.h }, text: "", threshold: 0.8 }] });
    return id;
  }
  state(winId, id) { const w = this.window(winId); return w && (w.states || []).find((s) => s.id === id); }
  states(winId) { const w = this.window(winId); return (w && w.states) || []; }
  setStateBox(winId, id, box) {
    const s = this.state(winId, id);
    if (s && s.anchors && s.anchors[0]) s.anchors[0].search = { x: box.x, y: box.y, w: box.w, h: box.h };
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
    if (w && it && newId && !w.items.some((x) => x.id === newId)) it.id = newId;
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
    f.field = newId; f.id = newId;
  }

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
  return { name, process_names: [], window_title_hint: null, fields: [], windows: [] };
}
