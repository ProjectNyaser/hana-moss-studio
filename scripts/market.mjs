// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/market.mjs — 把投稿要用到的两段 JSON 拼出来。
 *
 * 市场不接受上传安装包，只接受登记 PR：在 registry.json 追加「这个扩展在哪个仓库」，
 * 在 approvals.json 追加「上架哪个 tag、sha256 是多少」。两个文件都由人工 PR 提交，
 * 所以这里不直接改市场仓，只把该粘的东西按市场要的形状打印出来，避免手抄 sha256。
 *
 * 事实来源只有一个：dist-extensions 里的 entry.json（由 scripts/pack.mjs 对 ZIP 现算）。
 *
 * 用法：
 *   node scripts/market.mjs                      # 打印两段 JSON
 *   node scripts/market.mjs --repository owner/repo
 *   node scripts/market.mjs --write              # 顺带写 dist-extensions/market-submission.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(ROOT, "dist-extensions");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

function remoteSlug() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error("[market] 没有 dist-extensions/：先跑 node scripts/pack.mjs");
    process.exit(1);
  }
  const entryFile = fs.readdirSync(OUT_DIR).find((f) => f.endsWith(".entry.json"));
  if (!entryFile) {
    console.error("[market] dist-extensions/ 里没有 *.entry.json：先跑 node scripts/pack.mjs");
    process.exit(1);
  }

  const entry = JSON.parse(fs.readFileSync(path.join(OUT_DIR, entryFile), "utf8"));
  const repository = arg("--repository") || remoteSlug();
  if (!repository) {
    console.error("[market] 不知道该登记到哪个仓库：设置 origin remote，或传 --repository owner/repo");
    process.exit(1);
  }

  const readmePath = path.join(ROOT, "app", "README.md");
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8").trim() : "";

  const registry = { kind: entry.kind, id: entry.id, repository, publisher: entry.publisher };
  const approval = {
    kind: entry.kind,
    id: entry.id,
    tag: "v" + entry.version,
    sha256: entry.archive.sha256,
    ...(readme ? { readme } : {}),
  };

  const block =
    "```json\n" +
    JSON.stringify(registry, null, 2) +
    "\n```\n\n追加到 `approvals.json` 的 `approvals` 数组：\n\n```json\n" +
    JSON.stringify(approval, null, 2) +
    "\n```\n";

  console.log("[market] 投稿条目 " + entryFile + "（v" + entry.version + "）");
  console.log("\n追加到 registry.json 的 entries 数组：\n" + block);

  if (process.argv.includes("--write")) {
    const out = path.join(OUT_DIR, "market-submission.md");
    const doc = [
      "# 市场投稿材料",
      "",
      "来源：`" + entryFile + "`。`sha256` 由 `scripts/pack.mjs` 对 ZIP 现算，不要手改。",
      "",
      "## 步骤",
      "",
      "1. 把本版本打到 tag `v" + entry.version + "`，推送到 `" + repository + "`。",
      "2. 在仓库发**正式** Release（不能是 draft 或 prerelease），把 `" + path.basename(entry.archive.url) + "` 与 `" + entryFile + "` 一起作为附件上传。",
      "3. 向市场仓提 PR，各追加一条到 `registry.json` 与 `approvals.json`。",
      "",
      "## 片段",
      "",
      block,
    ].join("\n");
    fs.writeFileSync(out, doc, "utf8");
    console.log("[market] 写好了 " + path.relative(ROOT, out).replace(/\\/g, "/"));
  }
}

main();
