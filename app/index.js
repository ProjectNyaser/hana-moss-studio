import { defineApp } from "./sdk/app-contract/server-client.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "./lib/engine.js";
import { clamp, createStore } from "./lib/store.js";
import { UPSTREAM } from "./lib/upstream.js";

export const name = "moss-studio";

/** 单次生成等待上限（工具调用侧）；界面走后台队列，不受这个限制。 */
const TOOL_WAIT_MS = 240_000;

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const outputsDir = join(dataDir, "outputs");
  const cacheDir = join(dataDir, "cache");
  for (const dir of [outputsDir, cacheDir]) mkdirSync(dir, { recursive: true });

  const store = createStore(dataDir);
  const progress = new Map();
  const queue = [];
  let running = false;

  const engine = new Engine({
    getSettings: () => store.getSettings(),
    outputsDir,
    cacheDir,
    onEvent: (event) => {
      if (event.type === "progress") {
        progress.set(event.jobId, { percent: event.percent, step: event.step, total: event.total, label: event.label ?? "去噪采样", etaMs: event.etaMs });
      } else if (event.type === "stage") {
        const current = progress.get(event.jobId) ?? { percent: 0, step: 0, total: 0 };
        progress.set(event.jobId, { ...current, label: event.label, etaMs: null });
      } else if (event.type === "done") {
        progress.delete(event.jobId);
        if (event.status === "error" && event.error) sdk.logger.warn(`生成失败：${event.error}`);
      }
    },
  });

  function pickReport(report) {
    if (!report || typeof report !== "object") return null;
    return {
      seedUsed: typeof report.seed_used === "number" ? report.seed_used : null,
      quality: report.quality ?? null,
      timings: report.timings_s ?? null,
    };
  }

  function submit(input) {
    const prompt = String(input?.prompt ?? "").trim();
    if (!prompt) throw new Error("提示词不能为空");
    const settings = store.getSettings();
    const id = `mj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fileName = `${id}.png`;
    const record = {
      id,
      prompt,
      negativePrompt: String(input?.negativePrompt ?? "").trim(),
      width: clamp(input?.width, 256, 2048, settings.defaults.width),
      height: clamp(input?.height, 256, 2048, settings.defaults.height),
      steps: clamp(input?.steps, 1, 80, settings.defaults.steps),
      cfg: clamp(input?.cfg, 0, 20, settings.defaults.cfg),
      seed: Number.isInteger(input?.seed) ? input.seed : Math.floor(Math.random() * 4294967295),
      status: "queued",
      createdAt: new Date().toISOString(),
      output: fileName,
    };
    store.upsertJob(record);
    queue.push({ ...record, output: join(outputsDir, fileName) });
    void pump();
    return record;
  }

  async function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    const startedAt = new Date();
    store.upsertJob({ id: job.id, status: "running", startedAt: startedAt.toISOString() });
    try {
      const result = await engine.generate(job);
      const elapsedMs = Date.now() - startedAt.getTime();
      if (result.status === "ok") {
        store.upsertJob({
          id: job.id,
          status: "done",
          finishedAt: new Date().toISOString(),
          elapsedMs,
          report: pickReport(result.report),
        });
      } else {
        store.upsertJob({ id: job.id, status: "cancelled", finishedAt: new Date().toISOString(), elapsedMs });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.upsertJob({
        id: job.id,
        status: "error",
        error: message,
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt.getTime(),
      });
    } finally {
      running = false;
      if (queue.length) void pump();
    }
  }

  function modelPlan() {
    const models = UPSTREAM.catalog.models;
    const official = (model) => Array.isArray(model.tags) && (model.tags.includes("official") || model.tags.includes("shared"));
    const pick = (role) => models.find((model) => model.role === role && official(model)) ?? models.find((model) => model.role === role) ?? null;
    const components = ["dit", "text_encoder", "vae", "support"]
      .map((role) => pick(role))
      .filter(Boolean)
      .map((model) => ({ role: model.role, id: model.id, name: model.name, repo: model.repo, files: model.files, subfolder: model.subfolder, sizeBytes: model.sizeBytes }));
    const totalBytes = components.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
    return {
      components,
      totalBytes,
      estimated:
        models.length === 0
          ? []
          : models
              .filter((model) => model.role === "dit" && Array.isArray(model.tags) && model.tags.includes("official"))
              .map((model) => ({ id: model.id, name: model.name, sizeBytes: model.sizeBytes })),
    };
  }

  function state() {
    const settings = store.getSettings();
    return {
      settings,
      engine: {
        ...engine.snapshot(),
        serverFound: Boolean(engine.serverPath()),
        modelFound: Boolean(settings.modelPath && existsSync(settings.modelPath)),
      },
      queue: queue.map((job) => ({ id: job.id, prompt: job.prompt })),
      running,
      jobs: store.listJobs().slice(0, 24),
      progress: Object.fromEntries(progress),
      upstream: {
        commit: UPSTREAM.source.commit,
        commitDate: UPSTREAM.source.commitDate,
        generatedAt: UPSTREAM.generatedAt,
        protocolVersion: UPSTREAM.protocol.protocolVersion,
        engineRepo: UPSTREAM.engine.repo,
        catalogUpdatedAt: UPSTREAM.catalog.updatedAt,
        models: UPSTREAM.catalog.models.length,
      },
      plan: modelPlan(),
    };
  }

  function safeOutput(name) {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.png$/.test(name)) return null;
    const target = join(outputsDir, name);
    if (!existsSync(target)) return null;
    return target;
  }

  await sdk.routes.register((app) => {
    app.get("/state", (c) => c.json(state()));

    app.get("/models", (c) =>
      c.json({
        upstream: {
          repo: UPSTREAM.source.repo,
          commit: UPSTREAM.source.commit,
          commitDate: UPSTREAM.source.commitDate,
          generatedAt: UPSTREAM.generatedAt,
          protocolVersion: UPSTREAM.protocol.protocolVersion,
          engineRepo: UPSTREAM.engine.repo,
        },
        models: UPSTREAM.catalog.models,
        plan: modelPlan(),
      }),
    );

    app.post("/settings", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      store.saveSettings(body ?? {});
      if (engine.snapshot().running && (body?.modelPath !== undefined || body?.tier !== undefined || body?.memoryMode !== undefined)) {
        engine.loadedKey = null;
      }
      return c.json(state());
    });

    app.post("/engine/start", async (c) => {
      try {
        await engine.start();
        return c.json(state());
      } catch (error) {
        return c.json({ ...state(), error: error instanceof Error ? error.message : String(error) }, 500);
      }
    });

    app.post("/engine/stop", (c) => {
      engine.stop();
      return c.json(state());
    });

    app.post("/generate", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const job = submit(body ?? {});
        return c.json({ job, state: state() });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    });

    app.post("/cancel", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const id = String(body?.id ?? "");
      const index = queue.findIndex((job) => job.id === id);
      if (index >= 0) {
        queue.splice(index, 1);
        store.upsertJob({ id, status: "cancelled", finishedAt: new Date().toISOString() });
        return c.json(state());
      }
      await engine.cancel(id);
      return c.json(state());
    });

    app.get("/output", (c) => {
      const file = safeOutput(c.req.query("name"));
      if (!file) return c.text("not found", 404);
      const data = readFileSync(file);
      return c.body(data, 200, { "content-type": "image/png", "cache-control": "private, max-age=30" });
    });

    app.post("/jobs/clear", (c) => {
      store.saveJobs(store.listJobs().filter((job) => job.status === "running" || job.status === "queued"));
      return c.json(state());
    });
  });

  await sdk.tools.register({
    name: "moss_generate",
    description:
      "用本机 MOSS-Image 引擎生成一张图片。提交后进入串行队列，等待出图并返回文件位置。适合按提示词出图、改图方向探索、批量试参数。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "正向提示词，越具体越好" },
        negativePrompt: { type: "string", description: "反向提示词" },
        width: { type: "integer", description: "宽度，缺省取 App 设置里的默认值" },
        height: { type: "integer", description: "高度" },
        steps: { type: "integer", description: "采样步数，缺省 8" },
        cfg: { type: "number", description: "CFG，缺省 3" },
        seed: { type: "integer", description: "随机种子，缺省随机" },
      },
      required: ["prompt"],
    },
    execute: async (args) => {
      const job = submit(args ?? {});
      const deadline = Date.now() + TOOL_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const record = store.getJob(job.id);
        if (!record) continue;
        if (record.status === "done") {
          return {
            content: [
              {
                type: "text",
                text: `出图完成：${record.width}×${record.height}，用时 ${Math.round((record.elapsedMs ?? 0) / 1000)} 秒，种子 ${record.report?.seedUsed ?? record.seed}。文件在苔室画廊里：${record.output}`,
              },
            ],
          };
        }
        if (record.status === "error") {
          return { content: [{ type: "text", text: `出图失败：${record.error ?? "未知错误"}` }], isError: true };
        }
        if (record.status === "cancelled") {
          return { content: [{ type: "text", text: "任务已被取消。" }] };
        }
      }
      return { content: [{ type: "text", text: `任务 ${job.id} 还在队列里，可以在苔室工作区查看进度。` }] };
    },
  });

  await sdk.tools.register({
    name: "moss_status",
    description: "查看苔室引擎状态、队列与最近任务，判断引擎是否就绪、模型是否加载。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const current = state();
      const lines = [
        `引擎：${current.engine.running ? "运行中" : "未启动"}`,
        `引擎文件：${current.engine.serverFound ? "已定位" : "未配置"}`,
        `模型目录：${current.engine.modelFound ? "已定位" : "未配置"}`,
        `当前任务：${current.engine.active ? `${current.engine.active.jobId}（${current.engine.active.phase || "准备中"}）` : "空闲"}`,
        `队列：${current.queue.length} 个等待`,
        `最近任务：${current.jobs.slice(0, 5).map((job) => `${job.id}:${job.status}`).join("，") || "无"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  sdk.logger.info("苔室已加载");
});
