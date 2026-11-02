// 扫「JS 里取的 DOM id 在 HTML 里不存在」。
//
// 删掉一个元素时很容易漏掉 JS 里的 nodes.xxx，运行时才炸成
//   Cannot set properties of undefined (setting 'textContent')
// check-ident 只查未声明的标识符，属性访问它看不见，所以单列一条。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const htmlFiles = ["app/ui/studio.html", "app/ui/panel.html"];
const jsFiles = ["app/ui/assets/studio.js", "app/ui/assets/panel.js", "app/ui/assets/task.js", "app/ui/assets/live.js"];

const ids = new Set();
for (const file of htmlFiles) {
  const file2 = path.join(root, file);
  if (!fs.existsSync(file2)) continue;
  for (const match of fs.readFileSync(file2, "utf8").matchAll(/id="([^"]+)"/g)) ids.add(match[1]);
}

let problems = 0;
for (const file of jsFiles) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, "utf8");
  const lines = src.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\bel\(\s*["']([^"']+)["']\s*\)/g)) {
      const id = match[1];
      if (ids.has(id)) continue;
      problems += 1;
      console.log(`${file}:${index + 1}: el("${id}") 在 HTML 里找不到对应元素`);
    }
  });
}

console.log(problems ? `\n共 ${problems} 处` : "DOM id 检查通过");
process.exit(problems ? 1 : 0);
