import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 app/ 打成可安装目录 build/<id>/。根目录留给 submodule 与脚本，
 * 安装包里只有苔室自己的文件，不含上游源码。
 *
 * app/sdk 是 scripts/derive.mjs 从依赖树展开的 SDK 副本（不入库）。缺它装上去就起不来，
 * 所以在复制之前先确认它在。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const source = join(repoRoot, "app");

if (!existsSync(join(source, "manifest.json"))) {
  console.error("package: app/manifest.json 不存在，先检查 app/ 目录");
  process.exit(1);
}
if (!existsSync(join(source, "sdk", "app-contract", "server-client.js"))) {
  console.error("package: app/sdk 缺 SDK 副本（index.js 靠它取 defineApp），先跑 pnpm run derive");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const out = join(repoRoot, "build", manifest.id);

rmSync(join(repoRoot, "build"), { recursive: true, force: true });
cpSync(source, out, { recursive: true });

// 页面靠这个文件判定「装的是不是新构建」：变了就自己刷一次，
// 不用用户手动找刷新按钮——iframe 里的旧 DOM 不会自己长出新代码。
writeFileSync(join(out, "ui", "build.json"), JSON.stringify({ stamp: Date.now() }, null, 0));

console.log(`打包完成：${out}`);
console.log(`${manifest.name}（${manifest.id}）v${manifest.version}`);
