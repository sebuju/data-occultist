// Toast node: raises an OS desktop notification when fired. A trigger names this node's id in
// its `targets` (drag the trigger's fire-port here, or pick it in the trigger's "fires"), so any
// trigger condition can pop a Windows toast. The 🔔 test button pops it now with the current
// config. The body is an ordered list of styled TEXT BLOCKS (rich text) — each a font style +
// alignment + max-lines; the server renders them as a toast's stacked AdaptiveText lines. Every
// field maps to the ToastSpec the toasted-backed notifier renders. Rendering only — wiring is in
// main.js (wireToast). Config persists in the profile YAML like any other node.
import { h, svg, frag, labCell, srcRow, srcChip, srcInputs, kv, subhead, gspan, trashBtn, PLUS, COPY } from "../dom.js";
import { slideToggle } from "./node_parts.js";
import { iconFor } from "./node_icons.js";
import { nineGrid, fontSelect, biuGroup, borderEditor, anchorRow, colorPair } from "./textctl.js";

const DURATIONS = [["short", "short"], ["long", "long"]];
// font-size/weight presets a text block can pick (value stored, resolved server-side to a
// ToastTextStyle enum by upper-casing). "" = the platform default line style.
const STYLES = [["", "default"], ["caption", "caption"], ["captionsubtle", "caption subtle"],
    ["body", "body"], ["basesubtle", "base subtle"], ["base", "base"], ["subtitle", "subtitle"],
    ["title", "title"], ["subheader", "subheader"], ["header", "header"]];
const ALIGNS = [["", "auto"], ["left", "left"], ["center", "center"], ["right", "right"]];
const IMG_UNITS = [["px", "px"], ["pct", "% of image"]];

// Editor for one generated image (hero banner / inline body image): an enable toggle, a live
// server-rendered preview, background (solid/gradient) + canvas size, and a list of positioned
// text lines (content + x/y + size + colour + align). `which` is "hero" | "inline"; every control
// carries data-which so ONE wiring pass drives both editors (rule 7).
const IMG_PLACE = [["hero", "hero (top banner)"], ["inline", "inline (body)"], ["none", "none (off)"]];

