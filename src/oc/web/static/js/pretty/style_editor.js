// The ONE style editor. Renders editing controls for a live `Style` object (mutated in
// place) from STYLE_FIELDS, calling `onChange` after each edit. Used by the inspector (widget
// style) and the theme panel (document defaults) — never copied (rule 7). No blocking
// dialogs; every control is inline (rule 2).

import { STYLE_FIELDS, FONT_CHOICES } from "./style.js";
import { el } from "./widgets/util.js";

const ALIGNS = ["left", "center", "right", "justify"];

// Build the editor into `host`, editing `style` (the object is mutated directly). `onChange`
// fires after any edit so the caller can persist + re-apply. `opts.effective` (the element's
// computed Style) prefills a field's DISPLAY when the style doesn't override it — so inputs
// show the value actually in force, without writing it unless the user changes it.
export function styleEditor(host, style, onChange, opts = {}) {
  host.textContent = "";
  host.classList.add("pw-style-ed");   // ADD, don't clobber — the theme panel's host is the .fw-body
  const eff = opts.effective || {};
  const disp = (k) => (style[k] !== undefined ? style[k] : eff[k]);   // value to SHOW (style wins, else effective)
  const change = () => onChange && onChange();
  const setv = (k, v) => { if (v === "" || v == null) delete style[k]; else style[k] = v; change(); };

  // Fields that ride inline on another field's row, not their own: B/I/U on the size row,
  // border colour + style on the border-width row.
  const SKIP = new Set(["bold", "italic", "underline", "border_color", "border_style"]);
  const toggleBtn = (key, label) => {
    const b = el("button", "pw-se-toggle", label);
    b.classList.toggle("on", !!disp(key));
    b.addEventListener("click", () => { const on = !disp(key); b.classList.toggle("on", on); setv(key, on || ""); });
    return b;
  };
  const colorMini = (key) => {
    const c = el("input", "pw-se-cmini"); c.type = "color"; c.title = "border colour"; c.value = toHex(disp(key)) || "#000000";
    c.addEventListener("input", () => setv(key, c.value));
    return c;
  };
  const selectMini = (key, options) => {
    const s = el("select"); s.title = "border style";
    for (const o of ["", ...options]) { const op = el("option", null, o || "(none)"); op.value = o; s.appendChild(op); }
    s.value = disp(key) || "";
    s.addEventListener("change", () => setv(key, s.value));
    return s;
  };

  for (const f of STYLE_FIELDS) {
    if (SKIP.has(f.key)) continue;
    const row = el("div", "pw-se-row");
    row.appendChild(el("span", "pw-se-lab", f.label));
    const cur = disp(f.key);

    if (f.kind === "color") {
      const c = el("input"); c.type = "color"; c.value = toHex(cur) || "#000000";
      const t = el("input", "pw-se-text"); t.type = "text"; t.placeholder = "—"; t.value = cur || "";
      c.addEventListener("input", () => { t.value = c.value; setv(f.key, c.value); });
      t.addEventListener("change", () => setv(f.key, t.value.trim()));
      const clr = el("button", "pw-se-clear", "×"); clr.title = "clear";
      clr.addEventListener("click", () => { t.value = ""; setv(f.key, ""); });
      row.append(c, t, clr);
    } else if (f.kind === "font") {
      const s = el("select");
      for (const fam of FONT_CHOICES) { const o = el("option", null, fam || "(default)"); o.value = fam; s.appendChild(o); }
      s.value = FONT_CHOICES.includes(cur) ? cur : "";
      s.addEventListener("change", () => setv(f.key, s.value));
      row.appendChild(s);
    } else if (f.kind === "px") {
      const n = el("input", "pw-se-num"); n.type = "number"; if (f.min != null) n.min = f.min; if (f.max != null) n.max = f.max;
      n.value = cur ?? "";
      n.addEventListener("change", () => setv(f.key, n.value === "" ? "" : Number(n.value)));
      row.appendChild(n);
      // B I U live on the size row
      if (f.key === "font_size") row.append(toggleBtn("bold", "B"), toggleBtn("italic", "I"), toggleBtn("underline", "U"));
      // border colour + style live on the border-width row
      if (f.key === "border_w") row.append(colorMini("border_color"), selectMini("border_style", (STYLE_FIELDS.find((x) => x.key === "border_style") || {}).options || []));
    } else if (f.kind === "range01") {
      const r = el("input"); r.type = "range"; r.min = 0; r.max = 1; r.step = 0.05; r.value = cur ?? 1;
      const out = el("span", "pw-se-out", String(cur ?? 1));
      r.addEventListener("input", () => { out.textContent = r.value; setv(f.key, Number(r.value)); });
      row.append(r, out);
    } else if (f.kind === "toggle") {
      const b = el("button", "pw-se-toggle", f.label);
      b.classList.toggle("on", !!cur);
      b.addEventListener("click", () => { const on = !style[f.key]; b.classList.toggle("on", on); setv(f.key, on || ""); });
      row.textContent = ""; row.appendChild(b);
    } else if (f.kind === "align") {
      const g = el("div", "pw-se-align");
      ALIGNS.forEach((a) => {
        const b = el("button", "pw-se-aln", a[0].toUpperCase());
        b.title = a; b.classList.toggle("on", cur === a);
        b.addEventListener("click", () => { g.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); setv(f.key, a); });
        g.appendChild(b);
      });
      row.appendChild(g);
    } else if (f.kind === "select") {
      const s = el("select");
      for (const o of ["", ...(f.options || [])]) { const op = el("option", null, o || "(default)"); op.value = o; s.appendChild(op); }
      s.value = cur || "";
      s.addEventListener("change", () => setv(f.key, s.value));
      row.appendChild(s);
    } else {   // text
      const t = el("input", "pw-se-text"); t.type = "text"; t.value = cur || "";
      t.addEventListener("change", () => setv(f.key, t.value.trim()));
      row.appendChild(t);
    }
    host.appendChild(row);
  }
}

function toHex(v) {
  if (typeof v !== "string") return null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);   // computed colours come back as rgb()
  if (m) { const h = (n) => (+n).toString(16).padStart(2, "0"); return `#${h(m[1])}${h(m[2])}${h(m[3])}`; }
  return null;
}
