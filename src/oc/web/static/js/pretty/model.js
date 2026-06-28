// PrettyModel: the editable Pretty Studio document (theme + pages + widgets) and its
// debounced save to <game>.pretty.yaml. Mirrors GraphModel's role for the node view — pure
// data + small edit ops; rendering lives elsewhere.

import * as papi from "./api.js";

const DEBOUNCE = 400;

export class PrettyModel {
    constructor() { this.game = null; this.doc = blankDoc(); this._t = null; }

    load(game, doc) {
        this.game = game;
        this.doc = normalize(doc);
        return this.doc;
    }

    // ---- persistence (debounced) ------------------------------------------------------
    save() {
        clearTimeout(this._t);
        this._t = setTimeout(() => this.flush(), DEBOUNCE);
    }
    async flush() {
        clearTimeout(this._t); this._t = null;
        if (!this.game) return;
        try { await papi.savePretty(this.game, this.doc); } catch { /* offline; retry on next edit */ }
    }

    // ---- theme ------------------------------------------------------------------------
    theme() { return this.doc.theme || (this.doc.theme = {}); }
    setTheme(key, value) { this.theme()[key] = value; this.save(); }

    // ---- pages ------------------------------------------------------------------------
    pages() { return this.doc.pages; }
    page(id) { return this.doc.pages.find((p) => p.id === id) || null; }
    firstPageId() { return this.doc.pages[0] ? this.doc.pages[0].id : null; }
    addPage(title = "Page") {
        const id = this._uid("page", (p) => p.id, this.doc.pages);
        this.doc.pages.push({ id, title: title || id, style: {}, widgets: [] });
        this.save();
        return id;
    }
    removePage(id) {
        if (this.doc.pages.length <= 1) return false;   // keep at least one page
        this.doc.pages = this.doc.pages.filter((p) => p.id !== id);
        this.save();
        return true;
    }
    renamePage(id, title) { const p = this.page(id); if (p) { p.title = title; this.save(); } }
    // Reorder pages to match `ids` (a permutation of the current page ids). Any page omitted from
    // `ids` is kept, appended in its original order, so a stale list can never drop a page.
    reorderPages(ids) {
        const byId = new Map(this.doc.pages.map((p) => [p.id, p]));
        const next = ids.map((id) => byId.get(id)).filter(Boolean);
        for (const p of this.doc.pages) if (!next.includes(p)) next.push(p);
        if (next.length === this.doc.pages.length) { this.doc.pages = next; this.save(); }
    }

    // ---- widgets ----------------------------------------------------------------------
    widgets(pageId) { const p = this.page(pageId); return p ? p.widgets : []; }
    widget(pageId, wid) { return this.widgets(pageId).find((w) => w.id === wid) || null; }
    addWidget(pageId, widget) {
        const p = this.page(pageId);
        if (!p) return null;
        const all = this.doc.pages.flatMap((pg) => pg.widgets);
        const id = uid("w", (w) => w.id, all);
        const w = { id, x: 40, y: 40, w: 220, h: 80, z: all.length + 1, style: {}, conditions: {}, ...widget };
        w.id = id;
        p.widgets.push(w);
        this.save();
        return w;
    }
    removeWidget(pageId, wid) {
        const p = this.page(pageId);
        if (p) p.widgets = p.widgets.filter((w) => w.id !== wid);
        this.save();
    }
    // Rename a widget id, REPOINTING every reference so nothing breaks: other widgets' anchor.to /
    // matchW / matchH, and every {{widget:<id>}} token in any string field (labels, conditions, ...).
    // Widget ids are globally unique, so this works across all pages. Refuses an empty, duplicate, or
    // token-unsafe id (chars that would break {{widget:id}} parsing). Returns true on success.
    renameWidget(oldId, newId) {
        newId = (newId || "").trim();
        if (!newId || newId === oldId || /[\s{}|:.]/.test(newId)) return false;
        const all = this.doc.pages.flatMap((p) => p.widgets);
        if (all.some((w) => w.id === newId)) return false;
        const target = all.find((w) => w.id === oldId);
        if (!target) return false;
        target.id = newId;
        // replace `widget:<oldId>` tokens anywhere a string is held (\b stops it matching w3 inside w33)
        const re = new RegExp(`\\bwidget:${oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        const rep = `widget:${newId}`;
        const walk = (o) => {
            if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { if (typeof o[i] === "string") o[i] = o[i].replace(re, rep); else if (o[i] && typeof o[i] === "object") walk(o[i]); } }
            else if (o && typeof o === "object") { for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === "string") o[k] = v.replace(re, rep); else if (v && typeof v === "object") walk(v); } }
        };
        for (const w of all) {
            if (w.anchor && w.anchor.to === oldId) w.anchor.to = newId;
            if (w.matchW === oldId) w.matchW = newId;
            if (w.matchH === oldId) w.matchH = newId;
            walk(w);
        }
        this.save();
        return true;
    }
    // mutate a widget then persist (caller edits the object in place first, or passes a patch)
    touch() { this.save(); }

    _uid(prefix, getId, list) { return uid(prefix, getId, list); }
}

function uid(prefix, getId, list) {
    let n = 1, id = `${prefix}${n}`;
    const taken = new Set((list || []).map(getId));
    while (taken.has(id)) id = `${prefix}${++n}`;
    return id;
}

function blankDoc() {
    return { version: 1, theme: {}, pages: [{ id: "main", title: "Main", style: {}, widgets: [] }] };
}

// Normalise a loaded doc so the editor can trust its shape (ids present, arrays present).
function normalize(doc) {
    const d = doc && typeof doc === "object" ? doc : {};
    d.version = d.version || 1;
    d.theme = d.theme || {};
    d.pages = Array.isArray(d.pages) && d.pages.length ? d.pages : blankDoc().pages;
    d.pages.forEach((p, i) => {
        p.id = p.id || `page${i + 1}`;
        p.title = p.title || p.id;
        p.style = p.style || {};
        p.widgets = Array.isArray(p.widgets) ? p.widgets : [];
        p.widgets.forEach((w) => {
            w.style = w.style || {};
            w.conditions = w.conditions || {};
            w.conditions.rules = Array.isArray(w.conditions.rules) ? w.conditions.rules : [];
            w.config = w.config || {};
            // table columns: coerce any legacy string entries to {key, enabled}
            if (Array.isArray(w.config.columns)) {
                w.config.columns = w.config.columns.map((c) => (typeof c === "string" ? { key: c, enabled: true } : c));
            }
            if (w.type === "chart") w.config.colorBy = w.config.colorBy || {};
        });
    });
    return d;
}
