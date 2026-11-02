import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const outputsDir = join(dataDir, "generated");
  const cacheDir = join(dataDir, "cache");
  for (const dir of [outputsDir, cacheDir]) mkdirSync(dir, { recursive: true });

  const store = createStore(dataDir);
  /** 改设置的后置动作：路径变了就停引擎，模型下次生成重新 load。装完与切换版本都走这里。 */
  const applySettings = (patch) => {
    store.saveSettings(patch);
    // 路径变了：引擎在跑就停掉，旧的那份不能再往上跑；模型下次生成重新 load。
    if (patch.serverPath && engine.snapshot().running) engine.stop();
    engine.loadedKey = null;
  };
  const installer = createInstaller({
    dataDir,
    getSettings: () => store.getSettings(),
    saveSettings: applySettings,
    onUpdate: () => schedulePush(0),
    // 装完直接拉起来，省用户一次点击；失败不影响安装结果。
    onInstalled: (kind) => {
      if (kind !== "engine") return;
      engine.start().catch((error) => sdk.logger.warn(`装完自动启动失败：${message(error)}`));
    },
  });
  const queue = [];
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
      schedulePush(180);
      if (event.type === "stage") {
        entry.phase = event.phase ?? entry.phase;
        if (entry.phase && !entry.phasesSeen.includes(entry.phase)) entry.phasesSeen.push(entry.phase);
        syncTask(entry, { progress: taskProgress(entry) });
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

  // 引擎硬限制：单张基础图不超过 4.2 百万像素（侧长也按 16 对齐）。超出的分辨率走高清修正。
  const MAX_PIXELS = 4_200_000;
  const MAX_SIDE = 4096;
  const MIN_SIDE = 256;

  function resolveSize(input, defaults) {
    const round16 = (value) => Math.max(16, Math.round(value / 16) * 16);
    const width = round16(clamp(input?.width, MIN_SIDE, MAX_SIDE, defaults.width));
    const height = round16(clamp(input?.height, MIN_SIDE, MAX_SIDE, defaults.height));
    if (width * height > MAX_PIXELS) {
      throw new Error(
        `MOSS-Image 单张最大 4.2 百万像素（例如 2048×2048、2560×1600）。` +
          `${width}×${height} 是 ${((width * height) / 1e6).toFixed(1)} 百万像素，要更大请用高清修正（hiresScale）分两步出图`,
      );
    }
    return { width, height };
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
      steps: clamp(input?.steps, MIN_STEPS, 80, Math.max(MIN_STEPS, settings.defaults.steps)),
      cfg: clampFloat(input?.cfg, 0, 20, settings.defaults.cfg),
      seed: Number.isInteger(input?.seed) ? input.seed : Math.floor(Math.random() * 4294967295),
      hiresScale: clamp(input?.hiresScale ?? settings.defaults.hiresScale, 0, 3, 0),
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
    if (record.hiresScale > 0) {
      const round16 = (value) => Math.max(16, Math.round((value * record.hiresScale) / 16) * 16);
      record.hiresWidth = round16(box.width);
      record.hiresHeight = round16(box.height);
    }
    store.upsertJob(record);
    const entry = remember(liveEntry(record));
    queue.push({ ...record, output: join(outputsDir, fileName) });
    schedulePush(0);
    void pump();
    return entry;
  }

  async function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
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
    }
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
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfg: job.cfg,
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
              phase: active.phase,
              progress: taskProgress(active),
            }
          : null,
      },
      queue: queue.map((job) => ({ id: job.id, prompt: job.prompt })),
      running,
      jobs: store.listJobs().slice(0, 24).map(slimJob),
      progress: Object.fromEntries([...live.values()].map((entry) => [entry.id, taskProgress(entry)])),
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
      queue: queue.map((job) => ({ id: job.id, prompt: job.prompt, width: job.width, height: job.height })),
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

    app.get(`/${APP_ID}/state`, (c) => c.json(state()));

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
          }, 15000);
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
      if (installer.busy()) return c.json({ ...state(), error: "已有安装在进行" }, 409);
      const body = await c.req.json().catch(() => ({}));
      installer
        .installEngine({ zipPath: body?.zipPath, preferCuda: body?.preferCuda })
        .catch((error) => sdk.logger.warn(`引擎安装失败：${message(error)}`));
      return c.json(state());
    });

    app.post(`/${APP_ID}/install/weights`, async (c) => {
      if (installer.busy()) return c.json({ ...state(), error: "已有安装在进行" }, 409);
      installer.installWeights().catch((error) => sdk.logger.warn(`权重下载失败：${message(error)}`));
      return c.json(state());
    });

    app.post(`/${APP_ID}/install/cancel`, (c) => {
      installer.cancel();
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

    app.get(`/${APP_ID}/output`, (c) => {
      const file = safeOutput(c.req.query("name"));
      if (!file) return c.text("not found", 404);
      const data = readFileSync(file);
      return c.body(data, 200, { "content-type": "image/png", "cache-control": "private, max-age=30" });
    });

    app.post(`/${APP_ID}/jobs/clear`, (c) => {
      store.saveJobs(store.listJobs().filter((job) => job.status === "running" || job.status === "queued"));
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
          description: "高清修正倍数：0 关闭（缺省），2 表示先按基础尺寸生成再放大 2 倍精修。4K 就走这条路",
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
