// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/vendor/aria2.mjs — 把 aria2c.exe 取进 app/vendor-bin/，随包装出去。
 *
 * 为什么随包：App 自己要能下载引擎与 27 GB 权重，而 App 进程里的 sdk.network.fetch
 * 有响应字节上限，大文件只能交给子进程。aria2 的多连接在实测里比单连接快一个数量级，
 * 而且它自带重连，不会在某个字节上静静挂住。
 *
 * 校验锚：aria2 的 Release 没有 SHA256SUMS，GitHub API 的 digest 对这个资产也是 null，
 * 所以第一次取到后把 sha256 记进 vendor/aria2-bin.json，之后每次构建都对照它。
 * 版本与 submodule 指针要一起动。
 *
 * 用法：
 *   node scripts/vendor/aria2.mjs            # 取（缺锚时写锚）
 *   node scripts/vendor/aria2.mjs --check    # 只校验，缺或不合规就 exit 1
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ANCHOR = path.join(ROOT, "vendor", "aria2-bin.json");
const OUT_DIR = path.join(ROOT, "app", "vendor-bin");
const OUT_EXE = path.join(OUT_DIR, "aria2c.exe");

const checkOnly = process.argv.includes("--check");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const fatal = (m) => {
  console.error("[aria2] " + m);
  process.exit(1);
};

function readAnchor() {
  if (!fs.existsSync(ANCHOR)) return null;
  try {
    return JSON.parse(fs.readFileSync(ANCHOR, "utf8"));
  } catch {
    fatal(`${rel(ANCHOR)} 读不出，JSON 损坏`);
    return null;
  }
}

function writeAnchor(anchor) {
  fs.writeFileSync(ANCHOR, JSON.stringify(anchor, null, 2) + "\n", "utf8");
  console.log(`[aria2] 写入校验锚 ${rel(ANCHOR)}`);
}

/**
 * 用 curl.exe 取，不用 node fetch：这台机器上 undici 对 GitHub 的 objects 域会静静挂住，
 * 同一个 URL 交给 curl 几秒就完。Windows 10+ 自带 curl.exe。
 */
function fetchZip(anchor) {
  console.log(`[aria2] 下载 ${anchor.asset}`);
  const zip = path.join(os.tmpdir(), anchor.asset);
  fs.rmSync(zip, { force: true });
  execFileSync("curl.exe", ["-L", "--fail", "--retry", "3", "--connect-timeout", "20", "-o", zip, anchor.url], {
    stdio: "inherit",
  });
  const size = fs.statSync(zip).size;
  if (anchor.zipSize && size !== anchor.zipSize) {
    fs.rmSync(zip, { force: true });
    fatal(`zip 大小不符：期望 ${anchor.zipSize}，实际 ${size}`);
  }
  return { zip, size };
}

function extractExe(zip) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "aria2-stage-"));
  execFileSync("tar", ["-xf", zip, "-C", stage], { stdio: "inherit" });
  const hits = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (name === "aria2c.exe") hits.push(abs);
    }
  })(stage);
  if (hits.length !== 1) fatal(`zip 里应有且只有一个 aria2c.exe，实际 ${hits.length}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(hits[0], OUT_EXE);
  fs.rmSync(stage, { recursive: true, force: true });
  return OUT_EXE;
}

async function main() {
  let anchor = readAnchor();
  if (!anchor) {
    if (checkOnly) fatal(`缺 ${rel(ANCHOR)}——先跑 node scripts/vendor/aria2.mjs 生成`);
    const version = "1.37.0";
    const asset = `aria2-${version}-win-64bit-build1.zip`;
    anchor = {
      version,
      asset,
      url: `https://github.com/aria2/aria2/releases/download/release-${version}/${asset}`,
      zipSize: null,
      exeSha256: null,
    };
    console.log(`[aria2] 没有校验锚，按缺省版本 ${version} 取一次`);
  }

  if (fs.existsSync(OUT_EXE) && anchor.exeSha256 && sha256(OUT_EXE) === anchor.exeSha256) {
    console.log(`[aria2] ${rel(OUT_EXE)} 已就位（${anchor.version}）`);
    return;
  }
  if (checkOnly) {
    fatal(`缺 ${rel(OUT_EXE)} 或与锚不符。跑 node scripts/vendor/aria2.mjs 重新取`);
  }

  const { zip, size } = fetchZip(anchor);
  extractExe(zip);
  fs.rmSync(zip, { force: true });

  const got = sha256(OUT_EXE);
  if (anchor.exeSha256 && got !== anchor.exeSha256) {
    fs.rmSync(OUT_EXE, { force: true });
    fatal(`aria2c.exe 与锚不符（期望 ${anchor.exeSha256.slice(0, 12)}，实际 ${got.slice(0, 12)}）`);
  }
  if (!anchor.exeSha256) {
    anchor.exeSha256 = got;
    anchor.zipSize = size;
    writeAnchor(anchor);
  }
  console.log(`[aria2] 就位 ${rel(OUT_EXE)}（${anchor.version}，${(fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(2)} MB）`);
}

main().catch((error) => {
  fatal(error instanceof Error ? error.message : String(error));
});
