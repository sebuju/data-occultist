// A small, SAFE expression evaluator for element conditions (visible_when / enabled_when) and
// future styled-when rules. No `eval`/`new Function` on user input — a tokenizer + a
// recursive-descent parser over a fixed operator grammar, with `{{...}}` tokens resolved live
// through a caller-supplied `resolve(inner)`:
//
//   "{{ node:price_nodes[p1].enabled }} && {{ widget:filter }} != ''"
//   "{{ dataset:prices.count }} > 0"
//
// Supported: || && == != < <= > >= + - * / % ! ( ) , numbers, 'strings', true/false/null.
// A bareword (unquoted, not a keyword) is treated as a string literal — forgiving for
// comparisons like `== active`.

const KW = { true: true, false: false, null: null };

function tokenize(src) {
  const toks = [];
  let i = 0;
  const two = ["||", "&&", "==", "!=", "<=", ">="];
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "{" && src[i + 1] === "{") {
      const end = src.indexOf("}}", i + 2);
      const inner = (end < 0 ? src.slice(i + 2) : src.slice(i + 2, end)).trim();
      toks.push({ t: "tok", v: inner });
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) { s += src[j]; j++; }
      toks.push({ t: "lit", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "lit", v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }
    const pair = src.slice(i, i + 2);
    if (two.includes(pair)) { toks.push({ t: "op", v: pair }); i += 2; continue; }
    if ("()!<>+-*/%,".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_.:]/.test(src[j])) j++;
      const word = src.slice(i, j);
      toks.push(word in KW ? { t: "lit", v: KW[word] } : { t: "lit", v: word });
      i = j; continue;
    }
    i++;   // skip anything unrecognised rather than throw
  }
  return toks;
}

const num = (v) => (typeof v === "number" ? v : parseFloat(v));
const bothNum = (a, b) => Number.isFinite(num(a)) && Number.isFinite(num(b));

function compare(op, a, b) {
  if (bothNum(a, b)) { a = num(a); b = num(b); }
  else { a = a == null ? "" : String(a); b = b == null ? "" : String(b); }
  switch (op) {
    case "<": return a < b; case "<=": return a <= b;
    case ">": return a > b; case ">=": return a >= b;
  }
  return false;
}
function eq(a, b) {
  if (bothNum(a, b)) return num(a) === num(b);
  return String(a ?? "") === String(b ?? "");
}

// Parse + evaluate in one pass. `resolve(inner)` -> a value for a {{token}}.
function makeParser(toks, resolve) {
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (t && (v === undefined || t.v === v)) { p++; return t; } return null; };

  function primary() {
    const t = peek();
    if (!t) return null;
    if (t.t === "op" && t.v === "(") { p++; const e = orExpr(); eat(")"); return e; }
    if (t.t === "op" && t.v === "!") { p++; return !truthy(unary()); }
    if (t.t === "op" && t.v === "-") { p++; return -num(unary()); }
    if (t.t === "tok") { p++; return resolve(t.v); }
    if (t.t === "lit") { p++; return t.v; }
    p++; return null;
  }
  function unary() { return primary(); }
  function mul() { let a = unary(); for (let t = peek(); t && t.t === "op" && "*/%".includes(t.v); t = peek()) { p++; const b = unary(); a = t.v === "*" ? num(a) * num(b) : t.v === "/" ? num(a) / num(b) : num(a) % num(b); } return a; }
  function add() { let a = mul(); for (let t = peek(); t && t.t === "op" && (t.v === "+" || t.v === "-"); t = peek()) { p++; const b = mul(); a = t.v === "-" ? num(a) - num(b) : (bothNum(a, b) ? num(a) + num(b) : `${a ?? ""}${b ?? ""}`); } return a; }
  function cmp() { let a = add(); for (let t = peek(); t && t.t === "op" && ["<", "<=", ">", ">="].includes(t.v); t = peek()) { p++; a = compare(t.v, a, add()); } return a; }
  function equality() { let a = cmp(); for (let t = peek(); t && t.t === "op" && (t.v === "==" || t.v === "!="); t = peek()) { p++; const b = cmp(); a = t.v === "==" ? eq(a, b) : !eq(a, b); } return a; }
  function andExpr() { let a = equality(); for (let t = peek(); t && t.v === "&&"; t = peek()) { p++; const b = equality(); a = truthy(a) && truthy(b); } return a; }
  function orExpr() { let a = andExpr(); for (let t = peek(); t && t.v === "||"; t = peek()) { p++; const b = andExpr(); a = truthy(a) || truthy(b); } return a; }
  return orExpr;
}

export function truthy(v) {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

// Evaluate an expression to a raw value. Empty/absent expression -> `dflt`. Never throws —
// a malformed expression resolves to `dflt` so a bad condition can't break the page.
export function evaluate(expr, resolve, dflt = true) {
  const src = (expr || "").trim();
  if (!src) return dflt;
  try {
    const toks = tokenize(src);
    if (!toks.length) return dflt;
    return makeParser(toks, resolve)();
  } catch {
    return dflt;
  }
}

// The inner strings of every {{token}} in a piece of text/expression (for dependency tracking).
export function tokensIn(text) {
  const out = [];
  const re = /\{\{(.+?)\}\}/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1].trim());
  return out;
}
