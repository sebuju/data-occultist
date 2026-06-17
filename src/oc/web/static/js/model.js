// EditorModel: the complete editable profile for ONE window, plus conversion
// to/from the on-disk GameProfile shape. Every teachable knob lives here — fields
// (type/pattern/learn), window dataset + key, grid params, states (valid_for_save),
// and the labelled boxes — so nothing about a game needs hand-edited YAML.

import { DEFAULT_DETECT_THRESHOLD, DETECT_DEFAULTS, detectToProfile, detectToBox } from "./defaults.js";

let _seq = 1;
const nextId = (role) => `${role}_${_seq++}`;

export class EditorModel {
  constructor() {
    this.reset("", "equipment");
  }

  reset(name, windowId) {
    this.name = name;
    this.processNames = [];
    this.titleHint = "";

    this.windowId = windowId;
    this.dataset = "";          // blank => defaults to windowId on save
    // record key (dedup identity): ordered field ids joined by sep — e.g. arcanes
    // key on name+level so each level is its own record
    this.key = { fields: ["name"], sep: "|", case_sensitive: false };

    this.fields = [];           // {id, type, pattern, learn, fuzzy}
    this.states = [];           // {id, kind, valid_for_save}
    this.grid = { enabled: false, rows: 1, cols: 1, rowStride: 0, colStride: 0 };
    this.preprocess = { mode: "none", colors: [], tolerance: 60, scale: 1 };
    this.boxes = [];            // {id, role, x,y,w,h, field?, text?, stateId?, threshold?}
    this.selectedId = null;
  }

  // ---- fields -------------------------------------------------------------

  ensureField(id) {
    if (!id) return;
    if (!this.fields.some((f) => f.id === id)) {
      this.fields.push({ id, type: "text", extract: "whole", separator: "/", learn: false, fuzzy: 0.82 });
    }
  }
  removeField(id) {
    this.fields = this.fields.filter((f) => f.id !== id);
    // a key part pointing at a dead field would drop every record — prune it
    this.key.fields = this.key.fields.filter((f) => f !== id);
    if (!this.key.fields.length) this.key.fields = [this.fields[0]?.id || "name"];
  }

  // ---- states -------------------------------------------------------------

  addState(id) {
    if (id && !this.states.some((s) => s.id === id)) {
      this.states.push({ id, kind: "ordering", valid_for_save: true });
    }
  }
  removeState(id) {
    this.states = this.states.filter((s) => s.id !== id);
    this.boxes = this.boxes.filter((b) => !(b.role === "state_detect" && b.stateId === id));
  }

  // ---- boxes --------------------------------------------------------------

  addBox(geom, role = "region") {
    const box = {
      id: nextId(role), role, field: "", text: "", stateId: "",
      threshold: DEFAULT_DETECT_THRESHOLD, ...DETECT_DEFAULTS, ...geom,
    };
    this.boxes.push(box);
    this.selectedId = box.id;
    return box;
  }
  get selected() { return this.boxes.find((b) => b.id === this.selectedId) || null; }
  remove(id) {
    this.boxes = this.boxes.filter((b) => b.id !== id);
    if (this.selectedId === id) this.selectedId = null;
  }

  // Region boxes are the per-field base cell; the grid tiles them.
  regionBoxes() { return this.boxes.filter((b) => b.role === "region"); }

  // ---- profile <-> model --------------------------------------------------

