// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/installer.js — 引擎与权重的下载安装。
 *
 * 两类文件都很大（引擎约 1 GB，权重 25 GiB），App 进程里的 sdk.network.fetch 有响应
 * 字节上限，够不着这种量级。所以对外请求一律交给子进程：curl 取 JSON 与校验文件，
 * aria2c 下大文件（随包在 vendor-bin/，多连接 + 自带重连）。子进程有自己的网络栈，
 * 不需要在 manifest 里声明 network。
 *
 * 进度不解析 aria2 的输出：它是不带换行的动态行，按 \r 切很脆。改成定期扫目标目录的
 * 体积增量，跟下载器解耦。
 *
 * 装完只做一件事：把路径写进设置，让 Engine 那边直接用。
 */
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MOSSIMAGE } from "./mossimage.js";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARIA2 = join(APP_ROOT, "vendor-bin", "aria2c.exe");

const ENGINE_REPO = "mossimage-cpp/mossimage.cpp";
const ENGINE_API = `https://api.github.com/repos/${ENGINE_REPO}/releases/latest`;

const MODEL_REPO = "OpenMOSS-Team/MOSS-Image-SFT";
const MODEL_ENDPOINT = "https://hf-mirror.com";
const MODEL_INCLUDES = [
  "model_index.json",
  "scheduler/*",
  "transformer/*",
  "vae/*",
  "text_encoder/*",
  "tokenizer/*",
];

/** CUDA 13 需要驱动 R580+；算力 7.5 只有 Windows cu13 的 sm75 包。 */
const CUDA13_MIN_DRIVER = 580;

const sha256File = (file) =>
  new Promise((done, fail) => {
    const hash = crypto.createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", fail);
  });

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0);
const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1);

function curlText(url) {
  const result = spawnSync("curl.exe", ["-sL", "--fail", "--retry", "3", "--connect-timeout", "20", url], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`取 ${url} 失败：${(result.stderr || "").trim().slice(0, 200)}`);
  return result.stdout;
}

export function probeGpu() {
  const result = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader"],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  const [name, driver, cc] = result.stdout.trim().split(/\r?\n/)[0].split(",").map((s) => s.trim());
  const compute = Number(cc);
  return {
    name,
    driver,
    driverMajor: Number(String(driver).split(".")[0]) || null,
    computeCapability: Number.isFinite(compute) ? compute : null,
  };
}

/** 从资产名里挑出一个包：bundled 优先，其余按驱动与算力。 */
export function pickEngineAsset(assets, version, gpu) {
  const cuda = gpu?.driverMajor && gpu.driverMajor < CUDA13_MIN_DRIVER ? "cu12" : "cu13";
  const sm75 = gpu?.computeCapability === 7.5 && cuda === "cu13";
  const base = `mossinfer-${version}-windows-${cuda}-x86_64${sm75 ? "-sm75" : ""}`;
  const bundled = assets.find((a) => a.name === `${base}.zip`);
  const system = assets.find((a) => a.name === `${base}-system-cuda.zip`);
  const picked = bundled ?? system;
  if (!picked) {
    const available = assets.filter((a) => a.name.startsWith("mossinfer-")).map((a) => a.name);
    throw new Error(`Release 里没有 ${base}.zip，现有：${available.join("、") || "无"}`);
  }
  return { asset: picked, cuda, sm75, variant: bundled ? "bundled" : "system-cuda" };
}

/** 扫目录总字节，用来算下载进度。 */
function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) total += dirBytes(abs);
    else total += stat.size;
  }
  return total;
}

