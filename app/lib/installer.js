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
 * 下载进度走 aria2 的 JSON-RPC：任务用 aria2.addUri 下发，进度读引擎自报的
 * completedLength，失败有 errorCode，取消能逐任务 forceRemove，收尾用 aria2.shutdown
 * 让它自己退。不解析 stdout（动态行按 \r 切很脆），也不靠扫目录猜体积。
 * 调 RPC 用 curl 子进程，App 自己的网络权限面不因此扩大。
 *
 * 装完只做一件事：把路径写进设置，让 Engine 那边直接用。
 */
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MOSSIMAGE } from "./mossimage.js";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARIA2 = join(APP_ROOT, "vendor-bin", "aria2c.exe");

const ENGINE_REPO = "mossimage-cpp/mossimage.cpp";
const ENGINE_API = `https://api.github.com/repos/${ENGINE_REPO}/releases/latest`;

const MODEL_REPO = "OpenMOSS-Team/MOSS-Image-SFT";
/** 两个可选的权重仓库：SFT 是官方微调版，Base 是基座模型。 */
const MODELS = {
  sft: { repo: "OpenMOSS-Team/MOSS-Image-SFT", dir: "moss-image-sft", label: "MOSS-Image-SFT", note: "官方微调版，提示词响应更准" },
  base: { repo: "OpenMOSS-Team/MOSS-Image-Base", dir: "moss-image-base", label: "MOSS-Image-Base", note: "基座模型，适合自己微调" },
};
// 多个源同时交给 aria2：它会自己试哪个快。实测这台机器到 HF 直连比镜像快五倍，
// 但网络状况因人而异，所以两个都给，不写死。
const MODEL_ENDPOINTS = ["https://hf-mirror.com", "https://huggingface.co"];
const MODEL_ENDPOINT = MODEL_ENDPOINTS[0];
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
const brief = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 90);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const runFile = promisify(execFile);

/**
 * 取一段文本（JSON、SHA256SUMS）。走异步 execFile：同步版会在网络慢时卡住事件循环，
 * 那段时间 SSE 推不出去、面板跟着停。
 */
