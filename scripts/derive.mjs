// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/derive.mjs — 从依赖树里的 @hana/app-sdk 派生 App 目录内需要的那几份 SDK 副本。
 *
 * ## 为什么要有这一步
 *
 * App 装上去是自包含的：宿主只认 App 目录里的相对 import，不会替它解析 node_modules。
 * 所以 SDK 运行时必须以 App 自己的文件形态躺在包里。但那份副本不该是签入仓库的源码——
 * 它是对 vendor/hana-app-sdk 里 tgz 的派生，签入等于把「哪来的、哪个版本」全部丢失。
 * 这里按依赖树里的真身重新展开，谁都能从零复现。
 *
 * ## 派生的三样
 *
 *   1. app/sdk/**            = node_modules/@hana/app-sdk/dist/**
 *   2. app/ui/assets/ 里的五个浏览器侧文件（见 UI_COPIES）
 *   3. app/manifest.json 的 minAppVersion = 快照的 packedVersion
 *
 * 第 3 项与 SDK 快照同源：能推导却手抄，就是忘抬的那一类漂移。装到低版本宿主上
 * 表现为「API 悄悄不生效」，而不是装不上，所以让它机器派生。
 *
 * ## 版本一致性
 *
 * 依赖树的 version 与 vendor 里 source-manifest.json 的 packedVersion 必须相等。
 * 不等说明 pnpm 没重解析 tgz（它按 specifier 路径判有效性，不读文件内容），
 * 此时展开出来的会是旧版 SDK，脚本直接拒绝。
 *
 * 用法：
 *   pnpm run derive            # 写盘
 *   pnpm run derive:check      # 只校验，有漂移 exit 1
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIST = path.join(ROOT, "node_modules", "@hana", "app-sdk", "dist");
const SDK_PKG = path.join(ROOT, "node_modules", "@hana", "app-sdk", "package.json");
const VENDOR_MANIFEST = path.join(ROOT, "vendor", "hana-app-sdk", "source-manifest.json");
const APP_SDK = path.join(ROOT, "app", "sdk");
const UI_ASSETS = path.join(ROOT, "app", "ui", "assets");
const MANIFEST = path.join(ROOT, "app", "manifest.json");

/** 浏览器侧那几份：App 目录里的副本名 ← 包内的出处。 */
const UI_COPIES = [
  ["sdk.js", "ui.js"],
  ["app-ui.js", "app-ui.js"],
  ["app-ui.css", "app-ui.css"],
  ["app-ui.js.LEGAL.txt", "app-ui.js.LEGAL.txt"],
  ["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
];

const checkOnly = process.argv.includes("--check");
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const fatal = (m) => {
  console.error("[derive] " + m);
  process.exit(1);
};

/** 递归列出目录下全部文件（相对路径，正斜杠）。 */
function walk(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const name2 = prefix ? prefix + "/" + name : name;
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, name2));
    else out.push(name2);
  }
  return out;
}

function readVersion() {
  if (!fs.existsSync(SDK_PKG)) fatal(`依赖树里没有 @hana/app-sdk（${rel(SDK_PKG)}）。先 pnpm install`);
  if (!fs.existsSync(SDK_DIST)) fatal(`@hana/app-sdk 没有 dist（${rel(SDK_DIST)}）。装到的包不完整，重装`);
  const installed = JSON.parse(fs.readFileSync(SDK_PKG, "utf8")).version;
  if (!fs.existsSync(VENDOR_MANIFEST)) fatal(`缺 ${rel(VENDOR_MANIFEST)}。先 pnpm run sync:sdk`);
  const packed = JSON.parse(fs.readFileSync(VENDOR_MANIFEST, "utf8")).packedVersion;
  if (!packed) fatal(`${rel(VENDOR_MANIFEST)} 的 packedVersion 读不出`);
  if (installed !== packed) {
    fatal(
      `依赖树里的 SDK 是 ${installed}，vendor 快照是 ${packed}。` +
        `\n  锁文件停在旧 tgz，按包名重解析：pnpm update @hana/app-sdk && pnpm install`,
    );
  }
  return packed;
}

