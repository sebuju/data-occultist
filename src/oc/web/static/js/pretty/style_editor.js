// The ONE style editor. Renders editing controls for a live `Style` object (mutated in
// place) from STYLE_FIELDS, calling `onChange` after each edit. Used by the inspector (widget
// style) and the theme panel (document defaults) — never copied (rule 7). No blocking
// dialogs; every control is inline (rule 2).

import { STYLE_FIELDS, FONT_CHOICES, BORDER_SIDES } from "./style.js";
import { el } from "./widgets/util.js";
import { colorField } from "../graph/colorfield.js";

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

    // Fields that ride inline on another field's row, not their own: B/I/U on the size row.
    // border_w/color/style are owned wholesale by the custom borderRow (below), so all three skip
    // the generic loop.
    const SKIP = new Set(["bold", "italic", "underline", "border_w", "border_color", "border_style"]);
    const toggleBtn = (key, label) => {
        const b = el("button", "pw-se-toggle", label);
        b.classList.toggle("on", !!disp(key));
        b.addEventListener("click", () => { const on = !disp(key); b.classList.toggle("on", on); setv(key, on || ""); });
        return b;
    };

    // The border editor: one row whose width/colour/style controls retarget to the active SIDE. A
    // side button (all / T R B L) picks the scope; "all" edits the shared base keys, a side edits its
    // `border_*_<side>` override (shown value falls back base -> effective so it reads what's in force,
    // but only writes the per-side key on change). Clearing a side's width reverts it to the base.
    const borderRow = () => {
        const row = el("div", "pw-se-row pw-se-border");
        row.appendChild(el("span", "pw-se-lab", "border"));
        let side = null;   // null = all sides (base keys)
        const bk = (prop) => (side ? `border_${prop}_${side}` : `border_${prop}`);
        const show = (prop) => {
            if (side) { const v = style[`border_${prop}_${side}`]; if (v !== undefined) return v; }
            const b = style[`border_${prop}`];
            return b !== undefined ? b : eff[`border_${prop}`];
        };
        const wn = el("input", "pw-se-num"); wn.type = "number"; wn.min = 0; wn.max = 40; wn.title = "width";
        wn.addEventListener("change", () => setv(bk("w"), wn.value === "" ? "" : Number(wn.value)));
        const cm = el("input", "pw-se-cmini"); cm.type = "color"; cm.title = "border color";
        cm.addEventListener("input", () => setv(bk("color"), cm.value));
        const stOpts = (STYLE_FIELDS.find((x) => x.key === "border_style") || {}).options || [];
        const ss = el("select"); ss.title = "border style";
        for (const o of ["", ...stOpts]) { const op = el("option", null, o || "(none)"); op.value = o; ss.appendChild(op); }
        ss.addEventListener("change", () => setv(bk("style"), ss.value));
        const sync = () => { wn.value = show("w") ?? ""; cm.value = toHex(show("color")) || "#000000"; ss.value = show("style") || ""; };
        const sw = el("div", "pw-se-sides");
        const btns = new Map();
        const pick = (sv) => { side = sv; btns.forEach((b, k) => b.classList.toggle("on", k === sv)); sync(); };
        [["all", null], ...BORDER_SIDES.map((s) => [s[0].toUpperCase(), s])].forEach(([lab, sv]) => {
            const b = el("button", "pw-se-side", lab); b.title = sv ? `${sv} side` : "all sides";
            b.classList.toggle("on", sv === side);
            b.addEventListener("click", () => pick(sv));
            btns.set(sv, b); sw.appendChild(b);
        });
        sync();
        row.append(sw, wn, cm, ss);
        return row;
    };

    for (const f of STYLE_FIELDS) {
        if (f.key === "border_w") { host.appendChild(borderRow()); continue; }   // custom border block
        if (SKIP.has(f.key)) continue;
        const row = el("div", "pw-se-row");
        row.appendChild(el("span", "pw-se-lab", f.label));
        const cur = disp(f.key);

        if (f.kind === "color") {
            // a transparent effective value (e.g. an unset fill computes to rgba(0,0,0,0)) is NO colour,
            // not black — show it empty so the field reads as "no fill" and never serialises black.
            const shown = isTransparent(cur) ? "" : cur;
            const cf = colorField({
                value: shown, title: f.label, textClass: "pw-se-text", clearClass: "pw-se-clear",
                clearTitle: "reset to default",
                onChange: (v) => setv(f.key, v), onClear: () => setv(f.key, ""),
            });
            row.append(cf.row);
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

// A fully-transparent value (the keyword, or any rgba/hsla with alpha 0) means NO colour — an unset
// fill computes to rgba(0,0,0,0), which must NOT read back as black.
function isTransparent(v) {
    if (typeof v !== "string") return false;
    const s = v.trim().toLowerCase();
    if (s === "transparent") return true;
    const m = s.match(/^(?:rgba|hsla)\([^)]*,\s*([0-9.]+)\s*\)$/);
    return !!m && Number(m[1]) === 0;
}

function toHex(v) {
    if (typeof v !== "string" || isTransparent(v)) return null;
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);   // computed colours come back as rgb()
    if (m) { const h = (n) => (+n).toString(16).padStart(2, "0"); return `#${h(m[1])}${h(m[2])}${h(m[3])}`; }
    return null;
}
