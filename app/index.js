import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { Engine, buildGenerateParams } from "./lib/engine.js";
import { clamp, clampFloat, createStore } from "./lib/store.js";
import { capabilityMap, menuValues, readGeneration, readLayout, VALUES } from "./lib/params.js";
import { MOSSIMAGE, MODEL_BYTES } from "./lib/mossimage.js";
import { createInstaller, probeGpu, probeGpuDetailed } from "./lib/installer.js";
import { shrinkToWebp } from "./lib/image.js";
import { createSession } from "./lib/session.js";
import { checkpointPaths, readCheckpoint, runLatentGenerate, runLatentInpaint, writePng } from "./lib/latent.js";
import { decode as decodePng } from "fast-png";
import { readPngText, readStudioMeta, writePngMeta } from "./lib/outputs.js";

export const name = "hana-moss-studio";

/** 名单里的 id 与版本以 manifest 为准，别再在代码里写一份。 */
const MANIFEST = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const APP_ID = MANIFEST.id;
const APP_VERSION = MANIFEST.version;
/** 流内进度卡的页面路由（静态）；卡的身份经宿主 surface 上下文里的 cardInstanceId 反查任务。 */
const CARD_ROUTE = "/task.html";
const CAP_TASKS = "app/tasks.manage";
const CAP_START_TURN = "app/session.start-turn";
/** 采样阶段顺序，卡片的阶段时间轴按这个顺序点亮。 */
const PHASE_ORDER = ["text_encoder", "dit_load", "denoise", "decode"];
// 步数下限只留 1：高分辨率要多少步得实测出来，不按 768px 的经验一刀切。
const MIN_STEPS = 1;
const PHASE_LABEL = { text_encoder: "文本编码", dit_load: "加载模型", denoise: "去噪采样", decode: "解码出图" };
/** 内存里保留的活跃任务数；更早的任务只剩台账记录。 */
const LIVE_LIMIT = 40;
/** 宿主任务进度写回的最小间隔，避免逐步刷写。 */
const TASK_SYNC_MS = 1200;
const STATUS_TEXT = {
  queued: "排队中",
  running: "生成中",
  done: "已完成",
  error: "失败",
  cancelled: "已取消",
};

/**
 * 早期的缓存与 aria2 日志写在 dataDir 顶层，后来挤在 .runtime-tmp/cache，现在按种类分开。
 * 引擎的文本编码器缓存搬过去还能接着用，日志与旧预览直接删。
 */
