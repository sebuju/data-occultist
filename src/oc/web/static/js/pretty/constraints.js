// Node-input constraints, derived from the live profile (GraphModel) — NEVER hard-coded per
// game. A Pretty control binds to one input PATH; this module answers "what kind of value is
// that, and what's its legal range / option set" so the control can clamp to the node's real
// restriction (e.g. a confidence is a float 0..1) regardless of how the author dresses it up.
//
// `nodeInputs(model)` enumerates every settable input across all nodes — the catalogue the
// Sources panel lists and the control picker offers. `inputMeta(model, path)` looks one up
// (falling back to a string input for an unknown path). `clamp(meta, value)` enforces it.

const N = (min, max, step) => ({ kind: "number", min, max, step });
const BOOL = { kind: "bool" };
const STR = { kind: "string" };
const ENUM = (...options) => ({ kind: "enum", options });

// Per-node settable inputs. Each entry: { path, label, meta }. `meta.kind` ∈
// number|bool|enum|string with optional min/max/step/options.
export function nodeInputs(model) {
  const p = model.profile || {};
  const out = [];
  const add = (nodeId, nodeLabel, path, label, meta) =>
    out.push({ nodeId, nodeLabel, path, label, meta });

  for (const t of p.triggers || []) {
    const id = t.id;
    add(`trigger:${id}`, id, `triggers[${id}].enabled`, "enabled", BOOL);
    add(`trigger:${id}`, id, `triggers[${id}].kind`, "kind", ENUM("interval", "on_change", "manual"));
    add(`trigger:${id}`, id, `triggers[${id}].interval_s`, "interval (s)", N(1, null, 1));
  }
  for (const pn of p.price_nodes || []) {
    const id = pn.id;
    add(`price:${id}`, id, `price_nodes[${id}].enabled`, "enabled", BOOL);
    add(`price:${id}`, id, `price_nodes[${id}].mode`, "mode", ENUM("statistics", "orders"));
    add(`price:${id}`, id, `price_nodes[${id}].throttle`, "throttle (s)", N(0, null, 0.05));
    add(`price:${id}`, id, `price_nodes[${id}].source_field`, "source field", STR);
  }
  for (const w of p.windows || []) {
    const wid = w.id;
    add(`win:${wid}`, wid, `windows[${wid}].live`, "live", BOOL);
    add(`win:${wid}`, wid, `windows[${wid}].static_grid`, "static grid", BOOL);
    for (const f of w.fields || []) {
      const base = `windows[${wid}].fields[${f.id}]`;
      const lab = `${wid} ▸ ${f.id}`;
      add(`win:${wid}`, lab, `${base}.min_confidence`, "min confidence", N(0, 1, 0.05));
      add(`win:${wid}`, lab, `${base}.fuzzy`, "fuzzy", N(0, 1, 0.05));
      add(`win:${wid}`, lab, `${base}.learn`, "learn", BOOL);
      add(`win:${wid}`, lab, `${base}.type`, "type", ENUM("text", "number", "pips", "diamonds"));
      add(`win:${wid}`, lab, `${base}.min`, "min", N(null, null, 1));
      add(`win:${wid}`, lab, `${base}.max`, "max", N(null, null, 1));
      add(`win:${wid}`, lab, `${base}.isolate`, "isolate", BOOL);
    }
    for (const it of w.items || []) {
      add(`item:${wid}:${it.id}`, `${wid} ▸ ${it.id}`, `windows[${wid}].items[${it.id}].priority`, "priority", N(0, null, 1));
    }
  }
  for (const s of p.subsets || []) {
    add(`sub:${s.id}`, s.id, `subsets[${s.id}].limit`, "limit", N(0, null, 1));
    add(`sub:${s.id}`, s.id, `subsets[${s.id}].aggregate`, "aggregate", ENUM("latest", "first", "sum", "mean", "max", "min"));
    add(`sub:${s.id}`, s.id, `subsets[${s.id}].join_field`, "join field", STR);
  }
  for (const d of p.datasets || []) {
    add(`ds:${d.id}`, d.id, `datasets[${d.id}].aggregate`, "aggregate", ENUM("latest", "first", "sum", "mean", "max", "min"));
  }
  return out;
}

export function inputMeta(model, path) {
  const hit = nodeInputs(model).find((i) => i.path === path);
  return hit ? hit.meta : STR;
}

// Map an input path to the graph node(s) it belongs to — for the "pretty-dirty" badge.
export function nodeIdsForPath(model, path) {
  let m = /^triggers\[(.+?)\]/.exec(path); if (m) return [`trigger:${m[1]}`];
  m = /^price_nodes\[(.+?)\]/.exec(path); if (m) return [`price:${m[1]}`];
  m = /^subsets\[(.+?)\]/.exec(path); if (m) return [`sub:${m[1]}`];
  m = /^datasets\[(.+?)\]/.exec(path); if (m) return [`ds:${m[1]}`];
  m = /^windows\[(.+?)\]\.items\[(.+?)\]/.exec(path); if (m) return [`item:${m[1]}:${m[2]}`];
  m = /^windows\[(.+?)\]\.fields\[(.+?)\]/.exec(path);
  if (m) {
    const wid = m[1], fid = m[2], ids = [`win:${wid}`];
    const w = (model.profile.windows || []).find((x) => x.id === wid);
    for (const r of (w && w.regions) || []) if (r.field === fid) ids.push(`reg:${wid}:${r.id}`);
    for (const it of (w && w.items) || []) for (const f of it.fields || []) if (f.field === fid) ids.push(`fld:${wid}:${it.id}:${f.id}`);
    return ids;
  }
  m = /^windows\[(.+?)\]/.exec(path); if (m) return [`win:${m[1]}`];
  return [];
}

// Clamp/coerce a raw value to a constraint. Numbers clamp to [min,max]; enums must be a
// member (else unchanged); bools coerce; strings pass through.
export function clamp(meta, value) {
  const m = meta || STR;
  if (m.kind === "number") {
    let v = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(v)) return null;
    if (m.min != null) v = Math.max(m.min, v);
    if (m.max != null) v = Math.min(m.max, v);
    return v;
  }
  if (m.kind === "bool") return typeof value === "boolean" ? value : (String(value).toLowerCase() === "true" || value === "1" || value === 1 || value === "on");
  if (m.kind === "enum") return m.options.includes(value) ? value : undefined;
  return value == null ? "" : String(value);
}
