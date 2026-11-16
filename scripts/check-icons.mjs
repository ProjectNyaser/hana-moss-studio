// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/check-icons.mjs — 找出「引用了但没定义」的 SVG 图标。
 *
 * 图标用 <symbol id> 定义、<use href="#id"> 引用，缺一个只会渲成空白，
 * 页面不会报错，所以单独查一遍。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pages = ["app/ui/panel.html", "app/ui/studio.html", "app/ui/task.html"];

let missing = 0;
for (const page of pages) {
  const text = readFileSync(join(root, page), "utf8");
  const defined = new Set([...text.matchAll(/<symbol[^>]*id="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set([...text.matchAll(/<use[^>]*href="#([^"]+)"/g)].map((match) => match[1]));
  for (const id of used) {
    if (!defined.has(id)) {
      console.log(`${page}: 引用了未定义的图标 #${id}`);
      missing += 1;
    }
  }
}

if (missing) {
  console.log(`图标检查失败：${missing} 个缺失`);
  process.exit(1);
}
console.log("图标检查通过");
