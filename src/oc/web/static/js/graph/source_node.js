// File-source node: locate a game log/config file, parse it (no regex — declarative rules),
// and push parsed rows into its output dataset (wired source -> dataset, like a price node).
// Reading is driven by the node's own watch (manual / on file-change) and by trigger nodes that
// target it. Rendering only — every input is wired in main.js (wireSource). A live preview of
// what the current rules produce is fetched there too.
import { esc, TRASH, labCell } from "../dom.js";

// formats mirror the registered parsers (oc.source.parsers / registry._PARSER). `log_lines` is the
// only line-streaming one; the rest are whole-document (path lookups).
const FORMATS = [["log_lines", "log lines"], ["ini", "ini / cfg"], ["json", "json"],
    ["xml", "xml"], ["yaml", "yaml"]];
const STREAM = new Set(["log_lines"]);
const OPS = [["contains", "contains"], ["starts_with", "starts with"],
    ["ends_with", "ends with"], ["equals", "equals"]];
const METHODS = [["after", "after"], ["between", "between"], ["column", "column"], ["whole", "whole line"]];

const isStream = (s) => STREAM.has(s.format);
const sel = (v, cur) => (v === cur ? " selected" : "");

// one line-filter (match) row: op + text + case toggle + remove
function matchRow(m, i) {
    const ops = OPS.map(([v, l]) => `<option value="${v}"${sel(v, m.op)}>${l}</option>`).join("");
    return `<div class="src-m" data-i="${i}">
    <select class="mset" data-i="${i}" data-k="op">${ops}</select>
    <input class="mset" data-i="${i}" data-k="text" value="${esc(m.text || "")}" placeholder="text" />
    <label class="src-cs" title="case sensitive"><input type="checkbox" class="mset" data-i="${i}" data-k="case_sensitive"${m.case_sensitive ? " checked" : ""} />Aa</label>
    <button class="src-rmm danger" data-i="${i}" title="remove">${TRASH}</button></div>`;
}

// the method-specific inputs for one extraction field (varies by method)
function methodInputs(f, i) {
    const inp = (k, ph) => `<input class="fset2" data-i="${i}" data-k="${k}" value="${esc(f[k] ?? "")}" placeholder="${ph}" />`;
    if (f.method === "after") return inp("anchor", "after this text") + inp("stop", "stop at (optional)");
    if (f.method === "between") return inp("anchor", "start") + `<span class="src-arrow">→</span>` + inp("end", "end");
    if (f.method === "column") return inp("delim", "delimiter (blank = whitespace)")
        + `<input class="fset2" data-i="${i}" data-k="index" type="number" step="1" value="${Number(f.index) || 0}" title="token index (negative = from end)" />`;
    if (f.method === "path") return inp("path", "a.b.c  /  Section.Key  /  root/child");
    return "";   // whole: no extra inputs
}

// one extraction-field row: id + method (line formats) + method inputs + type + remove
function fieldRow(f, i, stream) {
    // line formats pick a method (after/between/column/whole); document formats are always path.
    const methodSel = stream
        ? `<select class="fset2" data-i="${i}" data-k="method">${METHODS.map(([v, l]) => `<option value="${v}"${sel(v, f.method)}>${l}</option>`).join("")}</select>`
        : "";
    const inputs = stream ? methodInputs(f, i)
        : `<input class="fset2" data-i="${i}" data-k="path" value="${esc(f.path ?? "")}" placeholder="a.b.c  /  Section.Key  /  root/child" />`;
    const types = ["text", "number"].map((t) => `<option${sel(t, f.type)}>${t}</option>`).join("");
    return `<div class="src-f" data-i="${i}">
    <input class="fset2 src-fid" data-i="${i}" data-k="id" value="${esc(f.id || "")}" placeholder="column" title="output column id" />
    ${methodSel}${inputs}
    <select class="fset2 src-ftype" data-i="${i}" data-k="type" title="value type">${types}</select>
    <button class="src-rmf danger" data-i="${i}" title="remove">${TRASH}</button></div>`;
}

export function sourceParts(s) {
    const stream = isStream(s);
    const fmtOpts = FORMATS.map(([v, l]) => `<option value="${v}"${sel(v, s.format)}>${l}</option>`).join("");

    const watchOpts = `<option value="manual"${sel("manual", s.watch)}>manual</option>`
        + `<option value="on_change"${sel("on_change", s.watch)}>on file change</option>`;
    const throttle = s.watch === "on_change"
        ? `${labCell("throttle", "seconds to wait after the file stops changing — guarantees the latest content is read")}<span class="src-secs"><input class="src-throttle" type="number" min="0" step="0.5" value="${s.throttle_s ?? 1}" /> s</span>`
        : "";
    const tail = stream
        ? `${labCell("tail", "read only newly appended lines (off = re-read the whole file each time)")}<label class="src-chk"><input type="checkbox" class="src-tail"${s.tail !== false ? " checked" : ""} /></label>`
        : "";

    const matchBlock = stream
        ? `${labCell("match lines", "keep only lines matching ALL of these (no clauses = every line)", true)}
       <div class="src-matches">${(s.match || []).map(matchRow).join("")}<button class="src-addm">+ match</button></div>`
        : "";
    const fields = `${labCell("fields", `columns pulled from each ${stream ? "matched line" : "file"}`, true)}
     <div class="src-fields">${(s.fields || []).map((f, i) => fieldRow(f, i, stream)).join("")}<button class="src-addf">+ field</button></div>`;

    const body = `<div class="lab-grid">
      ${labCell("format", "how the file is parsed")}<select class="src-format">${fmtOpts}</select>
      ${labCell("filename", "filename to auto-find — a glob, e.g. EE.log or *.cfg")}<input class="src-filename" value="${esc(s.filename || "")}" placeholder="EE.log" />
      ${labCell("path", "explicit file path (overrides auto-find)")}<div class="src-pathrow"><input class="src-path" value="${esc(s.path || "")}" placeholder="(auto-find by filename)" /><button class="src-find" title="search common game/config locations for the filename">⌕ auto-find</button></div>
      ${labCell("read", "when to read: a manual button, or whenever the file changes")}<select class="src-watch">${watchOpts}</select>
      ${throttle}${tail}
      ${matchBlock}${fields}</div>
      <div class="src-found muted"></div>
      <div class="src-prev-info muted"></div>
      <div class="src-preview"></div>
      <div class="gn-foot"><button class="src-read" title="read the file now and write rows to the dataset (click again to cancel)">read now</button>
        <button class="src-prevbtn" title="preview what the current rules produce (without writing)">preview</button>
        <span class="src-prog muted"></span></div>`;

    return {
        title: `<input class="gi gi-id srcrename" value="${esc(s.id)}" title="rename source" />`,
        body,
        ports: `<span class="port out" title="drag to a dataset to write parsed rows there"></span>`,
    };
}
