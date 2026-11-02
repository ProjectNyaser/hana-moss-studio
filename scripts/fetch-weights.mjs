// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * scripts/fetch-weights.mjs — 拉 MOSS-Image 权重，三平台同一份脚本。
 *
 * 为什么不用 huggingface_hub：它在部分网络下会切到 Xet 的 CAS 通道，连接建起来但读不动，
 * 反复 `The read operation timed out`。同一个镜像用单连接能到 8–11 MB/s。
 *
 * 续传按字节范围做：已存在且大小对得上就跳过，小就接着下，大了就重下。镜像站返回 200
 * （不支持 Range）时退回整文件覆盖，不半途弃掉。
 *
 * 用法：
 *   node scripts/fetch-weights.mjs
 *   node scripts/fetch-weights.mjs --root D:\models\moss-image-sft --endpoint https://hf-mirror.com
 *
 * 参数：
 *   --root      落盘目录，缺省 <HANA_HOME>/app-data/hana-moss-studio/models/moss-image-sft
 *   --repo      缺省 OpenMOSS-Team/MOSS-Image-SFT
 *   --endpoint  缺省 https://hf-mirror.com
 *   --retries   单文件重试次数，缺省 20
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

/** 要拉的目录与文件。`dir/*` 表示整个子树，其余按精确路径匹配。 */
const INCLUDES = [
  "model_index.json",
  "scheduler/*",
  "transformer/*",
  "vae/*",
  "tokenizer/*",
  "text_encoder/*",
];

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] ?? fallback;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return fallback;
}

const ROOT = path.resolve(
  arg("--root", path.join(HANA_HOME, "app-data", "hana-moss-studio", "models", "moss-image-sft")),
);
const REPO = arg("--repo", "OpenMOSS-Team/MOSS-Image-SFT");
const ENDPOINT = arg("--endpoint", "https://hf-mirror.com").replace(/\/$/, "");
const RETRIES = Number(arg("--retries", "20"));

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

async function main() {
  const files = await listFiles();
  const total = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  log(`需要 ${files.length} 个文件，合计 ${(total / 1024 / 1024 / 1024).toFixed(2)} GiB`);
  log(`落到 ${ROOT}`);

  let index = 0;
  let skipped = 0;
  for (const entry of files) {
    index += 1;
    const target = path.join(ROOT, ...entry.path.split("/"));
    const label = `[${index}/${files.length}] ${entry.path}`;
    if (fs.existsSync(target) && fs.statSync(target).size === entry.size) {
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`失败：${message}`);
  process.exit(1);
});