/** 把 dist 镜像到 app/sdk：先清空，免得旧版本的文件留下来混进安装包。 */
function mirrorSdk(changes) {
  const wanted = walk(SDK_DIST);
  if (fs.existsSync(APP_SDK)) {
    for (const name of walk(APP_SDK)) {
      if (!wanted.includes(name)) changes.push(`app/sdk/${name}（多余，删）`);
    }
  }
  for (const name of wanted) {
    const from = path.join(SDK_DIST, name);
    const to = path.join(APP_SDK, name);
    if (fs.existsSync(to) && sha256(to) === sha256(from)) continue;
    changes.push(`app/sdk/${name}`);
    if (checkOnly) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  if (checkOnly) return;

  const keep = new Set(wanted);
  for (const name of walk(APP_SDK)) {
    if (!keep.has(name)) fs.rmSync(path.join(APP_SDK, name));
  }
}

function copyUi(changes) {
  for (const [as, from] of UI_COPIES) {
    const src = path.join(SDK_DIST, from);
    const to = path.join(UI_ASSETS, as);
    if (!fs.existsSync(src)) fatal(`@hana/app-sdk/dist 里没有 ${from}，SDK 的导出结构变了`);
    if (fs.existsSync(to) && sha256(to) === sha256(src)) continue;
    changes.push(`app/ui/assets/${as}`);
    if (checkOnly) continue;
    fs.copyFileSync(src, to);
  }
}

function deriveMinAppVersion(version, changes) {
  const raw = fs.readFileSync(MANIFEST, "utf8");
  const manifest = JSON.parse(raw);
  if (manifest.minAppVersion === version) return;
  changes.push(`app/manifest.json  minAppVersion ${manifest.minAppVersion ?? "未声明"} → ${version}`);
  if (checkOnly) return;
  manifest.minAppVersion = version;
  // 原文件就是 2 空格缩进 + 结尾换行，往返不产生格式噪音。
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/**
 * 运行时依赖也以文件形态跟着 App 走：宿主不会替 App 解析 node_modules。
 * keep 决定哪些文件值得带，package.json 与 LICENSE 总会带上。
 */
const RUNTIME_DEPS = [
  { pkg: "fast-png", keep: (name) => name.startsWith("lib/") },
  { pkg: "fflate", via: "fast-png", keep: (name) => /^(lib|esm)\//.test(name) },
  { pkg: "iobuffer", via: "fast-png", keep: (name) => name.startsWith("lib/") },
  {
    pkg: "@jsquash/webp",
    // 只要编码器：解码用不上，simd 版盖了所有能跑这个 App 的 CPU。
    keep: (name) => /^(utils|meta)\.js$/.test(name) || name.startsWith("codec/enc/webp_enc_simd"),
  },
  { pkg: "yauzl", keep: () => true },
  { pkg: "pend", via: "yauzl", keep: (name) => name === "index.js" },
  { pkg: "semver", keep: () => true },
];

/**
 * 找包的真实目录。pnpm 只把直接依赖链到顶层，间接依赖藏在 .pnpm 里，
 * 不能直接用 `node_modules/<名>` 去拼；`via` 指定从哪个包的位置去解析。
 */
function packageDir(name, via) {
  const base = via ? packageDir(via) : null;
  let entry;
  try {
    entry = require.resolve(name, base ? { paths: [base] } : undefined);
  } catch {
    return null;
  }
  let dir = path.dirname(entry);
  for (;;) {
    const pkgFile = path.join(dir, "package.json");
    if (fs.existsSync(pkgFile)) {
      try {
        if (JSON.parse(fs.readFileSync(pkgFile, "utf8")).name === name) return dir;
      } catch {
        /* 继续往上找 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function mirrorDeps(changes) {
  for (const { pkg, via, keep } of RUNTIME_DEPS) {
    const src = packageDir(pkg, via);
    if (!src) fatal(`依赖树里没有 ${pkg}。先 pnpm install`);
    const dst = path.join(ROOT, "app", "node_modules", pkg);
    const wanted = walk(src).filter((name) => {
      // 声明文件与文档运行时不需要，带上只是占体积。
      if (/\.(md|map)$|\.d\.[cm]?ts$/i.test(name)) return false;
      return keep(name) || name === "package.json" || name === "LICENSE";
    });
    const have = fs.existsSync(dst) ? walk(dst) : [];
    for (const name of have) {
      if (wanted.includes(name)) continue;
      changes.push(`app/node_modules/${pkg}/${name}（多余，删）`);
      if (!checkOnly) fs.rmSync(path.join(dst, name), { force: true });
    }
    for (const name of wanted) {
      const from = path.join(src, name);
      const to = path.join(dst, name);
      if (fs.existsSync(to) && sha256(to) === sha256(from)) continue;
      changes.push(`app/node_modules/${pkg}/${name}`);
      if (checkOnly) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

const version = readVersion();
console.log(`[derive] @hana/app-sdk ${version}（${rel(SDK_DIST)}）`);

const changes = [];
mirrorSdk(changes);
copyUi(changes);
mirrorDeps(changes);
deriveMinAppVersion(version, changes);

if (!changes.length) {
  console.log("[derive] 已是最新，没有可写的");
  process.exit(0);
}
if (checkOnly) {
  console.error(`[derive] 漂移 ${changes.length} 项：`);
  for (const c of changes.slice(0, 20)) console.error("  - " + c);
  if (changes.length > 20) console.error(`  …另有 ${changes.length - 20} 项`);
  console.error("[derive] 跑 pnpm run derive 写回");
  process.exit(1);
}
console.log(`[derive] 写回 ${changes.length} 项`);
for (const c of changes.slice(0, 10)) console.log("  - " + c);
if (changes.length > 10) console.log(`  …另有 ${changes.length - 10} 项`);
