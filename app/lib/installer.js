// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/installer.js — 引擎与权重的下载安装。
 *
 * 两类文件都很大（引擎约 1 GB，权重 25 GiB），App 进程里的 sdk.network.fetch 有响应
 * 字节上限，够不着这种量级。所以下载交给 aria2c（随包在 vendor-bin/，多连接 + 自带重连）。
 * 小的文本请求（版本列表、目录树、SHA256SUMS）用 Node 自带的 fetch，不起外部进程。
 *
 * 下载进度走 aria2 的 JSON-RPC：任务用 aria2.addUri 下发，进度读引擎自报的
 * completedLength，失败有 errorCode，取消能逐任务 forceRemove，收尾用 aria2.shutdown
 * 让它自己退。不解析 stdout（动态行按 \r 切很脆），也不靠扫目录猜体积。
 * 调 RPC 用回环地址的 fetch。
 *
 * 装完只做一件事：把路径写进设置，让 Engine 那边直接用。
 */
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path, { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MOSSIMAGE } from "./mossimage.js";
import { unzipTo } from "./unzip.js";
import semver from "semver";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARIA2 = join(APP_ROOT, "vendor-bin", "aria2c.exe");

const ENGINE_REPO = "mossimage-cpp/mossimage.cpp";
const ENGINE_API = `https://api.github.com/repos/${ENGINE_REPO}/releases/latest`;

const MODEL_REPO = "OpenMOSS-Team/MOSS-Image-SFT";
/** 两个可选的权重仓库：SFT 是官方微调版，Base 是基座模型。 */
const MODELS = {
  sft: { repo: "OpenMOSS-Team/MOSS-Image-SFT", dir: "moss-image-sft", label: "MOSS-Image-SFT", note: "官方微调版，提示词响应更准", estimateBytes: 29_510_000_000 },
  base: { repo: "OpenMOSS-Team/MOSS-Image-Base", dir: "moss-image-base", label: "MOSS-Image-Base", note: "基座模型，适合自己微调", estimateBytes: 27_220_000_000 },
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

// 轻量包：只拿引擎识别模型必需的配置与分词器，加 VAE 权重（238 MB）。
// DiT 与文本编码器用单文件时，transformer/ 与 text_encoder/ 的权重根本不会被读
// （integration.md：a folder with only the configs and the tokenizer serves when all
// three files are given），保留 VAE 可以省掉第三个选择框。
const CONFIG_INCLUDES = [
  "model_index.json",
  "scheduler/*",
  "tokenizer/*",
  "vae/*",
  "transformer/config.json",
  "text_encoder/config.json",
];

/** CUDA 13 需要驱动 R580+；算力 7.5 只有 Windows cu13 的 sm75 包。 */
const CUDA13_MIN_DRIVER = 580;

/**
 * 文件的 sha256。
 *
 * 块开到 4 MB：默认的 64 KB 在 NVMe 上读不满带宽，同一块盘上 4.6 GiB
 * 用 64 KB 块比用 4 MB 块慢一倍以上。
 */
const sha256File = (file) =>
  new Promise((done, fail) => {
    const hash = crypto.createHash("sha256");
    createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", fail);
  });

/**
 * git blob 的 sha1：sha1("blob <size>\0" + 内容)。
 *
 * HF 对非 LFS 文件（config.json、tokenizer.json 这些）不给 lfs.oid，但给 git 的
 * oid，就是这个值。所以每个文件都能验，不存在只能看大小的死角。
 */
const gitBlobSha1 = (file, size) =>
  new Promise((done, fail) => {
    const hash = crypto.createHash("sha1");
    hash.update(`blob ${size}\u0000`);
    createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", fail);
  });

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0);
const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1);
const brief = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const runFile = promisify(execFile);

/**
 * 取一段文本（JSON、SHA256SUMS）。
 * 走 Node 自带的 fetch：不起外部进程，也不会在慢网络下卡住事件循环。
 * GitHub 的接口要求带 User-Agent，不带就是 403。
 */
