import { hana } from "./sdk.js";

const el = (id) => document.getElementById(id);

const nodes = {
  engineDot: el("engine-dot"),
  engineText: el("engine-text"),
  engineDetail: el("engine-detail"),
  engineToggle: el("engine-toggle"),
  prompt: el("prompt"),
  negative: el("negative"),
  width: el("width"),
  height: el("height"),
  steps: el("steps"),
  cfg: el("cfg"),
  seed: el("seed"),
  generate: el("generate"),
  cancel: el("cancel"),
  message: el("message"),
  serverPath: el("server-path"),
  modelPath: el("model-path"),
  memoryMode: el("memory-mode"),
  tier: el("tier"),
  saveSettings: el("save-settings"),
  currentLabel: el("current-label"),
  currentEta: el("current-eta"),
  currentBar: el("current-bar"),
  currentPrompt: el("current-prompt"),
  grid: el("grid"),
  clearJobs: el("clear-jobs"),
  planTotal: el("plan-total"),
  planList: el("plan-list"),
  upstreamNote: el("upstream-note"),
  lightbox: el("lightbox"),
  lightboxImage: el("lightbox-image"),
};

const imageCache = new Map();
let latest = null;
let settingsLoaded = false;
let pollTimer = null;

async function api(path, init) {
  const response = await hana.api.fetch(path, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error ?? text ?? `请求失败（${response.status}）`);
  }
  return data;
}

function say(text, kind) {
  nodes.message.textContent = text;
  nodes.message.className = kind ? `hint ${kind}` : "hint";
}

function applySettings(settings) {
  if (settingsLoaded) return;
  settingsLoaded = true;
  nodes.serverPath.value = settings.serverPath ?? "";
  nodes.modelPath.value = settings.modelPath ?? "";
  nodes.memoryMode.value = settings.memoryMode;
  nodes.tier.value = settings.tier;
  nodes.width.value = settings.defaults.width;
  nodes.height.value = settings.defaults.height;
  nodes.steps.value = settings.defaults.steps;
  nodes.cfg.value = settings.defaults.cfg;
}

function renderEngine(data) {
  const { engine } = data;
  let dotClass = "dot";
  let label;
  if (!engine.serverFound) {
    dotClass = "dot err";
    label = "未找到 moss-server";
  } else if (!engine.running) {
    label = "引擎未启动";
  } else if (engine.active) {
    dotClass = "dot busy";
    label = `引擎运行中 · ${engine.active.phase || "准备中"}`;
  } else {
    dotClass = "dot on";
    label = engine.loaded ? "引擎就绪 · 模型已加载" : "引擎就绪 · 模型未加载";
  }
  nodes.engineDot.className = dotClass;
  nodes.engineText.textContent = label;
  nodes.engineText.title = engine.lastError ?? "";
  nodes.engineToggle.textContent = engine.running ? "停止" : "启动";
  nodes.engineToggle.disabled = !engine.serverFound && !engine.running;
  renderEngineDetail(engine);
}

