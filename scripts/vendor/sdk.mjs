// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/vendor/sdk.mjs — 把本机宿主的 App SDK 快照同步进 vendor/hana-app-sdk。
 *
 * 快照是「宿主打包产出」在仓库里的一份副本：tgz 是 package.json 里 `file:` 依赖的真身，
 * source-manifest.json 的 packedVersion 是 manifest#minAppVersion 的来源（见 scripts/derive）。
 * 宿主升级后这份副本会漂，人肉拷贝既容易漏，也说不清同步到了哪个宿主版本。
 *
 * 只要 @hana/app-sdk 一个包：苔室服务端只用 defineApp（包内 `./server` 入口），
 * 浏览器侧只用 ui bundle（`./ui`）。plugin-sdk / plugin-protocol / plugin-components
 * 是给"借用宿主组件库"的 App 用的，本 App 没引，就不搬。
 *
 * 源的位置（按序探测，第一个命中的赢）：
 *   1. --source <dir>
 *   2. <HANA_HOME>/artifacts/server/<最新版本>/skills2set/hana-app-creator/assets/sdk（随宿主版本分发，权威）
 *   3. <HANA_HOME>/skills/hana-app-creator/assets/sdk（已安装 skill 的资产，兜底）
 *
 * 只写真变了的文件（按整文件 sha256 比对）；--check 只报漂移并 exit 1。源是本机宿主，
 * CI 上没有，所以 CI 门禁不含本脚本。
 *
 * 同步后 SDK 内容变了，两处要跟着走：
 *   · 依赖树与锁文件：pnpm update @hana/app-sdk，再 pnpm install
 *     （pnpm 按 specifier 路径判锁文件有效性，tgz 换了内容不会自己重解析）
 *   · 派生文件：pnpm run derive（app/sdk 展开、ui bundle 副本、manifest#minAppVersion）
 *
 * 用法：
 *   pnpm run sync:sdk
 *   node scripts/vendor/sdk.mjs --check
 *   node scripts/vendor/sdk.mjs --source <dir>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEST = path.join(ROOT, "vendor", "hana-app-sdk");
const HANA_HOME =
  process.env.HANA_HOME ||
  path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".hanako");

/** 快照的全部构成，缺一即半份——宁可报错，不写进去一个残份。 */
const FILES = ["hana-app-sdk.tgz", "source-manifest.json"];

const SKILL_SDK = path.join("skills", "hana-app-creator", "assets", "sdk");
const SERVER_SKILL_SDK = path.join("skills2set", "hana-app-creator", "assets", "sdk");

/** --flag value / --flag=value 两种写法。 */
function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const head = (h) => h.slice(0, 12);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";

/** packedVersion：宿主打包时写入的 SDK 版本。 */
function packedVersion(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "source-manifest.json"), "utf8"));
    return typeof j?.packedVersion === "string" ? j.packedVersion : null;
  } catch {
    return null;
  }
}

/** server 目录名形如 `1.5.48-beta-win32-x64-<hash>`；按语义版本降序。 */
function byVersionDesc(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function findSource() {
  const explicit = arg("--source");
  if (explicit) return path.resolve(explicit);

  const serverRoot = path.join(HANA_HOME, "artifacts", "server");
  if (fs.existsSync(serverRoot)) {
    const newest = fs
      .readdirSync(serverRoot)
      .filter((v) => fs.existsSync(path.join(serverRoot, v, SERVER_SKILL_SDK)))
      .sort(byVersionDesc)[0];
    if (newest) return path.join(serverRoot, newest, SERVER_SKILL_SDK);
  }
  return path.join(HANA_HOME, SKILL_SDK);
}

/** 锁文件里记的 tgz integrity 是否已跟上（pnpm 不会因本地 tarball 变化而自动重算）。 */
function lockBehind() {
  const lock = path.join(ROOT, "pnpm-lock.yaml");
  if (!fs.existsSync(lock)) return false;
  const text = fs.readFileSync(lock, "utf8");
  const want = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(path.join(DEST, "hana-app-sdk.tgz"))).digest("base64");
  return !text.includes(`integrity: ${want}`);
}

function reportFollowUps() {
  if (lockBehind()) {
    console.log("[sync-sdk] 锁文件停在旧 tgz，重解析按包名点名：");
    console.log("  pnpm update @hana/app-sdk && pnpm install");
    return;
  }
  console.log("[sync-sdk] 锁文件 integrity 已匹配；接着跑 pnpm run derive 刷新派生文件");
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const src = findSource();

  const missing = FILES.filter((f) => !fs.existsSync(path.join(src, f)));
  if (missing.length) {
    console.error(`[sync-sdk] 源不完整：${src} 缺 ${missing.join("、")}`);
    console.error("[sync-sdk] 宿主没装在预期位置？用 --source <dir> 指定 App SDK 快照目录。");
    process.exit(2);
  }
  const empty = FILES.filter((f) => fs.statSync(path.join(src, f)).size === 0);
  if (empty.length) {
    console.error(`[sync-sdk] 源文件为空：${empty.join("、")}（在 ${src}）`);
    process.exit(2);
  }

  const srcVersion = packedVersion(src);
  if (!srcVersion) {
    console.error(`[sync-sdk] 源 manifest 无效：${src} 的 packedVersion 读不出（字段缺失或 JSON 损坏）`);
    process.exit(2);
  }
  const destVersion = packedVersion(DEST);
  console.log(`[sync-sdk] 源 ${rel(src)}（packedVersion ${srcVersion}）`);
  console.log(`[sync-sdk] 目标 ${rel(DEST)}（packedVersion ${destVersion ?? "缺"}）`);

  const changed = [];
  for (const name of FILES) {
    const from = path.join(src, name);
    const to = path.join(DEST, name);
    if (fs.existsSync(to) && sha256(to) === sha256(from)) continue;
    changed.push(name);
    if (checkOnly) {
      console.log(`  - ${name}  ${fs.existsSync(to) ? head(sha256(to)) : "（缺）"} → ${head(sha256(from))}`);
      continue;
    }
    fs.mkdirSync(DEST, { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`[sync-sdk] 写回 ${name}（${fs.statSync(from).size} B）`);
  }

  if (checkOnly) {
    if (changed.length) {
      console.error(`[sync-sdk] 漂移 ${changed.length} 个文件——跑 node scripts/vendor/sdk.mjs 写回后提交`);
      process.exit(1);
    }
    console.log("[sync-sdk] 与宿主一致");
    return;
  }

  if (!changed.length) {
    console.log(`[sync-sdk] 无需同步（已是 packedVersion ${destVersion ?? "缺"}）`);
    reportFollowUps();
    return;
  }
  console.log(`[sync-sdk] 已同步 ${changed.length} 个文件：${changed.join("、")}`);
  if (destVersion && destVersion !== srcVersion) {
    console.log(`[sync-sdk] 版本 ${destVersion} → ${srcVersion}：minAppVersion 与 ui bundle 都会跟着抬，装之前先跑一遍界面`);
  }
  reportFollowUps();
}

main();
