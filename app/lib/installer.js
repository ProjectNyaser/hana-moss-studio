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
      ["-sL", "--fail", "--retry", "3", "--connect-timeout", "20", url],
      { timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 200);
    throw new Error(`取 ${url} 失败：${detail}`);
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

  const engineDir = join(dataDir, "engine");

  /**
   * 已有可用模型就装在原处，不另开一份 25 GiB 的副本。
   * 判据只看目录在不在：缺一两个文件也应该就地补齐，换目录等于把整份重下一遍。
   */
  function weightsTarget() {
    const existing = getSettings().modelPath;
    if (existing && existsSync(existing)) return existing;
    return join(dataDir, "models", "moss-image-sft");
  }

  /**
   * 已装引擎清单。旧版本装完不删，回滚就是在这里切回去。
   * 只列真带 bin/moss-server.exe 的目录，半途而废的解压残留不会冒充可用版本。
   */
  function listEngines() {
    if (!existsSync(engineDir)) return [];
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

  /**
   * curl 逐文件下载，作为 aria2 失败后的回退。
   * 在宿主里 aria2 的直连 socket 有时走不通，而 curl.exe 同一个地址能取——
   * 那种环境下宁可慢也不能停。
   */
  async function curlDownload(url, target, size) {
    const have = existsSync(target) ? statSync(target).size : 0;
    if (have === size) return;
    mkdirSync(dirname(target), { recursive: true });
    await runFile(
      "curl.exe",
      [
        "-L",
        "--fail",
        "-C",
        "-",
        "--retry",
        "10",
        "--retry-all-errors",
        "--retry-delay",
        "3",
        "--connect-timeout",
        "20",
        "--speed-time",
        "90",
        "--speed-limit",
        "10240",
        "-o",
        target,
        url,
      ],
      { timeout: 0, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const got = existsSync(target) ? statSync(target).size : 0;
    rmSync(`${target}.aria2`, { force: true });
    if (got !== size) throw new Error(`大小不符：期望 ${size}，实际 ${got}`);
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
      "--max-tries=3",
      "--retry-wait=3",
      "--lowest-speed-limit=10K",
      "--timeout=30",
      "--console-log-level=warn",
      "--summary-interval=0",
    ]);
    try {
      const items = [];
      for (const entry of entries) {
        if (cancelled) throw new Error("已取消");
        const gid = await aria2Call(session.port, session.secret, "aria2.addUri", [
          [entry.url],
          { dir, out: entry.out, continue: "true" },
        ]);
        items.push({ gid, out: entry.out, size: entry.size ?? 0 });
      }
      const total = totalBytes || items.reduce((sum, item) => sum + item.size, 0);
      let stall = 0;
      let lastBytes = -1;
      let lastDone = -1;

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
        try {
          const keys = ["gid", "status", "completedLength", "totalLength", "errorCode", "errorMessage"];
          const [active, waiting, stopped] = await Promise.all([
            aria2Call(session.port, session.secret, "aria2.tellActive", [keys], 6000),
            aria2Call(session.port, session.secret, "aria2.tellWaiting", [0, 1000, keys], 6000),
            aria2Call(session.port, session.secret, "aria2.tellStopped", [0, 1000, keys], 6000),
          ]);
          snapshot = new Map([...active, ...waiting, ...stopped].map((state) => [state.gid, state]));
        } catch {
          // 这一轮没读到就跳过，不把上一轮的进度写成 0。
          continue;
        }

        let bytes = 0;
        let done = 0;
        const failed = [];
        for (const item of items) {
          const state = snapshot.get(item.gid);
          if (!state) {
            bytes += item.size;
            continue;
          }
          bytes += Number(state.completedLength ?? 0);
          if (state.status === "complete") done += 1;
          else if (state.status === "error") failed.push({ item, state });
        }
        onTick?.({ bytes, totalBytes: total, done, total: items.length });

        // 字节和完成数都不再变超过三分钟，就当这条链路已经停了；不能无限等下去。
        if (bytes === lastBytes && done === lastDone) stall += 1;
        else {
          stall = 0;
          lastBytes = bytes;
          lastDone = done;
        }
        if (stall > 180) throw new Error(`下载停滞：${gib(bytes)} / ${gib(total)} GiB，${done}/${items.length} 个文件`);

        if (failed.length) {
          const { item, state } = failed[0];
          throw new Error(`${item.out} 下载失败（aria2 ${state.errorCode}）：${state.errorMessage ?? ""}`.trim());
        }
        if (done === items.length) return;
      }
    } finally {
      await stopAria2Rpc(session);
    }
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

  /** 用本机已有的 zip 装：拿得到官方 SHA256SUMS 就校验，拿不到就照装并在结果里注明。 */
  async function installFromLocalZip(zip) {
    const baseName = zip.split(/[\\/]/).pop().replace(/\.zip$/i, "");
    const target = join(engineDir, baseName);
    patch({ phase: "verify", message: `用本地包 ${baseName}.zip` });

    let verified = false;
    try {
      const release = JSON.parse(await curlText(ENGINE_API));
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

      const release = JSON.parse(await curlText(ENGINE_API));
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
      try {
        await downloadViaRpc([{ url: asset.browser_download_url, out: `${base}.zip`, size: asset.size ?? 0 }], {
          dir: engineDir,
          concurrency: 1,
          totalBytes: asset.size ?? 0,
          onTick: ({ bytes, totalBytes }) => patch({ bytes, totalBytes }),
        });
      } catch (error) {
        if (cancelled) throw error;
        // 宿主里 aria2 的直连 socket 可能走不通，而 curl 同一个地址能取。
        patch({ phase: "download", message: `aria2 走不通，改用 curl：${brief(error)}` });
        const probeZip = () => (existsSync(zip) ? statSync(zip).size : 0);
        const stopWatch = watchProgress(probeZip, asset.size ?? 0);
        try {
          await curlDownload(asset.browser_download_url, zip, asset.size ?? 0);
        } finally {
          stopWatch();
        }
      }

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

  async function installWeights() {
    if (job && !job.finishedAt) throw new Error("已有安装在进行");
    const weightsDir = weightsTarget();
    begin("weights", "权重");
    try {
      patch({ phase: "listing", message: "读取文件清单" });
      const tree = JSON.parse(await curlText(`${MODEL_ENDPOINT}/api/models/${MODEL_REPO}/tree/main?recursive=true`));
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
          url: `${MODEL_ENDPOINT}/${MODEL_REPO}/resolve/main/${entry.path}`,
          out: entry.path,
          size: entry.size ?? 0,
        }));
        for (const entry of entries) mkdirSync(dirname(join(weightsDir, ...entry.out.split("/"))), { recursive: true });
        try {
          await downloadViaRpc(entries, {
            dir: weightsDir,
            concurrency: 4,
            totalBytes,
            onTick: ({ bytes, totalBytes: total, done, total: count }) =>
              patch({
                bytes,
                totalBytes: total,
                message: `${done}/${count} 个文件 · ${gib(bytes)} / ${gib(total)} GiB`,
              }),
          });
        } catch (error) {
          if (cancelled) throw error;
          patch({ phase: "download", message: `aria2 走不通，改用 curl 逐个下：${brief(error)}` });
          const baseBytes = dirBytes(weightsDir);
          const stopWatch = watchProgress(() => Math.max(0, dirBytes(weightsDir) - baseBytes), totalBytes);
          try {
            for (const entry of entries) {
              if (cancelled) throw new Error("已取消");
              await curlDownload(entry.url, join(weightsDir, ...entry.out.split("/")), entry.size);
            }
          } finally {
            stopWatch();
          }
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
      onInstalled?.("weights", { modelPath: weightsDir });
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
    listEngines,
    getSettings,
  };
}
