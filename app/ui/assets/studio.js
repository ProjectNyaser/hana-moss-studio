// 苔室工作区：画布与画廊。生成设置与运行状态在左侧栏（panel.html），这边只管看。
import { hana } from "./sdk.js";
import { startLive, outputUrl } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";

const el = (id) => document.getElementById(id);
const nodes = {
  stageChip: el("stage-chip"),
  stageDot: el("stage-dot"),
  stageText: el("stage-text"),
  canvasMeta: el("canvas-meta"),
  canvas: el("canvas"),
  result: el("result"),
  resultImage: el("result-image"),
  resultCaption: el("result-caption"),
  canvasEmpty: el("canvas-empty"),
  progressBand: el("progress-band"),
  bandLabel: el("band-label"),
  bandBar: el("band-bar"),
  bandEta: el("band-eta"),
  galleryCount: el("gallery-count"),
  thumbs: el("thumbs"),
  clearJobs: el("clear-jobs"),
  lightbox: el("lightbox"),
  lightboxImage: el("lightbox-image"),
};

const imageCache = new Map();
let latest = null;
let renderedJobsKey = null;
let selectedId = null;
let lastNewestId = null;

async function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 主题 ───────────────────────────────────────────────────────────────
function syncTheme() {
  applyTheme(hana);
}

