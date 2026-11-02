// 扫「赋值给从未声明的标识符」。
// 严格模式（<script type="module">）下这会抛 ReferenceError，而 node --check
// 只查语法，查不出来。之前 pinnedMP / pinnedRatio 的声明被误删，三个滑块里
// 有两个当场失效，就是这类问题。
import fs from "node:fs";

const targets = process.argv.slice(2);
const GLOBALS = new Set([
  "window", "document", "console", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "fetch",
  "EventSource", "BroadcastChannel", "localStorage", "location", "navigator",
  "globalThis", "undefined", "NaN", "Infinity", "JSON", "Math", "Number",
  "String", "Array", "Object", "Map", "Set", "Promise", "Date", "URL",
  "URLSearchParams", "parseInt", "parseFloat", "isNaN", "alert", "structuredClone",
  "self", "queueMicrotask", "customElements", "HTMLElement", "Element", "Node",
  "FileReader", "Blob", "Image", "AbortController", "TextDecoder", "TextEncoder",
]);

/** 把注释与字符串抹成空白，保留换行。模板字符串保留 ${...} 里的表达式。 */
function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  const pad = (ch) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += pad(src[i]);
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += " ";
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += pad(src[i]);
        i += 1;
      }
      out += " ";
      i += 1;
      continue;
    }
    if (ch === "`") {
      out += " ";
      i += 1;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          out += "  ";
          i += 2;
          let depth = 1;
          const start = i;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth += 1;
            else if (src[i] === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
            i += 1;
          }
          // 表达式里可能还有嵌套的模板字符串，递归剥一次。
          out += strip(src.slice(start, i));
          out += " ";
          i += 1;
          continue;
        }
        out += pad(src[i]);
        i += 1;
      }
      out += " ";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

let problems = 0;

for (const file of targets) {
  const src = strip(fs.readFileSync(file, "utf8"));
  const declared = new Set();

  for (const m of src.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[=\s{[]/)[0];
      if (name) declared.add(name);
    }
  }
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[=\s{[]/)[0];
      if (name) declared.add(name);
    }
  }
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+\[?([^\]=\n]+)\]?\s+of\b/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim();
      if (name) declared.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/g)) {
    if (m[2]) declared.add(m[2]);
    if (m[1]) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) declared.add(name);
      }
    }
  }
  // catch (e)
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

  for (const m of src.matchAll(/(^|[^\w$.[])([A-Za-z_$][\w$]*)\s*=(?![=>])/gm)) {
    const name = m[2];
    if (declared.has(name) || GLOBALS.has(name)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    console.log(`${file}:${line}  未声明就被赋值: ${name}`);
    problems += 1;
  }
}

console.log(problems ? `\n${problems} 处未声明的赋值` : "未声明赋值检查通过");
process.exit(problems ? 1 : 0);