// The mini-inspector: the full controls for ONE selected text element (index `j`). Replaces the
// old per-element control strip — only the selected element's fields are shown. Every control
// carries data-i (the element index) so the SAME wiring selectors drive it (rule 7). `null` when
// no element is selected (empty image) — shown as a hint.
export function imageTextInspector(t, j, texts = [], unit = "px") {
    if (!texts.length)
        return h("div", { class: "tn-il-insp tn-il-empty muted" }, "no text elements — add one below");
    // deselected (picker set to "(none)"): render the controls greyed + disabled from a blank element.
    const off = (t == null || j == null);
    const e = off ? {} : t;
    const ji = off ? 0 : j;
    const u = unit === "pct" ? "%" : "px";                 // suffix for the image-space geom inputs
    const us = () => h("span", { class: "tn-il-u" }, u);
    // every row starts with a leading label (grid col 1 — all labels share the widest one's width,
    // sized by the grid, not a hardcoded width) followed by its controls (col 2).
    // per-row reset: restores this row's field(s) to the element defaults (label doubles as the
    // reset group key, see GraphModel._toastTextResetGroups). "background" reset drops bg entirely.
    const rst = (label) => h("button", { class: "tn-il-rst", type: "button", dataset: { row: label, i: ji },
        title: "reset to default" }, "↺");
    const row = (label, ...ctrl) => frag(
        h("span", { class: "tn-il-ll" }, label),
        h("div", { class: "tn-il-rc" }, ...ctrl, rst(label)));
    const num = (cls, val, attrs) => h("input", { class: cls, dataset: { i: ji }, type: "number", value: val, ...attrs });
    // a "match another element's size" dropdown: "—" (own size) + "image" (the canvas size) + every
    // sibling by index+content
    const matchSel = (cls, cur, title) => h("select", { class: cls, dataset: { i: ji }, title },
        h("option", { value: "", selected: !cur }, "—"),
        h("option", { value: "image", selected: cur === "image" }, cur === "image" ? "<image>" : "image"),
        texts.map((tt, k) => k === ji ? null
            : h("option", { value: String(k), selected: String(cur) === String(k) },
                String(cur) === String(k) ? `<${k + 1}: ${(tt.content || "").trim() || "(empty)"}>` : `${k + 1}: ${(tt.content || "").trim() || "(empty)"}`)));
    return h("div", { class: "tn-il-insp" + (off ? " tn-il-off" : ""), dataset: { i: ji } },
        h("div", { class: "tn-il-insp-h tn-il-span" },
            h("span", { class: "muted" }, off ? "no element selected" : `element ${j + 1}`),
            trashBtn({ cls: "tn-il-del", dataset: { i: ji }, title: "remove this element" })),
        row("position",
            num("tn-il-x", e.x ?? 0, { title: "x offset from the anchor point" }), us(),
            num("tn-il-y", e.y ?? 0, { title: "y offset from the anchor point" }), us()),
        row("anchor", anchorRow(e, ji, texts.length)),
        // a match on an axis WINS over that axis's own width/height — so the dimension input is dead
        // while a match is set; likewise a match-percent does nothing with no match. Disable the inert
        // input so it's obvious the value isn't read (syncInspector keeps this in step on edits).
        row("dimension",
            num("tn-il-w", e.width || "", { min: "0", placeholder: "auto", disabled: !!e.match_w, title: "box width — 0/blank = auto to the text; drag a box edge to resize" }), us(),
            num("tn-il-h", e.height || "", { min: "0", placeholder: "auto", disabled: !!e.match_h, title: "box height — 0/blank = auto to the text; drag a box edge to resize" }), us()),
        row("match",
            h("span", { class: "tn-il-u" }, "w"), matchSel("tn-il-mw", e.match_w, "match width to another element's size"),
            num("tn-il-mwp", e.match_w_pct ?? 100, { min: "1", disabled: !e.match_w, title: "percent of the matched width (100 = full, 50 = half)" }), h("span", { class: "tn-il-u" }, "%"),
            h("span", { class: "tn-il-u" }, "h"), matchSel("tn-il-mh", e.match_h, "match height to another element's size"),
            num("tn-il-mhp", e.match_h_pct ?? 100, { min: "1", disabled: !e.match_h, title: "percent of the matched height (100 = full, 50 = half)" }), h("span", { class: "tn-il-u" }, "%")),
        row("content", h("textarea", { class: "tn-il-content", dataset: { i: ji }, rows: "2", placeholder: "text — supports {{token}}" }, e.content || "")),
        // font: size (px) + family + B/I/U + wrap + overflow
        row("font",
            num("tn-il-size", e.size ?? 20, { min: "6", title: "font size (px)" }), h("span", { class: "tn-il-u" }, "px"),
            fontSelect(e.font_family, "tn-il-font"),
            biuGroup(e, "tn-il-biu"),
            h("label", { class: "tn-il-chk", title: "word-wrap within the box width onto more lines" },
                h("input", { class: "tn-il-wrap", dataset: { i: ji }, type: "checkbox", checked: e.wrap !== false }), "wrap"),
            h("label", { class: "tn-il-chk", title: "allow text to spill past the box; off = clip to it and end with … (overflow: hidden; text-overflow: ellipsis)" },
                h("input", { class: "tn-il-over", dataset: { i: ji }, type: "checkbox", checked: !!e.overflow }), "overflow")),
        // conditional: drop this element when its text resolves empty and collapse the gap so anchored
        // siblings shift up to fill it (see toast_image render — zero size + zero offset when disabled).
        row("cond",
            h("label", { class: "tn-il-chk", title: "when this element's text resolves empty (a missing/blank {{token}}), drop it AND collapse the gap: it draws nothing and takes no space, so elements anchored to it shift up to fill the hole" },
                h("input", { class: "tn-il-cond", dataset: { i: ji }, type: "checkbox", checked: !!e.disable_if_empty }), "disable if empty")),
        row("align", nineGrid({ left: "tl", center: "tc", right: "tr" }[e.align] || e.align, "tn-il-align", "text placement within the box")),
        // stacking order — higher z draws on top of a lower one where boxes overlap (ties keep list order)
        row("layer", num("tn-il-z", e.z_index ?? 0, { title: "stacking order — higher draws on top where elements overlap" })),
        row("text", h("label", { class: "tn-il-cl" }, colorPair("tn-il-color", e.color || "#ffffff", "text colour"))),
        row("background", colorPair("tn-il-bg", e.bg_color || "#000000", "background box colour (drawn only when width and height > 0)")),
        row("border", borderEditor(e)));
}