  toProfile() {
    const regions = [];
    const detect = [];
    const statesMap = new Map(this.states.map((s) => [s.id, { ...s, detect: [] }]));
    let scrollbarBox = null;

    for (const b of this.boxes) {
      const box = { x: b.x, y: b.y, w: b.w, h: b.h };
      if (b.role === "region") {
        const field = b.field || b.id;
        regions.push({ id: b.id, box, field });
        this.ensureField(field);
      } else if (b.role === "detect") {
        detect.push(detectToProfile(b, box));
      } else if (b.role === "state_detect") {
        const sid = b.stateId || "state";
        if (!statesMap.has(sid)) statesMap.set(sid, { id: sid, kind: "ordering", valid_for_save: true, detect: [] });
        statesMap.get(sid).detect.push(detectToProfile(b, box));
      } else if (b.role === "scrollbar") {
        scrollbarBox = box;
      }
    }

    const window = {
      id: this.windowId,
      dataset: this.dataset || null,
      key: { fields: [...this.key.fields], sep: this.key.sep || "|", case_sensitive: !!this.key.case_sensitive },
      fields: this.fields.map((f) => ({
        id: f.id, type: f.type, extract: f.extract || "whole", separator: f.separator || "/",
        learn: !!f.learn, fuzzy: f.fuzzy ?? 0.82,
        empty: f.empty ?? null, if_number: f.if_number ?? null, if_number_any: !!f.if_number_any,
        if_text: f.if_text ?? null, if_text_any: !!f.if_text_any, dict_mode: f.dict_mode || "correct",
      })),
      detect,
      states: [...statesMap.values()],
      regions,
      preprocess: {
        mode: this.preprocess.mode,
        colors: this.preprocess.colors,
        tolerance: this.preprocess.tolerance,
        scale: this.preprocess.scale,
      },
    };
    if (this.grid.enabled || scrollbarBox) {
      const first = this.regionBoxes()[0];
      window.scroll = {
        scrollbar: scrollbarBox,
        rows: this.grid.rows, cols: this.grid.cols,
        row_stride: this.grid.rowStride, col_stride: this.grid.colStride,
        cell: first ? { x: first.x, y: first.y, w: first.w, h: first.h } : null,
      };
    }

    return {
      name: this.name,
      process_names: this.processNames,
      window_title_hint: this.titleHint || null,
      fields: [],                 // schema lives on the window now
      windows: [window],
    };
  }

  fromProfile(profile, windowId) {
    this.reset(profile.name, windowId);
    this.processNames = profile.process_names || [];
    this.titleHint = profile.window_title_hint || "";
    _seq = 1;

    const win = (profile.windows || []).find((w) => w.id === windowId);
    // window fields, falling back to game-level fields for older profiles
    const rawFields = (win && win.fields && win.fields.length) ? win.fields : (profile.fields || []);
    // drop stale duplicate ids (first def wins — the one the server resolves too),
    // so a dirty profile heals on its next save instead of re-persisting the dup
    const seenIds = new Set();
    this.fields = rawFields.filter((f) => !seenIds.has(f.id) && seenIds.add(f.id)).map((f) => ({
      id: f.id, type: f.type || "text", extract: f.extract || "whole", separator: f.separator || "/",
      learn: !!f.learn, fuzzy: f.fuzzy ?? 0.82,
      empty: f.empty ?? null, if_number: f.if_number ?? null, if_number_any: !!f.if_number_any,
      if_text: f.if_text ?? null, if_text_any: !!f.if_text_any,
      // legacy profiles carry dict_only: true meant "correct AND drop unmatched"
      dict_mode: f.dict_mode || (f.dict_only ? "correct_drop" : "correct"),
    }));
    if (!win) return;
    this.dataset = win.dataset || "";
    if (win.key) {
      this.key = { fields: [...(win.key.fields || ["name"])], sep: win.key.sep ?? "|",
                   case_sensitive: !!win.key.case_sensitive };
    } else if (win.scroll && win.scroll.dedup_field) {
      this.key = { fields: [win.scroll.dedup_field], sep: "|", case_sensitive: false };  // legacy shape
    }
    if (win.preprocess) {
      this.preprocess = {
        mode: win.preprocess.mode || "none",
        colors: win.preprocess.colors || [],
        tolerance: win.preprocess.tolerance ?? 60,
        scale: win.preprocess.scale ?? 1,
      };
    }

    for (const a of win.detect || []) {
      this.boxes.push(detectToBox(a, { role: "detect" }));
    }
    for (const s of win.states || []) {
      this.states.push({ id: s.id, kind: s.kind || "ordering", valid_for_save: s.valid_for_save !== false });
      for (const a of s.detect || []) {
        this.boxes.push(detectToBox(a, { role: "state_detect", stateId: s.id }));
      }
    }
    for (const r of win.regions || []) {
      this.boxes.push({ id: r.id, role: "region", field: r.field, ...r.box });
    }
    if (win.scroll) {
      this.grid = {
        enabled: (win.scroll.rows || 1) > 1 || (win.scroll.cols || 1) > 1,
        rows: win.scroll.rows || 1, cols: win.scroll.cols || 1,
        rowStride: win.scroll.row_stride || 0, colStride: win.scroll.col_stride || 0,
      };
      if (win.scroll.scrollbar) {
        this.boxes.push({ id: "scrollbar", role: "scrollbar", ...win.scroll.scrollbar });
      }
    }
  }
}
