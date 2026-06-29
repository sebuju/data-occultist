// Named profiles shared by STYLE and CONFIG (rule 7: one primitive, two callers). A widget
// carries ONE base object (`w.style` / `w.config`, the "Default" profile) plus any number of
// extra named profiles (`w.styleProfiles` / `w.configProfiles` = [{id, name, <val>}]). Each
// profile is a FULL, independent object. Which one is in force is chosen at draw time: a
// condition rule (effect "style" / "config") activates its profile while true; otherwise the
// default. The inspector shows the profiles as tabs and edits one at a time.

// Ordered profiles: the default first (id "default", backed by w[valKey]), then the extras.
// Each entry's value is a LIVE reference into the widget, so the editor mutates it in place.
export function listProfiles(w, valKey, listKey, baseName = "Default") {
    const base = { id: "default", name: baseName, [valKey]: (w[valKey] = w[valKey] || {}) };
    const extra = (w[listKey] || []).map((p) => ({ id: p.id, name: p.name || p.id, [valKey]: (p[valKey] = p[valKey] || {}) }));
    return [base, ...extra];
}

// The value object of one profile by id ("default" / missing -> the base w[valKey]).
export function profileValue(w, valKey, listKey, id) {
    if (!id || id === "default") return w[valKey] || {};
    const p = (w[listKey] || []).find((x) => x.id === id);
    return p ? (p[valKey] || {}) : (w[valKey] || {});
}

// Concrete accessors for the two kinds.
export const widgetProfiles = (w) => listProfiles(w, "style", "styleProfiles");
export const widgetConfigProfiles = (w) => listProfiles(w, "config", "configProfiles");
export const profileStyle = (w, id) => profileValue(w, "style", "styleProfiles", id);
export const profileConfig = (w, id) => profileValue(w, "config", "configProfiles", id);