// Editor for one generated image at index `idx` in the toast's images list. A placement dropdown
// (hero/inline/none — "none" temporarily disables it), a live server-rendered preview WITH a
// clickable box overlaid on every text element, background (solid/gradient) + canvas size, a
// compact selectable element list, and a mini-inspector editing the selected element. `sel` is the
// selected element index (model.toastImageSel). Every control carries data-i (the image index) so
// ONE wiring pass drives every image editor (rule 7).
function imageEditor(im, idx, sel) {
    const opt = (cur) => ([v, l]) => h("option", { value: v, selected: v === (cur || "") }, v === (cur || "") ? `<${l}>` : l);
    const grad = im.bg_type === "gradient";
    const trans = im.bg_type === "transparent";   // no fill — the toast surface shows through
    const texts = im.texts || [];
    return h("div", { class: "tn-img", dataset: { i: idx } },
        // floating remove — top-right, reveals on hover of this image (shared trashBtn look)
        trashBtn({ cls: "tn-img-del", title: "remove this image" }),
        // preview + box overlay + guide layer share one positioned wrapper so a box's px coords line
        // up over the img. tabindex makes it focusable so WASD nudge/resize is scoped to this image.
        h("div", { class: "tn-img-pv", tabindex: "0" },
            h("img", { class: "tn-img-preview", dataset: { i: idx }, alt: "image preview" }),
            h("div", { class: "tn-img-boxes" }),
            svg("svg", { class: "tn-guides" })),
        // image settings (labelled) below the preview — placement/units/size/background + delete
        h("div", { class: "lab-grid" },
            labCell("placement", "where this image sits — none temporarily disables it"),
            h("select", { class: "tn-img-place" }, IMG_PLACE.map(opt(im.placement || "inline"))),
            labCell("units", "how element x/y/w/h read: px or % of the image size"),
            h("select", { class: "tn-img-unit" }, IMG_UNITS.map(opt(im.unit || "px"))),
            labCell("size", "canvas size in pixels (hero renders ~364×180; inline is body-width)"),
            h("div", { class: "tn-img-size" },
                h("input", { class: "tn-img-w", type: "number", min: "1", value: im.width, title: "width" }), h("span", { class: "tn-il-u" }, "px"), "×",
                h("input", { class: "tn-img-h2", type: "number", min: "1", value: im.height, title: "height" }), h("span", { class: "tn-il-u" }, "px")),
            labCell("background", "solid colour or a 2-colour gradient"),
            h("div", { class: "tn-img-bg" },
                h("select", { class: "tn-img-bgtype" }, [["solid", "solid"], ["gradient", "gradient"], ["transparent", "transparent"]].map(opt(im.bg_type))),
                trans ? null : colorPair("tn-img-c1", im.color1 || "#0a3d62", "colour 1"),
                grad ? colorPair("tn-img-c2", im.color2 || "#061826", "colour 2") : null,
                grad ? h("label", { class: "tn-img-angle-l" }, "∠", h("input", { class: "tn-img-angle", type: "number", value: im.angle ?? 90, title: "gradient angle (deg)" })) : null)),
        h("div", { class: "tn-img-texts" },
            // element picker (dropdown) + add / clone buttons; the inspector below edits the selected
            // element. Clicking a box on the preview selects too — the dropdown just mirrors/jumps.
            h("div", { class: "tn-il-bar" },
                texts.length
                    ? h("select", { class: "tn-il-pick", title: "select an element (or none to deselect)" },
                        h("option", { value: "", selected: sel == null }, "(none)"),
                        texts.map((t, i) => h("option", { value: i, selected: i === sel },
                            i === sel ? `<${i + 1}: ${(t.content || "").trim() || "(empty)"}>` : `${i + 1}: ${(t.content || "").trim() || "(empty)"}`)))
                    : null,
                h("button", { class: "tn-img-addtext", title: "add a text element" }, PLUS()),
                h("button", { class: "tn-img-clone", title: "clone the selected element", disabled: sel == null }, COPY())),
            imageTextInspector(texts[sel], texts.length ? sel : null, texts, im.unit)));
}

