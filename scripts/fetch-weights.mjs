// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/fetch-weights.mjs — 拉 MOSS-Image 权重。
 *
 * 有 aria2c 就用它：多连接在同一条镜像链路上能快一个数量级，而且它自带重连，
 * 不会像单连接那样在某个字节上静静挂住。没有 aria2c 就退回 Node fetch，逻辑一样，
 * 只是慢，并且遇到停滞要等 bodyTimeout 才能自愈。
 *
 * aria2 的来源按序探测（第一个命中的赢）：
 *   1. --aria2 <path>
 *   2. <HANA_HOME>/app-data/hana-moss-studio/tools/aria2c.exe
 *   3. PATH 里的 aria2c
 * 都没有且带 --bootstrap-aria2 时，从官方 release 取一份放到 tools/（约 2.4 MB）。
 * 不把 aria2c 打进 App：它是 GPLv2，运行时自取比随包分发干净，版本也好换。
 *
 * 用法：
 *   node scripts/fetch-weights.mjs
 *   node scripts/fetch-weights.mjs --aria2 D:\tools\aria2c.exe
 *   node scripts/fetch-weights.mjs --bootstrap-aria2
 *
 * 参数：
 *   --root       落盘目录，缺省 <HANA_HOME>/app-data/hana-moss-studio/models/moss-image-sft
 *   --repo       缺省 OpenMOSS-Team/MOSS-Image-SFT
 *   --endpoint   缺省 https://hf-mirror.com
 *   --retries    单文件重试次数（Node fetch 路径），缺省 20
 *   --connections aria2 每服务器连接数，缺省 16
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const DATA_DIR = path.join(HANA_HOME, "app-data", "hana-moss-studio");

/** 要拉的目录与文件。`dir/*` 表示整个子树，其余按精确路径匹配。 */
const INCLUDES = [
  "model_index.json",
  "scheduler/*",
  "transformer/*",
  "vae/*",
  "tokenizer/*",
  "text_encoder/*",
];

/** bootstrap 用的固定版本，换版本只改这两行。 */
const ARIA2_VERSION = "1.37.0";
const ARIA2_ZIP = `aria2-${ARIA2_VERSION}-win-64bit-build1.zip`;
const ARIA2_URL = `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/${ARIA2_ZIP}`;

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] ?? fallback;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return fallback;
}

const has = (name) => process.argv.includes(name);

const ROOT = path.resolve(
  arg("--root", path.join(DATA_DIR, "models", "moss-image-sft")),
);
const REPO = arg("--repo", "OpenMOSS-Team/MOSS-Image-SFT");
const ENDPOINT = arg("--endpoint", "https://hf-mirror.com").replace(/\/$/, "");
const RETRIES = Number(arg("--retries", "20"));
const CONNECTIONS = Number(arg("--connections", "16"));

fs.mkdirSync(ROOT, { recursive: true });
const LOG = path.join(ROOT, "download.log");

function log(message) {
  const stamp = new Date().toTimeString().slice(0, 8);
  const line = `[${stamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG, `${line}\n`);
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

function wanted(entry) {
  if (entry.type !== "file") return false;
  for (const pattern of INCLUDES) {
    if (pattern.endsWith("/*")) {
      if (entry.path.startsWith(pattern.slice(0, -1))) return true;
    } else if (entry.path === pattern) {
      return true;
    }
  }
  return false;
}

async function listFiles() {
  const url = `${ENDPOINT}/api/models/${REPO}/tree/main?recursive=true`;
  log(`读取文件清单 ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`清单请求失败：HTTP ${response.status}`);
  const entries = await response.json();
  return entries.filter(wanted);
}

/** 目标路径：把 HF 的 posix 路径拆开落到本机目录里。 */
const localPath = (entry) => path.join(ROOT, ...entry.path.split("/"));

/** 已存在且字节数对得上就算完整。 */
const complete = (entry, target) => fs.existsSync(target) && fs.statSync(target).size === entry.size;

// ── aria2 ──────────────────────────────────────────────────────────────────

function bootstrapAria2() {
  const zip = path.join(os.tmpdir(), ARIA2_ZIP);
  const stage = path.join(DATA_DIR, "tools", "aria2-stage");
  log(`没有 aria2c，取一份到 ${DATA_DIR}\\tools（${ARIA2_ZIP}）`);
  execFileSync("curl.exe", ["-L", "--fail", "-o", zip, ARIA2_URL], { stdio: "inherit" });
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  execFileSync("tar", ["-xf", zip, "-C", stage], { stdio: "inherit" });
  const found = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (name === "aria2c.exe") found.push(abs);
    }
  })(stage);
  if (found.length !== 1) throw new Error(`aria2 包里应有且只有一个 aria2c.exe，实际 ${found.length}`);
  const target = path.join(DATA_DIR, "tools", "aria2c.exe");
  fs.copyFileSync(found[0], target);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  log(`aria2c 就位：${target}`);
  return target;
}