async function curlText(url) {
  try {
    const { stdout } = await runFile(
      "curl.exe",
      // -sS：静默但保留错误文字。只用 -s 时 --fail 的失败原因会被吞掉，
      // 上层只能拿到一个空字符串，看着就像「失败：」后面什么都没有。
      ["-sS", "-L", "--fail", "--retry", "3", "--connect-timeout", "20", url],
      { timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 200);
    throw new Error(`取 ${url} 失败：${detail || "没有返回内容（可能是限流或网络不通）"}`);
  }
}

/**
 * nvidia-smi 的定位顺序。
 *
 * 不指望 PATH：App 进程的 PATH 是宿主给的，不保证含 System32，裸名会直接 ENOENT。
 * 大多数机器上它就在 System32（NVIDIA 驱动装的），旧式装在 NVSMI 目录的也留着。
 */
const SMI_CANDIDATES = [
  "C:\\Windows\\System32\\nvidia-smi.exe",
  "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
  "nvidia-smi",
];

const parseSmi = (stdout) => {
  if (!stdout?.trim()) return null;
  const [name, driver, cc] = stdout.trim().split(/\r?\n/)[0].split(",").map((s) => s.trim());
  const compute = Number(cc);
  return {
    name,
    driver,
    driverMajor: Number(String(driver).split(".")[0]) || null,
    computeCapability: Number.isFinite(compute) ? compute : null,
  };
};

/** 从 WMI 的 32.0.16.1692 推出 NVIDIA 自己的 616.92（后两段拼起来取末五位）。 */
export function nvidiaDriverFromWmi(version) {
  const parts = String(version ?? "").split(".");
  if (parts.length < 4) return null;
  const tail = `${parts[2]}${parts[3]}`.slice(-5);
  if (!/^\d{5}$/.test(tail)) return null;
  return `${Number(tail.slice(0, 3))}.${tail.slice(3)}`;
}

/**
 * 备选通道：WMI 只看系统记录的显卡信息，不碰驱动设备。
 * nvidia-smi 在 App 进程里会因为 NVML 初始化失败而退出（见 probeGpuDetailed），
 * 但装包只需要驱动主版本，WMI 能给的正好够。拿不到算力，所以 sm75 判断会失效；
 * 那类卡（算力 7.5）的驱动也老，会走 cu12 分支，不会误选。
 */
async function probeGpuViaWmi() {
  const script =
    "$g = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1; " +
    'if ($g) { "' + '$' + '($g.Name)|' + '$' + '($g.DriverVersion)" }';
  const exe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  try {
    const { stdout } = await runFile(
      exe,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const [name, raw] = String(stdout ?? "").trim().split("|");
    const driver = nvidiaDriverFromWmi(raw);
    if (!name || !driver) return { ok: false, name: name ?? null, raw: String(raw ?? "").trim(), error: "解析不出驱动版本" };
    return {
      ok: true,
      gpu: {
        name: name.trim(),
        driver,
        driverMajor: Number(driver.split(".")[0]) || null,
        computeCapability: null,
        source: "wmi",
      },
      raw: String(raw).trim(),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/** 带诊断的探测：每个候选都留下退出码与环境，方便查 App 里为何没读到。 */
export async function probeGpuDetailed() {
  const args = ["--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader"];
  const tried = [];
  for (const exe of SMI_CANDIDATES) {
    try {
      const { stdout, stderr } = await runFile(exe, args, { timeout: 15_000, windowsHide: true });
      tried.push({ exe, ok: true, stdout: String(stdout ?? "").trim().slice(0, 200), stderr: String(stderr ?? "").trim().slice(0, 200) });
      const gpu = parseSmi(stdout);
      if (gpu) return { gpu: { ...gpu, source: "nvidia-smi" }, tried, env: envSummary() };
    } catch (error) {
      tried.push({
        exe,
        ok: false,
        code: typeof error?.code === "number" ? error.code : String(error?.code ?? ""),
        signal: error?.signal ?? null,
        error: String(error?.message ?? error).slice(0, 200),
        stderr: String(error?.stderr ?? "").trim().slice(0, 200),
        stdout: String(error?.stdout ?? "").trim().slice(0, 200),
      });
    }
  }

  const wmi = await probeGpuViaWmi();
  return { gpu: wmi.ok ? wmi.gpu : null, tried, wmi, env: envSummary() };
}

/** 只报几条与子进程启动相关的环境，不把整个 env 抛出去。 */
function envSummary() {
  return {
    cwd: process.cwd(),
    execPath: process.execPath,
    SystemRoot: process.env.SystemRoot ?? null,
    windir: process.env.windir ?? null,
    PATH: String(process.env.PATH ?? "").slice(0, 400),
    PATHLength: String(process.env.PATH ?? "").length,
  };
}

/** 安装时用的探测：只走 WMI。
 *
 * 在 App 进程里 nvidia-smi 固定失败（宿主的 win32-job 沙箱，NVML 起不来），
 * 先试它只会白花时间，没有成功可能。完整的两条通道对比见 probeGpuDetailed。
 */
export async function probeGpu() {
  const wmi = await probeGpuViaWmi();
  return wmi.ok ? wmi.gpu : null;
}

/** 从资产名里挑出一个包。preferCuda 是手动指定的 cu12/cu13，不指定就看驱动。 */
export function pickEngineAsset(assets, version, gpu, preferCuda) {
  const cuda =
    preferCuda === "cu12" || preferCuda === "cu13"
      ? preferCuda
      : gpu?.driverMajor && gpu.driverMajor < CUDA13_MIN_DRIVER
        ? "cu12"
        : "cu13";
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

/** 目录名 → 版本与构建。命名规则：mossinfer-<ver>-<os>-<cu>-x86_64[-sm75][-system-cuda]。 */
export function parseEngineName(name) {
  const match = String(name).match(
    /^mossinfer-([0-9][0-9.]*)-([a-z0-9]+)-([a-z0-9]+)-x86_64(?:-(sm\d+))?(?:-(system-cuda))?$/i,
  );
  if (!match) return { version: null, os: null, cuda: null, sm: null, variant: null };
  return {
    version: match[1].replace(/\.$/, ""),
    os: match[2],
    cuda: match[3],
    sm: match[4] ?? null,
    variant: match[5] ? "system-cuda" : "bundled",
  };
}

/** 按数字段比版本，大的在前。 */
export function compareEngineVersion(a, b) {
  const left = String(a ?? "").split(".").map((n) => Number(n) || 0);
  const right = String(b ?? "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function createInstaller({ dataDir, getSettings, saveSettings, onUpdate, onInstalled }) {
  /** 当前安装任务；null 表示空闲。 */
  let job = null;
  let child = null;
  let cancelled = false;
  /**
   * 当前 aria2 会话的控制面。下载跑着的时候才有，用来按文件名找 gid，
   * 做单任务的暂停 / 继续 / 移除。
   */
  let control = null;

  const engineDir = join(dataDir, "engine");

  /**
   * 已有可用模型就装在原处，不另开一份 25 GiB 的副本。
   * 判据只看目录在不在：缺一两个文件也应该就地补齐，换目录等于把整份重下一遍。
   */
  /** 每个仓库一个目录：SFT 与 Base 可以同时装着，用哪个看 settings.modelPath。 */
  function weightsTarget(variant = "base") {
    const key = MODELS[variant] ? variant : "base";
    const stored = getSettings().modelPaths?.[key];
    if (stored && existsSync(stored)) return stored;
    return join(dataDir, "models", MODELS[key].dir);
  }

  /**
   * 已装引擎清单。旧版本装完不删，回滚就是在这里切回去。
   * 只列真带 bin/moss-server.exe 的目录，半途而废的解压残留不会冒充可用版本。
   */
  function listEngines() {    if (!existsSync(engineDir)) return [];
    const current = String(getSettings().serverPath ?? "");
    return readdirSync(engineDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const serverPath = join(engineDir, entry.name, "bin", "moss-server.exe");
        if (!existsSync(serverPath)) return null;
        return {
          name: entry.name,
          serverPath,
          current: serverPath === current,
          bytes: dirBytes(join(engineDir, entry.name)),
          ...parseEngineName(entry.name),
        };
      })
      .filter(Boolean)
      .sort((a, b) => compareEngineVersion(b.version, a.version));
  }

  /** 可装的引擎版本：Release 列表，标出哪些已经装了。缓存十分钟，不必每次开面板都拉一遍。 */
  let releaseCache = null;
  async function listReleases() {
    if (!releaseCache || Date.now() - releaseCache.at > 10 * 60_000) {
      try {
        const raw = JSON.parse(await curlText(`${ENGINE_API.replace(/\/latest$/, "")}?per_page=20`));
        const items = (Array.isArray(raw) ? raw : []).map((rel) => ({
          tag: rel.tag_name ?? "",
          version: String(rel.tag_name ?? "").replace(/^v/, ""),
          publishedAt: rel.published_at ?? null,
          prerelease: Boolean(rel.prerelease),
          windowsAssets: (rel.assets ?? []).filter((asset) => /windows.*x86_64.*\.zip$/i.test(asset.name ?? "")).length,
          bundledBytes: Math.max(
            0,
            ...(rel.assets ?? [])
              .filter((asset) => /windows.*x86_64.*\.zip$/i.test(asset.name ?? "") && !/system-cuda/i.test(asset.name ?? ""))
              .map((asset) => asset.size ?? 0),
          ),
        }));
        releaseCache = { at: Date.now(), items, stale: false };
      } catch (error) {
        // 拉不到时用上一次的结果，并标明是旧的。GitHub 匿名接口每小时 60 次，
        // 用完会直接 403，这时候列表还是能用的（版本不会几分钟一换）。
        if (releaseCache?.items?.length) {
          releaseCache = { ...releaseCache, stale: true, error: brief(error) };
        } else {
          throw new Error(`拿不到版本列表（GitHub 接口可能限流了，稍后再试）：${brief(error)}`);
        }
      }
    }
    const installed = new Set(listEngines().map((entry) => entry.version));
    return releaseCache.items.map((item) => ({
      ...item,
      installed: installed.has(item.version),
      stale: Boolean(releaseCache.stale),
    }));
  }

  /** 删掉一个已装版本。正在用的那个先清路径（会顺带停引擎），再删目录。 */
  function removeEngine(name) {
    const target = listEngines().find((entry) => entry.name === name);
    if (!target) throw new Error(`没有已装版本 ${name}`);
    if (target.current) saveSettings({ serverPath: "" });
    rmSync(join(engineDir, name), { recursive: true, force: true });
    return listEngines();
  }

  /** 删掉已装模型。25 GiB，调用方必须先确认。 */
  function removeWeights(variant = "base") {
    const key = MODELS[variant] ? variant : "base";
    const dir = getSettings().modelPaths?.[key];
    if (!dir || !existsSync(dir)) throw new Error("没有已装模型");
    rmSync(dir, { recursive: true, force: true });
    const paths = { ...(getSettings().modelPaths ?? {}), [key]: null };
    const active = getSettings().modelPath === dir ? (paths.sft ?? "") : getSettings().modelPath;
    saveSettings({ modelPaths: paths, modelPath: active });
    return true;
  }

  /** 安装任务串行：忙时排队，完成一个自动起下一个。 */
  let pending = [];

  function startNext() {
    const next = pending.shift();
    if (!next) return;
    const run = next.kind === "engine" ? installEngine(next.args) : installWeights(next.args?.variant);
    run.catch(() => {});
  }

  function enqueue(kind, args) {
    // 同一种任务只排一份：连点几下不该把权重排三次。
    const key = kind === "engine" ? `engine:${args?.tag ?? "latest"}` : `weights:${args?.variant === "sft" ? "sft" : "base"}`;
    const label = kind === "engine" ? `引擎 ${args?.tag ?? "latest"}` : `权重 ${args?.variant === "sft" ? "SFT" : "Base"}`;
    if (job && !job.finishedAt) {
      if (pending.some((item) => item.key === key)) {
        return { queued: true, position: pending.findIndex((item) => item.key === key) + 1, duplicate: true };
      }
      pending.push({ kind, args, key, label });
      onUpdate?.();
      return { queued: true, position: pending.length };
    }
    // installWeights 收的是 variant 字符串，installEngine 收的是参数对象。
    const run = kind === "engine" ? installEngine(args) : installWeights(args?.variant);
    run.catch(() => {});
    return { queued: false, position: 0 };
  }

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
    setTimeout(startNext, 0);
  }

  function fail(error) {
    // 取消已经写过终态，不让它再被改回收尾的 error。
    if (cancelled) return;
    patch({
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
    });
    setTimeout(startNext, 0);
  }

  /**
   * 调 aria2 的 JSON-RPC。走 curl 子进程而不是 App 内 fetch：子进程有自己的网络栈，
   * manifest 不用为回环地址多开一扇门。
   */
  async function aria2Call(port, secret, method, params = [], timeoutMs = 8000) {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "moss",
      method,
      params: [`token:${secret}`, ...params],
    });
    const { stdout } = await runFile(
      "curl.exe",
      [
        "-s",
        "--max-time",
        String(Math.max(1, Math.round(timeoutMs / 1000))),
        "-H",
        "content-type: application/json",
        "--data-binary",
        payload,
        `http://127.0.0.1:${port}/jsonrpc`,
      ],
      { timeout: timeoutMs + 2000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error(`${method}：RPC 返回不是 JSON`);
    }
    if (data.error) throw new Error(`${method}：${data.error.message}`);
    return data.result;
  }

  /** 起一个只当 RPC 服务端的 aria2c，端口冲突就换一个再试。 */
  async function startAria2Rpc(globalOptions) {
    let lastError = new Error("aria2 RPC 没有就绪");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (cancelled) throw new Error("已取消");
      const port = 6800 + Math.floor(Math.random() * 200);
      const secret = crypto.randomBytes(8).toString("hex");
      const proc = spawn(
        ARIA2,
        [
          "--enable-rpc",
          `--rpc-listen-port=${port}`,
          "--rpc-listen-all=false",
          `--rpc-secret=${secret}`,
          "--no-conf",
          ...globalOptions,
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      let exited = false;
      proc.on("close", () => {
        exited = true;
      });
      proc.on("error", () => {
        exited = true;
      });
      child = proc;

      for (let i = 0; i < 40; i += 1) {
        if (exited) break;
        try {
          await aria2Call(port, secret, "aria2.getVersion", [], 3000);
          return { proc, port, secret, exited: () => exited };
        } catch {
          await sleep(150);
        }
      }
      proc.kill();
      child = null;
      lastError = new Error("aria2c 起不来或端口被占");
    }
    throw lastError;
  }

  async function stopAria2Rpc(session) {
    // 先请求它优雅退出，不退再杀；退不退都不影响已下好的文件。
    try {
      await aria2Call(session.port, session.secret, "aria2.shutdown", [], 2000);
    } catch {
      /* 进程可能已经没了 */
    }
    const deadline = Date.now() + 3000;
    while (!session.exited() && Date.now() < deadline) await sleep(100);
    if (!session.exited()) session.proc.kill();
    child = null;
  }

  /**
   * 用 RPC 下一组文件。
   *
   * 返回值不带业务信息，进度走 onTick：字节数是引擎自报的，不用再给目标目录做快照差。
   * 失败直接抛，带上是哪个文件与 aria2 的错误码。
   */
  async function downloadViaRpc(entries, { dir, concurrency = 1, totalBytes = 0, onTick } = {}) {
    const session = await startAria2Rpc([
      "-x16",
      "-s16",
      "-k1M",
      `-j${concurrency}`,
      "--file-allocation=none",
      "--max-tries=5",
      "--retry-wait=3",
      "--timeout=30",
      "--console-log-level=warn",
      "--summary-interval=0",
    ]);
    try {
      const items = [];
      for (const entry of entries) {
        if (cancelled) throw new Error("已取消");
        // 调用方给 urls（多个镜像）或单个 url（引擎包只有 GitHub 一个源）。
        const urls = entry.urls ?? (entry.url ? [entry.url] : []);
        const gid = await aria2Call(session.port, session.secret, "aria2.addUri", [
          urls,
          { dir, out: entry.out, continue: "true" },
        ]);
        items.push({ gid, out: entry.out, size: entry.size ?? 0, urls });
      }
      const total = totalBytes || items.reduce((sum, item) => sum + item.size, 0);
      control = { port: session.port, secret: session.secret, gids: new Map(items.map((item) => [item.out, item.gid])) };
      let stall = 0;
      let lastBytes = -1;
      let lastDone = -1;
      let speedAt = 0;
      let speed = 0;
      const failedIds = new Set();
      // 偶尔会有某一轮 RPC 返回不完整的字段（totalLength/completedLength 读成 0），
      // 直接把 0 发出去，面板就会闪一下「0 / 0B」。记住上一轮的值当兵底。
      const known = new Map();

      for (;;) {
        if (cancelled) {
          await Promise.all(
            items.map((item) =>
              aria2Call(session.port, session.secret, "aria2.forceRemove", [item.gid], 3000).catch(() => {}),
            ),
          );
          throw new Error("已取消");
        }
        await sleep(1000);
        // 一次拿全量再按 gid 对号：逐个 tellStatus 在 20 个文件时会并发 20 次 RPC，
        // 设备忙时容易一片超时，进度就会被误读成 0。
        let snapshot;
        let waitingStates = [];
        try {
          const keys = [
            "gid",
            "status",
            "completedLength",
            "totalLength",
            "errorCode",
            "errorMessage",
            "connections",
            "downloadSpeed",
          ];
          const [active, waiting, stopped] = await Promise.all([
            aria2Call(session.port, session.secret, "aria2.tellActive", [keys], 6000),
            aria2Call(session.port, session.secret, "aria2.tellWaiting", [0, 1000, keys], 6000),
            aria2Call(session.port, session.secret, "aria2.tellStopped", [0, 1000, keys], 6000),
          ]);
          snapshot = new Map([...active, ...waiting, ...stopped].map((state) => [state.gid, state]));
          waitingStates = waiting;
        } catch {
          // 这一轮没读到就跳过，不把上一轮的进度写成 0。
          continue;
        }

        // 只统计 aria2 自报的 completedLength。查不到状态的按 0 算，绝不当已完成：
        // 新加的 gid 还没进 tellActive 时，当已完成会让进度一步跳到 100%。
        let bytes = 0;
        let done = 0;
        const failed = [];
        for (const item of items) {
          const state = snapshot.get(item.gid);
          if (!state) continue;
          bytes += Number(state.completedLength ?? 0);
          const st = state.status;
          if (st === "complete") done += 1;
          // removed = 用户单独取消了这一条；跟 error 一样当终态，不再等它。
          else if ((st === "error" || st === "removed") && !failedIds.has(item.gid)) {
            failedIds.add(item.gid);
            failed.push({ item, state });
          }
        }
        const pendingItem = items.find((item) => snapshot.get(item.gid)?.status === "active");
        // 连接数按 aria2 CLI 里 CN 那一列的口径：所有活跃任务加起来。
        let connections = 0;
        for (const item of items) {
          const state = snapshot.get(item.gid);
          if (state?.status === "active") connections += Number(state.connections ?? 0);
        }
        // 排队位置从 tellWaiting 的顺序里取，而不是自己编号。
        const waitingGids = waitingStates.map((state) => state.gid);
        // 每个文件的状态都带出去，面板按 aria2 那样一条文件一节。
        const tasks = items.map((item) => {
          const state = snapshot.get(item.gid) ?? {};
          const prev = known.get(item.gid) ?? {};
          const status = state.status ?? prev.status ?? "waiting";
          const task = {
            out: item.out,
            size: Number(state.totalLength ?? 0) || prev.size || item.size || 0,
            got: Number(state.completedLength ?? 0) || prev.got || 0,
            speed: Number(state.downloadSpeed ?? 0),
            status,
            queue: status === "waiting" ? waitingGids.indexOf(item.gid) + 1 : null,
          };
          if (status !== "waiting") known.set(item.gid, task);
          return task;
        });
        // 速度直接问 aria2，不自己按字节差分：文件切换那一秒会算出假的高峰再归零。
        const now = Date.now();
        if (now - speedAt >= 1500) {
          speedAt = now;
          const gs = await aria2Call(session.port, session.secret, "aria2.getGlobalStat", [], 4000).catch(() => null);
          speed = Number(gs?.downloadSpeed ?? 0);
        }
        onTick?.({ bytes, totalBytes: total, done, total: items.length, speed, connections, tasks, current: pendingItem?.out ?? null, failed: failed.length });

        // 字节和完成数都不再变超过三分钟，就当这条链路已经停了；不能无限等下去。
        const settled = done + failedIds.size;
        if (bytes === lastBytes && settled === lastDone) stall += 1;
        else {
          stall = 0;
          lastBytes = bytes;
          lastDone = settled;
        }
        if (stall > 180) throw new Error(`下载停滞：${gib(bytes)} / ${gib(total)} GiB，${done}/${items.length} 个文件`);

        if (done + failedIds.size === items.length) return { failed };
      }
    } finally {
      control = null;
      await stopAria2Rpc(session);
    }
  }

  /**
   * 单任务操作：pause / unpause / remove。
   * 按相对路径（task.out）定位，面板上点的是哪一行就传哪个。
   */
  async function taskAction(out, action) {
    if (!control) return { ok: false, error: "当前没有下载" };
    const gid = control.gids.get(out);
    if (!gid) return { ok: false, error: "找不到这个文件" };
    const method =
      action === "pause" ? "aria2.pause" : action === "resume" ? "aria2.unpause" : "aria2.forceRemove";
    try {
      await aria2Call(control.port, control.secret, method, [gid], 5000);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 用本机已有的 zip 装：拿得到官方 SHA256SUMS 就校验，拿不到就照装并在结果里注明。 */
  async function installFromLocalZip(zip) {
    const baseName = zip.split(/[\\/]/).pop().replace(/\.zip$/i, "");
    const target = join(engineDir, baseName);
    patch({ phase: "verify", message: `用本地包 ${baseName}.zip` });

    let verified = false;
    try {
      // 本地包可能是旧版本，校验文件得去对应 tag 找，而不是最新那个。
      const version = parseEngineName(baseName).version;
      const tag = version ? `v${version}` : null;
      const release = tag
        ? JSON.parse(await curlText(`https://api.github.com/repos/${ENGINE_REPO}/releases/tags/${encodeURIComponent(tag)}`))
        : JSON.parse(await curlText(ENGINE_API));
      const sums = await curlText(`https://github.com/${ENGINE_REPO}/releases/download/${release.tag_name}/SHA256SUMS`);
      const want = sums
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[1] === `${baseName}.zip`)?.[0];
      if (!want) throw new Error("官方校验文件里没有这个包");
      const got = await sha256File(zip);
      if (got.toLowerCase() !== want.toLowerCase()) {
        throw new Error(`sha256 不符：期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…`);
      }
      verified = true;
    } catch (error) {
      const text = String(error?.message ?? error);
      if (text.startsWith("sha256 不符")) throw error;
      patch({ message: `拿不到官方校验值（${text.slice(0, 60)}），跳过比对` });
    }

    patch({ phase: "extracting", message: verified ? "校验通过，解压" : "解压（未校验）" });
    try {
      await runFile("tar", ["-xf", zip, "-C", engineDir], { timeout: 300_000, windowsHide: true });
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 200);
      throw new Error(`解压失败：${detail}`);
    }

    const serverPath = join(target, "bin", "moss-server.exe");
    if (!existsSync(serverPath)) throw new Error(`包里没有 ${serverPath}`);
    saveSettings({ serverPath });
    finish({
      phase: "done",
      message: `引擎就绪：${baseName}${verified ? "" : "（未校验 sha256）"}`,
      detail: { serverPath, verified },
    });
    onInstalled?.("engine", { serverPath });
  }

  async function installEngine(options = {}) {
    if (job && !job.finishedAt) throw new Error("已有安装在进行");
    begin("engine", "引擎");
    try {
      // 预先下好的包：跳过探测与下载，只做校验与解压。网络不行时的出路。
      // App 只能读自己的目录与 app-data，所以包只能从 app-data 里拿；
      // 传相对名就从 incoming/ 找，传绝对路径则必须在 dataDir 下。
      const raw = typeof options.zipPath === "string" ? options.zipPath.trim() : "";
      if (raw) {
        const incoming = join(dataDir, "incoming");
        const zip = path.isAbsolute(raw) ? resolve(raw) : resolve(join(incoming, raw));
        const root = resolve(dataDir);
        if (!zip.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
          throw new Error(`安装包必须放在 ${incoming} 里再传文件名；App 只能读自己的目录与 app-data`);
        }
        if (!existsSync(zip)) throw new Error(`找不到安装包：${zip}`);
        if (!/\.zip$/i.test(zip)) throw new Error("安装包必须是 .zip");
        await installFromLocalZip(zip);
        return;
      }

      patch({ phase: "probing", message: "读显卡与驱动" });
      const preferCuda = options.preferCuda === "cu12" || options.preferCuda === "cu13" ? options.preferCuda : "auto";
      const gpu = await probeGpu();
      patch({
        phase: "release",
        message: gpu
          ? `${gpu.name} · 驱动 ${gpu.driver}${gpu.computeCapability ? ` · 算力 ${gpu.computeCapability}` : ""}`
          : "没读到显卡信息，按 cu13 选包（驱动不到 R580 就在自定义里选 cu12）",
        detail: gpu,
      });

      // 指定 tag 就装那个版本，不指定装最新。
      const tag = typeof options.tag === "string" && options.tag.trim() ? options.tag.trim() : null;
      const releaseUrl = tag
        ? `https://api.github.com/repos/${ENGINE_REPO}/releases/tags/${encodeURIComponent(tag)}`
        : ENGINE_API;
      const release = JSON.parse(await curlText(releaseUrl));
      const version = String(release.tag_name ?? "").replace(/^v/, "");
      if (!version) throw new Error("Release 没有可用的 tag");
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const { asset, cuda, sm75, variant } = pickEngineAsset(assets, version, gpu, preferCuda);
      patch({ message: `选中 ${asset.name}（${variant}）`, detail: { ...gpu, cuda, sm75, variant, version, tag: release.tag_name } });

      mkdirSync(engineDir, { recursive: true });
      const base = asset.name.replace(/\.zip$/, "");
      const target = join(engineDir, base);
      const zip = join(engineDir, `${base}.zip`);

      patch({ phase: "download", message: `下载 ${asset.name}（${mb(asset.size ?? 0)} MB）`, totalBytes: asset.size ?? 0 });
      await downloadViaRpc([{ url: asset.browser_download_url, out: `${base}.zip`, size: asset.size ?? 0 }], {
        dir: engineDir,
        concurrency: 1,
        totalBytes: asset.size ?? 0,
        onTick: ({ bytes, totalBytes, speed, connections, tasks }) =>
          patch({
            bytes,
            totalBytes,
            percent: totalBytes ? Math.min(99, Math.floor((bytes / totalBytes) * 100)) : 0,
            speed,
            connections,
            tasks,
          }),
      });

      patch({ phase: "verify", message: "校验 sha256" });
      const sumsUrl = asset.browser_download_url.replace(/[^/]+$/, "SHA256SUMS");
      let sums = "";
      try {
        sums = await curlText(sumsUrl);
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
      try {
        await runFile("tar", ["-xf", zip, "-C", engineDir], { timeout: 300_000, windowsHide: true });
      } catch (error) {
        const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 200);
        throw new Error(`解压失败：${detail}`);
      }
      rmSync(zip, { force: true });

      const serverPath = join(target, "bin", "moss-server.exe");
      if (!existsSync(serverPath)) throw new Error(`包里没有 ${serverPath}`);
      saveSettings({ serverPath });
      // 只有 Release 里没发 bundled 才会落到 system-cuda，那时得提醒一句。
      const variantNote = variant === "system-cuda" ? "；这个包不自带 CUDA 库，系统缺 cuBLASLt 会出不了图" : "";
      const drift = MOSSIMAGE.version === version ? "" : `；app/lib/mossimage.js 里还写着 ${MOSSIMAGE.version}`;
      finish({ phase: "done", message: `引擎就绪：${base}${drift}${variantNote}`, detail: { serverPath, version } });
      onInstalled?.("engine", { serverPath });
    } catch (error) {
      fail(error);
    }
  }

  async function installWeights(variant = "base") {
    if (job && !job.finishedAt) throw new Error("已有安装在进行");
    const key = MODELS[variant] ? variant : "base";
    const repo = MODELS[key].repo;
    const weightsDir = weightsTarget(key);
    begin("weights", `权重 · ${MODELS[key].label}`);
    try {
      patch({ phase: "listing", message: "读取文件清单" });
      const tree = JSON.parse(await curlText(`${MODEL_ENDPOINT}/api/models/${repo}/tree/main?recursive=true`));
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
        const entries = missing.map((entry) => ({
          urls: MODEL_ENDPOINTS.map((endpoint) => `${endpoint}/${repo}/resolve/main/${entry.path}`),
          out: entry.path,
          size: entry.size ?? 0,
        }));
        for (const entry of entries) mkdirSync(dirname(join(weightsDir, ...entry.out.split("/"))), { recursive: true });
        // aria2 先上（多源、多连接）。它完全起不来或个别文件反复失败，
        // 都不回退 curl——单连接不可能更快，进度也问不到。
        const outcome = await downloadViaRpc(entries, {
          dir: weightsDir,
          concurrency: 4,
          totalBytes,
          onTick: ({ bytes, totalBytes: total, done, total: count, speed, connections, tasks, failed: failedCount }) =>
            patch({
              bytes,
              totalBytes: total,
              percent: total ? Math.min(99, Math.floor((bytes / total) * 100)) : 0,
              speed,
              connections,
              tasks,
              files: [done, count],
              // 文件数、字节、速度都在结构化字段里，message 只说异常。
              message: failedCount ? `${failedCount} 个文件失败` : "",
            }),
        });
        const dead = outcome?.failed ?? [];
        if (dead.length && !cancelled) {
          const names = dead.slice(0, 3).map((entry) => `${entry.item.out}（aria2 ${entry.state.errorCode}）`);
          throw new Error(`${dead.length} 个文件下载失败：${names.join("、")}。重试会从断点续传。`);
        }
      }

      patch({ phase: "verify", message: "核对大小" });
      // 不能只看文件大小：aria2 默认会预分配，文件一开始就是满的，
      // 大小对得上不等于内容完整。控制文件还在 = 一定没下完。
      const broken = wanted.filter((entry) => {
        const target = join(weightsDir, ...entry.path.split("/"));
        if (!existsSync(target)) return true;
        if (existsSync(`${target}.aria2`)) return true;
        return statSync(target).size !== entry.size;
      });
      if (broken.length) throw new Error(`${broken.length} 个文件不完整：${broken.slice(0, 3).map((e) => e.path).join("、")}`);

      const paths = { ...(getSettings().modelPaths ?? {}), [key]: weightsDir };
      saveSettings({ modelPaths: paths, modelPath: weightsDir });
      finish({ phase: "done", message: `权重就绪：${wanted.length} 个文件`, detail: { modelPath: weightsDir, variant: key } });
      onInstalled?.("weights", { modelPath: weightsDir, variant: key });
    } catch (error) {
      fail(error);
    }
  }

  /** 可选的两个权重仓库，以及各自装没装、是不是当前生效的那个。 */
  function listModels() {
    const settings = getSettings();
    return Object.entries(MODELS).map(([variant, meta]) => {
      const dir = settings.modelPaths?.[variant] ?? null;
      const installed = Boolean(dir && existsSync(dir));
      return {
        variant,
        label: meta.label,
        note: meta.note,
        repo: meta.repo,
        installed,
        path: installed ? dir : null,
        bytes: installed ? dirBytes(dir) : null,
        // 组件明细：选模型时最常问的就是「这个 27 GB 到底花在哪」。
        components: installed ? modelComponents(dir) : null,
        active: installed && settings.modelPath === dir,
      };
    });
  }

  /** 目录里的几个模型组件各自多大。只认 diffusers 那套目录名。 */
  function modelComponents(dir) {
    const parts = [
      ["transformer", "DiT"],
      ["text_encoder", "文本编码器"],
      ["vae", "VAE"],
      ["tokenizer", "分词器"],
      ["scheduler", "调度器"],
    ];
    const rows = [];
    for (const [folder, label] of parts) {
      const sub = join(dir, folder);
      if (!existsSync(sub)) continue;
      rows.push({ label, bytes: dirBytes(sub) });
    }
    return rows.length ? rows : null;
  }

  return {
    /** 给 state() 用：没有安装任务时给最近一次的结果。 */
    snapshot() {
      const base = job ? { ...job } : null;
      return base ? { ...base, queue: pending.map((item) => item.label) } : { queue: pending.map((item) => item.label) };
    },
    enqueue,
    busy() {
      return Boolean(job && !job.finishedAt);
    },
    cancel() {
      if (!job || job.finishedAt) return false;
      // 取消就是全停：排着的也一起清掉，否则用户按了取消却又有新任务自己开始。
      pending = [];
      cancelled = true;
      child?.kill();
      patch({ phase: "cancelled", message: "已取消", finishedAt: new Date().toISOString() });
      return true;
    },
    installEngine,
    installWeights,
    taskAction,
    listEngines,
    listModels,
    listReleases,
    removeEngine,
    removeWeights,
    getSettings,
  };
}