// The {{token}} chips a toast offers, grouped by wired source so a chip label needn't repeat the
// source id — each group carries a subheading (the source id) and its chips carry SHORT labels
// (the field/column name, or "row count" for the bare collection). Built ONLY from the sources
// wired to it. Mirrors the pretty grammar so the same text renders identically server-side.
// Returns [{ head, chips:[{ token, label, title }] }] — `token` is the inner (no braces).
function tokenGroups(model, x) {
    const groups = [];
    const sources = model.toastSources(x.id);
    const readouts = sources.filter((s) => s.kind === "readout");
    if (readouts.length)
        groups.push({ head: "readouts", chips: readouts.map((s) => (
            { token: `readout:${s.id}`, label: s.id, title: `insert {{readout:${s.id}}}` })) });
    for (const s of sources) {
        if (s.kind !== "dataset" && s.kind !== "subset") continue;
        const cols = s.kind === "subset" ? model.subsetColumns(s.id) : model.datasetFields(s.id);
        groups.push({ head: s.id, chips: [
            { token: `${s.kind}:${s.id}`, label: "row count", title: `insert {{${s.kind}:${s.id}}} — number of rows` },
            ...cols.map((c) => ({ token: `${s.kind}:${s.id}.${c}`, label: c, title: `insert {{${s.kind}:${s.id}.${c}}}` })),
        ] });
    }
    return groups;
}

// One editable text block: a content textarea + its style/align/max-lines controls + reorder /
// remove. `i` is its index (carried on every control as data-i for the wiring).
function blockRow(b, i, n) {
    const opt = (cur) => ([v, l]) => h("option", { value: v, selected: v === (cur || "") }, v === (cur || "") ? `<${l}>` : l);
    return h("div", { class: "tn-block", dataset: { i } },
        h("textarea", { class: "tn-bk-content", dataset: { i }, rows: "2",
            placeholder: "text — supports {{token}}" }, b.content || ""),
        h("div", { class: "tn-bk-ctl" },
            h("select", { class: "tn-bk-style", dataset: { i }, title: "font style" }, STYLES.map(opt(b.style))),
            h("select", { class: "tn-bk-align", dataset: { i }, title: "text alignment" }, ALIGNS.map(opt(b.align))),
            h("input", { class: "tn-bk-max", dataset: { i }, type: "number", min: "0",
                value: b.max_lines || "", placeholder: "lines", title: "max lines (blank / 0 = unlimited)" }),
            h("button", { class: "tn-bk-up", dataset: { i }, title: "move up", disabled: i === 0 }, "▲"),
            h("button", { class: "tn-bk-dn", dataset: { i }, title: "move down", disabled: i === n - 1 }, "▼"),
            trashBtn({ cls: "tn-bk-del", dataset: { i }, title: "remove block" })));
}