async function fetchText(network, url, timeoutMs = 40_000) {
  let response;
  try {
    response = await network.fetch(url, { headers: { "user-agent": "hana-moss-studio" }, timeoutMs });
  } catch (error) {
    throw new Error(`取 ${url} 失败：${brief(error)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const hint = response.status === 403 || response.status === 429 ? "，可能是接口限流" : "";
    throw new Error(`取 ${url} 失败：HTTP ${response.status} ${response.statusText}${hint} ${body.slice(0, 160)}`.trim());
  }
  return await response.text();
}

/** XML 里的命名实体，够 atom 用。 */
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** 取一段 XML 里第一个同名标签的文本内容，去实体。 */
function firstTag(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]).trim() : "";
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

/** 校验值不符。单独一个类，靠类型区分「校验失败」与「拿不到校验值」，不靠错误文案。 */
class ChecksumMismatch extends Error {}

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

/**
 * dirBytes 的带缓存版。state() 每次推送都调 listEngines / listModels，
 * 而它们要把两个大目录递归 stat 一遍（模型 25 GiB、引擎 0.5 GB）。
 * 安装、删除与切换后由 invalidateSizes() 清掉。
 */
const sizeCache = new Map();
const SIZE_TTL_MS = 10_000;

function cachedBytes(dir) {
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.bytes;
  const bytes = dirBytes(dir);
  sizeCache.set(dir, { at: Date.now(), bytes });
  return bytes;
}

function invalidateSizes() {
  sizeCache.clear();
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

/**
 * 按版本号比大小，大的在前。
 *
 * 用 semver：手写的那版只看数字段，碰上 `2.1.1-rc1` 这种预发布版会把它与
 * `2.1.1` 判成相等，碰上 `v2.1.1` 或缺段的 `2.1` 也会算错。
 * `valid` 优先（保留预发布语义），不行再 `coerce`（容忍 v 前缀与缺段）。
 */
export function compareEngineVersion(a, b) {
  const parse = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    return semver.valid(text) ? semver.parse(text) : semver.coerce(text);
  };
  const left = parse(a);
  const right = parse(b);
  if (left && right) return semver.compare(left, right);
  if (left) return 1;
  if (right) return -1;
  return 0;
}

export function createInstaller({ dataDir, runtimeDir, getSettings, saveSettings, onUpdate, onInstalled, network }) {
  /**
   * 每个安装任务一份自己的状态，可以同时跑。
   * 任务之间不排队：文件全都丢给 aria2，并发由它的 -j4 管；这里只负责各自的进度。
   */
  const tasks = new Map();

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

  /** 自管清单里的「配置与分词器」目录：不随 SFT/Base 分身，两份内容完全一样。 */
  function configDirTarget() {
    return join(dataDir, "models", "moss-image-config");
  }

  /**
   * 装配置包：只拿 model_index、scheduler、tokenizer、vae 与两个组件的 config.json，
   * 约 258 MB。DiT 与文本编码器由单文件提供，所以这里不碰权重。
   */
  async function installConfigPack() {
    const repo = MODELS.sft.repo;
    const dir = configDirTarget();
    const task = makeTask("config", "配置与分词器");
    try {
      task.patch({ phase: "listing", message: "读取文件清单" });
      const tree = JSON.parse(await fetchText(network, `${MODEL_ENDPOINT}/api/models/${repo}/tree/main?recursive=true`));
      const wanted = (tree ?? []).filter((entry) => {
        if (entry.type !== "file") return false;
        return CONFIG_INCLUDES.some((pattern) =>
          pattern.endsWith("/*") ? entry.path.startsWith(pattern.slice(0, -1)) : entry.path === pattern,
        );
      });
      if (!wanted.length) throw new Error("清单为空，镜像可能不可用");
      mkdirSync(dir, { recursive: true });
      const totalBytes = wanted.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
      task.patch({ phase: "download", message: `${wanted.length} 个文件，共 ${gib(totalBytes)} GiB`, totalBytes, bytes: 0 });
      const entries = wanted.map((entry) => ({
        urls: MODEL_ENDPOINTS.map((endpoint) => `${endpoint}/${repo}/resolve/main/${entry.path}`),
        out: entry.path,
        size: entry.size ?? 0,
      }));
      for (const entry of entries) mkdirSync(dirname(join(dir, ...entry.out.split("/"))), { recursive: true });
      const outcome = await downloadViaRpc(task, entries, {
        dir,
        concurrency: 4,
        totalBytes,
        onTick: ({ bytes, totalBytes: total, done, total: count, speed, connections, files, failed: failedCount }) =>
          task.patch({
            bytes,
            totalBytes: total,
            percent: total ? Math.min(99, Math.floor((bytes / total) * 100)) : 0,
            speed,
            connections,
            tasks: files.map((file) => ({ ...file, ...where(dir, file.out) })),
            files: [done, count],
            message: failedCount ? `${failedCount} 个文件失败` : "",
          }),
      });
      const dead = outcome?.failed ?? [];
      if (dead.length && !task.cancelled) throw new Error(`${dead.length} 个文件下载失败，重试会续传`);
      const bad = await verifyWeights(task, wanted, dir);
      if (bad.length) throw new Error(`${bad.length} 个文件校验不过：${bad.slice(0, 3).map((e) => e.path).join("、")}`);
      saveSettings({ modelPath: dir, modelPaths: { ...(getSettings().modelPaths ?? {}), config: dir } });
      task.finish({ phase: "done", message: `配置就绪：${wanted.length} 个文件`, detail: { modelPath: dir } });
      onInstalled?.("config", { modelPath: dir });
    } catch (error) {
      task.fail(error);
    }
  }

  function removeConfigPack() {
    const dir = configDirTarget();
    if (!existsSync(dir)) throw new Error("没有已装配置包");
    rmSync(dir, { recursive: true, force: true });
    const settings = getSettings();
    const paths = { ...(settings.modelPaths ?? {}) };
    delete paths.config;
    const next = settings.modelPath === dir ? (settings.modelPaths?.base ?? "") : settings.modelPath;
    saveSettings({ modelPaths: paths, modelPath: next && existsSync(next) ? next : null });
    return true;
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
          bytes: cachedBytes(join(engineDir, entry.name)),
          ...parseEngineName(entry.name),
        };
      })
      .filter(Boolean)
      .sort((a, b) => compareEngineVersion(b.version, a.version));
  }

  /** 可装的引擎版本：Release 列表，标出哪些已经装了。缓存十分钟，不必每次开面板都拉一遍。 */
  let releaseCache = null;
  /** 上次拉到的版本列表。拉不到时靠它，存磁盘所以重启也在。 */
  function readReleaseCache(cacheFile) {
    try {
      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      return Array.isArray(raw?.items) && raw.items.length ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * 发布记录的 Atom feed。不限流，列版本靠它就够。
   *
   * tag 名从 <id> 尾部取（tag:github.com,2008:Repository/<id>/<tag>）。
   * <title> 是发布者自己写的标题，改过名字就跟 tag 没关系了，只当傅用。
   * 代价是没有资产体积和变体数——那两样只在真装某个版本时问一次 tag 接口。
   */
  async function listReleasesViaAtom() {
    const xml = await fetchText(network, `https://github.com/${ENGINE_REPO}/releases.atom`);
    const items = [];
    for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
      const block = match[1];
      const id = firstTag(block, "id");
      const title = firstTag(block, "title");
      const tag = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : title;
      if (!tag) continue;
      const publishedAt = firstTag(block, "updated") || null;
      items.push({
        tag,
        version: tag.replace(/^v/, ""),
        publishedAt,
        prerelease: false,
        windowsAssets: 0,
        bundledBytes: 0,
      });
    }
    return items;
  }

  async function listReleases() {
    const cacheFile = join(runtimeDir, "releases.json");
    if (!releaseCache || Date.now() - releaseCache.at > 10 * 60_000) {
      try {
        const items = await listReleasesViaAtom();
        if (!items.length) throw new Error("atom 里没有发布记录");
        releaseCache = { at: Date.now(), items };
        try {
          // .runtime-tmp 可能被宿主清掉，写之前补一次目录。
          mkdirSync(dirname(cacheFile), { recursive: true });
          writeFileSync(cacheFile, JSON.stringify({ at: releaseCache.at, items }), "utf8");
        } catch {
          // 写不进去不影响本次结果
        }
      } catch (error) {
        const cached = releaseCache?.items?.length ? releaseCache : readReleaseCache(cacheFile);
        if (!cached?.items?.length) throw new Error(`拿不到版本列表：${brief(error)}`);
        releaseCache = { ...cached, stale: true };
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
    invalidateSizes();
    return listEngines();
  }

  /** 删掉已装模型。25 GiB，调用方必须先确认。 */
  function removeWeights(variant = "base") {
    const key = MODELS[variant] ? variant : "base";
    const dir = getSettings().modelPaths?.[key];
    if (!dir || !existsSync(dir)) throw new Error("没有已装模型");
    rmSync(dir, { recursive: true, force: true });
    invalidateSizes();
    const paths = { ...(getSettings().modelPaths ?? {}), [key]: null };
    const active = getSettings().modelPath === dir ? (paths.sft ?? "") : getSettings().modelPath;
    saveSettings({ modelPaths: paths, modelPath: active });
    return true;
  }

  /**
   * 开始一个安装任务。
   *
   * 另外开一个「待办列表」是替 aria2 干活：它自己就是队列（-j4 管文件级并发，
   * -x16 -s16 管单文件连接）。这里只做一件事——把任务转交给它，忙的时候
   * 如实说一句「正在跑哪个」，不替用户排。
   */
  /**
   * 开一份任务状态。每个任务独立：自己的 job、取消标记、aria2 子进程和控制面。
   * 两个仓库同时下就是两个任务并行，不互相等。
   */
  function makeTask(target, label) {
    const task = {
      job: {
        id: `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
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
      },
      cancelled: false,
      child: null,
      /** aria2 会话的控制面：port、secret、gids（按落盘绝对路径索引）。 */
      control: null,
      patch(update) {
        // 收尾之后不再接受进度写入：取消那一刻可能还有一帧 onTick 在飞。
        if (task.job.finishedAt && !update.finishedAt) return;
        Object.assign(task.job, update);
        task.job.updatedAt = new Date().toISOString();
        onUpdate?.();
      },
      finish(update) {
        invalidateSizes();
        task.patch({ ...update, percent: 100, finishedAt: new Date().toISOString() });
      },
      fail(error) {
        task.patch({
          phase: task.cancelled ? "cancelled" : "error",
          error: task.cancelled ? null : error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      },
    };
    tasks.set(task.job.id, task);
    onUpdate?.();
    return task;
  }

  function enqueue(kind, args) {
    // installWeights 收 variant 加选项，installEngine 收参数对象。
    const run =
      kind === "engine"
        ? installEngine(args)
        : installWeights(args?.variant, { configOnly: Boolean(args?.configOnly) });
    run.catch(() => {});
    return { queued: false };
  }

  /**
   * 调 aria2 的 JSON-RPC。回环地址，fetch 直连。
   */
  async function aria2Call(port, secret, method, params = [], timeoutMs = 8000) {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "moss",
      method,
      params: [`token:${secret}`, ...params],
    });
    let response;
    try {
      response = await network.fetch(`http://127.0.0.1:${port}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        timeoutMs,
      });
    } catch (error) {
      throw new Error(`${method}：连不上 aria2（${brief(error)}）`);
    }
    let data;
    try {
      data = JSON.parse(await response.text());
    } catch {
      throw new Error(`${method}：RPC 返回不是 JSON`);
    }
    if (data.error) throw new Error(`${method}：${data.error.message}`);
    return data.result;
  }

  /** 起一个只当 RPC 服务端的 aria2c，端口冲突就换一个再试。 */
  async function startAria2Rpc(task, globalOptions) {
    let lastError = new Error("aria2 RPC 没有就绪");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (task.cancelled) throw new Error("已取消");
      const port = 6800 + Math.floor(Math.random() * 200);
      const secret = crypto.randomBytes(8).toString("hex");
      // aria2c 的 stderr 落一份盘，起不来的时候才有东西可看。
      let logFd = null;
      try {
        const logDir = join(runtimeDir, "downloads");
        mkdirSync(logDir, { recursive: true });
        logFd = openSync(join(logDir, "aria2.log"), "a");
      } catch {
        /* 写不了日志不影响干活 */
      }
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
        { windowsHide: true, stdio: logFd === null ? "ignore" : ["ignore", "ignore", logFd] },
      );
      let exited = false;
      proc.on("close", () => {
        exited = true;
      });
      proc.on("error", () => {
        exited = true;
      });
      task.child = proc;

      // 上一次 RPC 失败的原因要留住，否则只能看到「起不来」这种无用的结论。
      let detail = null;
      let ready = null;
      for (let i = 0; i < 40; i += 1) {
        if (exited) break;
        try {
          await aria2Call(port, secret, "aria2.getVersion", [], 3000);
          ready = { proc, port, secret, exited: () => exited };
          break;
        } catch (error) {
          detail = error;
          await sleep(150);
        }
      }
      if (logFd !== null) {
        try {
          closeSync(logFd);
        } catch {
          /* 已经关了 */
        }
      }
      if (ready) return ready;
      proc.kill();
      task.child = null;
      lastError = new Error(`aria2c 起不来或端口被占：${brief(detail ?? "进程没有起来")}`);
    }
    throw lastError;
  }

  async function stopAria2Rpc(task, session) {
    // 先请求它优雅退出，不退再杀；退不退都不影响已下好的文件。
    try {
      await aria2Call(session.port, session.secret, "aria2.shutdown", [], 2000);
    } catch {
      /* 进程可能已经没了 */
    }
    const deadline = Date.now() + 3000;
    while (!session.exited() && Date.now() < deadline) await sleep(100);
    if (!session.exited()) session.proc.kill();
    if (task.child === session.proc) task.child = null;
  }

  /**
   * 用 RPC 下一组文件。
   *
   * 返回值不带业务信息，进度走 onTick：字节数是引擎自报的，不用再给目标目录做快照差。
   * 失败直接抛，带上是哪个文件与 aria2 的错误码。
   */
  async function downloadViaRpc(task, entries, { dir, concurrency = 1, totalBytes = 0, onTick } = {}) {
    const session = await startAria2Rpc(task, [
      "-x16",
      "-s16",
      "-k1M",
      `-j${concurrency}`,
      // 不写 --file-allocation：预分配是 aria2 的本事。它会把 25 GiB 一次占好，
      // 磁盘不够当场报错，而不是下到一半才发现；写完也不会摊成一地碎片。
      // 关掉它的理由曾经是「文件大小要能反映进度」，而进度现在走 aria2 自报的
      // completedLength，这个理由不在了。
      "--max-tries=5",
      "--retry-wait=3",
      "--timeout=30",
      "--console-log-level=warn",
      "--summary-interval=0",
    ]);
    try {
      const items = [];
      for (const entry of entries) {
        if (task.cancelled) throw new Error("已取消");
        // 调用方给 urls（多个镜像）或单个 url（引擎包只有 GitHub 一个源）。
        const urls = entry.urls ?? (entry.url ? [entry.url] : []);
        const options = {
          dir,
          out: entry.out,
          continue: "true",
          // 默认开启时，目标文件已存在就会另存为 xxx.1.safetensors。
          // 那样“校验不过重下”会变成悄悄多下一份 4.6 GiB，原文件还坏着。
          "auto-file-renaming": "false",
        };
        if (entry.checksum) options.checksum = entry.checksum;
        const gid = await aria2Call(session.port, session.secret, "aria2.addUri", [urls, options]);
        items.push({ gid, out: entry.out, size: entry.size ?? 0, urls });
      }
      const total = totalBytes || items.reduce((sum, item) => sum + item.size, 0);
      task.control = {
        port: session.port,
        secret: session.secret,
        gids: new Map(items.map((item) => [join(dir, ...item.out.split("/")), item.gid])),
        // 暂停 / 继续会给下载换一个新 GID，操作完要把循环里那份也改掉，
        // 否则下一轮轮询就找不到这条下载，进度停住、再点一次又报 GID not found。
        items,
      };
      let stall = 0;
      let rpcFailures = 0;
      // 一条从没读到过状态的任务不能永远停在「下载中」：90 秒还一片空白就判它没起来。
      const startedAt = Date.now();
      let ticks = 0;
      let lastBytes = -1;
      let lastDone = -1;
      let speedAt = 0;
      let speed = 0;
      const failedIds = new Set();
      const completed = new Set();
      // 偶尔会有某一轮 RPC 返回不完整的字段（totalLength/completedLength 读成 0），
      // 直接把 0 发出去，面板就会闪一下「0 / 0B」。记住上一轮的值当兵底。
      const known = new Map();

      for (;;) {
        if (task.cancelled) {
          await Promise.all(
            items.map((item) =>
              aria2Call(session.port, session.secret, "aria2.forceRemove", [item.gid], 3000).catch(() => {}),
            ),
          );
          throw new Error("已取消");
        }
        if (ticks === 0 && Date.now() - startedAt > 90_000) {
          throw new Error("下载器没有响应：90 秒内没有任何进度（再点一次下载会重试）");
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
            // 传了 checksum 的文件下完要先把内容读一遍比对，这段时间 completedLength
            // 已经是满的但任务还没结束。不显示就会看着像卡住。
            "verifiedLength",
            "verifyIntegrityPending",
          ];
          const [active, waiting, stopped] = await Promise.all([
            aria2Call(session.port, session.secret, "aria2.tellActive", [keys], 6000),
            aria2Call(session.port, session.secret, "aria2.tellWaiting", [0, 1000, keys], 6000),
            aria2Call(session.port, session.secret, "aria2.tellStopped", [0, 1000, keys], 6000),
          ]);
          snapshot = new Map([...active, ...waiting, ...stopped].map((state) => [state.gid, state]));
          waitingStates = waiting;
        } catch (error) {
          // 这一轮没读到就跳过，不把上一轮的进度写成 0。
          // 但连续读不到说明 aria2 已经不在了，不能无限轮下去。
          rpcFailures += 1;
          if (rpcFailures >= 60) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`下载器无响应（连续 ${rpcFailures} 次读不到状态）：${reason}`);
          }
          continue;
        }
        rpcFailures = 0;
        ticks += 1;

        // 只统计 aria2 自报的 completedLength。查不到状态的按 0 算，绝不当已完成：
        // 新加的 gid 还没进 tellActive 时，当已完成会让进度一步跳到 100%。
        let bytes = 0;
        let done = 0;
        const failed = [];
        const paused = new Set();
        for (const item of items) {
          const state = snapshot.get(item.gid);
          if (!state) continue;
          bytes += Number(state.completedLength ?? 0);
          const st = state.status;
          if (st === "complete") {
            done += 1;
            completed.add(item.out);
          }
          // 用户手动暂停的既不算完成也不算失败，停在原地等继续。
          else if (st === "paused") paused.add(item.gid);
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
          const verifying = state.verifyIntegrityPending === "true";
          const task = {
            out: item.out,
            size: Number(state.totalLength ?? 0) || prev.size || item.size || 0,
            got: Number(state.completedLength ?? 0) || prev.got || 0,
            speed: Number(state.downloadSpeed ?? 0),
            status,
            verifying,
            verified: Number(state.verifiedLength ?? 0),
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
        onTick?.({ bytes, totalBytes: total, done, total: items.length, speed, connections, files: tasks, current: pendingItem?.out ?? null, failed: failed.length });

        // 字节和完成数都不再变超过三分钟，就当这条链路已经停了；不能无限等下去。
        // 有任务被用户暂停时不算停滞——那是用户主动让字节不动。
        const settled = done + failedIds.size + paused.size;
        if (bytes === lastBytes && settled === lastDone && paused.size === 0) stall += 1;
        else {
          stall = 0;
          lastBytes = bytes;
          lastDone = settled;
        }
        if (stall > 180) throw new Error(`下载停滞：${gib(bytes)} / ${gib(total)} GiB，${done}/${items.length} 个文件`);

        // 暂停的不算终态：循环得留着，aria2 也得活着，否则「继续」就没有会话可续。
        // 全部完成或失败才收尾（被移除的单条算失败）。
        if (done + failedIds.size === items.length) return { failed, completed };
      }
    } finally {
      task.control = null;
      await stopAria2Rpc(task, session);
    }
  }

  /**
   * 单任务操作：pause / unpause / remove。
   *
   * 界面上那一行给的是相对 dataDir 的路径（models/files/xxx.safetensors），
   * 而 gids 是按落盘绝对路径建的：两种都认，否则每次点都会回「找不到这个文件」。
   */
  async function taskAction(taskId, filePath, action) {
    const task = tasks.get(taskId);
    if (!task?.control) return { ok: false, error: "这个任务不在下载中" };
    const relative = String(filePath ?? "");
    const absolute = join(dataDir, ...relative.split(/[\\/]+/).filter(Boolean));
    const key = task.control.gids.has(relative) ? relative : absolute;
    const gid = task.control.gids.get(key);
    if (!gid) return { ok: false, error: "找不到这个文件" };
    const method =
      action === "pause" ? "aria2.pause" : action === "resume" ? "aria2.unpause" : "aria2.forceRemove";
    try {
      const result = await aria2Call(task.control.port, task.control.secret, method, [gid], 5000);
      // aria2 的 pause / unpause 会返回新的 GID（旧的就废了），两个地方都跟着换。
      const next = typeof result === "string" && result ? result : null;
      if (next && next !== gid) {
        task.control.gids.set(key, next);
        const item = task.control.items?.find((entry) => entry.gid === gid);
        if (item) item.gid = next;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 用本机已有的 zip 装：拿得到官方 SHA256SUMS 就校验，拿不到就照装并在结果里注明。 */
  async function installFromLocalZip(task, zip) {
    const baseName = zip.split(/[\\/]/).pop().replace(/\.zip$/i, "");
    const target = join(engineDir, baseName);
    task.patch({ phase: "verify", message: `用本地包 ${baseName}.zip` });

    let verified = false;
    try {
      // 本地包可能是旧版本，校验文件得去对应 tag 找，而不是最新那个。
      const version = parseEngineName(baseName).version;
      const tag = version ? `v${version}` : null;
      const release = tag
        ? JSON.parse(await fetchText(network, `https://api.github.com/repos/${ENGINE_REPO}/releases/tags/${encodeURIComponent(tag)}`))
        : JSON.parse(await fetchText(network, ENGINE_API));
      const sums = await fetchText(network, `https://github.com/${ENGINE_REPO}/releases/download/${release.tag_name}/SHA256SUMS`);
      const want = sums
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[1] === `${baseName}.zip`)?.[0];
      if (!want) throw new Error("官方校验文件里没有这个包");
      const got = await sha256File(zip);
      if (got.toLowerCase() !== want.toLowerCase()) {
        throw new ChecksumMismatch(`期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…`);
      }
      verified = true;
    } catch (error) {
      // 校验真不符就必须停下；拉不到校验值才允许跳过比对。
      if (error instanceof ChecksumMismatch) throw error;
      const text = String(error?.message ?? error);
      task.patch({ message: `拿不到官方校验值（${text.slice(0, 60)}），跳过比对` });
    }

    task.patch({ phase: "extracting", message: verified ? "校验通过，解压" : "解压（未校验）" });
    try {
      await unzipTo(zip, engineDir);
    } catch (error) {
      throw new Error(`解压失败：${String(error?.message ?? error).trim().slice(0, 200)}`);
    }

    const serverPath = join(target, "bin", "moss-server.exe");
    if (!existsSync(serverPath)) throw new Error(`包里没有 ${serverPath}`);
    saveSettings({ serverPath });
    task.finish({
      phase: "done",
      message: `引擎就绪：${baseName}${verified ? "" : "（未校验 sha256）"}`,
      detail: { serverPath, verified },
    });
    onInstalled?.("engine", { serverPath });
  }

  async function installEngine(options = {}) {
    const task = makeTask("engine", "引擎");
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
        await installFromLocalZip(task, zip);
        return;
      }

      task.patch({ phase: "probing", message: "读显卡与驱动" });
      const preferCuda = options.preferCuda === "cu12" || options.preferCuda === "cu13" ? options.preferCuda : "auto";
      const gpu = await probeGpu();
      task.patch({
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
      const release = JSON.parse(await fetchText(network, releaseUrl));
      const version = String(release.tag_name ?? "").replace(/^v/, "");
      if (!version) throw new Error("Release 没有可用的 tag");
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const { asset, cuda, sm75, variant } = pickEngineAsset(assets, version, gpu, preferCuda);
      task.patch({ message: `选中 ${asset.name}（${variant}）`, detail: { ...gpu, cuda, sm75, variant, version, tag: release.tag_name } });

      mkdirSync(engineDir, { recursive: true });
      const base = asset.name.replace(/\.zip$/, "");
      const target = join(engineDir, base);
      const zip = join(engineDir, `${base}.zip`);

      task.patch({ phase: "download", message: `下载 ${asset.name}（${mb(asset.size ?? 0)} MB）`, totalBytes: asset.size ?? 0 });
      await downloadViaRpc(task, [{ url: asset.browser_download_url, out: `${base}.zip`, size: asset.size ?? 0 }], {
        dir: engineDir,
        concurrency: 1,
        totalBytes: asset.size ?? 0,
        onTick: ({ bytes, totalBytes, speed, connections, files }) =>
          task.patch({
            bytes,
            totalBytes,
            percent: totalBytes ? Math.min(99, Math.floor((bytes / totalBytes) * 100)) : 0,
            speed,
            connections,
            tasks: files.map((file) => ({ ...file, ...where(engineDir, file.out) })),
          }),
      });

      task.patch({ phase: "verify", message: "校验 sha256" });
      const sumsUrl = asset.browser_download_url.replace(/[^/]+$/, "SHA256SUMS");
      let sums = "";
      let sumsError = null;
      try {
        sums = await fetchText(network, sumsUrl);
      } catch (error) {
        // 网络失败与「文件里没这一条」是两回事，不能都报成后者。
        sumsError = error instanceof Error ? error.message : String(error);
      }
      const want = sums
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[1] === asset.name)?.[0];
      if (!want) {
        throw new Error(
          sumsError
            ? `拿不到 SHA256SUMS：${sumsError.slice(0, 160)}`
            : `Release 里找不到 ${asset.name} 的 SHA256SUMS 条目`,
        );
      }
      const got = await sha256File(zip);
      if (got.toLowerCase() !== want.toLowerCase()) {
        throw new ChecksumMismatch(`期望 ${want}，实际 ${got}`);
      }

      task.patch({ phase: "extracting", message: "解压" });
      try {
        await unzipTo(zip, engineDir);
      } catch (error) {
        throw new Error(`解压失败：${String(error?.message ?? error).trim().slice(0, 200)}`);
      }
      rmSync(zip, { force: true });

      const serverPath = join(target, "bin", "moss-server.exe");
      if (!existsSync(serverPath)) throw new Error(`包里没有 ${serverPath}`);
      saveSettings({ serverPath });
      // 只有 Release 里没发 bundled 才会落到 system-cuda，那时得提醒一句。
      const variantNote = variant === "system-cuda" ? "；这个包不自带 CUDA 库，系统缺 cuBLASLt 会出不了图" : "";
      const drift = MOSSIMAGE.version === version ? "" : `；app/lib/mossimage.js 里还写着 ${MOSSIMAGE.version}`;
      task.finish({ phase: "done", message: `引擎就绪：${base}${drift}${variantNote}`, detail: { serverPath, version } });
      onInstalled?.("engine", { serverPath });
    } catch (error) {
      task.fail(error);
    }
  }

  /**
   * 用 HF 的 lfs.oid 逐个比 sha256，返回校验不过的条目。
   *
   * 不用 aria2 的 checksum 选项：它自带的 sha256 是纯软件实现，实测单文件
   * 4.65 GiB 要 63 秒（75 MB/s）；这边用 OpenSSL 的 SHA-NI，同一个文件 5.8 秒
   * （814 MB/s）。二十五 GiB 全量差出五分钟。下载全交给 aria2，只有哈希这一步归 Node。
   *
   * 四路并行能吃满 NVMe 的读带宽，二十个文件二十多秒跑完。没有 lfs.oid 的小文件
   * （普通 git blob）跳过——它们是配置与分词器，大小对了就够了。
   */
  async function verifyWeights(task, list, dir) {
    // 每个文件都有可比的值：LFS 文件给 sha256（lfs.oid），其余给 git blob 的 sha1（oid）。
    // 只有两者都缺的（不该出现）才退回大小判断。
    const targets = list
      .map((entry) => {
        const file = join(dir, ...entry.path.split("/"));
        if (entry.lfs?.oid) return { entry, file, algo: "sha256", want: String(entry.lfs.oid).toLowerCase() };
        if (entry.oid) return { entry, file, algo: "git", want: String(entry.oid).toLowerCase() };
        return null;
      })
      .filter(Boolean);
    const queue = [...targets];
    const bad = [];
    let checked = 0;
    const worker = async () => {
      for (;;) {
        if (task.cancelled) return;
        const item = queue.shift();
        if (!item) return;
        checked += 1;
        task.patch({ phase: "verify", message: `校验 ${checked}/${targets.length}` });
        let got = "";
        try {
          got = item.algo === "git" ? await gitBlobSha1(item.file, item.entry.size ?? 0) : await sha256File(item.file);
        } catch {
          got = "";
        }
        if (got !== item.want) bad.push(item.entry);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return bad;
  }

  /**
   * 下载任务落盘在哪个位置，相对 app-data。
   *
   * aria2 的 out 只是相对它那个 dir 的路径（transformer/xxx.safetensors），
   * 两个仓库的目录结构一样、文件名逐个对得上，光看这一串分不出落在哪。
   */
  function where(dir, out) {
    return {
      path: relative(dataDir, join(dir, ...out.split("/"))).replace(/\\/g, "/"),
      dir: relative(dataDir, dir).replace(/\\/g, "/"),
    };
  }

  /** 单文件权重与适配器的落盘位置：按 role 分开，文件名照发布包里的名字。 */
  function fileTarget(entry) {
    const base =
      entry.role === "control"
        ? join(dataDir, "control")
        : entry.role === "lora"
          ? join(dataDir, "loras")
          : join(dataDir, "models", "files");
    return join(base, entry.path.split("/").pop());
  }

  /** 发布页那张表：每个文件在哪、下没下、是不是当前在用的那个。 */
  function listFiles() {
    const settings = getSettings();
    // 单文件的 DiT / 文本编码器是 bundle 里那两份的量化替代品，
    // 带上 bundle 里对应组件的体积，界面才说得清「它替掉的是什么」。
    const activeDir = settings.modelPath && existsSync(settings.modelPath) ? settings.modelPath : null;
    // 轻量配置包里没有权重，跟它比体积没有意义（DiT 只会有 config.json 的 240 字节）。
    const parts = activeDir && hasDitWeights(activeDir) ? modelComponents(activeDir) : [];
    const bundle = (role) => {
      const label = role === "dit" ? "DiT" : role === "text_encoder" ? "文本编码器" : role === "vae" ? "VAE" : null;
      if (!label) return null;
      const part = parts.find((item) => item.label === label);
      return part ? { label, bytes: part.bytes } : null;
    };
    return (MOSSIMAGE.files ?? []).map((entry) => {
      const target = fileTarget(entry);
      let installed = false;
      try {
        // aria2 会先预分配：文件大小对不代表下完了，旁边还挂着 .aria2 控制文件就是没完。
        installed = existsSync(target) && (!entry.bytes || statSync(target).size === entry.bytes) && !existsSync(`${target}.aria2`);
      } catch {
        installed = false;
      }
      const active =
        entry.role === "control"
          ? settings.defaults?.control?.adapter === target
          : entry.role === "lora"
            ? (settings.defaults?.loras ?? []).some((item) => item.path === target)
            : entry.role === "dit"
              ? settings.modelFiles?.dit === target
              : entry.role === "text_encoder"
                ? settings.modelFiles?.textEncoder === target
                : settings.modelFiles?.vae === target;
      return { ...entry, target, installed, active, bundle: bundle(entry.role) };
    });
  }

  /** 下来的文件怎么生效：适配器进库，权重进 modelFiles。 */
  function applyFile(entry, target) {
    const settings = getSettings();
    const defaults = settings.defaults ?? {};
    if (entry.role === "control") {
      saveSettings({ defaults: { ...defaults, control: { ...(defaults.control ?? {}), adapter: target } } });
      return;
    }
    if (entry.role === "lora") {
      const loras = [...(defaults.loras ?? [])];
      if (!loras.some((item) => item.path === target)) loras.push({ path: target, strength: 1, enabled: true });
      saveSettings({ defaults: { ...defaults, loras } });
      return;
    }
    const key = entry.role === "dit" ? "dit" : entry.role === "text_encoder" ? "textEncoder" : "vae";
    saveSettings({
      modelFiles: { ...(settings.modelFiles ?? {}), [key]: target },
      // 单文件 DiT 自带档位要求（INT4 只跑 turbo，INT8 只跑 high），一并切过去。
      ...(entry.role === "dit" && entry.tier ? { tier: entry.tier } : {}),
    });
  }

  /** 这个路径的单文件 DiT 需要哪个档位（不认识就 null）。 */
  function fileTier(target) {
    if (!target) return null;
    const entry = (MOSSIMAGE.files ?? []).find((item) => fileTarget(item) === target);
    return entry?.tier ?? null;
  }

  /**
   * 把档位拉回和当前 DiT 一致。
   * 引擎对错配的组合不会在 load 时拒绝，而是跑到 generate 才回 invalid_argument，
   * 所以启动时先对一下，不留一个“看着能用、一按就错”的状态。
   */
  function reconcileTier() {
    const settings = getSettings();
    const need = fileTier(settings.modelFiles?.dit ?? "");
    if (!need || settings.tier === need) return null;
    saveSettings({ tier: need });
    return { from: settings.tier, to: need };
  }

  /** 下一个单文件：aria2 多源、断点续传，完事对一下大小，然后写进设置。 */
  async function installFile(id) {
    const entry = (MOSSIMAGE.files ?? []).find((item) => item.id === id);
    if (!entry) throw new Error(`没有这个文件：${id}`);
    const task = makeTask("file", entry.name);
    try {
      const target = fileTarget(entry);
      mkdirSync(dirname(target), { recursive: true });
      const out = target.split(path.sep).pop();
      task.patch({ phase: "download", message: entry.note ?? "", totalBytes: entry.bytes ?? 0, bytes: 0 });
      await downloadViaRpc(
        task,
        [
          {
            urls: MODEL_ENDPOINTS.map((endpoint) => `${endpoint}/${entry.repo}/resolve/main/${entry.path}`),
            out,
            size: entry.bytes ?? 0,
          },
        ],
        {
          dir: dirname(target),
          concurrency: 4,
          totalBytes: entry.bytes ?? 0,
          onTick: ({ bytes, totalBytes, speed, connections, files, done, total }) =>
            task.patch({
              bytes,
              totalBytes: totalBytes || entry.bytes || 0,
              percent: entry.bytes ? Math.min(99, Math.floor((bytes / entry.bytes) * 100)) : 0,
              speed,
              connections,
              tasks: files.map((file) => ({ ...file, ...where(dirname(target), file.out) })),
              files: [done, total],
            }),
        },
      );
      if (task.cancelled) throw new Error("已取消");
      const size = statSync(target).size;
      if (entry.bytes && size !== entry.bytes) {
        throw new Error(`大小不对：${size} ≠ ${entry.bytes}，重新下载会续传`);
      }
      applyFile(entry, target);
      task.finish({ phase: "done", message: "已装好并启用", bytes: size, totalBytes: size });
    } catch (error) {
      task.fail(error);
    }
  }

  /** 已下好的单文件切成当前在用：适配器进库、权重进 modelFiles。 */
  function useFile(id) {
    const entry = (MOSSIMAGE.files ?? []).find((item) => item.id === id);
    if (!entry) throw new Error(`没有这个文件：${id}`);
    const target = fileTarget(entry);
    if (!existsSync(target)) throw new Error("这个文件还没下载");
    applyFile(entry, target);
    return { ok: true, id, target };
  }

  /**
   * 删一个单文件权重 / 适配器。
   *
   * 先删文件，再存一遍设置：归一化会把指向不存在文件的条目摘掉
   * （modelFiles、LoRA 库、控制适配器都靠这一手），同时发一次 settings 事件，
   * 侧栏不用等到下一帧才知道适配器没了。
   */
  function removeFile(id) {
    const entry = (MOSSIMAGE.files ?? []).find((item) => item.id === id);
    if (!entry) throw new Error(`没有这个文件：${id}`);
    const target = fileTarget(entry);
    if (!existsSync(target)) throw new Error("这个文件还没下载");
    rmSync(target, { force: true });
    const settings = getSettings();
    saveSettings({ modelFiles: settings.modelFiles, defaults: settings.defaults });
    return { ok: true, id, target };
  }

  async function installWeights(variant = "base", options = {}) {
    const key = MODELS[variant] ? variant : "base";
    const configOnly = Boolean(options.configOnly);
    const repo = MODELS[key].repo;
    const weightsDir = weightsTarget(key);
    const task = makeTask(configOnly ? "config" : "weights", `${configOnly ? "配置" : "权重"} · ${MODELS[key].label}`);
    try {
      task.patch({ phase: "listing", message: "读取文件清单" });
      const tree = JSON.parse(await fetchText(network, `${MODEL_ENDPOINT}/api/models/${repo}/tree/main?recursive=true`));
      const patterns = configOnly ? CONFIG_INCLUDES : MODEL_INCLUDES;
      const wanted = (tree ?? []).filter((entry) => {
        if (entry.type !== "file") return false;
        return patterns.some((pattern) =>
          pattern.endsWith("/*") ? entry.path.startsWith(pattern.slice(0, -1)) : entry.path === pattern,
        );
      });
      if (!wanted.length) throw new Error("清单为空，镜像可能不可用");

      mkdirSync(weightsDir, { recursive: true });
      // 全部交给 aria2。addUri 带 continue=true 时它自己会看 .aria2 控制文件与
      // 本地大小：完整的直接完成为 complete，没下完的续传。在这之前先算一遍
      // 「缺哪些」是把同一件事做第二遍，还会和 aria2 的判断打架——
      // 预分配或最后一段先落盘时，文件大小已经是目标值，控制文件却还在。
      const totalBytes = wanted.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
      task.patch({
        phase: "download",
        message: `${wanted.length} 个文件，共 ${gib(totalBytes)} GiB`,
        totalBytes,
        bytes: 0,
      });

      {
        const entries = wanted.map((entry) => ({
          urls: MODEL_ENDPOINTS.map((endpoint) => `${endpoint}/${repo}/resolve/main/${entry.path}`),
          out: entry.path,
          size: entry.size ?? 0,
        }));
        for (const entry of entries) mkdirSync(dirname(join(weightsDir, ...entry.out.split("/"))), { recursive: true });
        // aria2 先上（多源、多连接）。它完全起不来或个别文件反复失败，
        // 都不回退 curl——单连接不可能更快，进度也问不到。
        const outcome = await downloadViaRpc(task, entries, {
          dir: weightsDir,
          concurrency: 4,
          totalBytes,
          onTick: ({ bytes, totalBytes: total, done, total: count, speed, connections, files, failed: failedCount }) =>
            task.patch({
              bytes,
              totalBytes: total,
              percent: total ? Math.min(99, Math.floor((bytes / total) * 100)) : 0,
              speed,
              connections,
              // 两个仓库的文件名一模一样（transformer/... 那套目录结构相同），
              // 队列里只靠相对路径分不出是哪个仓库的。带上 variant 与落盘路径。
              tasks: files.map((file) => ({ ...file, variant: key, ...where(weightsDir, file.out) })),
              files: [done, count],
              // 文件数、字节、速度都在结构化字段里，message 只说异常。
              message: failedCount ? `${failedCount} 个文件失败` : "",
            }),
        });
        const dead = outcome?.failed ?? [];
        if (dead.length && !task.cancelled) {
          const names = dead.slice(0, 3).map((entry) => `${entry.item.out}（aria2 ${entry.state.errorCode}）`);
          throw new Error(`${dead.length} 个文件下载失败：${names.join("、")}。重试会从断点续传。`);
        }
      }

      // 下载完了不代表内容对：预分配、断点续传、磁盘写入都可能留下一个大小对、内容坏的文件。
      // 按 lfs.oid 过一遍 sha256，不对的删了重下一遍。
      let bad = await verifyWeights(task, wanted, weightsDir);
      if (bad.length) {
        if (task.cancelled) throw new Error("已取消");
        task.patch({ phase: "download", message: `${bad.length} 个文件校验不过，重新下` });
        for (const entry of bad) rmSync(join(weightsDir, ...entry.path.split("/")), { force: true });
        await downloadViaRpc(task, 
          bad.map((entry) => ({
            urls: MODEL_ENDPOINTS.map((endpoint) => `${endpoint}/${repo}/resolve/main/${entry.path}`),
            out: entry.path,
            size: entry.size ?? 0,
          })),
          {
            dir: weightsDir,
            concurrency: 4,
            totalBytes: bad.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
            onTick: ({ bytes, totalBytes: total, files }) =>
              task.patch({
                bytes,
                totalBytes: total,
                percent: total ? Math.min(99, Math.floor((bytes / total) * 100)) : 0,
                tasks: files.map((file) => ({ ...file, variant: key, ...where(weightsDir, file.out) })),
              }),
          },
        );
        bad = await verifyWeights(task, bad, weightsDir);
        if (bad.length) {
          throw new Error(`重下后仍有 ${bad.length} 个文件校验不过：${bad.slice(0, 3).map((e) => e.path).join("、")}`);
        }
      }

      const paths = { ...(getSettings().modelPaths ?? {}), [key]: weightsDir };
      saveSettings({ modelPaths: paths, modelPath: weightsDir });
      task.finish({
        phase: "done",
        message: `${configOnly ? "配置" : "权重"}就绪：${wanted.length} 个文件`,
        detail: { modelPath: weightsDir, variant: key, configOnly },
      });
      onInstalled?.("weights", { modelPath: weightsDir, variant: key, configOnly });
    } catch (error) {
      task.fail(error);
    }
  }

  /** 这个目录里有没有 DiT 权重：没有就是只下了配置的轻量包。 */
  function hasDitWeights(dir) {
    try {
      return readdirSync(join(dir, "transformer")).some((name) => /^diffusion_pytorch_model.*\.safetensors$/i.test(name));
    } catch {
      return false;
    }
  }

  /**
   * 当前模型是轻量包（只有配置与分词器/VAE）时缺哪几个单文件权重。
   * 全部包 try/catch：这只为一个提示服务，读不出来的目录不能把整帧 state 拖挂。
   */
  function liteModelGaps(settings) {
    try {
      const dir = settings?.modelPath;
      if (!dir || !existsSync(dir)) return null;
      if (hasDitWeights(dir)) return null;
      const missing = [];
      if (!settings.modelFiles?.dit) missing.push("DiT");
      if (!settings.modelFiles?.textEncoder) missing.push("文本编码器");
      return { lite: true, missing };
    } catch {
      return null;
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
        bytes: installed ? cachedBytes(dir) : null,
        // 没装时也要说个大概：两个仓库体积不同，不能拿同一个数糊弄。
        estimate: meta.estimateBytes ?? null,
        // 组件明细：选模型时最常问的就是「这个 27 GB 到底花在哪」。
        components: installed ? modelComponents(dir) : null,
        active: installed && settings.modelPath === dir,
        // 只下了配置的轻量包：DiT 与文本编码器得靠单文件，界面要说清楚。
        lite: installed ? !hasDitWeights(dir) : false,
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
      rows.push({ label, bytes: cachedBytes(sub) });
    }
    return rows.length ? rows : null;
  }

  /** 自检：真的把 aria2 拉起来并问一句版本，出错时带回真实原因。 */
  async function diagRpc() {
    const session = await startAria2Rpc(task, ["--console-log-level=warn", "--summary-interval=0"]);
    try {
      const version = await aria2Call(session.port, session.secret, "aria2.getVersion", [], 3000);
      return { ok: true, port: session.port, version: version?.version ?? null, exe: ARIA2 };
    } finally {
      await stopAria2Rpc(task, session);
    }
  }

  return {
    /**
     * 给 state() 用：所有还在跑的任务，加上一分钟内刚收尾的（让界面能看到结果）。
     * 没有任务时返回空数组，不返回一个字段残缺的空壳。
     */
    snapshot() {
      const now = Date.now();
      const live = [];
      for (const task of tasks.values()) {
        const job = task.job;
        if (job.finishedAt) {
          const age = now - Date.parse(job.finishedAt);
          if (Number.isFinite(age) && age > 60_000) {
            tasks.delete(job.id);
            continue;
          }
        }
        live.push({ ...job });
      }
      return live.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    },
    enqueue,
    diagRpc,
    busy() {
      for (const task of tasks.values()) if (!task.job.finishedAt) return true;
      return false;
    },
    cancel(id) {
      const task = tasks.get(id);
      if (!task || task.job.finishedAt) return false;
      task.cancelled = true;
      task.child?.kill();
      // 残留的活跃任务跟着落成终态，否则收尾后那一条还挂着最后一帧速度和进度。
      const files = (task.job.tasks ?? []).map((file) =>
        file.status === "active" || file.status === "waiting" ? { ...file, status: "removed", speed: 0 } : file,
      );
      task.patch({ phase: "cancelled", message: "已取消", finishedAt: new Date().toISOString(), tasks: files });
      return true;
    },
    installEngine,
    installWeights,
    installFile,
    listFiles,
    useFile,
    removeFile,
    fileTier,
    reconcileTier,
    liteModelGaps,
    installConfigPack,
    removeConfigPack,
    configDirTarget,
    taskAction,
    listEngines,
    listModels,
    listReleases,
    removeEngine,
    removeWeights,
    getSettings,
  };
}
