// Toast node: raises an OS desktop notification when fired. A trigger names this node's id in
// its `targets` (drag the trigger's fire-port here, or pick it in the trigger's "fires"), so any
// trigger condition can pop a Windows toast. The 🔔 test button pops it now with the current
// config. The body is an ordered list of styled TEXT BLOCKS (rich text) — each a font style +
// alignment + max-lines; the server renders them as a toast's stacked AdaptiveText lines. Every
// field maps to the ToastSpec the toasted-backed notifier renders. Rendering only — wiring is in
// main.js (wireToast). Config persists in the profile YAML like any other node.
import { h, frag, labCell, srcChip, srcInputs, TRASH } from "../dom.js";
import { slideToggle } from "./node_parts.js";
import { iconFor } from "./node_icons.js";

const DURATIONS = [["short", "short"], ["long", "long"]];
// font-size/weight presets a text block can pick (value stored, resolved server-side to a
// ToastTextStyle enum by upper-casing). "" = the platform default line style.
const STYLES = [["", "default"], ["caption", "caption"], ["captionsubtle", "caption subtle"],
    ["body", "body"], ["basesubtle", "base subtle"], ["base", "base"], ["subtitle", "subtitle"],
    ["title", "title"], ["subheader", "subheader"], ["header", "header"]];
const ALIGNS = [["", "auto"], ["left", "left"], ["center", "center"], ["right", "right"]];
const IMG_ALIGNS = [["left", "left"], ["center", "center"], ["right", "right"]];

// Editor for one generated image (hero banner / inline body image): an enable toggle, a live
// server-rendered preview, background (solid/gradient) + canvas size, and a list of positioned
// text lines (content + x/y + size + colour + align). `which` is "hero" | "inline"; every control
// carries data-which so ONE wiring pass drives both editors (rule 7).
const IMG_PLACE = [["hero", "hero (top banner)"], ["inline", "inline (body)"], ["none", "none (off)"]];

// Editor for one generated image at index `idx` in the toast's images list. A placement dropdown
// (hero/inline/none — "none" temporarily disables it), a live server-rendered preview, background
// (solid/gradient) + canvas size, and a list of positioned text lines. Every control carries
// data-i (the image index) so ONE wiring pass drives every image editor (rule 7).
function imageEditor(im, idx) {
    const opt = (cur) => ([v, l]) => h("option", { value: v, selected: v === (cur || "") }, l);
    const grad = im.bg_type === "gradient";
    const textLine = (t, i) => h("div", { class: "tn-il", dataset: { i } },
        h("div", { class: "tn-il-row" },
            h("input", { class: "tn-il-content", dataset: { i }, value: t.content || "", placeholder: "text — supports {{token}}" }),
            h("button", { class: "tn-il-del danger", dataset: { i }, title: "remove line" }, TRASH())),
        h("div", { class: "tn-il-ctl" },
            h("label", {}, "x", h("input", { class: "tn-il-x", dataset: { i }, type: "number", value: t.x ?? 0 })),
            h("label", {}, "y", h("input", { class: "tn-il-y", dataset: { i }, type: "number", value: t.y ?? 0 })),
            h("label", {}, "size", h("input", { class: "tn-il-size", dataset: { i }, type: "number", min: "6", value: t.size ?? 20 })),
            h("label", {}, "w", h("input", { class: "tn-il-w", dataset: { i }, type: "number", min: "0", value: t.width || "", placeholder: "∞", title: "text/box width in px (blank / 0 = unconstrained)" })),
            h("label", {}, "h", h("input", { class: "tn-il-h", dataset: { i }, type: "number", min: "0", value: t.height || "", placeholder: "0", title: "box height in px (0 = no box; >0 draws a background box behind the text)" })),
            h("label", { title: "within width: on = wrap to more lines; off = one line, truncated with …" }, "wrap", h("input", { class: "tn-il-wrap", dataset: { i }, type: "checkbox", checked: t.wrap !== false })),
            h("input", { class: "tn-il-color", dataset: { i }, type: "color", value: t.color || "#ffffff", title: "text colour" }),
            h("input", { class: "tn-il-bg", dataset: { i }, type: "color", value: t.bg_color || "#000000", title: "background box colour (drawn only when width and height > 0)" }),
            h("select", { class: "tn-il-align", dataset: { i }, title: "horizontal anchor at x" }, IMG_ALIGNS.map(opt(t.align)))));
    return h("div", { class: "tn-img", dataset: { i: idx } },
        h("div", { class: "tn-img-h" },
            h("span", { class: "muted" }, `image ${idx + 1}`),
            h("select", { class: "tn-img-place", title: "where this image sits — none temporarily disables it" }, IMG_PLACE.map(opt(im.placement || "inline"))),
            h("button", { class: "tn-img-del danger", title: "remove this image" }, TRASH())),
        h("img", { class: "tn-img-preview", dataset: { i: idx }, alt: `image ${idx + 1} preview` }),
        h("div", { class: "lab-grid" },
            labCell("size", "canvas size in pixels (hero renders ~364×180; inline is body-width)"),
            h("div", { class: "tn-img-size" },
                h("input", { class: "tn-img-w", type: "number", min: "1", value: im.width, title: "width" }), "×",
                h("input", { class: "tn-img-h2", type: "number", min: "1", value: im.height, title: "height" })),
            labCell("background", "solid colour or a 2-colour gradient"),
            h("div", { class: "tn-img-bg" },
                h("select", { class: "tn-img-bgtype" }, [["solid", "solid"], ["gradient", "gradient"]].map(opt(im.bg_type))),
                h("input", { class: "tn-img-c1", type: "color", value: im.color1 || "#0a3d62", title: "colour 1" }),
                grad ? h("input", { class: "tn-img-c2", type: "color", value: im.color2 || "#061826", title: "colour 2" }) : null,
                grad ? h("label", { class: "tn-img-angle-l" }, "∠", h("input", { class: "tn-img-angle", type: "number", value: im.angle ?? 90, title: "gradient angle (deg)" })) : null)),
        h("div", { class: "tn-img-texts" },
            (im.texts || []).map(textLine),
            h("button", { class: "tn-img-addtext" }, "+ add text line")));
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
    const opt = (cur) => ([v, l]) => h("option", { value: v, selected: v === (cur || "") }, l);
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
            h("button", { class: "tn-bk-del danger", dataset: { i }, title: "remove block" }, TRASH())));
}

