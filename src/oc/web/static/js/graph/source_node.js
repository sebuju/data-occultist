// File-source node: locate a game log/config file, parse it (no regex — declarative rules),
// and push parsed rows into its output dataset (wired source -> dataset, like a price node).
// Reading is driven by the node's own watch (manual / on file-change) and by trigger nodes that
// target it. Rendering only — every input is wired in main.js (wireSource). A live preview of
// what the current rules produce is fetched there too.
import { h, frag, TRASH, labCell } from "../dom.js";

// formats mirror the registered parsers (oc.source.parsers / registry._PARSER). `log_lines` is the
// only line-streaming one; the rest are whole-document (path lookups).
const FORMATS = [["log_lines", "log lines"], ["ini", "ini / cfg"], ["json", "json"],
    ["xml", "xml"], ["yaml", "yaml"]];
const STREAM = new Set(["log_lines"]);
const OPS = [["contains", "contains"], ["starts_with", "starts with"],
    ["ends_with", "ends with"], ["equals", "equals"]];
const METHODS = [["after", "after"], ["between", "between"], ["column", "column"], ["whole", "whole line"]];

const isStream = (s) => STREAM.has(s.format);

// one line-filter (match) row: op + text + case toggle + remove
function matchRow(m, i) {
    const ops = OPS.map(([v, l]) => h("option", { value: v, selected: v === m.op }, l));
    return h("div", { class: "src-m", dataset: { i } },
        h("select", { class: "mset", dataset: { i, k: "op" } }, ops),
        h("input", { class: "mset", dataset: { i, k: "text" }, value: m.text || "", placeholder: "text" }),
        h("label", { class: "src-cs", title: "case sensitive" },
            h("input", { type: "checkbox", class: "mset", dataset: { i, k: "case_sensitive" }, checked: !!m.case_sensitive }), "Aa"),
        h("button", { class: "src-rmm danger", dataset: { i }, title: "remove" }, TRASH()));
}

// the method-specific inputs for one extraction field (varies by method)
function methodInputs(f, i) {
    const inp = (k, ph) => h("input", { class: "fset2", dataset: { i, k }, value: f[k] ?? "", placeholder: ph });
    if (f.method === "after") return [inp("anchor", "after this text"), inp("stop", "stop at (optional)")];
    if (f.method === "between") return [inp("anchor", "start"), h("span", { class: "src-arrow" }, "→"), inp("end", "end")];
    if (f.method === "column") return [inp("delim", "delimiter (blank = whitespace)"),
        h("input", { class: "fset2", dataset: { i, k: "index" }, type: "number", step: "1", value: Number(f.index) || 0, title: "token index (negative = from end)" })];
    if (f.method === "path") return inp("path", "a.b.c  /  Section.Key  /  root/child");
    return null;   // whole: no extra inputs
}

// one extraction-field row: id + method (line formats) + method inputs + type + remove
function fieldRow(f, i, stream) {
    // line formats pick a method (after/between/column/whole); document formats are always path.
    const methodSel = stream
        ? h("select", { class: "fset2", dataset: { i, k: "method" } },
            METHODS.map(([v, l]) => h("option", { value: v, selected: v === f.method }, l)))
        : null;
    const inputs = stream ? methodInputs(f, i)
        : h("input", { class: "fset2", dataset: { i, k: "path" }, value: f.path ?? "", placeholder: "a.b.c  /  Section.Key  /  root/child" });
    const types = ["text", "number"].map((t) => h("option", { selected: t === f.type }, t));
    return h("div", { class: "src-f", dataset: { i } },
        h("input", { class: "fset2 src-fid", dataset: { i, k: "id" }, value: f.id || "", placeholder: "column", title: "output column id" }),
        methodSel, inputs,
        h("select", { class: "fset2 src-ftype", dataset: { i, k: "type" }, title: "value type" }, types),
        h("button", { class: "src-rmf danger", dataset: { i }, title: "remove" }, TRASH()));
}

export function sourceParts(s) {
    const stream = isStream(s);
    const fmtOpts = FORMATS.map(([v, l]) => h("option", { value: v, selected: v === s.format }, l));

    const watchOpts = [
        h("option", { value: "manual", selected: s.watch === "manual" }, "manual"),
        h("option", { value: "on_change", selected: s.watch === "on_change" }, "on file change"),
    ];
    const throttle = s.watch === "on_change"
        ? frag(labCell("throttle", "seconds to wait after the file stops changing — guarantees the latest content is read"),
            h("span", { class: "src-secs" },
                h("input", { class: "src-throttle", type: "number", min: "0", step: "0.5", value: s.throttle_s ?? 1 }), " s"))
        : null;
    const tail = stream
        ? frag(labCell("tail", "read only newly appended lines (off = re-read the whole file each time)"),
            h("label", { class: "src-chk" }, h("input", { type: "checkbox", class: "src-tail", checked: s.tail !== false })))
        : null;

    const matchBlock = stream
        ? frag(labCell("match lines", "keep only lines matching ALL of these (no clauses = every line)", true),
            h("div", { class: "src-matches" },
                (s.match || []).map(matchRow),
                h("button", { class: "src-addm" }, "+ match")))
        : null;
    const fields = frag(
        labCell("fields", `columns pulled from each ${stream ? "matched line" : "file"}`, true),
        h("div", { class: "src-fields" },
            (s.fields || []).map((f, i) => fieldRow(f, i, stream)),
            h("button", { class: "src-addf" }, "+ field")));

    const body = frag(
        h("div", { class: "lab-grid" },
            labCell("format", "how the file is parsed"),
            h("select", { class: "src-format" }, fmtOpts),
            labCell("filename", "filename to auto-find — a glob, e.g. EE.log or *.cfg"),
            h("input", { class: "src-filename", value: s.filename || "", placeholder: "EE.log" }),
            labCell("path", "explicit file path (overrides auto-find)"),
            h("div", { class: "src-pathrow" },
                h("input", { class: "src-path", value: s.path || "", placeholder: "(auto-find by filename)" }),
                h("button", { class: "src-find", title: "search common game/config locations for the filename" }, "⌕ auto-find")),
            labCell("read", "when to read: a manual button, or whenever the file changes"),
            h("select", { class: "src-watch" }, watchOpts),
            throttle, tail, matchBlock, fields),
        h("div", { class: "src-found muted" }),
        h("div", { class: "src-prev-info muted" }),
        h("div", { class: "src-preview" }),
        h("div", { class: "gn-foot" },
            h("button", { class: "src-read", title: "read the file now and write rows to the dataset (click again to cancel)" }, "read now"),
            h("button", { class: "src-prevbtn", title: "preview what the current rules produce (without writing)" }, "preview"),
            h("span", { class: "src-prog muted" })));

    return {
        title: h("input", { class: "gi gi-id srcrename", value: s.id, title: "rename source" }),
        body,
        ports: h("span", { class: "port out", title: "drag to a dataset to write parsed rows there" }),
    };
}