export function toastParts(x, model) {
    const durOpt = ([v, l]) => h("option", { value: v, selected: v === (x.duration || "short") }, v === (x.duration || "short") ? `<${l}>` : l);
    const groups = model ? tokenGroups(model, x) : [];
    const titleDefault = (model && model.profile && model.profile.window_title_hint) || "Warframe";
    // sources row (FIRST): the data feeders wired to this toast — removable pills + an add-select.
    const wired = model ? model.toastSources(x.id) : [];
    const wiredRefs = new Set(wired.map((s) => s.ref));
    const avail = model ? [
        ...model.readouts().map((v) => `readout:${v.id}`),
        ...model.datasets().map((d) => `dataset:${d}`),
        ...(model.profile.subsets || []).map((s) => `subset:${s.id}`),
    ].filter((r) => !wiredRefs.has(r)) : [];
    const sourcesRow = srcRow("sources", "wired data feeders — a readout, dataset, or subset whose live value the text below can interpolate as a {{token}}. Add here, or drag a node's out-port onto this toast.",
        srcInputs(
            wired.map((s) => srcChip(s.ref, "ref", "tn-rmsrc")),
            "tn-addsrc",
            [h("option", { value: "" }, "+ source"), avail.map((r) => h("option", { value: r }, r))]));
    // the rich-text body: an ordered, styled block list + an "add block" button
    const blocks = (x.texts || []);
    const blocksSection = h("div", { class: "tn-blocks" },
        subhead("blocks", null, "the toast body — one styled line per block; the first is the bold title line"),
        blocks.map((b, i) => blockRow(b, i, blocks.length)),
        h("button", { class: "tn-bk-add", title: "add another text block" }, "+ text"));
    // token chips (rendered below the images, inside a .tn-tokbox): click a chip to copy its
    // {{token}} to the clipboard, ready to paste into any text block or image text line.
    const hint = groups.length ? h("div", { class: "tn-tokwrap" },
        groups.map((g) => frag(
            groups.length > 1 ? subhead(g.head, null, `tokens from ${g.head}`) : null,
            h("div", { class: "tn-rotokens" },
                g.chips.map((c) => h("button", { class: "tn-rotoken", type: "button", dataset: { token: c.token }, title: c.title }, c.label))))),
        h("div", { class: "tn-tokhint muted" },
            "refine: ", h("code", {}, "[i]"), " / ", h("code", {}, "[a:b]"), " slice · ",
            h("code", {}, "|sum"), " mean min max count first latest · ",
            h("code", {}, "|join"), " / ", h("code", {}, "|join:\", \""), " · ",
            h("code", {}, "|round:N"), " decimals (0 = none)")) : null;
    return {
        title: h("input", { class: "gi gi-id toastrename", value: x.id, title: "rename toast" }),
        body: frag(
            h("div", { class: "lab-grid" }, sourcesRow),
            // token palette sits directly UNDER sources (its tokens feed both text blocks and image
            // text lines); borderless/heaerless — clicking a chip copies {{token}} to the clipboard.
            groups.length ? h("div", { class: "tn-tokbox" }, hint) : null,
            blocksSection,
            // generated images (drawn on the fly, message text painted on) — a list, each with its
            // own placement (hero / inline / none); "+ image" appends another.
            h("div", { class: "tn-imgs" },
                model ? model.toastImages(x.id).map((im, idx) => imageEditor(im, idx, model.toastImageSel(x.id, idx))) : null,
                h("button", { class: "tn-img-add" }, "+ image")),
            h("div", { class: "lab-grid" },
                labCell("app", "the notification's source label (its AppUserModelID)"),
                h("input", { class: "tn-app", value: x.app_name || "", placeholder: titleDefault }),
                labCell("duration", "how long the toast lingers before auto-dismissing"),
                h("select", { class: "tn-duration" }, DURATIONS.map(durOpt)),
                labCell("icon", "app-logo image path/URL shown on the toast — a raster file (png/jpg/gif) or http(s) URL; leave blank to use the data-occultist logo. Toggle off to show no logo."),
                h("div", { class: "tn-icon-row" },
                    slideToggle({ on: x.show_icon !== false, cls: "tn-showicon", title: "show the app-logo icon on the toast" }),
                    h("input", { class: "tn-icon", value: x.icon || "", placeholder: "(data-occultist logo)" })),
                labCell("attribution", "small attribution line under the body — supports {{token}}"),
                h("input", { class: "tn-attr", value: x.attribution || "", placeholder: "(none)" }),
                labCell("muted", "silence the toast's notification sound"),
                slideToggle({ on: !!x.muted, cls: "tn-muted", title: "silence the toast sound" }))),
        // monochrome bell from the ONE icon source (not a colour emoji) + label
        foot: h("button", { class: "tn-test", title: "pop this toast now" }, iconFor("toast"), "test"),
        // drop a readout / dataset / subset out-port onto this toast to wire it as a {{token}} feeder
        ports: h("span", { class: "port in", title: "drag a readout, dataset or subset here to feed its live value as a {{token}}" }),
    };
}