function resolveAria2() {
  if (has("--no-aria2")) return null;
  const explicit = arg("--aria2", null);
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`--aria2 指向的文件不存在：${explicit}`);
    return path.resolve(explicit);
  }
  const local = path.join(DATA_DIR, "tools", "aria2c.exe");
  if (fs.existsSync(local)) return local;
  const onPath = spawnSync("where.exe", ["aria2c"], { encoding: "utf8" });
  if (onPath.status === 0) {
    const first = onPath.stdout.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  if (has("--bootstrap-aria2")) return bootstrapAria2();
  return null;
}

async function runAria2(binary, files) {
  const pending = files.filter((entry) => !complete(entry, localPath(entry)));
  const skipped = files.length - pending.length;
  if (!pending.length) {
    log(`全部已完整（跳过 ${skipped} 个）`);
    return;
  }
  log(`aria2c -x${CONNECTIONS}：待下 ${pending.length} 个，跳过 ${skipped} 个`);

  // aria2 的输入文件：一行 URL，下一行缩进的 out= 相对路径。
  const listFile = path.join(os.tmpdir(), `moss-weights-${Date.now()}.txt`);
  const lines = [];
  for (const entry of pending) {
    // aria2 不会替 out= 里的子目录建父目录。
    fs.mkdirSync(path.dirname(localPath(entry)), { recursive: true });
    lines.push(`${ENDPOINT}/${REPO}/resolve/main/${entry.path}`);
    lines.push(`  out=${entry.path}`);
  }
  fs.writeFileSync(listFile, lines.join("\n") + "\n", "utf8");

  try {
    const result = spawnSync(
      binary,
      [
        `-x${CONNECTIONS}`,
        `-s${CONNECTIONS}`,
        "-k1M",
        "-j4",
        "-c",
        "--file-allocation=none",
        "--max-tries=5",
        "--retry-wait=5",
        "--lowest-speed-limit=10K",
        "--timeout=60",
        "--connect-timeout=20",
        "--timeout=60",
        "--console-log-level=warn",
        "--summary-interval=30",
        "-d",
        ROOT,
        "-i",
        listFile,
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error(`aria2c 退出码 ${result.status}`);
  } finally {
    fs.rmSync(listFile, { force: true });
  }

  const broken = pending.filter((entry) => !complete(entry, localPath(entry)));
  if (broken.length) throw new Error(`aria2 结束后仍有 ${broken.length} 个文件不完整：${broken.map((e) => e.path).join("、")}`);
  log(`全部完成（跳过 ${skipped} 个，下载 ${pending.length} 个）`);
}

// ── Node fetch 回退 ────────────────────────────────────────────────────────

/**
 * 下到 target。返回 'skip' / 'done'。
 * 服务器不认 Range 时必须重头写，否则会在旧字节后面接出坏文件。
 */
async function downloadOnce(url, target, size) {
  let have = fs.existsSync(target) ? fs.statSync(target).size : 0;
  if (have === size) return "skip";
  if (have > size) {
    fs.rmSync(target);
    have = 0;
  }

  const response = await fetch(url, {
    headers: have > 0 ? { range: `bytes=${have}-` } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const resuming = response.status === 206;
  if (have > 0 && !resuming) have = 0;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target, { flags: resuming ? "a" : "w" }));

  const got = fs.statSync(target).size;
  if (got !== size) throw new Error(`大小不符：期望 ${size}，实际 ${got}`);
  return "done";
}

async function fetchWithRetry(url, target, size, label) {
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      return await downloadOnce(url, target, size);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === RETRIES) throw new Error(`${label} 重试 ${RETRIES} 次仍失败：${message}`);
      const wait = Math.min(5 * attempt, 30);
      log(`  ${label} 第 ${attempt} 次失败（${message}），${wait}s 后重试`);
      await new Promise((done) => setTimeout(done, wait * 1000));
    }
  }
  throw new Error(`${label} 未完成`);
}

async function runFetch(files) {
  log("没有 aria2c，走 Node fetch 单连接（慢，卡住要等超时）");
  let index = 0;
  let skipped = 0;
  for (const entry of files) {
    index += 1;
    const target = localPath(entry);
    const label = `[${index}/${files.length}] ${entry.path}`;
    if (complete(entry, target)) {
      skipped += 1;
      log(`${label} 跳过（已完整）`);
      continue;
    }
    const url = `${ENDPOINT}/${REPO}/resolve/main/${entry.path}`;
    const started = Date.now();
    log(`${label} 开始（${mb(entry.size)} MB）`);
    await fetchWithRetry(url, target, entry.size, entry.path);
    const seconds = Math.max((Date.now() - started) / 1000, 0.1);
    log(`${label} 完成 ${seconds.toFixed(0)}s ${(entry.size / 1024 / 1024 / seconds).toFixed(2)} MB/s`);
  }
  log(`全部完成（跳过 ${skipped} 个，下载 ${files.length - skipped} 个）`);
}

// ── 入口 ───────────────────────────────────────────────────────────────────

async function main() {
  const files = await listFiles();
  const total = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  log(`需要 ${files.length} 个文件，合计 ${(total / 1024 / 1024 / 1024).toFixed(2)} GiB`);
  log(`落到 ${ROOT}`);

  const aria2 = resolveAria2();
  if (aria2) {
    log(`用 ${aria2} 下载`);
    await runAria2(aria2, files);
  } else {
    await runFetch(files);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`失败：${message}`);
  process.exit(1);
});