export function createInstaller({ dataDir, getSettings, saveSettings, onUpdate }) {
  /** 当前安装任务；null 表示空闲。 */
  let job = null;
  let child = null;
  let cancelled = false;

  const engineDir = join(dataDir, "engine");
  const weightsDir = join(dataDir, "models", "moss-image-sft");

  function patch(update) {
    if (!job) return;
    Object.assign(job, update);
    job.updatedAt = new Date().toISOString();
    onUpdate?.();
  }

  function begin(target, label) {
    job = {
      id: `inst-${Date.now().toString(36)}`,
      target,
      label,
      phase: "starting",
      message: "",
      percent: 0,
      bytes: 0,
      totalBytes: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      detail: null,
    };
    cancelled = false;
    onUpdate?.();
  }

  function finish(update) {
    patch({ ...update, percent: 100, finishedAt: new Date().toISOString() });
  }

  function fail(error) {
    // 取消已经写过终态，不让它再被改回收尾的 error。
    if (cancelled) return;
    patch({
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
    });
  }

  /** 起一个 aria2c，等它退出；进度靠外部轮询目录体积。 */
  function runAria2(args) {
    return new Promise((done, reject) => {
      const proc = spawn(ARIA2, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child = proc;
      let tail = "";
      const collect = (chunk) => {
        tail = (tail + chunk).slice(-1200);
      };
      proc.stdout.on("data", collect);
      proc.stderr.on("data", collect);
      proc.on("error", (error) => {
        child = null;
        reject(new Error(`无法启动 aria2c：${error.message}`));
      });
      proc.on("close", (code) => {
        child = null;
        if (cancelled) reject(new Error("已取消"));
        else if (code !== 0) reject(new Error(`aria2c 退出码 ${code}：${tail.trim().split(/\r?\n/).slice(-2).join(" ")}`));
        else done();
      });
    });
  }

  function watchProgress(getBytes, totalBytes) {
    const timer = setInterval(() => {
      if (!job || job.finishedAt) return;
      const bytes = getBytes();
      patch({ bytes, totalBytes, percent: totalBytes ? Math.min(99, Math.floor((bytes / totalBytes) * 100)) : 0 });
    }, 1500);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function installEngine() {
    if (job && !job.finishedAt) throw new Error("已有安装在进行");
    begin("engine", "引擎");
    try {
      patch({ phase: "probing", message: "读显卡与驱动" });
      const gpu = probeGpu();
      patch({
        phase: "release",
        message: gpu ? `${gpu.name} · 驱动 ${gpu.driver} · 算力 ${gpu.computeCapability ?? "?"}` : "没有读到 nvidia-smi",
        detail: gpu,
      });

      const release = JSON.parse(curlText(ENGINE_API));
      const version = String(release.tag_name ?? "").replace(/^v/, "");
      if (!version) throw new Error("Release 没有可用的 tag");
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const { asset, cuda, sm75, variant } = pickEngineAsset(assets, version, gpu);
      patch({ message: `选中 ${asset.name}（${variant}）`, detail: { ...gpu, cuda, sm75, variant, version, tag: release.tag_name } });

      mkdirSync(engineDir, { recursive: true });
      const base = asset.name.replace(/\.zip$/, "");
      const target = join(engineDir, base);
      const zip = join(engineDir, `${base}.zip`);

      patch({ phase: "download", message: `下载 ${asset.name}（${mb(asset.size ?? 0)} MB）`, totalBytes: asset.size ?? 0 });
      const stopWatch = watchProgress(() => (existsSync(zip) ? statSync(zip).size : 0), asset.size ?? 0);
      try {
        await runAria2([
          "-x16",
          "-s16",
          "-k1M",
          "-c",
          "--file-allocation=none",
          "--max-tries=5",
          "--retry-wait=5",
          // 多分片时偶尔有一个连接挂住，文件已满但 aria2 不退出；低于 10 KB/s 满 60 秒就断开重连。
          "--lowest-speed-limit=10K",
          "--timeout=60",
          "--console-log-level=warn",
          "--summary-interval=0",
          "-d",
          engineDir,
          "-o",
          `${base}.zip`,
          asset.browser_download_url,
        ]);
      } finally {
        stopWatch();
      }

      patch({ phase: "verify", message: "校验 sha256" });
      const sumsUrl = asset.browser_download_url.replace(/[^/]+$/, "SHA256SUMS");
      let sums = "";
      try {
        sums = curlText(sumsUrl);
      } catch {
        sums = "";
      }
      const want = sums
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[1] === asset.name)?.[0];
      if (!want) throw new Error("Release 里找不到这个包的 SHA256SUMS 条目");
      const got = await sha256File(zip);
      if (got.toLowerCase() !== want.toLowerCase()) throw new Error(`sha256 不符：期望 ${want}，实际 ${got}`);

      patch({ phase: "extracting", message: "解压" });
      const unzip = spawnSync("tar", ["-xf", zip, "-C", engineDir], { encoding: "utf8", windowsHide: true });
      if (unzip.status !== 0) throw new Error(`解压失败：${(unzip.stderr || "").trim().slice(0, 200)}`);
      rmSync(zip, { force: true });

      const serverPath = join(target, "bin", "moss-server.exe");
      if (!existsSync(serverPath)) throw new Error(`包里没有 ${serverPath}`);
      saveSettings({ serverPath });
      const drift = MOSSIMAGE.version === version ? "" : `；app/lib/mossimage.js 里还写着 ${MOSSIMAGE.version}`;
      finish({ phase: "done", message: `引擎就绪：${base}${drift}`, detail: { serverPath, version } });
    } catch (error) {
      fail(error);
    }
  }

  async function installWeights() {
    if (job && !job.finishedAt) throw new Error("已有安装在进行");
    begin("weights", "权重");
    try {
      patch({ phase: "listing", message: "读取文件清单" });
      const tree = JSON.parse(curlText(`${MODEL_ENDPOINT}/api/models/${MODEL_REPO}/tree/main?recursive=true`));
      const wanted = (tree ?? []).filter((entry) => {
        if (entry.type !== "file") return false;
        return MODEL_INCLUDES.some((pattern) =>
          pattern.endsWith("/*") ? entry.path.startsWith(pattern.slice(0, -1)) : entry.path === pattern,
        );
      });
      if (!wanted.length) throw new Error("清单为空，镜像可能不可用");

      mkdirSync(weightsDir, { recursive: true });
      const missing = wanted.filter((entry) => {
        const target = join(weightsDir, ...entry.path.split("/"));
        return !(existsSync(target) && statSync(target).size === entry.size);
      });
      const totalBytes = missing.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
      patch({
        phase: "download",
        message: missing.length ? `${missing.length} 个文件待下，合计 ${gib(totalBytes)} GiB` : "文件已齐，只做校验",
        totalBytes,
        bytes: 0,
      });

      if (missing.length) {
        const listFile = join(weightsDir, ".aria2-input.txt");
        const lines = [];
        for (const entry of missing) {
          mkdirSync(dirname(join(weightsDir, ...entry.path.split("/"))), { recursive: true });
          lines.push(`${MODEL_ENDPOINT}/${MODEL_REPO}/resolve/main/${entry.path}`);
          lines.push(`  out=${entry.path}`);
        }
        writeFileSync(listFile, lines.join("\n") + "\n", "utf8");
        const stopWatch = watchProgress(() => dirBytes(weightsDir) - (existsSync(listFile) ? statSync(listFile).size : 0), totalBytes);
        try {
          await runAria2([
            "-x16",
            "-s16",
            "-k1M",
            "-j4",
            "-c",
            "--file-allocation=none",
            "--max-tries=5",
            "--retry-wait=5",
            "--lowest-speed-limit=10K",
            "--timeout=60",
            "--console-log-level=warn",
            "--summary-interval=0",
            "-d",
            weightsDir,
            "-i",
            listFile,
          ]);
        } finally {
          stopWatch();
          rmSync(listFile, { force: true });
        }
      }

      patch({ phase: "verify", message: "核对大小" });
      const broken = wanted.filter((entry) => {
        const target = join(weightsDir, ...entry.path.split("/"));
        return !(existsSync(target) && statSync(target).size === entry.size);
      });
      if (broken.length) throw new Error(`${broken.length} 个文件不完整：${broken.slice(0, 3).map((e) => e.path).join("、")}`);

      saveSettings({ modelPath: weightsDir });
      finish({ phase: "done", message: `权重就绪：${wanted.length} 个文件`, detail: { modelPath: weightsDir } });
    } catch (error) {
      fail(error);
    }
  }

  return {
    /** 给 state() 用：没有安装任务时给最近一次的结果。 */
    snapshot() {
      return job ? { ...job } : null;
    },
    busy() {
      return Boolean(job && !job.finishedAt);
    },
    cancel() {
      if (!job || job.finishedAt) return false;
      cancelled = true;
      child?.kill();
      patch({ phase: "cancelled", message: "已取消", finishedAt: new Date().toISOString() });
      return true;
    },
    installEngine,
    installWeights,
    /** 供 UI 判断环境：aria2c 在不在包里。 */
    environment() {
      return { aria2: existsSync(ARIA2), dataDir, weightsDir };
    },
    getSettings,
  };
}
