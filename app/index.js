import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { Engine } from "./lib/engine.js";
import { clamp, clampFloat, createStore } from "./lib/store.js";
import { MOSSIMAGE, MODEL_BYTES } from "./lib/mossimage.js";
import { createInstaller, probeGpu, probeGpuDetailed } from "./lib/installer.js";

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
 * 早期的缓存与 aria2 日志写在 dataDir 顶层，现在统一住 .runtime-tmp。
 * 引擎的文本编码器缓存（.miemb）搬过去还能接着用，日志直接删。
 */
function migrateRuntimeDirs(dataDir, cacheDir) {
  for (const name of ["cache", "logs"]) {
    const from = join(dataDir, name);
    if (!existsSync(from)) continue;
    if (name === "cache") {
      for (const entry of readdirSync(from)) {
        const to = join(cacheDir, entry);
        if (existsSync(to)) continue;
        try {
          renameSync(join(from, entry), to);
        } catch {
          // 搬不动的跟旧目录一起删；缓存丢了能重算。
        }
      }
    }
    rmSync(from, { recursive: true, force: true });
  }
}

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const outputsDir = join(dataDir, "generated");
  // 运行时产物（缓存、日志）统一放 .runtime-tmp，顶层只留持久数据：
  // engine / models / generated / settings.json。
  const runtimeDir = join(dataDir, ".runtime-tmp");
  const cacheDir = join(runtimeDir, "cache");
  for (const dir of [outputsDir, cacheDir]) mkdirSync(dir, { recursive: true });
  migrateRuntimeDirs(dataDir, cacheDir);

  const store = createStore(dataDir, outputsDir);
  /** 改设置的后置动作：路径变了就停引擎，模型下次生成重新 load。装完与切换版本都走这里。 */
  const applySettings = (patch) => {
    store.saveSettings(patch);
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
    cacheDir,
    getSettings: () => store.getSettings(),
    saveSettings: applySettings,
    // 下载每秒会跳好几次，推全量 state 太浪费；只把安装那一段当成小帧送出去。
    // 收尾时（成功、失败、取消）例外：版本与模型列表跟着变了，要整帧刷新。
    onUpdate: () => {
      const snap = installer.snapshot();
      if (snap?.finishedAt) schedulePush(0);
      else pushEvent("transfer", { install: snap });
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
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfg: job.cfg,
      seed: job.seed,
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
    cacheDir,
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

  function pickReport(report) {
    if (!report || typeof report !== "object") return null;
    return {
      seedUsed: typeof report.seed_used === "number" ? report.seed_used : null,
      quality: report.quality ?? null,
      timings: report.timings_s ?? null,
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

  function submit(input) {
    const prompt = String(input?.prompt ?? "").trim();
    if (!prompt) throw new Error("提示词不能为空");
    const settings = store.getSettings();
    const box = resolveSize(input, settings.defaults);
    const id = `mj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fileName = `${id}.png`;
    const record = {
      id,
      prompt,
      negativePrompt: String(input?.negativePrompt ?? "").trim(),
      width: box.width,
      height: box.height,
      // 用户要的尺寸与实际出的尺寸不一致时，留个底，便于事后对照。
      sizeRequested: box.adjusted ? box.requested : null,
      steps: clamp(input?.steps, MIN_STEPS, 80, Math.max(MIN_STEPS, settings.defaults.steps)),
      cfg: clampFloat(input?.cfg, 0, 20, settings.defaults.cfg),
      seed: Number.isInteger(input?.seed) ? input.seed : Math.floor(Math.random() * 4294967295),
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
      initImage: typeof input?.initImage === "string" && input.initImage.trim() ? input.initImage.trim() : null,
      strength: clampFloat(input?.strength, 0.05, 1, 0.6),
      resize: ["crop", "fit", "stretch"].includes(input?.resize) ? input.resize : "crop",
      status: "queued",
      createdAt: new Date().toISOString(),
      output: fileName,
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
    store.upsertJob(record);
    const entry = remember(liveEntry(record));
    queue.push({ ...record, output: join(outputsDir, fileName) });
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
      const result = await engine.generate(job);
      const elapsedMs = Date.now() - startedAt.getTime();
      if (result.status === "ok") {
        const report = pickReport(result.report);
        store.upsertJob({ id: job.id, status: "done", finishedAt: new Date().toISOString(), elapsedMs, report });
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
    return {
      id: job.id,
      cardId: cardIdOf(job.id),
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? "",
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfg: job.cfg,
      // 高清修正开着时引擎总步数会多出第二阶段，界面要能解释这个差额。
      hiresScale: job.hiresScale ?? 0,
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

  function state() {
    const settings = store.getSettings();
    const snapshot = engine.snapshot();
    const active = liveActive();
    return {
      settings,
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
        const all = store.listJobs();
        const pending = all.filter((job) => job.status !== "done" && job.status !== "cancelled");
        const done = all.filter((job) => job.status === "done").slice(0, 2);
        return [...pending, ...done].map(slimJob);
      })(),
      // 全量记录数：state 只带前面那些，界面上的总数不能跟着它算。
      jobTotal: store.listJobs().length,
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
      install: installer.snapshot(),
      engines: installer.listEngines(),
      models: installer.listModels(),
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
      install: installer.snapshot(),
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
      hiresScale: source.hiresScale ?? 0,
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

  // 画廊分页：state 只带最近 24 条，剩下的从这里拉。
  app.get(`/${APP_ID}/jobs`, (c) => {
    const all = store.listJobs();
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 60));
    return c.json({
      total: all.length,
      offset,
      jobs: all.slice(offset, offset + limit).map(slimJob),
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
      store.saveSettings(body ?? {});
      if (
        engine.snapshot().running &&
        (body?.modelPath !== undefined || body?.tier !== undefined || body?.memoryMode !== undefined)
      ) {
        engine.loadedKey = null;
      }
      schedulePush(0);
      return c.json(state());
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
      return c.json({
        ...state(),
        queued: result.queued,
        position: result.position,
        duplicate: Boolean(result.duplicate),
      });
    });

    app.post(`/${APP_ID}/install/weights`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      // 没传就用默认，传了认不出就报错——不能猜。
      const variant = readVariant(body?.variant);
      if (!variant) return c.json({ ...state(), error: `未知模型 ${String(body?.variant)}` }, 400);
      const result = installer.enqueue("weights", { variant });
      schedulePush(0);
      return c.json({
        ...state(),
        queued: result.queued,
        position: result.position,
        duplicate: Boolean(result.duplicate),
      });
    });

    app.post(`/${APP_ID}/install/cancel`, (c) => {
      installer.cancel();
      schedulePush(0);
      return c.json(state());
    });

    // 单任务：暂停、继续、移除。out 是相对路径，面板上点哪一行传哪个。
    app.post(`/${APP_ID}/install/task`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const out = String(body?.out ?? "");
      const action = body?.action;
      if (!out) return c.json({ ...state(), error: "缺少 out" }, 400);
      if (!["pause", "resume", "remove"].includes(action)) {
        return c.json({ ...state(), error: `未知动作 ${String(action)}` }, 400);
      }
      const result = await installer.taskAction(out, action);
      schedulePush(0);
      if (!result.ok) return c.json({ ...state(), error: result.error }, 400);
      return c.json(state());
    });

    // 宿主的气泡提示：页面自己画的那个只作兵底，用宿主的效果与主题一致。
    app.post(`/${APP_ID}/toast`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const text = String(body?.message ?? "");
      if (!text) return c.json({ ok: false, error: "缺少 message" }, 400);
      try {
        await sdk.ui?.toast?.show({ message: text, type: body?.type ?? "info", duration: 2400 });
        return c.json({ ok: true });
      } catch (error) {
        sdk.logger.warn(`气泡提示没弹出来：${message(error)}`);
        return c.json({ ok: false, error: message(error) });
      }
    });

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

    app.post(`/${APP_ID}/generate`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const entry = submit(body ?? {});
        await attachTask(entry, null);
        return c.json({ job: jobView(entry), state: state() });
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

    // 采样预览：引擎在采样过程中不断重写同一个文件。
    // 体积大的那些引擎会额外给一份 JPEG，界面优先读它。
    app.get(`/${APP_ID}/preview`, (c) => {
      const file = engine.previewFile();
      if (!existsSync(file)) return c.text("not found", 404);
      const type = file.endsWith(".jpg") ? "image/jpeg" : "image/png";
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

    app.post(`/${APP_ID}/jobs/clear`, (c) => {
      // 记录跟着图走，这里只把成功过的任务清出运行态，不动文件。
      schedulePush(0);
      return c.json(state());
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
        prompt: { type: "string", description: "正向提示词，越具体越好" },
        negativePrompt: { type: "string", description: "反向提示词" },
        width: { type: "integer", description: "宽度，缺省取苔室设置里的默认值。单张最大 4.2 百万像素" },
        height: { type: "integer", description: "高度，与宽度共同受 4.2 百万像素限制" },
        steps: { type: "integer", description: "采样步数，缺省取设置值。步数越少越容易发寡，高分辨率建议多给几步" },
        cfg: { type: "number", description: "CFG，缺省 3" },
        seed: { type: "integer", description: "随机种子，缺省随机" },
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
      required: ["prompt"],
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
        `已提交出图任务：${entry.width}×${entry.height}，${entry.steps} 步，CFG ${entry.cfg}，种子 ${entry.seed}。`,
        `- 提示词：${entry.prompt.slice(0, 120)}${entry.prompt.length > 120 ? "…" : ""}`,
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
            submittedAt: entry.createdAt,
            taskNote: entry.taskNote,
          },
        },
      };
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
        active
          ? `当前任务：${active.id} · ${taskProgress(active).phase}${active.total ? ` ${active.step}/${active.total}` : ""}（${active.percent}%）`
          : "当前任务：空闲",
        `队列：${current.queue.length} 个等待`,
        `最近任务：${current.jobs
          .slice(0, 5)
          .map((job) => `${job.id}:${job.status}`)
          .join("，") || "无"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  sdk.logger.info("苔室已加载");
});