// ── 网络 ───────────────────────────────────────────────────────────────
async function api(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await hana.api.fetch(`${API}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(data?.error ?? text ?? `请求失败（${response.status}）`);
  return data;
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ── 格式化 ─────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

// ── 渲染 ───────────────────────────────────────────────────────────────
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
    const progress = engine.active.progress ?? {};
    label = `${progress.phase ?? "生成中"}${progress.total ? ` ${progress.step}/${progress.total}` : ""}`;
  } else {
    dotClass = "dot on";
    label = engine.loaded ? "就绪 · 模型已加载" : "就绪 · 模型未加载";
  }
  nodes.stageDot.className = dotClass;
  nodes.stageText.textContent = label;
  nodes.stageChip.title = engine.lastError ?? "";
}

function renderProgress(data) {
  const active = data.engine.active;
  if (!active) {
    nodes.progressBand.hidden = true;
  } else {
    const progress = active.progress ?? {};
    nodes.progressBand.hidden = false;
    nodes.bandLabel.textContent = `${progress.phase ?? "准备中"}${progress.total ? ` · ${progress.step}/${progress.total}` : ""}`;
    const percent = typeof progress.percent === "number" ? progress.percent : 0;
    nodes.bandBar.classList.toggle("indeterminate", percent <= 0);
    nodes.bandBar.querySelector("i").style.width = percent > 0 ? `${percent}%` : "36%";
    nodes.bandEta.textContent = progress.etaMs ? `约剩 ${formatDuration(progress.etaMs)}` : progress.elapsedMs ? `已跑 ${formatDuration(progress.elapsedMs)}` : "";
  }
  nodes.canvasMeta.textContent = `协议 v${data.upstream.protocolVersion ?? "?"} · 上游 ${data.upstream.commit ?? "?"} · 记录 ${data.jobs.length} 条`;
}

function latestDone(data) {
  if (selectedId) {
    const picked = data.jobs.find((job) => job.id === selectedId && job.status === "done" && job.output);
    if (picked) return picked;
  }
  return data.jobs.find((job) => job.status === "done" && job.output) ?? null;
}

function loadImage(name) {
  if (!name) return null;
  if (!imageCache.has(name)) imageCache.set(name, outputUrl(name));
  return imageCache.get(name);
}

function openLightbox(src) {
  nodes.lightboxImage.src = src;
  nodes.lightbox.hidden = false;
}

async function renderCanvas(data) {
  const job = latestDone(data);
  if (!job) {
    nodes.result.hidden = true;
    nodes.canvasEmpty.hidden = false;
    return;
  }
  const url = await loadImage(job.output);
  if (!url) {
    nodes.result.hidden = true;
    nodes.canvasEmpty.hidden = false;
    return;
  }
  nodes.canvasEmpty.hidden = true;
  nodes.result.hidden = false;
  if (nodes.resultImage.getAttribute("src") !== url) nodes.resultImage.src = url;
  const seed = job.report?.seedUsed ?? job.seed;
  nodes.resultCaption.textContent = `${job.width}×${job.height} · ${job.steps} 步 · CFG ${job.cfg} · 种子 ${seed} · ${formatDuration(job.elapsedMs)}`;
  nodes.resultImage.onclick = () => openLightbox(url);
}

async function renderGallery(data) {
  const visible = data.jobs.filter((job) => job.status !== "cancelled");
  await Promise.all(visible.filter((job) => job.status === "done" && job.output).map((job) => loadImage(job.output)));
  nodes.thumbs.replaceChildren();
  nodes.galleryCount.textContent = visible.length ? `${visible.length} 张` : "";
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "empty-line";
    empty.textContent = "还没有出过图。";
    nodes.thumbs.appendChild(empty);
    return;
  }
  for (const job of visible) {
    const tile = document.createElement("div");
    tile.className = "thumb";
    const shown = latestDone(data);
    if (job.status === "done" && job.output) {
      if (shown && shown.id === job.id) tile.classList.add("on");
      const url = imageCache.get(job.output);
      if (url) {
        const image = document.createElement("img");
        image.src = url;
        image.alt = job.prompt.slice(0, 40);
        image.loading = "lazy";
        image.addEventListener("click", () => {
          selectedId = job.id;
          renderedJobsKey = null;
          void refresh();
        });
        tile.appendChild(image);
        const meta = document.createElement("div");
        meta.className = "thumb-meta";
        meta.textContent = `${job.width}×${job.height} · ${job.steps} 步`;
        tile.appendChild(meta);
      }
    } else if (job.status === "error") {
      tile.classList.add("placeholder", "bad");
      tile.textContent = job.error ?? "生成失败";
    } else {
      tile.classList.add("placeholder");
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      const text = document.createElement("span");
      text.textContent = job.status === "queued" ? "排队中" : "生成中";
      tile.append(spinner, text);
    }
    nodes.thumbs.appendChild(tile);
  }
}

function render(data) {
  latest = data;
  renderEngine(data);
  renderProgress(data);
  // 新的一张落定时回到它，用户先前在画廊里点选的那张不挡住新结果。
  const newest = data.jobs.find((job) => job.status === "done" && job.output)?.id ?? null;
  if (newest && newest !== lastNewestId) {
    lastNewestId = newest;
    selectedId = null;
  }
  void renderCanvas(data);
  const key = data.jobs.map((job) => `${job.id}:${job.status}`).join("|");
  if (key !== renderedJobsKey) {
    renderedJobsKey = key;
    // 新任务落定时回到最新一张，旧的选择不挡住新结果。
    if (selectedId && !data.jobs.some((job) => job.id === selectedId && job.status === "done")) selectedId = null;
    void renderGallery(data);
  }
}

async function refresh() {
  try {
    render(await api("/state"));
  } catch (error) {
    nodes.stageText.textContent = error instanceof Error ? error.message : String(error);
    nodes.stageDot.className = "dot err";
  }
}

async function onClearJobs() {
  try {
    render(await post("/jobs/clear"));
    renderedJobsKey = null;
  } catch (error) {
    nodes.stageText.textContent = error instanceof Error ? error.message : String(error);
    nodes.stageDot.className = "dot err";
  }
}

nodes.clearJobs.addEventListener("click", onClearJobs);
nodes.lightbox.addEventListener("click", () => {
  nodes.lightbox.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !nodes.lightbox.hidden) nodes.lightbox.hidden = true;
});

async function boot() {
  syncTheme();
  try {
    hana.theme?.subscribe?.(() => syncTheme());
  } catch {
    /* 老宿主没有主题订阅 */
  }
  try {
    // 宿主握手可能卡住，不能让它把首帧也拖死。
    await withTimeout(hana.ready(), 5000);
  } catch {
    /* 非宿主环境 */
  }
  await refresh();
  startLive({
    hana,
    onState: (state) => render(state),
    fetchState: () => api("/state"),
    source: "studio",
    onError: (error) => {
      if (latest) return;
      nodes.stageText.textContent = error instanceof Error ? error.message : String(error);
      nodes.stageDot.className = "dot err";
    },
  });
}

void boot();
