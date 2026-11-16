// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/vendor/shm-bridge.mjs — 编译共享内存桥。
 *
 * 引擎的 component session 走命名共享内存，Node 没有 mmap 入口，所以带一个
 * 只做字节搬运的小程序。源码在 tools/shm-bridge/ShmBridge.cs，产物落到
 * app/vendor-bin/shm-bridge.exe（与 aria2c 一样是 App 自带的外部可执行文件）。
 *
 * 用 .NET Framework 自带的 csc.exe 编译：目标机一定有那份运行时，不额外装 SDK。
 * 找不到 csc 就让构建失败——缺了它，断点续画会静默降级，那比构建报错难查。
 *
 * 用法：
 *   node scripts/vendor/shm-bridge.mjs           # 需要时编译
 *   node scripts/vendor/shm-bridge.mjs --check   # 只校验产物是否最新
 *   node scripts/vendor/shm-bridge.mjs --force   # 强制重编
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(ROOT, "tools", "shm-bridge", "ShmBridge.cs");
const OUT_DIR = path.join(ROOT, "app", "vendor-bin");
const TARGET = path.join(OUT_DIR, "shm-bridge.exe");

const checkOnly = process.argv.includes("--check");
const force = process.argv.includes("--force");

const CANDIDATES = [
  path.join(process.env["WINDIR"] ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(process.env["WINDIR"] ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];

function findCompiler() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

const source = stat(SOURCE);
if (!source) {
  console.error(`[shm-bridge] 找不到源码：${SOURCE}`);
  process.exit(1);
}

const target = stat(TARGET);
const fresh = target && target.mtimeMs >= source.mtimeMs && target.size > 0;

if (checkOnly) {
  if (!fresh) {
    console.error("[shm-bridge] 产物缺失或过期，运行 node scripts/vendor/shm-bridge.mjs 重新编译");
    process.exit(1);
  }
  console.log(`[shm-bridge] ${path.relative(ROOT, TARGET)} 已就位（${target.size} 字节）`);
  process.exit(0);
}

if (fresh && !force) {
  console.log(`[shm-bridge] ${path.relative(ROOT, TARGET)} 已是最新`);
  process.exit(0);
}

if (process.platform !== "win32") {
  console.error("[shm-bridge] 只有 Windows 需要这个桥");
  process.exit(1);
}

const compiler = findCompiler();
if (!compiler) {
  console.error("[shm-bridge] 找不到 csc.exe（.NET Framework 4.x），无法编译共享内存桥");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
try {
  execFileSync(compiler, ["/nologo", "/target:exe", "/optimize+", `/out:${TARGET}`, SOURCE], {
    stdio: "inherit",
  });
} catch (error) {
  console.error(`[shm-bridge] 编译失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const built = stat(TARGET);
if (!built || built.size === 0) {
  console.error("[shm-bridge] 编译没有产出可执行文件");
  process.exit(1);
}
console.log(`[shm-bridge] ${path.relative(ROOT, TARGET)} 已就位（${built.size} 字节）`);
