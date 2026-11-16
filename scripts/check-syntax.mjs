// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/check-syntax.mjs — 用 node 自己的解析器过一遍前端脚本。
 *
 * 重复声明、非法的顶层语句这类早期错误，页面只会给出白屏或一句
 * 「应用加载失败」，运行时的自检抓不到，所以在这里先解析一次。
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const lib = readdirSync("app/lib")
  .filter((name) => name.endsWith(".js"))
  .map((name) => `app/lib/${name}`);
const ui = ["panel", "studio", "live", "task", "theme", "theme-boot"].map((name) => `app/ui/assets/${name}.js`);
const files = ["app/index.js", ...lib, ...ui];

let bad = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    const text = String(error.stderr ?? error);
    console.log(`${file}: ${text.split("\n").find((line) => line.includes("Error")) ?? text.split("\n")[0]}`);
    bad += 1;
  }
}

if (bad) {
  console.log(`语法检查失败：${bad} 个文件`);
  process.exit(1);
}
console.log("语法检查通过");