export function toastParts(x, model) {
    const durOpt = ([v, l]) => h("option", { value: v, selected: v === (x.duration || "short") }, l);
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
    const sourcesRow = frag(
        labCell("sources", "wired data feeders — a readout, dataset, or subset whose live value the text below can interpolate as a {{token}}. Add here, or drag a node's out-port onto this toast.", true),
        srcInputs(
            wired.map((s) => srcChip(s.ref, "ref", "tn-rmsrc")),
            "tn-addsrc",
            [h("option", { value: "" }, "+ source"), avail.map((r) => h("option", { value: r }, r))]));
    // the rich-text body: an ordered, styled block list + an "add block" button
    const blocks = (x.texts || []);
    const blocksSection = h("div", { class: "tn-blocks" },
        h("div", { class: "muted tn-blocks-h", title: "the toast body — one styled line per block; the first is the bold title line" }, "text blocks"),
        blocks.map((b, i) => blockRow(b, i, blocks.length)),
        h("button", { class: "tn-bk-add", title: "add another text block" }, "+ add text block"));
    // token chips (rendered below the images, inside a .tn-tokbox): click a chip to copy its
    // {{token}} to the clipboard, ready to paste into any text block or image text line.
    const hint = groups.length ? h("div", { class: "tn-tokwrap" },
        h("div", { class: "muted tn-tokhead" }, "insert token"),
        groups.map((g) => frag(
            groups.length > 1 ? h("div", { class: "tn-tokhead muted", title: `tokens from ${g.head}` }, g.head) : null,
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
            blocksSection,
            // generated images (drawn on the fly, message text painted on) — a list, each with its
            // own placement (hero / inline / none); "+ image" appends another.
            h("div", { class: "tn-imgs" },
                model ? model.toastImages(x.id).map((im, idx) => imageEditor(im, idx)) : null,
                h("button", { class: "tn-img-add" }, "+ image")),
            // token palette sits BELOW the images (its tokens feed both text blocks and image text
            // lines), wrapped in its own bordered box; clicking a chip copies {{token}} to clipboard.
            groups.length ? h("div", { class: "tn-tokbox" }, hint) : null,
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
                slideToggle({ on: !!x.muted, cls: "tn-muted", title: "silence the toast sound" })),
            h("div", { class: "gn-foot" },
                // monochrome bell from the ONE icon source (not a colour emoji) + label
                h("button", { class: "tn-test", title: "pop this toast now" }, iconFor("toast"), "test"))),
        // drop a readout / dataset / subset out-port onto this toast to wire it as a {{token}} feeder
        ports: h("span", { class: "port in", title: "drag a readout, dataset or subset here to feed its live value as a {{token}}" }),
    };
}
