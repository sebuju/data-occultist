// File-source node: locate a game log/config file, parse it (no regex — declarative rules),
// and push parsed rows into its output dataset (wired source -> dataset, like a price node).
// Reading is driven by the node's own watch (manual / on file-change) and by trigger nodes that
// target it. Rendering only — every input is wired in main.js (wireSource). A live preview of
// what the current rules produce is fetched there too.
import { h, frag, TRASH, labCell, kv, subhead, gspan, trashBtn } from "../dom.js";
import { slideToggle } from "./node_parts.js";   // shared gn-slide switch (rule 7: one toggle primitive)

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
    const ops = OPS.map(([v, l]) => h("option", { value: v, selected: v === m.op }, v === m.op ? `<${l}>` : l));
    return h("div", { class: "src-m", dataset: { i } },
        h("select", { class: "mset", dataset: { i, k: "op" } }, ops),
        h("input", { class: "mset", dataset: { i, k: "text" }, value: m.text || "", placeholder: "text" }),
        h("label", { class: "src-cs", title: "case sensitive" },
            h("input", { type: "checkbox", class: "mset", dataset: { i, k: "case_sensitive" }, checked: !!m.case_sensitive }), "Aa"),
        trashBtn({ cls: "src-rmm", dataset: { i }, title: "remove" }));
}

// The two method-specific input cells for one extraction field. ALWAYS exactly two cells (empty
// placeholders for `whole`) so every row contributes the same column count to the shared grid and
// the inputs line up across rows. The `between` arrow is dropped — the start/end placeholders read
// clearly and a stray glyph would break a grid column.
// a value made only of whitespace renders as an empty-looking box — flag it so a literal-space
// delimiter is distinguishable from "blank = whitespace" (the default).
const isWhitespace = (s) => typeof s === "string" && s.length > 0 && s.trim() === "";

function methodInputs(f, i) {
    const inp = (k, ph) => h("input", { class: "fset2", dataset: { i, k }, value: f[k] ?? "", placeholder: ph });
    if (f.method === "after") return [inp("anchor", "after this text"), inp("stop", "stop at (optional)")];
    if (f.method === "between") return [inp("anchor", "start"), inp("end", "end")];
    if (f.method === "column") {
        // delimiter wrapped with a ␣ flag shown when the value is whitespace-only (so a typed space
        // doesn't look like an empty field). wireSource toggles `.has-ws` live as the user types.
        const delim = h("input", { class: "fset2 src-delim", dataset: { i, k: "delim" }, value: f.delim ?? "", placeholder: "blank = whitespace" });
        const wrap = h("span", { class: `src-delim-wrap${isWhitespace(f.delim) ? " has-ws" : ""}` },
            delim, h("span", { class: "src-ws-flag", title: "value is whitespace" }, "␣"));
        return [wrap, h("input", { class: "fset2 src-fnum", dataset: { i, k: "index" }, type: "number", step: "1", value: Number(f.index) || 0, title: "token index (negative = from end)" })];
    }
    return [h("span", { class: "src-fcell" }), h("span", { class: "src-fcell" })];   // whole: keep the 2 slots empty
}

