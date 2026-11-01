import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 app/ 打成可安装目录 dist/。根目录留给 submodule 与脚本，
 * 安装包里只有苔室自己的文件，不含上游源码。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const source = join(repoRoot, "app");

if (!existsSync(join(source, "manifest.json"))) {
  console.error("package: app/manifest.json 不存在，先检查 app/ 目录");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const out = join(repoRoot, "build", manifest.id);

rmSync(join(repoRoot, "build"), { recursive: true, force: true });
cpSync(source, out, { recursive: true });

console.log(`打包完成：${out}`);
console.log(`${manifest.name}（${manifest.id}）v${manifest.version}`);