function migrateRuntimeDirs(dataDir, { engineCacheDir, previewDir, thumbsDir, runtimeDir }) {
  const legacyTop = ["cache", "logs"];
  for (const name of legacyTop) {
    const from = join(dataDir, name);
    if (!existsSync(from)) continue;
    rmSync(from, { recursive: true, force: true });
  }

  const flat = join(runtimeDir, "cache");
  if (!existsSync(flat)) return;
  for (const entry of readdirSync(flat, { withFileTypes: true })) {
    const from = join(flat, entry.name);
    // .miemb 与硬件探测结果属于引擎缓存。
    if (entry.name.endsWith(".miemb") || entry.name === "hardware_profile.json") {
      try {
        renameSync(from, join(engineCacheDir, entry.name));
      } catch {
        /* 搬不动就留着，下次启动再试 */
      }
      continue;
    }
    if (entry.name.startsWith("preview")) {
      try {
        renameSync(from, join(previewDir, entry.name));
      } catch {
        /* 同上 */
      }
      continue;
    }
    if (entry.name === "thumbs") {
      for (const thumb of readdirSync(from)) {
        try {
          renameSync(join(from, thumb), join(thumbsDir, thumb));
        } catch {
          /* 同上 */
        }
      }
      continue;
    }
    // releases.json 等小件直接搬到 .runtime-tmp 根上。
    try {
      renameSync(from, join(runtimeDir, entry.name));
    } catch {
      /* 同上 */
    }
  }
  rmSync(flat, { recursive: true, force: true });
}

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const outputsDir = join(dataDir, "generated");
  // 运行时产物按种类分开放，都在 .runtime-tmp 下。查问题时一眼能看出哪一堆是什么，
  // 清理也能按堆清：miemb 删了只是重算，thumbs 删了只是重缩。
  const runtimeDir = join(dataDir, ".runtime-tmp");
  /** 引擎自己的缓存：文本编码器嵌入（.miemb）与硬件探测结果。 */
  const engineCacheDir = join(runtimeDir, "miemb");
  /** 采样预览：引擎每次重写同一对文件。 */
  const previewDir = join(runtimeDir, "preview");
  /** 画廊缩略图。 */
  const thumbsDir = join(runtimeDir, "thumbs");
  /** 下载器的日志与控制文件。 */
  const downloadsDir = join(runtimeDir, "downloads");
  /** 参考图与蒙版：界面按目标尺寸画好再传上来，任务只引用这里的绝对路径。 */
  // 底图与参考图是用户资产：放 app-data，不跟运行期临时目录一起清。
  const inputsDir = join(dataDir, "inputs");
  /** 导入的 LoRA：放 app-data 里，路径稳定，换工作区也找得到。 */
  const lorasDir = join(dataDir, "loras");
  /** 控制适配器（depth / canny 那一类）：单独一堆，别跟 LoRA 混。 */
  const controlDir = join(dataDir, "control");
  for (const dir of [outputsDir, engineCacheDir, previewDir, thumbsDir, downloadsDir, inputsDir, lorasDir, controlDir]) {
    mkdirSync(dir, { recursive: true });
  }
  migrateRuntimeDirs(dataDir, { engineCacheDir, previewDir, thumbsDir, runtimeDir });
  // 上一版把上传的图放在临时目录里，重启会被清掉，这里搬到持久位置。
  try {
    const legacyInputs = join(runtimeDir, "inputs");
    if (existsSync(legacyInputs)) {
      for (const name of readdirSync(legacyInputs)) {
        const from = join(legacyInputs, name);
        const to = join(inputsDir, name);
        if (!existsSync(to)) {
          try {
            renameSync(from, to);
          } catch {
            /* 搬不动就留着 */
          }
        }
      }
    }
  } catch {
    /* 老的临时目录不在就算了 */
  }

  const store = createStore(dataDir, outputsDir);
  /** 设置改成一条事件推出去：侧栏不必自己轮询式比对。 */
  const saveSettings = (patch) => {
    const next = store.saveSettings(patch);
    pushEvent("settings", { settings: next, rev: store.settingsRevision() });
    return next;
  };
  /** 改设置的后置动作：路径变了就停引擎，模型下次生成重新 load。装完与切换版本都走这里。 */
  const applySettings = (patch) => {
    saveSettings(patch);
    // 动了 serverPath 就把旧引擎停掉，但任务在跑时不动：停引擎会把正在采样的
    // 那张打断，任务就卡在运行中。新路径下次启动时自然生效。
    if (Object.prototype.hasOwnProperty.call(patch, "serverPath")) {
      const snap = engine.snapshot();
      if (snap.running && !snap.busy) engine.stop();
    }
    engine.loadedKey = null;
  };
  const installer = createInstaller({
    dataDir,
    runtimeDir,
    getSettings: () => store.getSettings(),
    saveSettings: applySettings,
    // 下载每秒会跳好几次，推全量 state 太浪费；只把安装那一段当成小帧送出去。
    // 收尾时（成功、失败、取消）例外：版本与模型列表跟着变了，要整帧刷新。
    onUpdate: () => {
      const snap = installer.snapshot();
      // 任一任务收尾就整帧刷新：版本与模型列表跟着变了。
      if (snap.some((item) => item.finishedAt)) schedulePush(0);
      else pushEvent("transfer", { installs: snap });
    },
    network: sdk.network,
    // 装完直接拉起来，省用户一次点击；失败不影响安装结果。
    onInstalled: (kind) => {
      if (kind !== "engine") return;
      engine.start().catch((error) => sdk.logger.warn(`装完自动启动失败：${message(error)}`));
    },
  });
  const queue = [];
  /**
   * 模型变体的入参校验：没传当默认（Base），传了认不出返回 null。
   * 静默回退会让「点 Base 却下了 SFT」这种事变成哑巴亏，路由层直接 400。
   */
  function readVariant(raw) {
    if (raw === undefined || raw === null || raw === "") return "base";
    return raw === "sft" || raw === "base" ? raw : null;
  }
  /** jobId → 活跃任务快照（进度、阶段、宿主任务 id）。 */
  const live = new Map();
  let running = false;
  let lastTaskSync = 0;

  const cardIdOf = (jobId) => `a_${createHash("sha256").update(`${APP_ID}:job:${jobId}`).digest("hex").slice(0, 20)}`;

  function liveEntry(job) {
    return {
      id: job.id,
      cardId: cardIdOf(job.id),
      prompt: job.caption ?? job.prompt,
      negativePrompt: job.negativePrompt,
      mode: job.mode ?? "generate",
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfg: job.cfg,
      batch: job.batch ?? 1,
      seed: job.seed,
      sampler: job.sampler ?? null,
      scheduler: job.scheduler ?? null,
      shift: job.shift ?? null,
      stepCache: job.stepCache ?? "off",
      loras: Array.isArray(job.loras) ? job.loras : [],
      control: job.control ?? null,
      layout: job.layout ?? null,
      references: job.references ?? null,
      initImage: job.initImage ?? null,
      mask: job.mask ?? null,
      status: job.status,
      // 高清修正开着时引擎总步数 = 主步数 + 修正步数，界面靠这个区分两段。
      hiresScale: job.hiresScale ?? 0,
      createdAt: job.createdAt,
      startedAt: null,
      finishedAt: null,
      elapsedMs: null,
      phase: null,
      phasesSeen: [],
      step: 0,
      total: 0,
      percent: 0,
      etaMs: null,
      error: null,
      output: job.output,
      report: null,
      taskId: null,
      taskNote: null,
      drained: false,
    };
  }

  function remember(entry) {
    live.set(entry.id, entry);
    while (live.size > LIVE_LIMIT) {
      const oldest = [...live.values()].find((item) => item.status !== "running" && item.status !== "queued");
      if (!oldest) break;
      live.delete(oldest.id);
    }
    return entry;
  }

  // ── 宿主任务桥 ────────────────────────────────────────────────────────────
  const capsCache = { at: 0, map: null };
  async function capabilitiesMap() {
    if (capsCache.map && Date.now() - capsCache.at < 30_000) return capsCache.map;
    try {
      const res = await sdk.bus.request("app:capabilities", {});
      const map = {};
      for (const item of Array.isArray(res?.capabilities) ? res.capabilities : []) {
        if (item && typeof item.capability === "string") map[item.capability] = item.status;
      }
      capsCache.at = Date.now();
      capsCache.map = map;
      return map;
    } catch {
      return null;
    }
  }

  async function hasCapability(word) {
    const map = await capabilitiesMap();
    const status = map?.[word];
    return status === "always" || status === "session";
  }

  /** 工具调用带来的 callToken 才有资格建宿主任务：按钮通道没有调用凭证，只做内存跟踪。 */
  async function attachTask(entry, callToken) {
    if (!callToken) {
      entry.taskNote = "无调用凭证（页面按钮提交）：结果只回工作区，不投递回会话";
      return;
    }
    const [canTasks, canStartTurn] = await Promise.all([hasCapability(CAP_TASKS), hasCapability(CAP_START_TURN)]);
    if (!canTasks) {
      entry.taskNote = "缺少能力 app/tasks.manage，未创建宿主任务";
      return;
    }
    if (!canStartTurn) {
      entry.taskNote = "缺少能力 app/session.start-turn，结果无法投递回会话";
      return;
    }
    try {
      const task = await sdk.tasks.create({
        callToken,
        label: `苔室出图 · ${entry.prompt.slice(0, 24)}${entry.prompt.length > 24 ? "…" : ""}`,
        delivery: "next-step",
        metadata: { moss: { jobId: entry.id, submittedAt: entry.createdAt } },
      });
      entry.taskId = task?.taskId ? String(task.taskId) : null;
      if (!entry.taskId) {
        entry.taskNote = "宿主任务创建未返回 taskId";
        return;
      }
      // 任务可能在建桥之前就已经跑完（引擎缺失这类失败只需几十毫秒），也可能已经跑到中途：
      // 两种都把当下状态同步一次，别让任务卡在初生状态。
      if (entry.status === "done" || entry.status === "error" || entry.status === "cancelled") settleTask(entry);
      else syncTask(entry, { status: "running", progress: taskProgress(entry) }, true);
    } catch (error) {
      entry.taskNote = `宿主任务创建失败：${message(error).slice(0, 160)}`;
      sdk.logger.warn(`苔室任务桥：${entry.taskNote}`);
    }
  }

  function taskProgress(entry) {
    return {
      phase: entry.phase ? (PHASE_LABEL[entry.phase] ?? entry.phase) : entry.status === "queued" ? "排队中" : "准备中",
      percent: entry.percent,
      step: entry.step,
      total: entry.total,
      etaMs: entry.etaMs,
      elapsedMs: entry.elapsedMs ?? (entry.startedAt ? Date.now() - Date.parse(entry.startedAt) : null),
      // 跑起来之后按墙钟算：引擎的 elapsed 只在回帧时刷新，界面要每秒都动。
      liveElapsedMs: entry.startedAt && entry.status === "running" ? Date.now() - Date.parse(entry.startedAt) : null,
    };
  }

  function syncTask(entry, patch, force = false) {
    if (!entry.taskId) return;
    const now = Date.now();
    if (!force && now - lastTaskSync < TASK_SYNC_MS) return;
    lastTaskSync = now;
    sdk.tasks.update(entry.taskId, patch).catch((error) => sdk.logger.warn(`苔室任务进度写回失败：${message(error)}`));
  }

  function taskResultText(entry) {
    const seconds = Math.round((entry.elapsedMs ?? 0) / 1000);
    const seed = entry.report?.seedUsed ?? entry.seed;
    return [
      `苔室出图完成：${entry.width}×${entry.height}，${entry.steps} 步，用时 ${seconds} 秒，种子 ${seed}。`,
      `文件在苔室画廊：${entry.output}`,
    ].join("\n");
  }

  function settleTask(entry) {
    if (!entry.taskId || entry.drained) return;
    entry.drained = true;
    const taskId = entry.taskId;
    if (entry.status === "done") {
      sdk.tasks
        .complete(taskId, {
          text: taskResultText(entry),
          moss: {
            jobId: entry.id,
            output: entry.output,
            width: entry.width,
            height: entry.height,
            steps: entry.steps,
            cfg: entry.cfg,
            seed: entry.report?.seedUsed ?? entry.seed,
            elapsedMs: entry.elapsedMs,
            timings: entry.report?.timings ?? null,
          },
        })
        .catch((error) => sdk.logger.warn(`苔室任务结算失败：${message(error)}`));
    } else if (entry.status === "error") {
      sdk.tasks.fail(taskId, `苔室出图失败：${entry.error ?? "未知错误"}`).catch((error) => sdk.logger.warn(`苔室任务结算失败：${message(error)}`));
    } else if (entry.status === "cancelled") {
      sdk.tasks.cancel(taskId, "任务已取消").catch((error) => sdk.logger.warn(`苔室任务结算失败：${message(error)}`));
    }
  }

  // ── 引擎 ──────────────────────────────────────────────────────────────────
  const engine = new Engine({
    getSettings: () => store.getSettings(),
    outputsDir,
    cacheDir: engineCacheDir,
    previewDir,
    onEvent: (event) => {
      if (event.type === "engine-log" || event.type === "log") {
        if (event.type === "log") sdk.logger.info(`[引擎] ${event.message}`);
        return;
      }
      const entry = event.jobId ? live.get(event.jobId) : null;
      if (!entry) return;
      if (event.type === "stage") {
        entry.phase = event.phase ?? entry.phase;
        if (entry.phase && !entry.phasesSeen.includes(entry.phase)) entry.phasesSeen.push(entry.phase);
        syncTask(entry, { progress: taskProgress(entry) });
        // 换阶段是结构性的变化，推一整帧；步进只推小帧。
        schedulePush(0);
        return;
      }
      if (event.type === "progress") {
        if (event.phase && event.phase !== entry.phase) {
          entry.phase = event.phase;
          if (!entry.phasesSeen.includes(event.phase)) entry.phasesSeen.push(event.phase);
        }
        // 解码这类收尾阶段会带 total=0 的退化进度，不能拿它把步进和百分比抹回起点。
        const total = Number(event.total ?? 0);
        if (total > 0) {
          // 解码阶段会带 total 但 step=0 的退化进度：步进只进不退。
          entry.step = Math.max(entry.step, Number(event.step ?? 0));
          entry.total = total;
          entry.percent = Math.max(entry.percent, Number(event.percent ?? 0));
        }
        if (typeof event.etaMs === "number") entry.etaMs = event.etaMs;
        else if (entry.total > 0 && entry.step >= entry.total) entry.etaMs = null;
        syncTask(entry, { progress: taskProgress(entry) });
        // 步进不推全量：一帧 progress 才几十字节，全量 state 是九千。
        pushEvent("progress", { jobId: entry.id, progress: taskProgress(entry), phase: entry.phase });
        return;
      }
      if (event.type === "preview") {
        entry.previewAt = event.at ?? Date.now();
        // 预览只推这一条事件，不把整个 state 再算一遍。
        pushEvent("preview", { jobId: entry.id, at: entry.previewAt });
        return;
      }
      if (event.type === "done") {
        if (event.status === "error" && event.error) sdk.logger.warn(`生成失败：${event.error}`);
      }
    },
  });

  function message(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // 可续画的断点：每一步一份 latent + 一份参数，取消或重开之后还能接着跑。
  const checkpointsDir = join(dataDir, "checkpoints");
  mkdirSync(checkpointsDir, { recursive: true });
  const session = createSession({
    engine,
    exePath: fileURLToPath(new URL("./vendor-bin/shm-bridge.exe", import.meta.url)),
    tmpDir: join(runtimeDir, "shm"),
    onLog: (entry) => sdk.logger.info(`[组件会话] ${entry.message}`),
  });

  function pickReport(report) {
    if (!report || typeof report !== "object") return null;
    return {
      seedUsed: typeof report.seed_used === "number" ? report.seed_used : null,
      quality: report.quality ?? null,
      timings: report.timings_s ?? null,
      latent: report.latent ?? null,
    };
  }

  // 引擎硬限制：基础图与高清修正共用一个上限（侧长 4096、总 4.2 百万像素）。
  const MAX_PIXELS = 4_200_000;
  const MAX_SIDE = 4096;
  const MIN_SIDE = 256;

  /**
   * 用户传什么就收什么，只把**实际出图尺寸**收进引擎限制。
   * 超限时按比例往下缩（只缩不拉，16 的倍数），而不是直接把任务拒掉。
   */
  /**
   * 把宽高收进引擎限制：只缩不拉，比例保持不变。
   * 单边与总量两条上限取更严的那个缩放系数，不能只截超限的那一维——
   * 5120×2880 只把宽截到 4096 会把 16:9 变成 1.42。
   */
  function fitToLimit(width, height) {
    const floor16 = (value) => Math.max(MIN_SIDE, Math.floor(value / 16) * 16);
    let w = Math.max(MIN_SIDE, width);
    let h = Math.max(MIN_SIDE, height);
    const sideScale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const pixelScale = w * h > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (w * h)) : 1;
    const scale = Math.min(sideScale, pixelScale);
    w = floor16(w * scale);
    h = floor16(h * scale);
    // 取整后可能擦线超一点，逐边再收。
    while ((w * h > MAX_PIXELS || w > MAX_SIDE || h > MAX_SIDE) && w > MIN_SIDE && h > MIN_SIDE) {
      if (w * h > MAX_PIXELS || Math.max(w, h) > MAX_SIDE) {
        if (w >= h) w = floor16(w - 16);
        else h = floor16(h - 16);
      } else break;
    }
    return { width: w, height: h };
  }

  function resolveSize(input, defaults) {
    const round16 = (value) => Math.max(16, Math.round(value / 16) * 16);
    const requested = {
      width: round16(clamp(input?.width, MIN_SIDE, MAX_SIDE, defaults.width)),
      height: round16(clamp(input?.height, MIN_SIDE, MAX_SIDE, defaults.height)),
    };
    const fitted = fitToLimit(requested.width, requested.height);
    return {
      ...fitted,
      requested,
      adjusted: fitted.width !== requested.width || fitted.height !== requested.height,
    };
  }

  /**
   * 一次生成的归一化：排队、工具、预估算的都是这一层。
   * 返回的记录不含 id / output，那两样只属于真正入队的那些。
   */
  function buildRecord(input, settings) {
    const box = resolveSize(input, settings.defaults);
    // 布局先算：它会把 prompt 换成一段 JSON，而 caption 仍当展示用的提示词。
    const layout = readLayout(input, box.width, box.height);
    const caption = String(input?.prompt ?? "").trim() || layout?.caption || "";
    if (!caption) throw new Error("提示词不能为空");
    // 参数面先收敛：认不出的采样器、缺文件的 LoRA 在这里就拒，别让它排进队列才失败。
    const gen = readGeneration(input, settings.defaults);
    // 编辑适配器学的是「给一张源图去改」，它读 references；图生图读 initImage。
    // 底图就是源图，所以有底图时直接接成 references[0]，真的没图才摘掉。
    const notices = [];
    if (Array.isArray(gen.loras) && gen.loras.length && !gen.references?.images?.length) {
      const kept = [];
      for (const lora of gen.loras) {
        const name = String(lora?.path ?? "").split(/[\\/]/).pop() ?? "";
        if (!/edit/i.test(name)) {
          kept.push(lora);
          continue;
        }
        if (gen.initImage) {
          gen.references = { images: [gen.initImage], maxEdge: 512 };
          notices.push(`编辑适配器 ${name} 用底图当源图`);
          kept.push(lora);
        } else {
          notices.push(`没有源图，这次的编辑适配器 ${name} 没生效`);
        }
      }
      gen.loras = kept;
    }
    // 可续画（component session）：只做文生图，采样器必须 euler。
    const mode = input?.mode === "latent" ? "latent" : "generate";
    if (mode === "latent") {
      if (gen.sampler !== "euler") throw new Error("可续画模式只支持 euler（MOSS 官方组合）");
      if (gen.initImage || gen.mask) throw new Error("可续画模式只做文生图：不要给底图或蒙版");
      // 控制适配器与编辑参考图是设置里的长期选择：没显式要就默默摘下，
      // 不能因为上次选过一个就让可续画任务卡在那里。
      const explicitControl = Boolean(input?.control?.adapter ?? input?.controlAdapter);
      if (explicitControl && gen.control?.adapter) throw new Error("可续画模式暂不支持控制适配器");
      gen.control = null;
      const explicitReferences = Boolean(
        (Array.isArray(input?.referenceImages) && input.referenceImages.length) ||
          (Array.isArray(input?.references) && input.references.length) ||
          (Array.isArray(input?.references?.images) && input.references.images.length),
      );
      if (explicitReferences && gen.references?.images?.length) throw new Error("可续画模式暂不支持编辑参考图");
      gen.references = null;
    }
    const record = {
      mode,
      batch: mode === "latent" ? clamp(input?.batch, 1, 4, 1) : 1,
      prompt: layout ? layout.prompt : caption,
      caption,
      layout: layout ? { items: layout.items, caption: layout.caption } : null,
      negativePrompt: String(input?.negativePrompt ?? "").trim(),
      width: box.width,
      height: box.height,
      // 用户要的尺寸与实际出的尺寸不一致时，留个底，便于事后对照。
      sizeRequested: box.adjusted ? box.requested : null,
      steps: clamp(input?.steps, MIN_STEPS, 80, Math.max(MIN_STEPS, settings.defaults.steps)),
      cfg: clampFloat(input?.cfg, 0, 20, settings.defaults.cfg),
      seed: Number.isInteger(input?.seed) ? input.seed : Math.floor(Math.random() * 4294967295),
      sampler: gen.sampler,
      scheduler: gen.scheduler,
      shift: gen.shift,
      stepCache: gen.stepCache,
      stepCacheThreshold: gen.stepCacheThreshold,
      cfgTruncation: gen.cfgTruncation,
      loraPlacement: gen.loraPlacement,
      uncondSkipLayers: gen.uncondSkipLayers,
      slgLayers: gen.slgLayers,
      slgScale: gen.slgScale,
      slgStart: gen.slgStart,
      slgStop: gen.slgStop,
      maxSequenceLength: gen.maxSequenceLength,
      flowMultiplier: gen.flowMultiplier,
      noiseLayout: gen.noiseLayout,
      noiseSource: gen.noiseSource,
      eta: gen.eta,
      sNoise: gen.sNoise,
      dataspace: gen.dataspace,
      distill: gen.distill,
      loras: gen.loras,
      control: gen.control,
      references: gen.references,
      // 倍率统一在这里收进当前尺寸做得到的范围：无论参数来自面板、工具还是卡片，
      // 否则界面显示关闭、引擎却按旧倍率跑了第二阶段。倍率是浮点，不能用取整的 clamp。
      hiresScale: Math.round(
        Math.min(
          clampFloat(input?.hiresScale ?? settings.defaults.hiresScale, 0, 64, 0),
          Math.min(MAX_SIDE / Math.max(box.width, box.height), Math.sqrt(MAX_PIXELS / (box.width * box.height))),
        ) * 100,
      ) / 100,
      hiresSteps: clamp(input?.hiresSteps ?? settings.defaults.hiresSteps, 0, 80, 0),
      hiresStrength: clampFloat(input?.hiresStrength ?? settings.defaults.hiresStrength, 0.05, 1, 0.45),
      initImage: gen.initImage,
      mask: gen.mask,
      maskEncoding: gen.maskEncoding,
      strength: clampFloat(input?.strength, 0.05, 1, 0.6),
      resize: VALUES.resize.includes(input?.resize) ? input.resize : "crop",
      // 会话 id：出图后要写进 PNG，否则重启就不知道这张图属于哪一段。
      conv: typeof input?.conv === "string" && input.conv ? input.conv : null,
      ...(notices.length ? { notices } : {}),
    };
    // 引擎的高清修正要的是具体目标尺寸，不是倍数，这里先算好。
    // 1.0 等于关闭：目标与基础图同尺寸，第二阶段没有意义。
    if (record.hiresScale > 1.001) {
      const round16 = (value) => Math.max(16, Math.round((value * record.hiresScale) / 16) * 16);
      // 修正目标同样受基础图那条上限，超了按比例收，而不是把任务拒掉。
      const fitted = fitToLimit(round16(box.width), round16(box.height));
      if (fitted.width <= record.width && fitted.height <= record.height) {
        // 收完不比原图大，这一檔修正等于没做，直接关掉。
        record.hiresScale = 0;
      } else {
        record.hiresWidth = fitted.width;
        record.hiresHeight = fitted.height;
      }
    }
    return record;
  }

  function submit(input) {
    // 早一步对齐档位与权重：错配的组合引擎要到采样才回 invalid_argument，
    // 那时用户看到的是一句英文，而这里能把它直接改成能跑的组合。
    const tierFix = installer.reconcileTier();
    const settings = store.getSettings();
    const record = buildRecord(input, settings);
    if (tierFix) {
      const note = `精度档 ${tierFix.from} 需要 bf16 权重，已按手里的权重改成 ${tierFix.to}`;
      record.notices = [...(record.notices ?? []), note];
    }
    const id = `mj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fileName = `${id}.png`;
    Object.assign(record, { id, status: "queued", createdAt: new Date().toISOString(), output: fileName });
    store.upsertJob(record);
    const entry = remember(liveEntry(record));
    if (record.notices) entry.notices = record.notices;
    queue.push({ ...record, output: join(outputsDir, fileName), resumeFrom: input?.resumeFrom ?? null });
    // 有新任务就把待停的计时取消掉。
    clearTimeout(idleStopTimer);
    schedulePush(0);
    void pump();
    return entry;
  }

  async function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    // 引擎可能因为空闲被停了，开始干活前先确保它活着。
    if (!engine.snapshot().running) {
      try {
        await engine.start();
      } catch (error) {
        sdk.logger.warn(`出图前启动引擎失败：${message(error)}`);
      }
    }
    const entry = live.get(job.id);
    const startedAt = new Date();
    if (entry) {
      entry.status = "running";
      entry.startedAt = startedAt.toISOString();
      syncTask(entry, { status: "running", progress: taskProgress(entry) }, true);
    }
    store.upsertJob({ id: job.id, status: "running", startedAt: startedAt.toISOString() });
    schedulePush(0);
    try {
      let result;
      if (job.mode === "latent") {
        // 可续画：每一步的 latent 落盘，取消只在步与步之间生效。
        const stopFlag = { stopped: false };
        if (entry) entry.stopFlag = stopFlag;
        try {
          await engine.ensureLoaded(job);
          const latent = await runLatentGenerate({
            session,
            spec: {
              id: job.id,
              prompt: job.prompt,
              negativePrompt: job.negativePrompt,
              width: job.width,
              height: job.height,
              steps: job.steps,
              cfg: job.cfg,
              shift: job.shift,
              seed: job.seed,
              sampler: job.sampler,
              batch: Number.isFinite(job.batch) ? job.batch : 1,
              output: job.output,
              from: job.resumeFrom ?? null,
            },
            checkpointDir: checkpointsDir,
            onProgress: (progress) => {
              if (!entry) return;
              entry.step = progress.step;
              entry.total = progress.total;
              entry.percent = Math.round((progress.step / Math.max(1, progress.total)) * 1000) / 10;
              entry.phase = "denoise";
              syncTask(entry, { progress: taskProgress(entry) });
              schedulePush(0);
            },
            shouldStop: () => stopFlag.stopped,
          });
          result = {
            status: "ok",
            output: job.output,
            batch: latent.batch,
            outputs: latent.outputs ?? [job.output],
            report: {
              seed_used: job.seed,
              latent: { stepsRun: latent.stepsRun, totalSteps: latent.totalSteps, checkpoint: latent.checkpoint, latents: latent.latents },
            },
          };
        } catch (error) {
          if (error?.cancelled) result = { status: "cancelled", output: job.output };
          else throw error;
        }
      } else {
        result = await engine.generate(job);
      }
      const elapsedMs = Date.now() - startedAt.getTime();
      if (result.status === "ok") {
        const report = pickReport(result.report);
        store.upsertJob({ id: job.id, status: "done", finishedAt: new Date().toISOString(), elapsedMs, report });
        // 出图之后就把缩略图做出来，打开画廊時不必现等。
        // 队列里的 output 是绝对路径（相对的是记录里的文件名），先认清楚再用。
        const pngPath = isAbsolute(job.output) ? job.output : join(outputsDir, job.output);
        void ensureThumb(pngPath);
        // 引擎这一版不再写 generation 块：参数与来源由这里补上，
        // 不然重启之后记录就只剩一张图，提示词与底图全丢。
        {
          const png = pngPath;
          const report = result.report ?? {};
          const had = readPngText(png)?.generation ?? null;
          // 每次都写：引擎自己写的那份字段不全，两边合起来以请求参数为准。
          const meta = {
            ...(had ?? {}),
            prompt: job.prompt ?? had?.prompt ?? "",
            // 写入磁盘那一刻的时间：会话排序以它为准，文件 mtime 会变。
            created_at: had?.created_at ?? job.createdAt ?? new Date().toISOString(),
            negative_prompt: job.negativePrompt ?? had?.negative_prompt ?? "",
            width: job.width ?? had?.width ?? null,
            height: job.height ?? had?.height ?? null,
            steps: job.steps ?? had?.steps ?? null,
            cfg: job.cfg ?? had?.cfg ?? null,
            seed: report.seedUsed ?? job.seed ?? had?.seed ?? null,
            sampler: job.sampler ?? had?.sampler ?? null,
            scheduler: job.scheduler ?? had?.scheduler ?? null,
            shift: job.shift ?? had?.shift ?? null,
            engine: { ...(had?.engine ?? {}), tier: report.tier ?? had?.engine?.tier ?? null },
          };
          try {
            writePngMeta(png, "generation", JSON.stringify(meta));
          } catch {
            /* 写不进去不影响图本身 */
          }
          const conv = job.conv ?? job.input?.conv ?? null;
          if (conv) {
            const origin = {
              conv: String(conv),
              // 只存文件名：绝对路径一旦搬家就失效。
              base: job.initImage ? basename(String(job.initImage)) : null,
              mask: job.mask ? basename(String(job.mask)) : null,
              refs: Array.isArray(job.references) ? job.references.map((item) => basename(String(item))) : [],
              parent: job.parent ?? null,
            };
            try {
              writePngMeta(png, "moss-studio", JSON.stringify(origin));
            } catch {
              /* 同上 */
            }
          }
        }
        // 多张（component session 的 batch）：其余几张也各记一条，画廊里能单独点开。
        const extras = Array.isArray(result.outputs) ? result.outputs.slice(1) : [];
        if (extras.length) {
          const { resumeFrom: _resume, output: _abs, ...recordBase } = job;
          const finishedAt = new Date().toISOString();
          for (const [index, path] of extras.entries()) {
            store.upsertJob({
              ...recordBase,
              id: `${job.id}-${index + 2}`,
              output: basename(path),
              seed: (Number.isFinite(job.seed) ? job.seed : 42) + index + 1,
              status: "done",
              finishedAt,
              elapsedMs,
            });
            void ensureThumb(path);
            // 额外几张也是图，重启后不能只剩一张皮。
            const seedFor = (Number.isFinite(job.seed) ? job.seed : 42) + index + 1;
            const extraMeta = {
              prompt: job.prompt ?? "",
              created_at: job.createdAt ?? new Date().toISOString(),
              negative_prompt: job.negativePrompt ?? "",
              width: job.width ?? null,
              height: job.height ?? null,
              steps: job.steps ?? null,
              cfg: job.cfg ?? null,
              seed: seedFor,
              sampler: job.sampler ?? null,
              scheduler: job.scheduler ?? null,
              shift: job.shift ?? null,
              engine: { tier: result.report?.tier ?? null },
            };
            try {
              writePngMeta(path, "generation", JSON.stringify(extraMeta));
              if (job.conv) writePngMeta(path, "moss-studio", JSON.stringify({ conv: String(job.conv) }));
            } catch {
              /* 写不进去不影响图本身 */
            }
          }
        }
        if (entry) {
          entry.status = "done";
          entry.percent = 100;
          entry.etaMs = null;
          entry.step = entry.total || entry.step;
          entry.elapsedMs = elapsedMs;
          entry.finishedAt = new Date().toISOString();
          entry.report = report;
          settleTask(entry);
        }
      } else {
        store.upsertJob({ id: job.id, status: "cancelled", finishedAt: new Date().toISOString(), elapsedMs });
        if (entry) {
          entry.status = "cancelled";
          entry.elapsedMs = elapsedMs;
          entry.finishedAt = new Date().toISOString();
          settleTask(entry);
        }
      }
    } catch (error) {
      const text = message(error);
      // 权限、缺文件这类错误只看一行没法定位，堆栈写进日志。
      sdk.logger.warn(`[苔室] 任务 ${job.id} 失败：${error?.stack ?? text}`);
      const elapsedMs = Date.now() - startedAt.getTime();
      store.upsertJob({
        id: job.id,
        status: "error",
        error: text,
        finishedAt: new Date().toISOString(),
        elapsedMs,
      });
      if (entry) {
        entry.status = "error";
        entry.error = text;
        entry.elapsedMs = elapsedMs;
        entry.finishedAt = new Date().toISOString();
        settleTask(entry);
      }
    } finally {
      running = false;
      schedulePush(0);
      if (queue.length) void pump();
      else scheduleIdleStop();
    }
  }

  /**
   * 队列空了就把引擎停掉。启停本身只要 0.4 秒，模型加载约 1 秒，
   * 而它带模型时占着 1.4 GB 显存——不生成的时候没必要占着。
   * 留几秒缓冲：连着调参数再生成，不用每次重加载。
   */
  let idleStopTimer = null;
  const IDLE_STOP_MS = 8000;

  function scheduleIdleStop() {
    clearTimeout(idleStopTimer);
    idleStopTimer = setTimeout(() => {
      if (running || queue.length) return;
      if (!engine.snapshot().running) return;
      engine.stop();
      schedulePush(0);
    }, IDLE_STOP_MS);
  }

  // ── 视图数据 ──────────────────────────────────────────────────────────────
  function modelPlan() {
    const components = MOSSIMAGE.components.map((item) => ({
      role: item.role,
      id: item.id,
      name: item.name,
      repo: MOSSIMAGE.model.repo,
      files: item.files,
      sizeBytes: item.sizeBytes,
    }));
    return { model: MOSSIMAGE.model, components, totalBytes: MODEL_BYTES };
  }

  function deviceOf(snapshot) {
    const probe = snapshot?.hello?.probe;
    if (!probe) return null;
    const devices = Array.isArray(probe.devices) ? probe.devices : [];
    const device = devices.find((item) => item.supported) ?? devices[0] ?? null;
    if (!device) return null;
    return {
      name: device.name ?? "GPU",
      totalMemoryBytes: device.total_memory_bytes ?? null,
      computeCapability: device.compute_capability ?? null,
      driverCudaVersion: probe.driver_cuda_version ?? null,
      cublaslt: probe.cublaslt ?? null,
    };
  }

  function liveActive() {
    for (const entry of live.values()) {
      if (entry.status === "running") return entry;
    }
    return null;
  }

  function slimJob(job) {
    if (!job || typeof job !== "object") return job;
    // 图已经不在了就别再列：文件才是记录的真相源。
    if (job.output && !existsSync(join(outputsDir, job.output))) return null;
    // 记录有两种存法：早期是扁平字段，后来是 params 里一层，两边都要认。
    const p = job.params ?? {};
    return {
      id: job.id,
      cardId: cardIdOf(job.id),
      prompt: job.caption ?? job.prompt ?? p.prompt,
      negativePrompt: job.negativePrompt ?? p.negativePrompt ?? "",
      width: job.width ?? p.width,
      height: job.height ?? p.height,
      steps: job.steps ?? p.steps,
      cfg: job.cfg ?? p.cfg,
      // 高清修正开着时引擎总步数会多出第二阶段，界面要能解释这个差额。
      hiresScale: job.hiresScale ?? p.hiresScale ?? 0,
      sampler: job.sampler ?? p.sampler ?? null,
      scheduler: job.scheduler ?? p.scheduler ?? null,
      shift: job.shift ?? p.shift ?? null,
      origin: job.origin ?? (job.conv ? {
        // 队列里的记录把会话 id 放在顶层，跟盘上读出来的 origin.conv 是同一件事。
        conv: String(job.conv),
        base: job.initImage ? basename(String(job.initImage)) : null,
        mask: job.mask ? basename(String(job.mask)) : null,
        refs: Array.isArray(job.references) ? job.references.map((item) => basename(String(item))) : [],
        parent: job.parent ?? null,
      } : null),
      stepCache: job.stepCache ?? "off",
      loras: Array.isArray(job.loras) ? job.loras : [],
      control: job.control ? { kind: job.control.kind ?? null, images: job.control.images?.length ?? 0 } : null,
      layout: job.layout ?? null,
      hasInitImage: Boolean(job.initImage),
      hasMask: Boolean(job.mask),
      seed: job.report?.seedUsed ?? job.seed,
      status: job.status,
      output: job.output ?? null,
      error: job.error ?? null,
      elapsedMs: job.elapsedMs ?? null,
      createdAt: job.createdAt ?? null,
    };
  }

  /** 最近一次显卡探测结果。面板常驻显示，不必等装引擎时才有。 */
  let gpuCache = null;
  // 稍后探一次，不与首帧争时间；探不到就不管，面板自行退回默认。
  setTimeout(() => {
    probeGpu()
      .then((gpu) => {
        if (!gpu) return;
        gpuCache = gpu;
        schedulePush(0);
      })
      .catch((error) => sdk.logger.warn(`显卡探测失败：${message(error)}`));
  }, 1500).unref?.();

  /** 缩略图缓存路径。画廊与预览都按这个规则落盘。 */
  function thumbPath(file, size) {
  return join(thumbsDir, `${basename(file).replace(/\.png$/i, "")}-${size}.webp`);
}

/** 确保缩略图存在。已存在就直接返回，不重复转。 */
async function ensureThumb(file, size = 320) {
  const dst = thumbPath(file, size);
  if (existsSync(dst) || !existsSync(file)) return;
  try {
    // force：小图不够宽也要转。不转就没有这个文件，每次请求都会重新解一遍 PNG。
    await shrinkToWebp(file, dst, size, { force: true });
  } catch {
    /* 转不出来就等路由那里退回原图 */
  }
}

function engineFacets() {
  const hello = engine.snapshot().hello;
  return { menus: menuValues(hello), capabilities: capabilityMap(hello) };
}

function state() {
  const settings = store.getSettings();
  const snapshot = engine.snapshot();
  const active = liveActive();
  // 每帧要三处用到任务列表（画布/队列、记录数、成图数），算一次就够。
  const allJobs = store.listJobs();
  return {
    settings,
    // 档位和当前 DiT 不一致时给界面一句话（启动时已经修过一次，这里是手动改回去的情形）。
    tierMismatch: (() => {
      const need = installer.fileTier(settings.modelFiles?.dit ?? "");
      return need && need !== settings.tier ? { need, current: settings.tier } : null;
    })(),
    // 只下了配置的轻量包：DiT 与文本编码器必须来自单文件，界面要能说清缺什么。
    modelLite: installer.liteModelGaps(settings),
    configPack: (() => {
      const dir = installer.configDirTarget();
      return { installed: existsSync(dir), path: dir };
    })(),
    // 设置版本：界面靠它决定要不要重新对一遍，不必每帧序列化比较。
    settingsRev: store.settingsRevision(),
    engine: {
      ...snapshot,
      serverFound: Boolean(engine.serverPath()),
      modelFound: Boolean(settings.modelPath && existsSync(settings.modelPath)),
      device: deviceOf(snapshot),
      active: active
        ? {
            jobId: active.id,
            prompt: active.prompt,
            width: active.width,
            height: active.height,
            steps: active.steps,
            cfg: active.cfg,
            seed: active.report?.seedUsed ?? active.seed ?? null,
            hiresScale: active.hiresScale ?? 0,
            phase: active.phase,
            progress: taskProgress(active),
            previewAt: active.previewAt ?? null,
          }
        : null,
    },
    queue: queue.map((job) => ({ id: job.id, prompt: job.prompt, width: job.width, height: job.height, steps: job.steps })),
    running,
    // 只带界面当场要用的那几条：未收尾的全带（排队、运行、失败），完成的只留最近
    // 两条给画布与首屏。整份历史走 /jobs 分页，不该每帧跟着 state 跑一遍。
    jobs: (() => {
      const pending = allJobs.filter((job) => job.status !== "done" && job.status !== "cancelled");
      const done = allJobs.filter((job) => job.status === "done").slice(0, 2);
      return [...pending, ...done].map(slimJob).filter(Boolean);
    })(),
    // 全量记录数：state 只带前面那些，界面上的总数不能跟着它算。
    jobTotal: allJobs.length,
    // 真正能看到的图。画廊角标用这个，不能用 jobTotal（它含失败与取消）。
    doneTotal: allJobs.filter((job) => job.status === "done" && job.output).length,
    // 只算还没收尾的：结束的任务进度已经没意义，四十条堆在每帧里白占体积。
    progress: Object.fromEntries(
      [...live.values()]
        .filter((entry) => entry.status === "running" || entry.status === "queued")
        .map((entry) => [entry.id, taskProgress(entry)]),
    ),
    mossimage: {
      repo: MOSSIMAGE.repo,
      version: MOSSIMAGE.version,
      protocolVersion: MOSSIMAGE.protocolVersion,
      abiVersion: MOSSIMAGE.abiVersion,
      model: MOSSIMAGE.model.id,
      modelBytes: MODEL_BYTES,
    },
    plan: modelPlan(),
    facets: engineFacets(),
    installs: installer.snapshot(),
    engines: installer.listEngines(),
    models: installer.listModels(),
    files: installer.listFiles(),
    gpu: gpuCache,
  };
}

  /** 功能面板要的是一份小而全的快照：引擎、当前任务、队列、最近成图。 */
  function panel() {
    const settings = store.getSettings();
    const snapshot = engine.snapshot();
    const active = liveActive();
    const recent = store
      .listJobs()
      .filter((job) => job.status === "done" && job.output)
      .slice(0, 6)
      .map((job) => ({ id: job.id, output: job.output, width: job.width, height: job.height, prompt: job.prompt }));
    return {
      engine: {
        running: snapshot.running,
        loaded: snapshot.loaded,
        lastError: snapshot.lastError,
        serverFound: Boolean(engine.serverPath()),
        modelFound: Boolean(settings.modelPath && existsSync(settings.modelPath)),
        device: deviceOf(snapshot),
        tier: settings.tier,
        memoryMode: settings.memoryMode,
      },
      active: active ? { id: active.id, cardId: active.cardId, prompt: active.prompt, ...taskProgress(active) } : null,
      queue: queue.map((job) => ({ id: job.id, prompt: job.prompt, width: job.width, height: job.height, steps: job.steps })),
      recent,
      totals: {
        done: store.listJobs().filter((job) => job.status === "done").length,
        failed: store.listJobs().filter((job) => job.status === "error").length,
      },
      mossimage: {
        version: MOSSIMAGE.version,
        protocolVersion: MOSSIMAGE.protocolVersion,
      },
      installs: installer.snapshot(),
    };
  }

  function stageTimeline(entry) {
    const seen = new Set(entry.phasesSeen ?? []);
    return PHASE_ORDER.map((phase) => {
      const index = PHASE_ORDER.indexOf(phase);
      const currentIndex = entry.phase ? PHASE_ORDER.indexOf(entry.phase) : -1;
      let state = "idle";
      if (entry.status === "done") state = "done";
      else if (entry.status === "error") state = seen.has(phase) || index < currentIndex ? "done" : phase === entry.phase ? "bad" : "idle";
      else if (seen.has(phase)) state = phase === entry.phase && entry.status === "running" ? "current" : "done";
      else if (phase === entry.phase) state = "current";
      return { key: phase, label: PHASE_LABEL[phase] ?? phase, state };
    });
  }

  /** jobId → 卡片视图；活跃快照优先，落盘台账兜底（重启后老卡片仍能读出结局）。 */
  function jobView(entryOrId) {
    const entry = typeof entryOrId === "string" ? live.get(entryOrId) : entryOrId;
    const record = store.getJob(typeof entryOrId === "string" ? entryOrId : entryOrId.id);
    if (!entry && !record) return null;
    const status = entry?.status ?? record?.status ?? "queued";
    const elapsedMs =
      entry?.elapsedMs ??
      record?.elapsedMs ??
      (entry?.startedAt ? Date.now() - Date.parse(entry.startedAt) : null);
    const source = entry ?? liveEntry({ ...record, output: record.output });
    const percent = status === "done" ? 100 : (entry?.percent ?? 0);
    return {
      jobId: source.id,
      cardId: cardIdOf(source.id),
      label: source.prompt,
      prompt: source.prompt,
      negativePrompt: source.negativePrompt ?? "",
      width: source.width,
      height: source.height,
      steps: source.steps,
      cfg: source.cfg,
      mode: source.mode ?? "generate",
      batch: source.batch ?? 1,
      hiresScale: source.hiresScale ?? 0,
      sampler: source.sampler ?? null,
      scheduler: source.scheduler ?? null,
      shift: source.shift ?? null,
      stepCache: source.stepCache ?? "off",
      cfgTruncation: source.cfgTruncation ?? 1,
      loraPlacement: source.loraPlacement ?? "default",
      uncondSkipLayers: source.uncondSkipLayers ?? null,
      slgLayers: source.slgLayers ?? [],
      slgScale: source.slgScale ?? 0,
      slgStart: source.slgStart ?? 0,
      slgStop: source.slgStop ?? 1,
      maxSequenceLength: source.maxSequenceLength ?? null,
      flowMultiplier: source.flowMultiplier ?? 1,
      noiseLayout: source.noiseLayout ?? "official",
      noiseSource: source.noiseSource ?? "philox",
      eta: source.eta ?? 1,
      sNoise: source.sNoise ?? 1,
      dataspace: source.dataspace ?? null,
      distill: source.distill ?? null,
      loras: Array.isArray(source.loras) ? source.loras : [],
      layout: source.layout ?? null,
      control: source.control ?? null,
      references: source.references ?? null,
      initImage: source.initImage ?? null,
      mask: source.mask ?? null,
      strength: source.strength ?? null,
      seed: entry?.report?.seedUsed ?? record?.report?.seedUsed ?? source.seed,
      status,
      statusText: STATUS_TEXT[status] ?? status,
      percent,
      indeterminate: (status === "running" || status === "queued") && percent <= 0,
      phase: entry?.phase ?? null,
      phaseLabel: entry?.phase ? (PHASE_LABEL[entry.phase] ?? entry.phase) : null,
      timeline: entry ? stageTimeline(entry) : [],
      step: entry?.step ?? 0,
      total: entry?.total ?? 0,
      etaMs: entry?.etaMs ?? null,
      elapsedMs,
      submittedAt: source.createdAt ?? record?.createdAt ?? null,
      output: status === "done" ? (record?.output ?? source.output) : null,
      report: entry?.report ?? record?.report ?? null,
      error: entry?.error ?? record?.error ?? null,
      taskNote: entry?.taskNote ?? null,
      queuePosition: status === "queued" ? queue.findIndex((job) => job.id === source.id) + 1 : null,
      taskId: entry?.taskId ?? null,
    };
  }

  function findJobByCardId(cardId) {
    if (typeof cardId !== "string" || !/^a_[0-9a-f]{20}$/.test(cardId)) return null;
    for (const entry of live.values()) {
      if (entry.cardId === cardId) return entry.id;
    }
    for (const record of store.listJobs()) {
      if (record?.id && cardIdOf(record.id) === cardId) return record.id;
    }
    return null;
  }

  function cardRef(entry) {
    return {
      pluginId: APP_ID,
      cardId: "task",
      cardInstanceId: entry.cardId,
      route: CARD_ROUTE,
      title: `苔室出图 · ${entry.width}×${entry.height}`,
      description: `${entry.prompt.slice(0, 60)}${entry.prompt.length > 60 ? "…" : ""} · ${entry.steps} 步 · CFG ${entry.cfg}`,
      aspectRatio: "16:9",
      cardForm: "flush",
      preferredWidthPx: 460,
      titlebar: null,
    };
  }

  function safeOutput(name) {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.png$/.test(name)) return null;
    const target = join(outputsDir, name);
    if (!existsSync(target)) return null;
    return target;
  }

  // ── 实时推送（SSE）──────────────────────────────────────────────────────
  // 页面不再轮询 /state，而是订一条事件流：连上先给一帧快照，之后只在状态真变了才推。
  const streamClients = new Set();
  let pushTimer = null;

  /** 除了整帧 state，也允许推单条事件（比如采样预览），前端不必为此轮询。 */
  function pushEvent(name, payload) {
    if (!streamClients.size) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...streamClients]) client.send(frame);
  }

  function schedulePush(delay = 120) {
    if (!streamClients.size || pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (!streamClients.size) return;
      let frame;
      try {
        frame = `event: state\ndata: ${JSON.stringify(state())}\n\n`;
      } catch (error) {
        sdk.logger.warn(`苔室状态推送失败：${message(error)}`);
        return;
      }
      for (const client of [...streamClients]) client.send(frame);
    }, delay);
    pushTimer.unref?.();
  }

  // ── 路由 ──────────────────────────────────────────────────────────────────
  await sdk.routes.register((app) => {
    app.get(`/${APP_ID}/health`, (c) =>
      c.json({ ok: true, app: { id: APP_ID, version: APP_VERSION }, protocol: MOSSIMAGE.protocolVersion, ts: new Date().toISOString() }),
    );

    app.get(`/${APP_ID}/diag/gpu`, async (c) => c.json(await probeGpuDetailed()));

    // 下载走 aria2 的 JSON-RPC，这条能看出来到底是进程没起还是回环连不上。
    app.get(`/${APP_ID}/diag/rpc`, async (c) => {
      try {
        return c.json(await installer.diagRpc());
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message ?? error) }, 500);
      }
    });

    app.get(`/${APP_ID}/state`, (c) => c.json(state()));

    // 画廊分页：state 只带最近十几条，全量从这里拉。
    app.get(`/${APP_ID}/jobs`, (c) => {
      const all = store.listJobs();
      const offset = Math.max(0, Number(c.req.query("offset")) || 0);
      const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 60));
      return c.json({
        total: all.length,
        offset,
        jobs: all.slice(offset, offset + limit).map(slimJob).filter(Boolean),
      });
    });

    app.get(`/${APP_ID}/events`, (c) => {
      const src = String(c.req.query("src") ?? "?");
      const encoder = new TextEncoder();
      let cleanup = () => {};
      const stream = new ReadableStream({
        start(controller) {
          let closed = false;
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              cleanup();
            }
          }, 8000);
          heartbeat.unref?.();

          const client = {
            send(frame) {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(frame));
              } catch {
                cleanup();
              }
            },
          };

          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            streamClients.delete(client);
            sdk.logger.info(`[事件流] 断开 ${src}，剩 ${streamClients.size} 条`);
            try {
              controller.close();
            } catch {
              /* 已经关掉了 */
            }
          };

          streamClients.add(client);
          sdk.logger.info(`[事件流] 接入 ${src}，当前 ${streamClients.size} 条`);
          client.send(`retry: 3000\n\n`);
          try {
            client.send(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
          } catch (error) {
            sdk.logger.warn(`苔室首帧推送失败：${message(error)}`);
          }
          c.req.raw.signal?.addEventListener?.("abort", cleanup, { once: true });
        },
        cancel() {
          cleanup();
        },
      });

      return c.body(stream, 200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    });

    app.get(`/${APP_ID}/panel`, (c) => c.json(panel()));

    app.get(`/${APP_ID}/task`, (c) => {
      const cardId = c.req.query("cardId");
      const jobId = c.req.query("job") || c.req.query("id");
      const resolved = cardId ? findJobByCardId(cardId) : jobId ? String(jobId) : null;
      if (!resolved) {
        return c.json({ ok: true, found: false, cardId: cardId ?? null, job: null });
      }
      const job = jobView(resolved);
      if (!job) return c.json({ ok: true, found: false, cardId: cardId ?? null, job: null });
      return c.json({ ok: true, found: true, job });
    });

    app.get(`/${APP_ID}/models`, (c) =>
      c.json({
        engine: {
          repo: MOSSIMAGE.repo,
          version: MOSSIMAGE.version,
          protocolVersion: MOSSIMAGE.protocolVersion,
          abiVersion: MOSSIMAGE.abiVersion,
        },
        model: MOSSIMAGE.model,
        components: MOSSIMAGE.components,
        totalBytes: MODEL_BYTES,
      }),
    );

    app.post(`/${APP_ID}/settings`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      saveSettings(body ?? {});
      if (
        engine.snapshot().running &&
        (body?.modelPath !== undefined ||
          body?.tier !== undefined ||
          body?.memoryMode !== undefined ||
          body?.modelFiles !== undefined)
      ) {
        engine.loadedKey = null;
      }
      schedulePush(0);
      return c.json(state());
    });

    // 单文件权重与控制/编辑适配器：下载走 aria2（与引擎、权重同一条通道），
    // 装完自动写进设置；已下好的可以再用 /files/use 切回来。
    app.post(`/${APP_ID}/files/install`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id ?? "");
      if (!id) return c.json({ ...state(), error: "缺少文件 id" }, 400);
      const found = installer.listFiles().find((item) => item.id === id);
      if (!found) return c.json({ ...state(), error: `没有这个文件：${id}` }, 404);
      if (found.installed && !body?.force) {
        installer.useFile(id);
        schedulePush(0);
        return c.json(state());
      }
      installer.installFile(id);
      schedulePush(0);
      return c.json(state());
    });

    app.post(`/${APP_ID}/files/use`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        installer.useFile(String(body?.id ?? ""));
        engine.loadedKey = null;
        schedulePush(0);
        return c.json(state());
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    // 删单文件：引擎下次 load 会用新的设置，所以把 loadedKey 一并作废。
    app.post(`/${APP_ID}/files/remove`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id ?? "");
      if (!body?.confirm) return c.json({ ...state(), error: "需要确认" }, 400);
      try {
        installer.removeFile(id);
        engine.loadedKey = null;
        schedulePush(0);
        return c.json(state());
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    app.post(`/${APP_ID}/engine/start`, async (c) => {
      try {
        await engine.start();
        schedulePush(0);
        return c.json(state());
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 500);
      }
    });

    app.post(`/${APP_ID}/install/engine`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const result = installer.enqueue("engine", {
        zipPath: body?.zipPath,
        preferCuda: body?.preferCuda,
        tag: body?.tag,
      });
      schedulePush(0);
      return c.json({ ...state(), queued: Boolean(result.queued), queuePosition: result.position ?? null, duplicate: Boolean(result.duplicate) });
    });

    app.post(`/${APP_ID}/install/weights`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      // 没传就用默认，传了认不出就报错——不能猜。
      const variant = readVariant(body?.variant);
      if (!variant) return c.json({ ...state(), error: `未知模型 ${String(body?.variant)}` }, 400);
      const result = installer.enqueue("weights", { variant });
      schedulePush(0);
      return c.json({ ...state(), queued: Boolean(result.queued), queuePosition: result.position ?? null, duplicate: Boolean(result.duplicate) });
    });

    // 自管清单：配置与分词器是一个可装可卸的条目，不属于任何一个整包。
    app.post(`/${APP_ID}/config/install`, async (c) => {
      installer.installConfigPack();
      schedulePush(0);
      return c.json(state());
    });

    app.post(`/${APP_ID}/config/remove`, async (c) => {
      try {
        installer.removeConfigPack();
        engine.loadedKey = null;
        schedulePush(0);
        return c.json(state());
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    // 校验：不重下，只对哈希；不匹配时界面会建议重下。
    app.post(`/${APP_ID}/files/verify`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const result = await installer.verifyFile(String(body?.id ?? ""));
        return c.json({ ...state(), verify: result });
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    app.post(`/${APP_ID}/config/verify`, async (c) => {
      try {
        const result = await installer.verifyConfigPack();
        return c.json({ ...state(), verify: result });
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    app.post(`/${APP_ID}/install/config`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const variant = readVariant(body?.variant);
      if (!variant) return c.json({ ...state(), error: `未知模型 ${String(body?.variant)}` }, 400);
      installer.enqueue("weights", { variant, configOnly: true });
      schedulePush(0);
      return c.json(state());
    });

    app.post(`/${APP_ID}/install/cancel`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      // 不传 id 就把所有还在跑的都停掉；传了就只停那一个。
      const id = typeof body?.id === "string" ? body.id : null;
      if (id) installer.cancel(id);
      else for (const item of installer.snapshot()) installer.cancel(item.id);
      schedulePush(0);
      return c.json(state());
    });

    // 单文件：暂停、继续、移除。taskId 定位是哪个任务，path 是落盘绝对路径。
    app.post(`/${APP_ID}/install/task`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const taskId = String(body?.taskId ?? "");
      const path = String(body?.path ?? "");
      const action = body?.action;
      if (!taskId || !path) return c.json({ ...state(), error: "缺少 taskId 或 path" }, 400);
      if (!["pause", "resume", "remove"].includes(action)) {
        return c.json({ ...state(), error: `未知动作 ${String(action)}` }, 400);
      }
      const result = await installer.taskAction(taskId, path, action);
      schedulePush(0);
      if (!result.ok) return c.json({ ...state(), error: result.error }, 400);
      return c.json(state());
    });

    // 宿主的气泡提示走页面里的 hana.toast.show，不经过服务端（见 studio.js 的 toast）。

    app.get(`/${APP_ID}/engines/available`, async (c) => {
      try {
        return c.json({ items: await installer.listReleases() });
      } catch (error) {
        return c.json({ items: [], error: message(error) }, 502);
      }
    });

    app.post(`/${APP_ID}/engines/remove`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        installer.removeEngine(String(body?.name ?? ""));
        schedulePush(0);
        return c.json(state());
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    app.post(`/${APP_ID}/models/remove`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      // 25 GiB 不能误点就没了，调用方要显式带 confirm。
      if (body?.confirm !== true) return c.json({ ...state(), error: "需要确认后才删模型" }, 400);
      try {
        const variant = readVariant(body?.variant);
        if (!variant) return c.json({ ...state(), error: `未知模型 ${String(body?.variant)}` }, 400);
        installer.removeWeights(variant);
        schedulePush(0);
        return c.json(state());
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    app.post(`/${APP_ID}/weights/use`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const variant = readVariant(body?.variant);
      if (!variant) return c.json({ ...state(), error: `未知模型 ${String(body?.variant)}` }, 400);
      const found = installer.listModels().find((entry) => entry.variant === variant);
      if (!found?.installed) return c.json({ ...state(), error: `没有已装模型 ${variant}` }, 404);
      if (found.active) return c.json(state());
      applySettings({ modelPath: found.path });
      // 换模型得先把引擎停掉，否则它还在用旧的权重跑。
      try {
        engine.stop();
        await engine.start();
      } catch (error) {
        sdk.logger.warn(`换模型后启动失败：${message(error)}`);
      }
      schedulePush(0);
      return c.json(state());
    });

    app.post(`/${APP_ID}/engine/use`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const name = String(body?.name ?? "").trim();
      const found = installer.listEngines().find((entry) => entry.name === name);
      if (!found) return c.json({ ...state(), error: `没有已装版本 ${name || "（未指定）"}` }, 404);
      if (found.current) return c.json(state());
      applySettings({ serverPath: found.serverPath });
      // 等它真站起来再返回：前端在选择期间是禁用的，这样就不会出现“上一次 hello
      // 还在路上又被下一次 stop 打断”的竞态。装不装得成也能当场看到。
      try {
        await engine.start();
      } catch (error) {
        sdk.logger.warn(`切版本后启动失败：${message(error)}`);
      }
      schedulePush(0);
      return c.json(state());
    });

    app.post(`/${APP_ID}/engine/stop`, (c) => {
      engine.stop();
      schedulePush(0);
      return c.json(state());
    });

    /** 释放显存但留住引擎：6 GB 卡上跑完一批想干别的事时用。 */
    app.post(`/${APP_ID}/engine/release`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const result = await engine.release({ keepHostCopy: body?.keepHostCopy !== false });
        schedulePush(0);
        return c.json({ ...state(), release: result });
      } catch (error) {
        return c.json({ ...state(), error: message(error) }, 400);
      }
    });

    /** 文件是什么：LoRA / 控制适配器 / DiT / 文本编码器。不加载模型也不碰显存。 */
    app.post(`/${APP_ID}/inspect`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const path = typeof body?.path === "string" ? body.path.trim() : "";
      if (!path) return c.json({ error: "缺少 path" }, 400);
      if (!existsSync(path)) return c.json({ error: `文件不存在：${path}` }, 404);
      try {
        if (!engine.snapshot().running) await engine.start();
        return c.json(await engine.inspect(path));
      } catch (error) {
        return c.json({ error: message(error) }, 502);
      }
    });

    /**
     * 空跑一次：不加载权重、不写文件，只把同一份参数交给引擎检查并给估算。
     * 大图动辄几分钟，先问一句「这个组合跑得起来吗、要多久」比事后看报错便宜。
     */
    app.post(`/${APP_ID}/estimate`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const settings = store.getSettings();
      let record;
      try {
        record = buildRecord(body ?? {}, settings);
      } catch (error) {
        return c.json({ ok: false, error: message(error) }, 400);
      }
      try {
        if (!engine.snapshot().running) await engine.start();
        const result = await engine.check(engine.loadParams(), buildGenerateParams(record));
        return c.json({ ok: Boolean(result?.ok), check: result, size: { width: record.width, height: record.height } });
      } catch (error) {
        return c.json({ ok: false, error: message(error) }, 502);
      }
    });

    /** 参考图与蒙版：界面在浏览器里按目标尺寸画好，把 PNG 传上来落盘。 */
    app.post(`/${APP_ID}/inputs/upload`, async (c) => {
      const raw = c.req.query("kind");
      const kind = ["init", "mask", "ref", "control"].includes(raw) ? raw : "init";
      try {
        const data = Buffer.from(await c.req.arrayBuffer());
        if (!data.length) return c.json({ error: "空文件" }, 400);
        if (data.length > 64 * 1024 * 1024) return c.json({ error: "文件太大（上限 64 MB）" }, 413);
        // 只认 PNG：界面自己画的就是 PNG，别的格式不猜。
        if (data.readUInt32BE(0) !== 0x89504e47) return c.json({ error: "只接受 PNG" }, 415);
        // 按内容命名：同一张图反复用只留一份。
        const hash = createHash("sha256").update(data).digest("hex");
        const name = `${hash}.png`;
        const target = join(inputsDir, name);
        if (!existsSync(target)) writeFileSync(target, data);
        return c.json({ ok: true, kind, name, path: join(inputsDir, name), url: `/${APP_ID}/inputs/${name}` });
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
    });

    app.get(`/${APP_ID}/inputs/:name`, (c) => {
      const name = String(c.req.param("name") ?? "");
      if (!/^[A-Za-z0-9._-]+\.png$/.test(name)) return c.text("not found", 404);
      const file = join(inputsDir, name);
      if (!existsSync(file)) return c.text("not found", 404);
      return c.body(readFileSync(file), 200, { "content-type": "image/png", "cache-control": "private, max-age=60" });
    });

    /** LoRA 导入：二进制直传，落在 app-data 里，路径稳定，删了 App 也找得到。 */
    app.post(`/${APP_ID}/loras/import`, async (c) => {
      const raw = String(c.req.query("name") ?? "lora.safetensors");
      const name = basename(raw).replace(/[^A-Za-z0-9._-]/g, "_") || "lora.safetensors";
      if (!/\.(safetensors|ckpt|pt)$/i.test(name)) return c.json({ error: "只接受 safetensors / ckpt / pt" }, 415);
      try {
        const data = Buffer.from(await c.req.arrayBuffer());
        if (!data.length) return c.json({ error: "空文件" }, 400);
        if (data.length > 4 * 1024 * 1024 * 1024) return c.json({ error: "文件太大（上限 4 GB）" }, 413);
        const target = join(lorasDir, name);
        writeFileSync(target, data);
        return c.json({ ok: true, name, path: target, bytes: data.length });
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
    });

    /** 控制适配器导入：与 LoRA 同一条路，只是落在 control/ 下。 */
    app.post(`/${APP_ID}/control/import`, async (c) => {
      const raw = String(c.req.query("name") ?? "control.safetensors");
      const name = basename(raw).replace(/[^A-Za-z0-9._-]/g, "_") || "control.safetensors";
      if (!/\.(safetensors|ckpt|pt)$/i.test(name)) return c.json({ error: "只接受 safetensors / ckpt / pt" }, 415);
      try {
        const data = Buffer.from(await c.req.arrayBuffer());
        if (!data.length) return c.json({ error: "空文件" }, 400);
        if (data.length > 4 * 1024 * 1024 * 1024) return c.json({ error: "文件太大（上限 4 GB）" }, 413);
        const target = join(controlDir, name);
        writeFileSync(target, data);
        return c.json({ ok: true, name, path: target, bytes: data.length });
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
    });

    app.post(`/${APP_ID}/generate`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const entry = submit(body ?? {});
        await attachTask(entry, null);
        return c.json({ job: jobView(entry), notices: entry.notices ?? [], state: state() });
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
    });

    /** 可续画的断点清单：侧栏与工具都靠它列出来。 */
    app.get(`/${APP_ID}/latent/checkpoints`, (c) => {
      const items = existsSync(checkpointsDir)
        ? readdirSync(checkpointsDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => {
              try {
                const meta = JSON.parse(readFileSync(join(checkpointsDir, name), "utf8"));
                return {
                  id: name.replace(/\.json$/, ""),
                  prompt: String(meta.prompt ?? "").slice(0, 120),
                  width: meta.width,
                  height: meta.height,
                  steps: meta.steps,
                  stepIndex: meta.stepIndex,
                  updatedAt: meta.updatedAt ?? null,
                  done: Number(meta.stepIndex) >= Number(meta.steps),
                };
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        : [];
      return c.json({ dir: checkpointsDir, items });
    });

    /** 从断点接着跑：用断点里的提示词、尺寸与调度表，已跑的步不重算。 */
    app.post(`/${APP_ID}/latent/resume`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const raw = String(body?.id ?? "").trim();
      if (!raw) return c.json({ error: "要给断点 id" }, 400);
      const isPath = raw.endsWith(".json");
      const dir = isPath ? dirname(raw) : checkpointsDir;
      const id = isPath ? basename(raw).replace(/\.json$/, "") : raw;
      const checkpoint = readCheckpoint(dir, id);
      if (!checkpoint) return c.json({ error: `找不到断点：${raw}` }, 404);
      try {
        const entry = submit({
          mode: "latent",
          prompt: checkpoint.prompt,
          negativePrompt: checkpoint.negativePrompt,
          width: checkpoint.width,
          height: checkpoint.height,
          steps: checkpoint.steps,
          cfg: checkpoint.cfg,
          shift: checkpoint.shift,
          seed: checkpoint.seed,
          sampler: "euler",
          resumeFrom: checkpoint,
        });
        await attachTask(entry, null);
        return c.json({ job: jobView(entry), state: state() });
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
    });

    /** 读不读得到：App runtime 的 fs 权限受限，越界路径会直接抡错而不是返回 false。 */
    const readable = (path) => {
      try {
        return Boolean(path) && existsSync(path);
      } catch {
        return false;
      }
    };

    /** latent 级局部重绘：只在蒙版区域上跑几步，其余 latent 不动。 */
    app.post(`/${APP_ID}/latent/inpaint`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const imagePath = String(body?.imagePath ?? "").trim();
      const maskPath = String(body?.maskPath ?? "").trim();
      if (!readable(imagePath)) return c.json({ error: `找不到底图：${imagePath}` }, 400);
      if (!readable(maskPath)) return c.json({ error: `找不到蒙版：${maskPath}` }, 400);
      try {
        await engine.start();
        await engine.ensureLoaded({});
        const output = join(outputsDir, `inpaint-${Date.now().toString(36)}.png`);
        const preset = store.getSettings().defaults;
        const result = await runLatentInpaint({
          session,
          spec: {
            imagePath,
            maskPath,
            prompt: typeof body?.prompt === "string" ? body.prompt : "",
            negativePrompt: typeof body?.negativePrompt === "string" ? body.negativePrompt : "",
            steps: Number(body?.steps) || preset.steps,
            strength: Number(body?.strength) || 0.6,
            cfg: Number(body?.cfg) || preset.cfg,
            shift: Number(body?.shift) || preset.shift,
            seed: Number(body?.seed) || 0,
            output,
          },
        });
        void ensureThumb(output);
        return c.json({ output, name: basename(output), region: result.region, stepsRun: result.stepsRun, totalSteps: result.totalSteps, state: state() });
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
    });

    app.post(`/${APP_ID}/cancel`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id ?? body?.job ?? "");
      const index = queue.findIndex((job) => job.id === id);
      if (index >= 0) {
        queue.splice(index, 1);
        store.upsertJob({ id, status: "cancelled", finishedAt: new Date().toISOString() });
        const entry = live.get(id);
        if (entry) {
          entry.status = "cancelled";
          entry.finishedAt = new Date().toISOString();
          settleTask(entry);
        }
        return c.json(state());
      }
      // 可续画任务在步与步之间检查这个标记：当前这步会被跑完，断点留着能接着跑。
      const liveEntry = live.get(id);
      if (liveEntry?.stopFlag) {
        liveEntry.stopFlag.stopped = true;
        return c.json(state());
      }
      await engine.cancel(id);
      schedulePush(0);
      return c.json(state());
    });

    // 队列里换位：排队顺序就是执行顺序，让用户自己调。
    app.post(`/${APP_ID}/queue/move`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id ?? "");
      const delta = Number(body?.delta) === -1 ? -1 : 1;
      const index = queue.findIndex((job) => job.id === id);
      if (index < 0) return c.json({ ...state(), error: "队列里没有这条" }, 404);
      const target = index + delta;
      if (target < 0 || target >= queue.length) return c.json(state());
      const [moved] = queue.splice(index, 1);
      queue.splice(target, 0, moved);
      schedulePush(0);
      return c.json(state());
    });

    app.get(`/${APP_ID}/output`, (c) => {
      const file = safeOutput(c.req.query("name"));
      if (!file) return c.text("not found", 404);
      const data = readFileSync(file);
      return c.body(data, 200, { "content-type": "image/png", "cache-control": "private, max-age=30" });
    });

    // 画廊用缩略图：一屏几十张，铺原图一张就是几 MB。首次请求生成一次，之后落盘复用。
    app.get(`/${APP_ID}/thumb`, async (c) => {
      const file = safeOutput(c.req.query("name"));
      if (!file) return c.text("not found", 404);
      const size = Math.min(1024, Math.max(64, Number(c.req.query("size")) || 320));
      const dst = thumbPath(file, size);
      if (!existsSync(dst)) await ensureThumb(file, size);
      if (!existsSync(dst)) {
        return c.body(readFileSync(file), 200, { "content-type": "image/png", "cache-control": "private, max-age=30" });
      }
      return c.body(readFileSync(dst), 200, { "content-type": "image/webp", "cache-control": "private, max-age=86400" });
    });

    // 采样预览：引擎在采样过程中不断重写同一个文件。拿到的是缩好的 WebP，
    // 原图本来就小于 640 宽时直接给 preview.png。
    app.get(`/${APP_ID}/preview`, (c) => {
      const file = engine.previewFile();
      if (!existsSync(file)) return c.text("not found", 404);
      const type = file.endsWith(".webp") ? "image/webp" : "image/png";
      return c.body(readFileSync(file), 200, { "content-type": type, "cache-control": "no-store" });
    });

    app.post(`/${APP_ID}/jobs/remove`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id ?? "").trim();
      if (!id) return c.json({ ...state(), error: "缺少 id" }, 400);
      const job = store.getJob(id);
      if (!job) return c.json({ ...state(), error: `没有记录 ${id}` }, 404);
      // 图也一起删，不然文件会变成没人引用的孤子。
      if (job.output) {
        try {
          rmSync(join(outputsDir, job.output), { force: true });
        } catch {
          /* 文件已经不在就算了 */
        }
      }
      store.removeJob(id);
      schedulePush(0);
      return c.json(state());
    });

    // 手动归类：把这几张图的会话 id 改成同一个，图片文件本身不动。
    app.post(`/${APP_ID}/outputs/conv`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const names = Array.isArray(body?.names)
        ? body.names.filter((name) => typeof name === "string" && name.trim())
        : [];
      const conv = String(body?.conv ?? "").trim();
      if (!names.length) return c.json({ ok: false, error: "缺少 names" }, 400);
      let changed = 0;
      for (const name of names) {
        const target = join(outputsDir, name);
        if (!existsSync(target)) continue;
        const current = readStudioMeta(target) ?? {};
        const next = { ...current };
        // conv 为空就是解除归属：图还在画廊里，只是不再算某一段。
        if (conv) next.conv = conv;
        else delete next.conv;
        if (writePngMeta(target, "moss-studio", JSON.stringify(next))) changed += 1;
      }
      if (changed) {
        store.invalidate?.();
        schedulePush(0);
      }
      return c.json({ ok: true, changed });
    });
  });

  // ── 工具 ──────────────────────────────────────────────────────────────────
  await sdk.tools.register({
    name: "moss_generate",
    description:
      "用本机 MOSS-Image 引擎生成一张图片。提交后立刻返回：任务进串行队列，对话里挂一张进度卡，出图后宿主把结果投递回会话。适合按提示词出图、改图方向探索、批量试参数。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "正向提示词，越具体越好。给了 layout / boxes 且其中没写 caption 时可以省，省了就用 JSON 里的 caption" },
        layout: {
          type: "object",
          description:
            "布局提示（模型面 JSON layout）：{summary:{caption, ...}, items:[{label, caption, text?, bbox:[y_min,x_min,y_max,x_max]}]}。bbox 用画布中心为原点的绝对像素坐标，与官方文档一致；适合已有精确坐标时",
        },
        layoutPath: { type: "string", description: "布局 JSON 的绝对路径（与 layout 二选一）" },
        boxes: {
          type: "array",
          description:
            "指哪画哪的快捷写法：每个框 {label, caption, text?, box:[x0,y0,x1,y1]}，坐标从画布左上角算、单位是像素，按 width×height 换算成模型要的中心坐标。给了它就以它为准",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "text / object / 其它类别" },
              caption: { type: "string", description: "这块画什么" },
              text: { type: "string", description: "label 为 text 时要渲染的字" },
              box: { type: "array", description: "[x0, y0, x1, y1]，左上角原点", items: { type: "number" } },
            },
            required: ["box"],
          },
        },
        negativePrompt: { type: "string", description: "反向提示词" },
        width: { type: "integer", description: "宽度，缺省取苔室设置里的默认值。单张最大 4.2 百万像素" },
        height: { type: "integer", description: "高度，与宽度共同受 4.2 百万像素限制" },
        steps: { type: "integer", description: "采样步数，缺省取设置值。步数越少越容易发寡，高分辨率建议多给几步" },
        cfg: { type: "number", description: "CFG，缺省 3。MOSS-Image 对高 CFG 敏感，3～4 是常态" },
        seed: { type: "integer", description: "随机种子，缺省随机。回执里会给实际用的种子" },
        sampler: {
          type: "string",
          description:
            "采样器，缺省 euler（官方组合）。可选 euler / ab2 / euler_ancestral / heun / dpmpp_2m / dpmpp_2m_sde / er_sde / res_multistep / dataspace",
        },
        scheduler: {
          type: "string",
          description: "噪声明度调度，缺省 moss（官方，逐位复现官方流水线）。可选 simple / normal / karras / exponential / beta / sgm_uniform",
        },
        shift: { type: "number", description: "噪声偏移（协议 shift），缺省 5。越大越偏重整体结构，细节少" },
        stepCache: {
          type: "string",
          description: "加速器：off（缺省）/ fbcache。fbcache 跳过快稳定下来的 DiT 块，更快但图会变（lossy）",
        },
        stepCacheThreshold: {
          type: "number",
          description: "加速器的相对变化阈值（0, 1]，缺省用模型的默认值（SFT 0.03）。越大越快、与不开缓存差得越多",
        },
        cfgTruncation: { type: "number", description: "CFG 截断 [0,1]，缺省 1（关闭）。小于 1 时只在前段跑负向分支，lossy" },
        uncondSkipLayers: {
          type: "array",
          description: "负向分支跳过的 DiT 层号，缺省 [22]（官方）；给 [] 表示不跳。数组或 \"22, 24\" 这种串都收",
          items: { type: "integer" },
        },
        slgLayers: {
          type: "array",
          description: "SLG 跳过的层号，缺省空。开了 slgScale 时才有意义",
          items: { type: "integer" },
        },
        slgScale: { type: "number", description: "SLG（跳过层引导）强度，缺省 0（关闭）。与编辑参考图不能同时开" },
        slgStart: { type: "number", description: "SLG 生效起点（占总步数的比例 0~1），缺省 0" },
        slgStop: { type: "number", description: "SLG 生效终点（0~1），缺省 1" },
        maxSequenceLength: { type: "integer", description: "提示词最大 token 数，缺省 4096。长布局提示词要够长才不会被截" },
        flowMultiplier: { type: "number", description: "flow 采样器的倍率，缺省 1；moss 调度器忽略它" },
        noiseLayout: { type: "string", description: "噪声排布：official（缺省）/ batch_stream" },
        noiseSource: { type: "string", description: "随机数源：philox（缺省）/ philox_device / brownian_tree（后两个只影响随机采样器）" },
        eta: { type: "number", description: "随机采样器（euler_ancestral / dpmpp_2m_sde）的 eta，缺省 1" },
        sNoise: { type: "number", description: "随机采样器的 s_noise，缺省 1" },
        dataspace: { type: "string", description: "dataspace 采样器的参数文件绝对路径。选了 dataspace 就必须给" },
        distill: { type: "string", description: "distill 包目录（加速蒸馏模型）；引擎会追加它的 LoRA 与步数设置" },
        loras: {
          type: "array",
          description:
            "LoRA 列表，按顺序叠加：\"路径\" 或 {path, strength}。路径必须是本机已有的 safetensors/LoRA 文件；缺省用设置里勾选的那些",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "LoRA 文件绝对路径" },
              strength: { type: "number", description: "强度，缺省 1" },
            },
            required: ["path"],
          },
        },
        loraPlacement: {
          type: "string",
          description: "LoRA 作用位置：default（缺省）/ merge（合并进权重，换 LoRA 要重载模型）/ side_branch",
        },
        mask: {
          type: "string",
          description:
            "局部重绘蒙版的绝对路径（png/jpg，与 initImage 同尺寸的灰度图：白色重画、黑色保留）。必须同时给 initImage",
        },
        maskEncoding: { type: "string", description: "蒙版编码：u8（缺省，按灰度值）/ binary01（只认 0 与 1）" },
        controlAdapter: {
          type: "string",
          description:
            "控制适配器文件的绝对路径（depth / canny / pose / lineart 那类）。先用 moss_inspect 看它支持哪些 kind 与能不能加载",
        },
        controlKind: { type: "string", description: "控制图类型，必须是适配器支持的那个 kind（moss_inspect 的 control_kinds）" },
        controlImage: { type: "string", description: "控制图绝对路径（png/jpg），引擎会按 width×height 缩放后编码" },
        controlStrength: { type: "number", description: "控制强度 0~10，缺省 1。太大会把提示词的构图盖掉" },
        controlLoraStrength: { type: "number", description: "适配器自带 LoRA 部分的强度，缺省 1" },
        referenceImages: {
          type: "array",
          description:
            "编辑适配器的参考图（绝对路径，最多 4 张，第一张是源图）。需要先把编辑适配器放进 loras；引擎按参考图重画",
          items: { type: "string" },
        },
        referenceMaxEdge: { type: "integer", description: "参考图长边像素（16~2048），缺省 512" },
        hiresScale: {
          type: "number",
          description: "高清修正倍数：0 关闭（缺省），2 表示先按基础尺寸生成、再放大 2 倍细化。不改变尺寸上限，目标尺寸同样受 4.2 百万像素 / 单边 4096 限制",
        },
        hiresSteps: { type: "integer", description: "高清修正的步数，缺省跟主采样步数一致" },
        hiresStrength: { type: "number", description: "高清修正的重绘强度，缺省 0.45，越小越贴近原图" },
        initImage: {
          type: "string",
          description:
            "图生图的参考图绝对路径（png/jpg）。给了它就按这张图的构图与配色重画，strength 控制改动幅度；适合把已有立绘或头像带进画面",
        },
        strength: { type: "number", description: "图生图的重绘强度，0.05~1，缺省 0.6。越大越偏离原图，0.8 左右会重画背景又保住配色布局" },
        resize: { type: "string", description: "参考图适配方式：crop（居中等比裁剪，缺省）/ fit（留边）/ stretch（拉伸）" },
      },
      required: [],
    },
    execute: async (args) => {
      const input = args ?? {};
      const context = args?.context ?? {};
      let entry;
      try {
        entry = submit(input);
      } catch (error) {
        return { content: [{ type: "text", text: `提交失败：${message(error)}` }], isError: true };
      }
      await attachTask(entry, typeof context.callToken === "string" ? context.callToken : "");
      const settings = store.getSettings();
      const queuedAt = queue.findIndex((job) => job.id === entry.id);
      const position = entry.status === "queued" ? (queuedAt >= 0 ? queuedAt + 1 : queue.length + 1) : null;
      const lines = [
        `已提交出图任务：${entry.width}×${entry.height}，${entry.steps} 步，CFG ${entry.cfg}，${entry.sampler} + ${entry.scheduler}，种子 ${entry.seed}。`,
        entry.loras?.length ? `- LoRA：${entry.loras.map((item) => `${basename(item.path)}@${item.strength}`).join("，")}` : "",
        entry.stepCache !== "off" ? `- 加速：${entry.stepCache}（lossy，与不开缓存不是同一张图）` : "",
        entry.initImage ? `- 参考图：${basename(entry.initImage)}${entry.mask ? " + 蒙版" : ""}，强度 ${entry.strength}` : "",
        entry.control ? `- 控制：${basename(entry.control.adapter)}（${entry.control.kind ?? "无 kind"}，${entry.control.images.length} 张图）` : "",
        entry.references?.images?.length
          ? `- 编辑参考图：${entry.references.images.length} 张（长边 ${entry.references.maxEdge}）`
          : "",
        `- 提示词：${entry.prompt.slice(0, 120)}${entry.prompt.length > 120 ? "…" : ""}`,
        entry.layout ? `- 布局：${entry.layout.items} 个框 · 尺寸与 bbox 必须对应，改尺寸要重算坐标` : "",
        ...(entry.notices ?? []).map((notice) => `- 注意：${notice}`),
        `- 进度：下方卡片实时刷新（${position ? `队列第 ${position} 位` : "已开始"}）。`,
        entry.taskId
          ? `- 宿主任务：${entry.taskId}（出图完成后自动回执）`
          : `- 宿主任务：未创建${entry.taskNote ? `（${entry.taskNote}）` : ""}`,
        settings.serverPath && settings.modelPath ? "" : "- 注意：引擎或模型路径还没配好，去苔室工作区填一下再跑。",
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          card: cardRef(entry),
          moss: {
            jobId: entry.id,
            cardId: entry.cardId,
            taskId: entry.taskId,
            width: entry.width,
            height: entry.height,
            steps: entry.steps,
            cfg: entry.cfg,
            seed: entry.seed,
            sampler: entry.sampler,
            scheduler: entry.scheduler,
            loras: entry.loras?.length ?? 0,
            stepCache: entry.stepCache,
            submittedAt: entry.createdAt,
            taskNote: entry.taskNote,
          },
        },
      };
    },
  });

  await sdk.tools.register({
    name: "moss_latent",
    description:
      "可续画的生成：走引擎的组件会话（component session），每一步的 latent 都落盘。取消、关掉 App 之后能从断点接着跑；也产出 latent 文件（与 ComfyUI 的 Flux2 LATENT 同构）。只支持 euler + moss 的文生图。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "run（新开一次）/ resume（从断点接着跑）/ list（列已有断点）/ encode（PNG → latent）/ decode（latent → PNG）" },
        prompt: { type: "string", description: "正向提示词（run 用）" },
        negativePrompt: { type: "string", description: "反向提示词" },
        width: { type: "integer", description: "宽度，缺省用设置值；必须是 16 的倍数" },
        height: { type: "integer", description: "高度，缺省用设置值" },
        steps: { type: "integer", description: "总步数（含已跑过的），resume 时用断点里的值" },
        cfg: { type: "number", description: "CFG，缺省 3" },
        shift: { type: "number", description: "噪声偏移，缺省 5；resume 时必须与断点一致" },
        seed: { type: "integer", description: "种子，缺省随机" },
        checkpointId: { type: "string", description: "resume 用：断点 id（任务 id）或 meta 文件的绝对路径" },
        batch: { type: "integer", description: "一次出几张（1~4，缺省 1）。2 张以上走 host guidance，已实测与 MOSS guidance 逐像素一致" },
        imagePath: { type: "string", description: "encode / inpaint 用：PNG 路径（尺寸要是 16 的倍数）" },
        maskPath: { type: "string", description: "inpaint 用：蒙版 PNG，与底图同尺寸，白（≥128）处重画" },
        strength: { type: "number", description: "inpaint 用：重画幅度 0.05~1，缺省 0.6；1 就是从噪声重新画这块" },
        latentPath: { type: "string", description: "decode 用：latent 文件路径" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action ?? "run");
      try {
        if (action === "list") {
          const files = existsSync(checkpointsDir)
            ? readdirSync(checkpointsDir).filter((name) => name.endsWith(".json"))
            : [];
          const rows = files
            .map((name) => {
              try {
                const meta = JSON.parse(readFileSync(join(checkpointsDir, name), "utf8"));
                const id = name.replace(/\.json$/, "");
                return `- ${id}：${meta.stepIndex}/${meta.steps} 步，${meta.width}×${meta.height}，${String(meta.prompt ?? "").slice(0, 40)}`;
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          return {
            content: [{ type: "text", text: rows.length ? [`断点 ${rows.length} 份：`, ...rows].join("\n") : "还没有断点。" }],
          };
        }

        if (action === "encode" || action === "decode") {
          const file = String(action === "encode" ? args?.imagePath ?? "" : args?.latentPath ?? "").trim();
          if (!file || !existsSync(file)) throw new Error(`找不到文件：${file}`);
          await engine.ensureLoaded({});
          await session.open({ maxRows: 1 });
          try {
            if (action === "encode") {
              const png = decodePng(readFileSync(file));
              const width = Number(png.width);
              const height = Number(png.height);
              if (width % 16 || height % 16) throw new Error(`尺寸要是 16 的倍数（现在是 ${width}×${height}）`);
              const source = png.data;
              const channels = Number(png.channels ?? 4);
              const rgb = new Uint8Array(width * height * 3);
              let j = 0;
              for (let i = 0; i < source.length; i += channels) {
                rgb[j] = source[i];
                rgb[j + 1] = source[i + 1];
                rgb[j + 2] = source[i + 2];
                j += 3;
              }
              const encoded = await session.vaeEncode({ imageBuffer: Buffer.from(rgb), width, height });
              const outPath = join(checkpointsDir, `${basename(file).replace(/\.[^.]+$/, "")}.latent`);
              writeFileSync(outPath, encoded.latents);
              return {
                content: [{ type: "text", text: `已编码成 latent：${outPath}（${width}×${height}，${encoded.latents.length} 字节）` }],
              };
            }
            const width = Number(args?.width) || 0;
            const height = Number(args?.height) || 0;
            if (!width || !height) throw new Error("decode 要给 width 与 height：latent 文件本身不含形状");
            const latents = readFileSync(file);
            const decoded = await session.vaeDecode({ latents, width, height });
            const outPath = join(outputsDir, `${basename(file).replace(/\.[^.]+$/, "")}.png`);
            writePng(outPath, decoded.pixels, width, height);
            void ensureThumb(outPath);
            return { content: [{ type: "text", text: `已解码成图片：${outPath}（${width}×${height}）` }] };
          } finally {
            await session.close();
          }
        }

        if (action === "inpaint") {
          const imagePath = String(args?.imagePath ?? "").trim();
          const maskPath = String(args?.maskPath ?? "").trim();
          if (!imagePath || !existsSync(imagePath)) throw new Error(`找不到底图：${imagePath}`);
          if (!maskPath || !existsSync(maskPath)) throw new Error(`找不到蒙版：${maskPath}`);
          await engine.start();
          await engine.ensureLoaded({});
          const output = join(outputsDir, `inpaint-${Date.now().toString(36)}.png`);
          const started = Date.now();
          const result = await runLatentInpaint({
            session,
            spec: {
              imagePath,
              maskPath,
              prompt: typeof args?.prompt === "string" ? args.prompt : "",
              negativePrompt: typeof args?.negativePrompt === "string" ? args.negativePrompt : "",
              steps: Number(args?.steps) || settings().defaults.steps,
              strength: Number(args?.strength) || 0.6,
              cfg: Number(args?.cfg) || settings().defaults.cfg,
              shift: Number(args?.shift) || settings().defaults.shift,
              seed: Number(args?.seed) || 0,
              output,
            },
          });
          void ensureThumb(output);
          const lines = [
            `已重画：${result.region.width}×${result.region.height} 的区域（左上 ${result.region.x},${result.region.y}）`,
            `- 跑了 ${result.stepsRun} 步（共 ${result.totalSteps}），${((Date.now() - started) / 1000).toFixed(1)}s`,
            `- 输出：${output}`,
            "- 这一路是 latent 级：区域不经过 VAE 往返，但整图要重新解码，区域外会有约 0.3% 的再解码差异",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: { moss: { output, region: result.region } } };
        }

        let input;
        if (action === "resume") {
          const raw = String(args?.checkpointId ?? "").trim();
          if (!raw) throw new Error("resume 要给 checkpointId（断点 id 或 meta 文件路径）");
          const isPath = raw.endsWith(".json");
          const dir = isPath ? dirname(raw) : checkpointsDir;
          const id = isPath ? basename(raw).replace(/\.json$/, "") : raw;
          const checkpoint = readCheckpoint(dir, id);
          if (!checkpoint) throw new Error(`找不到断点：${raw}`);
          input = {
            mode: "latent",
            prompt: checkpoint.prompt,
            negativePrompt: checkpoint.negativePrompt,
            width: checkpoint.width,
            height: checkpoint.height,
            steps: checkpoint.steps,
            cfg: checkpoint.cfg,
            shift: checkpoint.shift,
            seed: checkpoint.seed,
            sampler: "euler",
            resumeFrom: checkpoint,
          };
        } else {
          input = { ...args, mode: "latent", sampler: "euler" };
        }

        const entry = submit(input);
        await attachTask(entry, typeof args?.context?.callToken === "string" ? args.context.callToken : "");
        const lines = [
          `已提交可续画任务：${entry.width}×${entry.height}，${entry.steps} 步，种子 ${entry.seed}。`,
          action === "resume" ? "- 从断点接着跑，前面已跑的步不会重算。" : "- 每一步的 latent 都会落盘，中断后可以 resume。",
          `- 断点目录：${checkpointsDir}`,
          `- 进度：${entry.taskId ? `宿主任务 ${entry.taskId}` : "下方卡片实时刷新"}`,
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { moss: { jobId: entry.id, mode: "latent", width: entry.width, height: entry.height, steps: entry.steps } },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `提交失败：${message(error)}` }], isError: true };
      }
    },
  });

  await sdk.tools.register({
    name: "moss_status",
    description: "查看苔室引擎状态、当前任务、队列与最近出图，判断引擎是否就绪、模型是否已加载。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const current = state();
      const active = liveActive();
      const lines = [
        ...(current.engine.platform?.supported
          ? []
          : [`平台：${current.engine.platform?.os} ${current.engine.platform?.arch}，苔室只支持 Windows x64`]),
        `引擎：${current.engine.running ? (current.engine.loaded ? "运行中 · 模型已加载" : "运行中 · 模型未加载") : "未启动"}`,
        `引擎文件：${current.engine.serverFound ? "已定位" : "未配置"}`,
        `模型目录：${current.engine.modelFound ? "已定位" : "未配置"}`,
        current.engine.device
          ? `设备：${current.engine.device.name}${current.engine.device.totalMemoryBytes ? ` · ${(current.engine.device.totalMemoryBytes / 1024 ** 3).toFixed(1)} GB` : ""}`
          : "设备：未探测",
        // 出图缺省值：moss_generate 不传参数时就按这套跑，调参前先看这里。
        `缺省：${current.settings.defaults.width}×${current.settings.defaults.height}，${current.settings.defaults.steps} 步，CFG ${current.settings.defaults.cfg}，${current.settings.defaults.sampler} + ${current.settings.defaults.scheduler}，shift ${current.settings.defaults.shift}`,
        `精度档：${current.settings.tier} · 显存策略：${current.settings.memoryMode} · 加速：${current.settings.defaults.stepCache ?? "off"}${current.settings.defaults.loras?.length ? ` · LoRA ${current.settings.defaults.loras.filter((item) => item.enabled !== false).length}/${current.settings.defaults.loras.length}` : ""}`,
        current.settings.modelFiles?.dit
          ? `单文件 DiT：${basename(current.settings.modelFiles.dit)}`
          : current.settings.tier === "turbo"
            ? "单文件 DiT：未启用 —— turbo 档需要 INT4 ConvRot 的 DiT，bundle 里是 bf16，现在这个组合跑不出图"
            : "",
        active
          ? `当前任务：${active.id} · ${taskProgress(active).phase}${active.total ? ` ${active.step}/${active.total}` : ""}（${active.percent}%）`
          : "当前任务：空闲",
        `队列：${current.queue.length} 个等待`,
        `最近任务：${current.jobs
          .slice(0, 5)
          .map((job) => `${job.id}:${job.status}`)
          .join("，") || "无"}`,
        current.engine.lastError ? `最近错误：${current.engine.lastError}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  await sdk.tools.register({
    name: "moss_inspect",
    description:
      "问引擎一个文件是什么：LoRA / 控制适配器 / DiT / 文本编码器，能不能加载，需要哪个 tier，控制适配器支持哪些 kind。不加载模型、不占显存。给 LoRA 或单文件模型前先用它确认。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "文件绝对路径（.safetensors / .ckpt / .pt）" } },
      required: ["path"],
    },
    execute: async (args) => {
      const path = String(args?.path ?? "").trim();
      if (!path) return { content: [{ type: "text", text: "缺少 path" }], isError: true };
      if (!existsSync(path)) return { content: [{ type: "text", text: `文件不存在：${path}` }], isError: true };
      try {
        if (!engine.snapshot().running) await engine.start();
        const info = await engine.inspect(path);
        const lines = [
          `${basename(path)}：${info.kind}，${info.loadable ? "可加载" : "不可加载"}，${(info.file_bytes / 1024 ** 3).toFixed(2)} GB，${info.tensors} 个张量`,
          info.precision ? `- 精度：${info.precision}${info.quantization ? `（${info.quantization}）` : ""}` : "",
          info.tiers?.length ? `- 可用 tier：${info.tiers.join(" / ")}` : "",
          info.control_kinds?.length ? `- 控制 kind：${info.control_kinds.join(" / ")}` : "",
          info.adapter_types?.length ? `- 适配器类型：${info.adapter_types.join(" / ")}，rank ${info.lora_rank ?? "?"}` : "",
          info.base_model ? `- 基础模型：${info.base_model}` : "",
          info.note ? `- 说明：${info.note}` : "",
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { moss: info } };
      } catch (error) {
        return { content: [{ type: "text", text: `检查失败：${message(error)}` }], isError: true };
      }
    },
  });

  await sdk.tools.register({
    name: "moss_estimate",
    description:
      "开跑前空跑一次：把和 moss_generate 相同的参数交给引擎检查，返回「能不能跑、要多久」。不加载权重、不写文件，几秒内回来。大图或试新参数组合先问它。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "正向提示词，必填（给布局时可用布局里的 caption）" },
        layout: { type: "object", description: "布局 JSON，同 moss_generate" },
        boxes: { type: "array", description: "指哪画哪的框，同 moss_generate", items: { type: "object" } },
        negativePrompt: { type: "string", description: "反向提示词" },
        width: { type: "integer", description: "宽度" },
        height: { type: "integer", description: "高度" },
        steps: { type: "integer", description: "采样步数" },
        cfg: { type: "number", description: "CFG" },
        sampler: { type: "string", description: "采样器，同 moss_generate" },
        scheduler: { type: "string", description: "调度器，同 moss_generate" },
        shift: { type: "number", description: "噪声偏移" },
        stepCache: { type: "string", description: "off / fbcache" },
        loras: { type: "array", description: "LoRA 列表，同 moss_generate", items: { type: "object" } },
        hiresScale: { type: "number", description: "高清修正倍数" },
        initImage: { type: "string", description: "参考图路径" },
        mask: { type: "string", description: "蒙版路径" },
        strength: { type: "number", description: "重绘强度" },
        controlAdapter: { type: "string", description: "控制适配器路径" },
        controlKind: { type: "string", description: "控制图 kind" },
        controlImage: { type: "string", description: "控制图路径" },
        referenceImages: { type: "array", description: "编辑适配器的参考图路径", items: { type: "string" } },
      },
      required: ["prompt"],
    },
    execute: async (args) => {
      let record;
      try {
        record = buildRecord(args ?? {}, store.getSettings());
      } catch (error) {
        return { content: [{ type: "text", text: `参数不合法：${message(error)}` }], isError: true };
      }
      try {
        if (!engine.snapshot().running) await engine.start();
        const check = await engine.check(engine.loadParams(), buildGenerateParams(record));
        if (!check?.ok) {
          const error = check?.error ?? {};
          return {
            content: [{ type: "text", text: `跑不了：${error.code ?? "refused"}：${error.message ?? "引擎拒绝了这个组合"}` }],
            details: { moss: check },
            isError: true,
          };
        }
        const estimate = check.plan?.estimate ?? {};
        const lines = [
          `可以跑：${record.width}×${record.height}，${record.steps} 步，预计约 ${Math.round(estimate.total_s ?? 0)} 秒（去噪 ${Math.round(estimate.denoise_s ?? 0)} 秒，每步约 ${Number(estimate.step_s ?? 0).toFixed(2)} 秒）。`,
          `- 文本编码 ${Math.round(estimate.text_encoder_s ?? 0)} 秒，加载模型 ${Math.round(estimate.dit_load_s ?? 0)} 秒，解码 ${Math.round(estimate.decode_s ?? 0)} 秒`,
          `- 估算来源：${estimate.rates ?? "default"}（default 是引擎内置系数，measured 才是这台机器的实测）`,
          check.explanation ? `- ${check.explanation}` : "",
          ...(check.warnings ?? []).map((line) => `- 注意：${line}`),
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { moss: check } };
      } catch (error) {
        return { content: [{ type: "text", text: `估算失败：${message(error)}` }], isError: true };
      }
    },
  });

  await sdk.tools.register({
    name: "moss_engine",
    description:
      "管引擎进程：start 启动、stop 停掉、release 把显存还回去但留住引擎（下次出图自动重新加载）。显存不足、要让显卡给别的工作时用 release。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "start / stop / release / preload" },
        keepHostCopy: { type: "boolean", description: "release 时是否把 DiT 权重留在内存里（缺省 true，下次加载更快）" },
        width: { type: "integer", description: "preload 要预热的尺寸（缺省用设置里的宽）" },
        height: { type: "integer", description: "preload 要预热的高度（缺省用设置里的高）" },
        steps: { type: "integer", description: "preload 的步数（只影响内存规划，缺省用设置值）" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action ?? "");
      try {
        if (action === "start") await engine.start();
        else if (action === "stop") engine.stop();
        else if (action === "release") await engine.release({ keepHostCopy: args?.keepHostCopy !== false });
        else if (action === "preload") await engine.preload({ width: args?.width, height: args?.height, steps: args?.steps });
        else return { content: [{ type: "text", text: `未知动作 ${action}，可选 start / stop / release / preload` }], isError: true };
      } catch (error) {
        return { content: [{ type: "text", text: `${action} 失败：${message(error)}` }], isError: true };
      }
      schedulePush(0);
      const snapshot = engine.snapshot();
      const text = [
        `引擎：${snapshot.running ? "运行中" : "已停止"}${action === "release" ? "，显存已释放（模型下次出图重新加载）" : ""}`,
        `模型：${snapshot.loaded ? "已加载" : "未加载"}`,
        snapshot.lastError ? `最近错误：${snapshot.lastError}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: text.join("\n") }], details: { moss: snapshot } };
    },
  });

  // 启动时把档位和当前 DiT 对一次：错配的组合引擎要到 generate 才回 invalid_argument。
  // 放在最后：这会写一次设置，而设置事件要经由 SSE 广播，注册完才安全。
  const tierFix = installer.reconcileTier();
  if (tierFix) sdk.logger.info(`档位随 DiT 调整：${tierFix.from} → ${tierFix.to}`);

  sdk.logger.info("苔室已加载");
});