// one extraction-field row: id + method + two method-input cells + type + remove. The row is
// `display:contents` (see CSS) so these become cells of the ONE `.src-fields` grid; every row emits
// the SAME cells so columns align. Document formats have no method: the path input spans the
// method+input columns instead (class `src-fpath`).
function fieldRow(f, i, stream) {
    const idCell = h("input", { class: "fset2 src-fid", dataset: { i, k: "id" }, value: f.id || "", placeholder: "column", title: "output column id" });
    const types = ["text", "number"].map((t) => h("option", { selected: t === f.type }, t === f.type ? `<${t}>` : t));
    const typeCell = h("select", { class: "fset2 src-ftype", dataset: { i, k: "type" }, title: "value type" }, types);
    // required toggle (default on): when on, this field MUST yield a valid value or the whole row is
    // dropped (and shown in the dismissed-rows preview). No label — the shared gn-slide switch.
    const req = slideToggle({ on: f.required !== false, cls: "src-req",
        title: "required — drop the row if this field has no valid value (number: a clean number; text: non-empty)" });
    req.dataset.i = i;   // which field this toggle drives (wireSource reads it)
    const rm = trashBtn({ cls: "src-rmf", dataset: { i }, title: "remove" });
    // line 1 (`.src-frow`, nowrap) always holds required + id + method + type + remove together; the
    // method inputs sit on their own full-width line below (`.src-finputs`) so they stay roomy.
    // document rows have no method: required + id + type + remove on line 1, path full-width below.
    if (stream) {
        const methodSel = h("select", { class: "fset2 src-fmethod", dataset: { i, k: "method" } },
            METHODS.map(([v, l]) => h("option", { value: v, selected: v === f.method }, v === f.method ? `<${l}>` : l)));
        const inputs = h("div", { class: "src-finputs" }, ...methodInputs(f, i));
        return h("div", { class: "src-f", dataset: { i } },
            h("div", { class: "src-frow" }, req, idCell, methodSel, typeCell, rm), inputs);
    }
    const path = h("input", { class: "fset2 src-fpath", dataset: { i, k: "path" }, value: f.path ?? "", placeholder: "a.b.c  /  Section.Key  /  root/child" });
    return h("div", { class: "src-f", dataset: { i } },
        h("div", { class: "src-frow" }, req, idCell, typeCell, rm), path);
}

export function sourceParts(s) {
    const stream = isStream(s);
    const fmtOpts = FORMATS.map(([v, l]) => h("option", { value: v, selected: v === s.format }, v === s.format ? `<${l}>` : l));

    const watchOpts = [
        h("option", { value: "manual", selected: s.watch === "manual" }, s.watch === "manual" ? "<manual>" : "manual"),
        h("option", { value: "on_change", selected: s.watch === "on_change" }, s.watch === "on_change" ? "<on file change>" : "on file change"),
    ];
    const throttle = s.watch === "on_change"
        ? frag(labCell("throttle", "seconds to wait after the file stops changing — guarantees the latest content is read"),
            h("span", { class: "src-secs" },
                h("input", { class: "src-throttle", type: "number", min: "0", step: "0.5", value: s.throttle_s ?? 1 }), " s"))
        : null;
    const tailOn = s.tail !== false;
    const tail = stream
        ? frag(labCell("tail", "read only the last N lines from the end of the file (off = read the whole file each time)"),
            h("div", { class: "src-tailrow" },
                slideToggle({ on: tailOn, cls: "src-tail", title: "read only the last N lines from the end of the file" }),
                tailOn ? h("input", { type: "number", min: "1", step: "1", class: "src-taillines",
                    value: s.tail_lines ?? 200, title: "how many lines from the end of the file to read" }) : null))
        : null;
    const linePos = stream
        ? frag(labCell("line position", "feed each row's source line number as its dataset position (rows order by file position) — stays tailing; the absolute line is tracked"),
            slideToggle({ on: !!s.line_position, cls: "src-linepos", title: "feed each row's source line number as its dataset position" }))
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
            h("div", { class: "src-faddrow" },
                h("button", { class: "src-addf" }, "+ field"),
                h("button", { class: "src-resolve", title: "inspect the file and propose extraction columns from its data" }, "auto-resolve"))));

    const body = frag(
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
        throttle, tail, linePos, matchBlock, fields,
        h("div", { class: "src-found muted" }));

    return {
        title: h("input", { class: "gi gi-id srcrename", value: s.id, title: "rename source" }),
        body,
        foot: h("button", { class: "src-read", title: "read the file now and write rows to the dataset (runs in the background; rows fill in live)" }, "↻ read"),
        ports: h("span", { class: "port out", title: "drag to a dataset to write parsed rows there" }),
    };
}