function formatGb(bytes) {
  if (!bytes) return "";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function renderEngineDetail(engine) {
  const probe = engine.hello?.probe;
  if (!engine.running || !probe) {
    nodes.engineDetail.className = "hint";
    nodes.engineDetail.textContent = engine.lastError ?? "";
    return;
  }
  const device = (probe.devices ?? []).find((item) => item.supported) ?? (probe.devices ?? [])[0];
  const parts = [];
  if (device) parts.push(`${device.name} · ${formatGb(device.total_memory_bytes)} · CC ${device.compute_capability}`);
  if (probe.driver_cuda_version) parts.push(`驱动 CUDA ${(probe.driver_cuda_version / 1000).toFixed(1)}`);
  const cu = probe.cublaslt;
  if (cu && cu.error) {
    nodes.engineDetail.className = "hint bad";
    nodes.engineDetail.textContent = `${parts.join(" · ")}\n缺少 cuBLASLt：换 bundled 引擎包，或把 cublasLt64_13.dll 放进引擎 bin 目录`;
    return;
  }
  nodes.engineDetail.className = "hint";
  nodes.engineDetail.textContent = parts.join(" · ");
}

function renderCurrent(data) {
  const { engine, jobs, progress } = data;
  if (engine.active) {
    const info = progress?.[engine.active.jobId] ?? {};
    const percent = typeof info.percent === "number" ? info.percent : 0;
    nodes.currentLabel.textContent = `${info.label ?? "准备中"}${info.total ? ` ${info.step}/${info.total}` : ""}`;
    nodes.currentEta.textContent = info.etaMs ? `约剩 ${Math.round(info.etaMs / 1000)} 秒` : "";
    nodes.currentBar.style.width = `${percent}%`;
    const job = jobs.find((item) => item.id === engine.active.jobId);
    nodes.currentPrompt.textContent = job?.prompt ?? "";
    nodes.cancel.disabled = false;
  } else if (data.queue.length) {
    nodes.currentLabel.textContent = `队列中 ${data.queue.length} 个`;
    nodes.currentEta.textContent = "";
    nodes.currentBar.style.width = "0%";
    nodes.currentPrompt.textContent = data.queue[0]?.prompt ?? "";
    nodes.cancel.disabled = true;
  } else {
    nodes.currentLabel.textContent = "空闲";
    nodes.currentEta.textContent = "";
    nodes.currentBar.style.width = "0%";
    nodes.currentPrompt.textContent = "";
    nodes.cancel.disabled = true;
  }
  nodes.generate.disabled = Boolean(engine.active) || data.queue.length > 0;
}

function tileFor(job) {
  const tile = document.createElement("div");
  tile.className = "tile";
  if (job.status === "done" && job.output) {
    const url = imageCache.get(job.output);
    if (url) {
      const node = document.createElement("img");
      node.src = url;
      node.alt = job.prompt.slice(0, 40);
      node.addEventListener("click", () => openLightbox(url, node.alt));
      tile.appendChild(node);
    }
    const caption = document.createElement("div");
    caption.className = "caption";
    caption.textContent = `${job.width}×${job.height} · ${job.steps} 步`;
    tile.appendChild(caption);
  } else if (job.status === "error") {
    tile.classList.add("placeholder", "failed");
    tile.textContent = job.error ?? "生成失败";
  } else {
    tile.classList.add("placeholder");
    const spin = document.createElement("span");
    spin.className = "spin";
    tile.appendChild(spin);
    const text = document.createElement("span");
    text.textContent = job.status === "queued" ? "排队中" : "生成中";
    tile.appendChild(text);
  }
  return tile;
}

async function loadImage(name) {
  if (imageCache.has(name)) return imageCache.get(name);
  try {
    const response = await hana.api.fetch(`/output?name=${encodeURIComponent(name)}`);
    if (!response.ok) return null;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    imageCache.set(name, url);
    return url;
  } catch {
    return null;
  }
}

async function renderGallery(data) {
  if (!data) return;
  const visible = data.jobs.filter((job) => job.status !== "cancelled");
  await Promise.all(visible.filter((job) => job.status === "done" && job.output).map((job) => loadImage(job.output)));
  nodes.grid.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有出过图。写下提示词，按「开始生成」。";
    nodes.grid.appendChild(empty);
    return;
  }
  for (const job of visible) nodes.grid.appendChild(tileFor(job));
}

function openLightbox(src, alt) {  nodes.lightboxImage.src = src;
  nodes.lightboxImage.alt = alt ?? "";
  nodes.lightbox.hidden = false;
}

const ROLE_LABEL = { dit: "主模型", text_encoder: "文本编码器", vae: "VAE", support: "流水线" };

