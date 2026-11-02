// 扫「调用了从未声明、也从未导入的名字」。
//
// node --check 只查语法；漏写 import 的 readFileSync 要到真跑那一行才炸，
// 而且外面包着 try 时会被 catch 静默吞掉，看上去一切正常。setInterval、
// 拼错的名字都属于这一类。
//
// 不是解析器，是词法近似：先抹掉注释与字符串，收齐所有声明位置出现的名字
// （导入、const/let/var、函数名、参数、解构、catch、方法定义），剩下的
// `名字(` 里凡是不在白名单的就报出来。
import fs from "node:fs";
import path from "node:path";

const GLOBALS = new Set([
  "window", "document", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "fetch", "EventSource", "BroadcastChannel",
  "localStorage", "location", "navigator", "globalThis", "undefined", "NaN", "Infinity",
  "JSON", "Math", "Number", "String", "Array", "Object", "Map", "Set", "WeakMap", "WeakSet",
  "WeakRef", "FinalizationRegistry", "Promise", "Date", "URL", "URLSearchParams", "RegExp",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError",
  "AggregateError", "parseInt", "parseFloat", "isNaN", "isFinite", "alert", "structuredClone",
  "self", "queueMicrotask", "customElements", "HTMLElement", "Element", "Node", "FileReader",
  "Blob", "Image", "AbortController", "AbortSignal", "TextDecoder", "TextEncoder", "Uint8Array",
  "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "Float32Array",
  "Float64Array", "ArrayBuffer", "DataView", "BigInt", "Symbol", "Proxy", "Reflect", "Intl", "WebAssembly",
  "Boolean", "Function", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
  "escape", "unescape", "process", "Buffer", "ReadableStream", "TransformStream", "WritableStream",
  "performance", "crypto", "Atomics", "SharedArrayBuffer", "Float16Array",
  "ResizeObserver", "MutationObserver", "IntersectionObserver", "PointerEvent",
  "KeyboardEvent", "MouseEvent", "CustomEvent", "DOMParser", "XMLSerializer",
]);

const KEYWORDS = /^(if|for|while|switch|catch|return|typeof|new|await|in|of|do|else|throw|delete|void|yield|async|function|super|this|case|with|default|try|finally|break|continue|instanceof|new|class|const|let|var)$/;

/** 抹掉注释、字符串与正则字面量，保留换行与位置。 */
function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  const pad = (ch) => (ch === "\n" ? "\n" : " ");
  let prevSignificant = "";
  while (i < n) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += pad(src[i]); i += 1; }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      out += " "; i += 1;
      while (i < n && src[i] !== ch) {
        if (src[i] === "\\") { out += " "; i += 1; }
        if (i < n) { out += pad(src[i]); i += 1; }
      }
      i += 1; out += " "; prevSignificant = '"';
      continue;
    }
    if (ch === "`") {
      out += " "; i += 1;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") { out += " "; i += 1; }
        if (i < n) { out += pad(src[i]); i += 1; }
      }
      i += 1; out += " "; prevSignificant = '"';
      continue;
    }
    // 正则字面量：只在「上一个有效字符不像操作数」时才当正则，避免把除号认成开头
    if (ch === "/" && !/[)\]\w$'"`]/.test(prevSignificant)) {
      let j = i + 1;
      let ok = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "/") { ok = true; break; }
        j += 1;
      }
      if (ok) {
        while (i <= j) { out += " "; i += 1; }
        prevSignificant = '"';
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return out;
}

function collectDeclared(src) {
  const known = new Set();
  const add = (name) => {
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) known.add(name);
  };
  for (const m of src.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    add(m[1]);
    if (m[2]) for (const part of m[2].split(",")) add(part.trim().split(/\s+as\s+/).pop().trim());
  }
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]/g)) {
    for (const part of m[1].split(",")) add(part.trim().split(/[:=]/).pop().trim());
  }
  for (const m of src.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(",")) add(part.trim().split("=")[0].trim());
  }
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) add(part.trim().split("=")[0].trim());
  }
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 方法定义与对象字面量的简写方法：整行就是「名字(参数) {」
  for (const m of src.matchAll(/^[ \t]*(?:async\s+)?(?:get\s+|set\s+|static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/gm)) add(m[1]);
  return known;
}

const targets = process.argv.slice(2);
const files = [];
for (const target of targets) {
  if (fs.statSync(target).isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(target, entry.name));
    }
  } else files.push(target);
}

let problems = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const src = strip(raw);
  const known = collectDeclared(src);
  const rawLines = raw.split(/\r?\n/);
  const seen = new Map();
  for (const line of src.split("\n")) {
    for (const m of line.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (GLOBALS.has(name) || known.has(name) || KEYWORDS.test(name)) continue;
      if (!seen.has(name)) seen.set(name, true);
    }
  }
  if (!seen.size) continue;
  // 报行号时按未抹白的原文找，给出人读得懂的上下文
  for (const name of seen.keys()) {
    const idx = rawLines.findIndex((line) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`).test(line));
    problems += 1;
    console.log(`${file}:${idx + 1}: 未声明也未导入 ${name}  →  ${(rawLines[idx] ?? "").trim().slice(0, 90)}`);
  }
}
console.log(problems ? `\n共 ${problems} 处` : "未声明调用检查通过");
process.exit(problems ? 1 : 0);
