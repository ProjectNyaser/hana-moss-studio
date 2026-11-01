import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * moss-server 是一个外部 C++/CUDA 进程，协议为 stdio JSON-lines：
 *   请求 {id, method, params} → 响应 {id, result} 或 {id, error:{code,message}}
 *   事件 {event, id, ...}，事件类型为 log / plan / progress / preview / done
 * 本文件只做一件事：把它的生命周期和消息格式包成 Promise 与事件。
 */

const PHASE_LABEL = {
  text_encoder: "文本编码",
  dit_load: "加载模型",
  denoise: "去噪采样",
  decode: "解码出图",
};

function splitLines() {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = [];
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    return lines;
  };
}

export function resolveServerPath(settingPath) {
  const candidates = [
    settingPath,
    process.env["MOSS_SERVER"],
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class Engine {
  constructor({ getSettings, outputsDir, cacheDir, onEvent }) {
    this.getSettings = getSettings;
    this.outputsDir = outputsDir;
    this.cacheDir = cacheDir;
    this.onEvent = onEvent ?? (() => {});
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.hello = null;
    this.loadedKey = null;
    this.active = null;
    this.stderrRing = [];
    this.lastError = null;
    this.startedAt = null;
  }

  /** 当前引擎状态，供前端与工具读取。 */
  snapshot() {
    return {
      running: Boolean(this.child),
      hello: this.hello,
      startedAt: this.startedAt,
      busy: Boolean(this.active),
      active: this.active ? { jobId: this.active.jobId, phase: this.active.phase } : null,
      loaded: Boolean(this.loadedKey),
      lastError: this.lastError,
      stderr: this.stderrRing.slice(-12),
    };
  }

  serverPath() {
    return resolveServerPath(this.getSettings().serverPath);
  }

  send(payload) {
    if (!this.child?.stdin?.writable) throw new Error("引擎未运行");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(id, method, params, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`引擎 ${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  call(method, params, timeoutMs = 60_000) {
    return this.request(`ms-${++this.sequence}`, method, params, timeoutMs);
  }

  dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.pushStderr(line);
      return;
    }
    if (typeof message.event === "string") {
      this.handleEvent(message);
      return;
    }
    const id = message.id;
    if (id === undefined) return;
    const entry = this.pending.get(String(id));
    if (!entry) return;
    this.pending.delete(String(id));
    clearTimeout(entry.timer);
    const error = message.error;
    if (error) {
      entry.reject(new Error(`${error.code ?? "error"}: ${error.message ?? ""}`.trim()));
    } else {
      entry.resolve(message.result ?? {});
    }
  }

  handleEvent(message) {
    const event = message.event;
    const jobId = message.id;
    if (event === "log" && (!this.active || jobId !== this.active.jobId)) {
      this.pushStderr(`[引擎] ${message.message ?? ""}`);
      return;
    }
    if (!this.active || jobId !== this.active.jobId) return;
    const active = this.active;
    switch (event) {
      case "log":
        this.onEvent({ type: "log", jobId, level: message.level === "warning" ? "warn" : "info", message: String(message.message ?? "") });
        return;
      case "plan":
        this.onEvent({ type: "log", jobId, level: "info", message: String(message.explanation ?? "") });
        return;
      case "progress": {
        const phase = String(message.phase ?? "");
        if (phase && phase !== active.phase) {
          active.phase = phase;
          this.onEvent({ type: "stage", jobId, phase, label: PHASE_LABEL[phase] ?? phase });
        }
        const step = Number(message.step ?? 0);
        const total = Number(message.total_steps ?? 0);
        const stepSeconds = Number(message.step_seconds ?? 0);
        this.onEvent({
          type: "progress",
          jobId,
          phase,
          step,
          total,
          percent: total ? Math.round((step / total) * 1000) / 10 : 0,
          etaMs: stepSeconds > 0 && total > step ? Math.round((total - step) * stepSeconds * 1000) : null,
        });
        return;
      }
      case "preview":
        return;
      case "done": {
        const status = String(message.status ?? "error");
        const warnings = Array.isArray(message.warnings) ? message.warnings : [];
        const report = message.report ?? null;
        this.active = null;
        for (const warning of warnings) {
          this.onEvent({ type: "log", jobId, level: "warn", message: String(warning) });
        }
        if (status === "ok") {
          this.onEvent({ type: "done", jobId, status: "ok", output: active.output, report });
          active.resolve?.({ status: "ok", output: active.output, report });
        } else if (status === "cancelled") {
          this.onEvent({ type: "done", jobId, status: "cancelled", output: active.output });
          active.resolve?.({ status: "cancelled", output: active.output });
        } else {
          const error = message.error ?? {};
          const text = String(error.message ?? "生成失败");
          this.lastError = text;
          this.onEvent({ type: "done", jobId, status: "error", output: active.output, error: text, code: error.code ?? null });
          active.reject?.(new Error(text));
        }
        return;
      }
      default:
        return;
    }
  }

  pushStderr(line) {
    const text = String(line).trim();
    if (!text) return;
    this.stderrRing.push(text);
    if (this.stderrRing.length > 60) this.stderrRing.shift();
    this.onEvent({ type: "engine-log", message: text });
  }

  async start() {
    if (this.child) return this.snapshot();
    const exe = this.serverPath();
    if (!exe) {
      throw new Error("没有找到 moss-server 可执行文件，请先在「引擎」里指向解压后的 moss-server.exe");
    }
    this.lastError = null;
    const binDir = dirname(exe);
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
    env[pathKey] = `${binDir};${env[pathKey] ?? ""}`;
    env["MOSS_INFER_BIN"] = binDir;

    let child;
    try {
      child = spawn(exe, ["--parent-pid", String(process.pid)], {
        cwd: binDir,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`无法启动引擎进程：${text}（需要 app/process.spawn 授权）`);
    }
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.hello = null;
    this.loadedKey = null;

    const out = splitLines();
    const err = splitLines();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of out(chunk)) if (line.trim()) this.dispatch(line.trim());
    });
    child.stderr.on("data", (chunk) => {
      for (const line of err(chunk)) {
        if (!line.trim()) continue;
        const text = line.trim();
        if (this.active) this.onEvent({ type: "log", jobId: this.active.jobId, level: "info", message: text });
        else this.pushStderr(text);
      }
    });
    child.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.pushStderr(this.lastError);
      this.teardown();
    });
    child.on("close", (code, signal) => {
      const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
      this.pushStderr(`引擎进程结束（${reason}）`);
      const active = this.active;
      this.teardown();
      if (active) {
        this.onEvent({ type: "done", jobId: active.jobId, status: "error", error: `引擎进程结束（${reason}）` });
        active.reject?.(new Error(`引擎进程结束（${reason}）`));
      }
    });

    try {
      const hello = await this.request("mi-hello", "hello", {
        client: "苔室",
        protocol_version: 2,
        devices: true,
      }, 45_000);
      if (hello.protocol_version !== 2) {
        throw new Error(`引擎协议不兼容（protocol ${hello.protocol_version}），需要 MossInfer ≥ 2.0`);
      }
      this.hello = hello;
      return this.snapshot();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.lastError = text;
      this.stop();
      throw error;
    }
  }

  /** 模型、设备、性能档任一变化都需要重新 load。 */
  async ensureLoaded(job) {
    const settings = this.getSettings();
    const key = JSON.stringify([settings.modelPath, job.device ?? 0, settings.memoryMode, settings.tier]);
    if (key === this.loadedKey) return;
    if (!settings.modelPath || !existsSync(settings.modelPath)) {
      throw new Error("模型目录不存在，请先在「设置」里指向 MOSS-Image 的 diffusers 目录");
    }
    this.onEvent({ type: "engine-log", message: "正在加载模型，首次加载需要较长时间" });
    await this.call("load", {
      model: settings.modelPath,
      mode: settings.memoryMode,
      device: job.device ?? 0,
      tier: settings.tier,
      cache_dir: this.cacheDir,
    }, 900_000);
    this.loadedKey = key;
  }

  async generate(job) {
    if (!this.child) await this.start();
    if (this.active) throw new Error("引擎正忙");
    await this.ensureLoaded(job);
    const active = { jobId: job.id, phase: "", output: job.output, resolve: null, reject: null };
    const settled = new Promise((resolve, reject) => {
      active.resolve = resolve;
      active.reject = reject;
    });
    this.active = active;
    const params = {
      output: job.output,
      prompt: job.prompt,
      negative_prompt: job.negativePrompt ?? "",
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfg: job.cfg,
      seed: job.seed,
      save_metadata: true,
      include_prompts: true,
    };
    try {
      await this.request(String(job.id), "generate", params, 3_600_000);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (this.active?.jobId === job.id) {
        this.active = null;
        this.lastError = text;
        this.onEvent({ type: "done", jobId: job.id, status: "error", error: text });
        active.reject?.(new Error(text));
      }
      throw error;
    }
    return settled;
  }

  async cancel(jobId) {
    if (!this.active || this.active.jobId !== jobId) return false;
    try {
      this.send({ id: `cancel-${++this.sequence}`, method: "cancel", params: { id: String(jobId) } });
      return true;
    } catch {
      return false;
    }
  }

  teardown() {
    this.child = null;
    this.active = null;
    this.loadedKey = null;
    this.startedAt = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("引擎进程已结束"));
    }
    this.pending.clear();
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.teardown();
    try {
      child.kill();
    } catch {
      // 进程可能已经消失
    }
  }
}

export { join as joinPath };