function formatSize(bytes) {
  if (!bytes) return "未知";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function renderPlan(data) {
  const plan = data.plan;
  if (!plan || !plan.components?.length) {
    nodes.planTotal.textContent = "没有读到模型目录快照。";
    nodes.planList.replaceChildren();
    return;
  }
  nodes.planTotal.textContent = `完整跑起来需要 ${plan.components.length} 个组件，合计约 ${formatSize(plan.totalBytes)}。`;
  nodes.planList.replaceChildren();
  for (const item of plan.components) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${ROLE_LABEL[item.role] ?? item.role} · ${item.name}`;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatSize(item.sizeBytes);
    row.append(name, size);
    nodes.planList.appendChild(row);
  }
  const upstream = data.upstream ?? {};
  nodes.upstreamNote.textContent = `上游快照 ${upstream.commit ?? "?"}（${(upstream.commitDate ?? "").slice(0, 10)}），协议 v${upstream.protocolVersion ?? "?"}，引擎仓 ${upstream.engineRepo ?? "?"}。`;
}

function render(data) {
  latest = data;
  applySettings(data.settings);
  renderEngine(data);
  renderCurrent(data);
  renderPlan(data);
  void renderGallery(data);
}

async function refresh() {
  try {
    const data = await api("/state");
    render(data);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

async function onGenerate() {
  const prompt = nodes.prompt.value.trim();
  if (!prompt) {
    say("先写一句提示词。", "bad");
    return;
  }
  nodes.generate.disabled = true;
  say("已提交，等待引擎…");
  try {
    const seed = nodes.seed.value.trim();
    const payload = {
      prompt,
      negativePrompt: nodes.negative.value,
      width: Number(nodes.width.value),
      height: Number(nodes.height.value),
      steps: Number(nodes.steps.value),
      cfg: Number(nodes.cfg.value),
    };
    if (seed) payload.seed = Number(seed);
    const result = await api("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    say(`已入队 ${result.job.id}`, "ok");
    render(result.state);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
    nodes.generate.disabled = false;
  }
}

async function onCancel() {
  if (!latest?.engine?.active) return;
  try {
    await api("/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: latest.engine.active.jobId }),
    });
    say("已请求取消");
    void refresh();
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

async function onEngineToggle() {
  const running = latest?.engine?.running;
  nodes.engineToggle.disabled = true;
  say(running ? "正在停止引擎…" : "正在启动引擎（首次会做 GPU 探测）…");
  try {
    const data = await api(running ? "/engine/stop" : "/engine/start", { method: "POST" });
    render(data);
    say(running ? "引擎已停止" : "引擎已启动", "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
    void refresh();
  } finally {
    nodes.engineToggle.disabled = false;
  }
}

async function onSaveSettings() {
  try {
    const data = await api("/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverPath: nodes.serverPath.value.trim() || null,
        modelPath: nodes.modelPath.value.trim() || null,
        memoryMode: nodes.memoryMode.value,
        tier: nodes.tier.value,
        defaults: {
          width: Number(nodes.width.value),
          height: Number(nodes.height.value),
          steps: Number(nodes.steps.value),
          cfg: Number(nodes.cfg.value),
        },
      }),
    });
    render(data);
    say("设置已保存", "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

async function onClearJobs() {
  try {
    const data = await api("/jobs/clear", { method: "POST" });
    render(data);
    say("记录已清理", "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

nodes.generate.addEventListener("click", onGenerate);
nodes.cancel.addEventListener("click", onCancel);
nodes.engineToggle.addEventListener("click", onEngineToggle);
nodes.saveSettings.addEventListener("click", onSaveSettings);
nodes.clearJobs.addEventListener("click", onClearJobs);
nodes.lightbox.addEventListener("click", () => {
  nodes.lightbox.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !nodes.lightbox.hidden) nodes.lightbox.hidden = true;
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!nodes.generate.disabled) void onGenerate();
  }
});

async function boot() {
  await hana.ready();
  await refresh();
  pollTimer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 1500);
}

void boot();
