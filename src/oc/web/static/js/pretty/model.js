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
    // Rename a page's display title. The page `id` (the stable reference held by switch_page buttons
    // and widgets' share lists) never changes, so every reference stays valid; all UIs read `title`
    // live, so the new name shows everywhere at once. Refuses an empty title or one that COLLIDES with
    // another page's title (case-insensitive) so two pages can't share a name. Returns true on success.
    renamePage(id, title) {
        title = (title || "").trim();
        const p = this.page(id);
        if (!p || !title) return false;
        const low = title.toLowerCase();
        if (this.doc.pages.some((pg) => pg.id !== id && (pg.title || "").trim().toLowerCase() === low)) return false;
        p.title = title;
        this.save();
        return true;
    }
    // Reorder pages to match `ids` (a permutation of the current page ids). Any page omitted from
    // `ids` is kept, appended in its original order, so a stale list can never drop a page.
    reorderPages(ids) {
        const byId = new Map(this.doc.pages.map((p) => [p.id, p]));
        const next = ids.map((id) => byId.get(id)).filter(Boolean);
        for (const p of this.doc.pages) if (!next.includes(p)) next.push(p);
        if (next.length === this.doc.pages.length) { this.doc.pages = next; this.save(); }
    }

    // ---- widgets ----------------------------------------------------------------------
    // A widget is STORED on exactly one page (its "home"). It may additionally be SHARED onto other
    // pages: `onAllPages` shows it everywhere; else `pages` is an allowlist of extra page ids. The
    // home page always shows it. The same object renders on each page, so an edit reflects everywhere.
    widgets(pageId) { const p = this.page(pageId); return p ? p.widgets : []; }   // home-stored only
    homePageId(wid) { const p = this.doc.pages.find((pg) => pg.widgets.some((w) => w.id === wid)); return p ? p.id : null; }
    _showsOn(w, pageId) { return !!w.onAllPages || (Array.isArray(w.pages) && w.pages.includes(pageId)); }
    // Every widget that should RENDER on `pageId`: the page's own widgets, plus any widget shared onto
    // it from another page. De-duped by id (a home widget is never re-added as a share).
    widgetsForPage(pageId) {
        const home = this.widgets(pageId);
        const seen = new Set(home.map((w) => w.id));
        const shared = [];
        for (const p of this.doc.pages) {
            if (p.id === pageId) continue;
            for (const w of p.widgets) if (!seen.has(w.id) && this._showsOn(w, pageId)) { shared.push(w); seen.add(w.id); }
        }
        return [...home, ...shared];
    }
    // lookup spans the RESOLVED set so a shared widget is found while viewing a page it's shared onto.
    widget(pageId, wid) { return this.widgetsForPage(pageId).find((w) => w.id === wid) || null; }
    // Toggle whether widget `wid` shows on `pageId` (never its home page — that's implicit). `on` adds,
    // else removes. Editing one page out of an `onAllPages` widget first expands it to an explicit list.
    setShare(wid, pageId, on) {
        const w = this.doc.pages.flatMap((p) => p.widgets).find((x) => x.id === wid);
        if (!w) return;
        const homeId = this.homePageId(wid);
        if (pageId === homeId) return;   // home is always shown; nothing to toggle
        if (w.onAllPages) {   // expand "all" to an explicit allowlist (every page except home) so one can be removed
            w.onAllPages = false;
            w.pages = this.doc.pages.map((p) => p.id).filter((id) => id !== homeId);
        }
        w.pages = Array.isArray(w.pages) ? w.pages : [];
        if (on) { if (!w.pages.includes(pageId)) w.pages.push(pageId); }
        else w.pages = w.pages.filter((id) => id !== pageId);
        this.save();
    }
    setShareAll(wid, on) {
        const w = this.doc.pages.flatMap((p) => p.widgets).find((x) => x.id === wid);
        if (!w) return;
        if (on) { w.onAllPages = true; delete w.pages; }
        else { w.onAllPages = false; w.pages = []; }
        this.save();
    }
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
    // Move which page OWNS `wid` (its home) to `toPageId`. The widget object (with its style/config/
    // conditions/share state) moves intact; only its storage page changes. Drops the new home from the
    // widget's share list (the home always shows, so listing it would be redundant). Returns true.
    rehomeWidget(wid, toPageId) {
        const from = this.doc.pages.find((p) => p.widgets.some((w) => w.id === wid));
        const to = this.page(toPageId);
        if (!from || !to || from.id === toPageId) return false;
        const w = from.widgets.find((x) => x.id === wid);
        from.widgets = from.widgets.filter((x) => x.id !== wid);
        if (Array.isArray(w.pages)) w.pages = w.pages.filter((id) => id !== toPageId);
        to.widgets.push(w);
        this.save();
        return true;
    }
    // Remove `wid` as seen from `pageId`. On its HOME page this DELETES the widget (so it disappears
    // from every page it was shared onto). On a page it's only SHARED onto, this UN-SHARES it from that
    // page (the widget itself survives on its home). So "delete" from a shared instance just detaches it.
    removeWidget(pageId, wid) {
        const homeId = this.homePageId(wid);
        if (homeId && homeId !== pageId) { this.setShare(wid, pageId, false); return; }
        const p = this.page(homeId || pageId);
        if (p) p.widgets = p.widgets.filter((w) => w.id !== wid);
        this.save();
    }
    // Duplicate a widget onto its OWN home page with a fresh, non-colliding id. The copy is a deep
    // clone (style/config/conditions/anchor/pages all carried), nudged down-right so it doesn't sit
    // exactly on the original. References the clone holds (anchor.to / matchW / {{widget:id}} tokens)
    // point at the SAME targets as the original — only the clone's own id is new. Returns the copy.
    cloneWidget(wid) {
        const homeId = this.homePageId(wid);
        const p = this.page(homeId);
        if (!p) return null;
        const src = p.widgets.find((w) => w.id === wid);
        if (!src) return null;
        const all = this.doc.pages.flatMap((pg) => pg.widgets);
        const id = uid("w", (w) => w.id, all);
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = id;
        if (typeof copy.x === "number") copy.x += 20;   // offset only when numeric (calc/% strings stay put)
        if (typeof copy.y === "number") copy.y += 20;
        p.widgets.push(copy);
        this.save();
        return copy;
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
            // extra named style profiles (the default profile is w.style itself). Each {id, name, style}.
            w.styleProfiles = Array.isArray(w.styleProfiles) ? w.styleProfiles.filter((sp) => sp && sp.id) : [];
            w.styleProfiles.forEach((sp) => { sp.name = sp.name || sp.id; sp.style = sp.style || {}; });
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
