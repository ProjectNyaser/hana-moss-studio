// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/pack.mjs — 出安装包（ZIP）与市场投稿条目（.entry.json）。
 *
 * ## 为什么不调官方打包器
 *
 * 官方那套认的是「extension」这一个通用大类的规则，对这个 App 有两个具体不合用的地方：
 * 它按自己的目录约定收文件（而该进包的只有 app/ 下的东西），失败信息也是通用的。
 * 包内容该由「这个 App 需要什么」来说。所以这里自己做，每件都带本 App 的断言。
 *
 * ## 条目是对产物的派生
 *
 * 产物是产物，市场是市场。ZIP 先出，条目再对 ZIP 现算字节数与 sha256 —— 事实只能从包本身
 * 得到，不经任何中间小票，也就不存在「小票与包对不上」这条失败路径。
 * 条目结构照 DSHana 的 market-entry 约定：archive.url 保留 `{{BASE_URL}}/` 占位符（市场
 * 同步器按这个前缀取资产名），写成绝对地址会被判成非法条目。
 *
 * ## 可复现
 *
 * ZIP 内每个条目的时间戳与权限固定，同输入连打两次 SHA256 相同。
 *
 * 用法：
 *   node scripts/pack.mjs
 *
 * 产物：
 *   build/<id>/                              安装目录（本地安装用）
 *   dist-extensions/<id>-v<version>.zip      安装包
 *   dist-extensions/app-<id>-<version>.entry.json  市场投稿条目
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCE = path.join(ROOT, "app");
const BUILD = path.join(ROOT, "build");
const OUT_DIR = path.join(ROOT, "dist-extensions");

const KIND = "app";
/** ZIP 内固定时间戳（1980-01-01 00:00），让产物可复现。 */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (1 << 5) | 1;

/** 打进包里的东西：app/ 下的全部内容，排掉开发件。app/node_modules 是派生出来的运行时依赖，要带走。 */
const SKIP = new Set([".DS_Store", "Thumbs.db", ".git"]);

const log = (...a) => console.log("[pack]", ...a);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const fatal = (m) => {
  console.error("[pack] " + m);
  process.exit(1);
};

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 最小 ZIP 写入器（deflate + 固定时间戳）。不引第三方库，本 App 零运行时依赖。 */
function writeZip(entries, outPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = fs.readFileSync(entry.abs);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o644 << 16, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));
}

function collect(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    const name2 = prefix ? prefix + "/" + name : name;
    if (fs.statSync(abs).isDirectory()) out.push(...collect(abs, name2));
    else out.push({ name: name2, abs });
  }
  return out;
}

function iconDataUri(iconRel) {
  const abs = path.join(SOURCE, iconRel);
  if (!fs.existsSync(abs)) fatal("manifest.icon 指向的文件不存在：" + iconRel);
  const mime = abs.toLowerCase().endsWith(".svg") ? "image/svg+xml" : abs.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
}

function main() {
  const manifestPath = path.join(SOURCE, "manifest.json");
  if (!fs.existsSync(manifestPath)) fatal("app/manifest.json 不存在");
  // 入口 import 的是 App 内的 SDK 副本（app/sdk），它不在库里，由 pnpm run derive 展开。
  if (!fs.existsSync(path.join(SOURCE, "sdk", "app-contract", "server-client.js"))) {
    fatal("app/sdk 缺 SDK 副本（入口靠它取 defineApp），先跑 pnpm run derive");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  if (pkg.version && pkg.version !== manifest.version) {
    fatal("package.json 的 version（" + pkg.version + "）与 manifest（" + manifest.version + "）不一致");
  }

  // 1) 安装目录：只放 App 自己的文件，submodule 与脚本留在仓库里。
  fs.rmSync(BUILD, { recursive: true, force: true });
  const stageDir = path.join(BUILD, manifest.id);
  fs.cpSync(SOURCE, stageDir, { recursive: true });

  for (const banned of ["vendor", ".git", "build"]) {
    if (fs.existsSync(path.join(stageDir, banned))) fatal("安装目录里混进了不该发布的目录：" + banned);
  }
  // node_modules 里只允许放派生出来的运行时依赖（见 derive.mjs 的 RUNTIME_DEPS），
  // 整个依赖树被拷进来通常是误操作。
  const stagedDeps = path.join(stageDir, "node_modules");
  if (fs.existsSync(stagedDeps)) {
    const allowed = new Set(["pngjs"]);
    for (const name of fs.readdirSync(stagedDeps)) {
      if (!allowed.has(name)) fatal(`app/node_modules 里出现了未派生的依赖：${name}`);
    }
  }

  // 2) 声明的入口与图标必须在包里真的存在，否则装上去就是坏的。
  const entries = collect(stageDir).sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(entries.map((e) => e.name));
  for (const key of ["entry", "icon"]) {
    const value = manifest[key];
    if (typeof value !== "string" || !value) fatal("manifest." + key + " 未声明");
    if (!names.has(value)) fatal("manifest." + key + " 指向的文件不在包里：" + value);
  }
  for (const card of manifest.contributes?.cards || []) {
    // face.image 相对 ui/ 解析（宿主校验器按这个口径读）。
    if (card.face?.image && !names.has("ui/" + card.face.image)) fatal("卡片 " + card.id + " 的 face 图不在包里：ui/" + card.face.image);
  }

  // 3) ZIP
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipName = `${manifest.id}-v${manifest.version}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  writeZip(entries, zipPath);

  const bytes = fs.readFileSync(zipPath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  // 4) 市场条目：对包现算事实。
  const entry = {
    kind: KIND,
    id: manifest.id,
    name: manifest.name || manifest.id,
    publisher: pkg.publisher || pkg.author || manifest.id,
    description: typeof manifest.description === "string" ? manifest.description : "",
    version: manifest.version,
    permissions: (Array.isArray(manifest.capabilities) ? manifest.capabilities : []).map((capability) => ({ capability })),
    ...(manifest.minAppVersion ? { compatibility: { minAppVersion: manifest.minAppVersion } } : {}),
    icon: iconDataUri(manifest.icon),
    archive: { url: `{{BASE_URL}}/${zipName}`, sha256, size: bytes.length, format: "zip" },
  };
  const entryName = `${KIND}-${manifest.id}-${manifest.version}.entry.json`;
  const entryPath = path.join(OUT_DIR, entryName);
  fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n", "utf8");

  log(`${manifest.name}（${manifest.id}）v${manifest.version}`);
  log(`安装目录：${rel(stageDir)}（${entries.length} 个文件）`);
  log(`安装包：  ${rel(zipPath)}  ${(bytes.length / 1024).toFixed(1)} KB`);
  log(`投稿条目：${rel(entryPath)}`);
  log(`sha256（approvals.json 用）：${sha256}`);
}

main();
