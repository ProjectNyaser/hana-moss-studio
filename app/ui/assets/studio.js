// 苔室工作区：画布、画廊、队列、版本、下载五个视图。生成设置在左侧栏（panel.html）。
import { hana } from "./sdk.js";
import { startLive, outputUrl } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";

const el = (id) => document.getElementById(id);
const nodes = {
  tabs: el("studio-tabs"),
  tabCount: el("tab-count"),
  tabQueue: el("tab-queue"),
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
  ctxMenu: el("ctx-menu"),
  lightboxClose: el("lightbox-close"),
  lightbox: el("lightbox"),
  lightboxImage: el("lightbox-image"),
  // 队列
  queueRunningState: el("queue-running-state"),
  queueRunning: el("queue-running"),
  queueCount: el("queue-count"),
  queueList: el("queue-list"),
  queueFailedCount: el("queue-failed-count"),
  queueFailed: el("queue-failed"),
  // 版本
  engineState: el("versions-engine-state"),
  engineToggle: el("versions-engine-toggle"),
  engineNote: el("versions-engine-note"),
  installed: el("versions-installed"),
  modelState: el("versions-model-state"),
  modelList: el("versions-model"),
  removeModel: el("versions-remove-model"),
  host: el("versions-host"),
  // 下载
  downloadState: el("download-state"),
  downloadEngine: el("download-engine"),
  downloadWeights: el("download-weights"),
  downloadCancel: el("download-cancel"),
  downloadBar: el("download-bar"),
  downloadMessage: el("download-message"),
  downloadAvailableState: el("download-available-state"),
  downloadAvailable: el("download-available"),
};

const views = ["canvas", "gallery", "queue", "versions", "download"];
const imageCache = new Map();
let latest = null;
let renderedJobsKey = null;
let selectedId = null;
let lastNewestId = null;
let currentView = "canvas";
let releasesLoaded = false;

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
  const timer = setTimeout(() => controller.abort(), 15000);
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

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

const tail = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : "");

// ── 视图切换 ───────────────────────────────────────────────────────────
function showView(view) {
  if (!views.includes(view)) return;
  currentView = view;
  for (const tab of nodes.tabs.querySelectorAll(".studio-tab")) {
    tab.classList.toggle("on", tab.dataset.view === view);
  }
  for (const name of views) {
    const section = el(`view-${name}`);
    if (section) section.hidden = name !== view;
  }
  if (view === "download") void loadReleases();
  // 画廊在隐藏状态下 clientWidth 是 0，首次算出来的列数偏少；显出来后重排一次。
  if (view === "gallery" && galleryEntries.length) {
    requestAnimationFrame(() => layoutGallery(galleryEntries));
  }
}

// ── 画布 ───────────────────────────────────────────────────────────────
function renderStage(data) {
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
  nodes.canvasMeta.textContent = `引擎 ${data.mossimage?.version ?? "?"} · 协议 v${data.mossimage?.protocolVersion ?? "?"} · 记录 ${data.jobs.length} 条`;
}

function renderProgress(data) {
  const active = data.engine.active;
  if (!active) {
    nodes.progressBand.hidden = true;
    return;
  }
  const progress = active.progress ?? {};
  nodes.progressBand.hidden = false;
  nodes.bandLabel.textContent = `${progress.phase ?? "准备中"}${progress.total ? ` · ${progress.step}/${progress.total}` : ""}`;
  const percent = typeof progress.percent === "number" ? progress.percent : 0;
  nodes.bandBar.classList.toggle("indeterminate", percent <= 0);
  nodes.bandBar.querySelector("i").style.width = percent > 0 ? `${percent}%` : "36%";
  nodes.bandEta.textContent = progress.etaMs
    ? `约剩 ${formatDuration(progress.etaMs)}`
    : progress.elapsedMs
      ? `已跑 ${formatDuration(progress.elapsedMs)}`
      : "";
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

// ── 画廊 ───────────────────────────────────────────────────────────────
const GALLERY_GAP = 10;
const GALLERY_MIN_COL = 208;
let galleryEntries = [];

/** 把已建好的卡按「当前最矮的一列」分配，列高才不会差太多。 */
function layoutGallery(entries) {
  const grid = nodes.thumbs;
  const width = grid.clientWidth || 900;
  const columns = Math.max(1, Math.floor((width + GALLERY_GAP) / (GALLERY_MIN_COL + GALLERY_GAP)));
  const colWidth = (width - GALLERY_GAP * (columns - 1)) / columns;
  const cols = [];
  const heights = [];
  for (let i = 0; i < columns; i += 1) {
    const col = document.createElement("div");
    col.className = "gallery-col";
    cols.push(col);
    heights.push(0);
  }
  for (const { job, tile } of entries) {
    const w = Number(job.width) || 1;
    const h = Number(job.height) || 1;
    // 图未加载时用宽高比估高度，布局不会因为加载完成而跳。
    const estimate = job.width && job.height ? Math.round((colWidth / w) * h) + 26 : Math.round(colWidth);
    const index = heights.indexOf(Math.min(...heights));
    cols[index].appendChild(tile);
    heights[index] += estimate + GALLERY_GAP;
  }
  grid.replaceChildren(...cols);
}

async function renderGallery(data) {
  const visible = data.jobs.filter((job) => job.status !== "cancelled");
  await Promise.all(visible.filter((job) => job.status === "done" && job.output).map((job) => loadImage(job.output)));
  nodes.galleryCount.textContent = visible.length ? `${visible.length} 张` : "";
  nodes.tabCount.textContent = visible.length ? ` ${visible.length}` : "";
  if (!visible.length) {
    galleryEntries = [];
    const empty = document.createElement("p");
    empty.className = "empty-line";
    empty.textContent = "还没有出过图。";
    nodes.thumbs.replaceChildren(empty);
    return;
  }

  const entries = [];
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
        image.title = job.prompt;
        if (job.width && job.height) image.style.aspectRatio = `${job.width} / ${job.height}`;
        image.addEventListener("click", () => {
          selectedId = job.id;
          renderedJobsKey = null;
          showView("canvas");
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
    // 右键菜单：看大图、用这张的参数、删除。失败的记录也走这里。
    tile.addEventListener("contextmenu", (event) => openMenu(event, job));
    entries.push({ job, tile });
  }

  galleryEntries = entries;
  layoutGallery(entries);
}

// ── 行与确认 ───────────────────────────────────────────────────────────
function manageRow({ name, meta, on, actions = [], remove }) {
  const row = document.createElement("div");
  row.className = on ? "manage-row on" : "manage-row";
  const nameNode = document.createElement("span");
  nameNode.className = "name";
  nameNode.textContent = name;
  nameNode.title = name;
  row.append(nameNode);
  if (meta) {
    const metaNode = document.createElement("span");
    metaNode.className = "meta";
    metaNode.textContent = meta;
    row.append(metaNode);
  }
  for (const action of actions) {
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => void action.run());
    row.append(button);
  }
  if (remove) {
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = remove.label;
    armable(button, remove.armedLabel, remove.label, remove.run);
    row.append(button);
  }
  return row;
}

/** 两段式确认：再点一次才真删，四秒不复位就恢复原样。 */
function armable(button, armedLabel, idleLabel, run) {
  if (button.dataset.armed === "1") {
    delete button.dataset.armed;
    button.textContent = idleLabel;
    void run();
    return;
  }
  button.dataset.armed = "1";
  button.textContent = armedLabel;
  setTimeout(() => {
    if (button.dataset.armed !== "1") return;
    delete button.dataset.armed;
    button.textContent = idleLabel;
  }, 4000);
}

const runSafe = async (fn, label) => {
  try {
    const next = await fn();
    if (next) render(next);
  } catch (error) {
    nodes.downloadMessage.textContent = `${label}失败：${error instanceof Error ? error.message : String(error)}`;
  }
};

// ── 队列 ───────────────────────────────────────────────────────────────
function renderQueue(data) {
  const active = data.engine.active;
  const queue = Array.isArray(data.queue) ? data.queue : [];
  const failed = data.jobs.filter((job) => job.status === "error");
  nodes.tabQueue.textContent = active || queue.length ? ` ${queue.length + (active ? 1 : 0)}` : "";

  nodes.queueRunningState.textContent = active ? `${active.prompt?.slice(0, 24) ?? ""}…` : "空闲";
  nodes.queueRunning.replaceChildren(
    ...(active
      ? [
          manageRow({
            name: active.prompt || "(无提示词)",
            meta: `${active.phase ?? "生成中"}${active.progress?.total ? ` ${active.progress.step}/${active.progress.total}` : ""}`,
            on: true,
          }),
        ]
      : [manageRow({ name: "没有正在跑的任务" })]),
  );

  nodes.queueCount.textContent = queue.length ? `${queue.length} 条` : "";
  nodes.queueList.replaceChildren(
    ...(queue.length
      ? queue.map((job, index) => manageRow({ name: `${index + 1}. ${job.prompt || "(无提示词)"}`, meta: "排队中" }))
      : [manageRow({ name: "队列是空的" })]),
  );

  nodes.queueFailedCount.textContent = failed.length ? `${failed.length} 条` : "";
  nodes.queueFailed.replaceChildren(
    ...(failed.length
      ? failed.slice(0, 8).map((job) =>
          manageRow({
            name: job.prompt || "(无提示词)",
            meta: (job.error ?? "失败").slice(0, 40),
            remove: { label: "删除", armedLabel: "确认", run: () => removeJob(job.id) },
          }),
        )
      : [manageRow({ name: "没有失败的记录" })]),
  );
}

// ── 版本 ───────────────────────────────────────────────────────────────
function renderVersions(data) {
  const { engine } = data;

  nodes.engineState.textContent = engine.running
    ? engine.loaded
      ? "运行中 · 模型已加载"
      : "运行中"
    : engine.serverFound
      ? "已安装，未启动"
      : "未安装";
  nodes.engineToggle.textContent = engine.running ? "停止引擎" : "启动引擎";
  nodes.engineToggle.disabled = !engine.serverFound && !engine.running;
  const cublasError = engine.device?.cublaslt?.error;
  nodes.engineNote.textContent = cublasError
    ? "缺 cuBLASLt：这个包能启动但出不了图，换 bundled 版本"
    : (engine.lastError ?? "");

  const engines = Array.isArray(data.engines) ? data.engines : [];
  nodes.installed.replaceChildren(
    ...(engines.length
      ? engines.map((item) =>
          manageRow({
            name: `${item.version} · ${item.cuda ?? ""}${item.variant === "system-cuda" ? " · system-cuda" : ""}`,
            meta: formatSize(item.bytes),
            on: item.current,
            actions: item.current
              ? []
              : [{ label: "切换", run: () => runSafe(() => post("/engine/use", { name: item.name }), "切换") }],
            remove: {
              label: "卸载",
              armedLabel: "确认卸载",
              run: () => runSafe(() => post("/engines/remove", { name: item.name }), "卸载"),
            },
          }),
        )
      : [manageRow({ name: "还没有装引擎，去「下载」页装一个" })]),
  );

  const modelDir = data.settings?.modelPath;
  nodes.modelState.textContent = engine.modelFound ? "已就位" : "未安装";
  nodes.removeModel.hidden = !engine.modelFound;
  nodes.modelList.replaceChildren(
    manageRow({
      name: engine.modelFound ? tail(modelDir) || "模型目录" : "还没有下载权重",
      meta: engine.modelFound && data.plan?.totalBytes ? formatSize(data.plan.totalBytes) : "",
      on: engine.modelFound,
    }),
  );

  const hostRows = [];
  if (data.gpu) hostRows.push(manageRow({ name: data.gpu.name, meta: `驱动 ${data.gpu.driver}` }));
  if (engine.device?.totalMemoryBytes) hostRows.push(manageRow({ name: "显存", meta: formatSize(engine.device.totalMemoryBytes) }));
  hostRows.push(manageRow({ name: "引擎协议", meta: `v${data.mossimage?.protocolVersion ?? "?"}` }));
  nodes.host.replaceChildren(...hostRows);
}

// ── 下载 ───────────────────────────────────────────────────────────────
function renderDownload(data) {
  const job = data.install;
  nodes.downloadEngine.disabled = Boolean(job && !job.finishedAt);
  nodes.downloadWeights.disabled = Boolean(job && !job.finishedAt);
  if (!job) {
    nodes.downloadBar.hidden = true;
    nodes.downloadCancel.hidden = true;
    nodes.downloadState.textContent = "";
    nodes.downloadMessage.textContent = "";
    return;
  }
  const percent = Math.max(0, Math.min(100, job.percent ?? 0));
  nodes.downloadBar.hidden = false;
  nodes.downloadBar.querySelector("i").style.width = `${percent || 4}%`;
  nodes.downloadCancel.hidden = Boolean(job.finishedAt);
  nodes.downloadState.textContent = job.phase ?? "";
  nodes.downloadMessage.textContent = job.error
    ? `${job.phase}：${job.error}`
    : `${job.label ?? ""} ${job.message ?? ""}${job.totalBytes ? ` ${formatSize(job.bytes)} / ${formatSize(job.totalBytes)}` : ""}`.trim();
}

async function loadReleases(force = false) {
  if (releasesLoaded && !force) return;
  nodes.downloadAvailableState.textContent = "读取中…";
  nodes.downloadAvailable.replaceChildren(manageRow({ name: "读取版本列表…" }));
  try {
    const data = await api("/engines/available");
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      nodes.downloadAvailableState.textContent = "";
      nodes.downloadAvailable.replaceChildren(manageRow({ name: data?.error ?? "没有可装的版本" }));
      return;
    }
    releasesLoaded = true;
    nodes.downloadAvailableState.textContent = `${items.length} 个`;
    nodes.downloadAvailable.replaceChildren(
      ...items.map((item) =>
        manageRow({
          name: item.version,
          meta: [item.publishedAt?.slice(0, 10), item.bundledBytes ? formatSize(item.bundledBytes) : null]
            .filter(Boolean)
            .join(" · "),
          on: item.installed,
          actions: item.installed
            ? []
            : [{ label: "装", run: () => runSafe(() => post("/install/engine", { tag: item.tag }), "安装") }],
        }),
      ),
    );
  } catch (error) {
    nodes.downloadAvailableState.textContent = "";
    nodes.downloadAvailable.replaceChildren(
      manageRow({ name: `读取失败：${error instanceof Error ? error.message : String(error)}` }),
    );
  }
}

// ── 右键菜单 ───────────────────────────────────────────────────────────
/** 同一源广播：把“用这张的参数”送回侧栏。 */
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;

function closeMenu() {
  nodes.ctxMenu.hidden = true;
}

function openMenu(event, job) {
  event.preventDefault();
  const menu = nodes.ctxMenu;
  const items = [];
  if (job.status === "done" && job.output) {
    items.push({ label: "看大图", run: () => openLightbox(imageCache.get(job.output)) });
    items.push({ label: "用这张的参数", run: () => reuseParams(job) });
    items.push({ sep: true });
  }
  items.push({
    label: job.output ? "删除记录与图片" : "删除记录",
    danger: true,
    run: () => removeJob(job.id),
  });

  menu.replaceChildren(
    ...items.map((item) => {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        return sep;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = item.danger ? "ctx-item danger" : "ctx-item";
      button.textContent = item.label;
      button.addEventListener("click", () => {
        closeMenu();
        void item.run();
      });
      return button;
    }),
  );

  // 先显示再量尺寸，避免贴边时溢出。
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/** 把这张的提示词与参数送回侧栏，在画布页接着改。 */
function reuseParams(job) {
  channel?.postMessage({
    type: "reuse",
    job: {
      prompt: job.prompt ?? "",
      negativePrompt: job.negativePrompt ?? "",
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfg: job.cfg,
      seed: job.seed,
    },
  });
  showView("canvas");
}

// ── 总渲染 ─────────────────────────────────────────────────────────────
function render(data) {
  latest = data;
  renderStage(data);
  renderProgress(data);
  renderQueue(data);
  renderVersions(data);
  renderDownload(data);
  const newest = data.jobs.find((job) => job.status === "done" && job.output)?.id ?? null;
  if (newest && newest !== lastNewestId) {
    lastNewestId = newest;
    selectedId = null;
  }
  void renderCanvas(data);
  const key = data.jobs.map((job) => `${job.id}:${job.status}`).join("|");
  if (key !== renderedJobsKey) {
    renderedJobsKey = key;
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

async function removeJob(id) {
  try {
    render(await post("/jobs/remove", { id }));
    renderedJobsKey = null;
  } catch (error) {
    nodes.galleryCount.textContent = error instanceof Error ? error.message : String(error);
  }
}

// ── 事件 ───────────────────────────────────────────────────────────────
nodes.tabs.addEventListener("click", (event) => {
  const tab = event.target.closest(".studio-tab");
  if (tab?.dataset.view) showView(tab.dataset.view);
});
nodes.engineToggle.addEventListener("click", () => {
  const running = latest?.engine?.running;
  void runSafe(() => post(running ? "/engine/stop" : "/engine/start"), running ? "停止" : "启动");
});
nodes.downloadEngine.addEventListener("click", () => void runSafe(() => post("/install/engine"), "安装"));
nodes.downloadWeights.addEventListener("click", () => void runSafe(() => post("/install/weights"), "下载"));
nodes.downloadCancel.addEventListener("click", () => void runSafe(() => post("/install/cancel"), "取消"));
nodes.removeModel.addEventListener("click", () =>
  armable(nodes.removeModel, "再点一次删 25 GiB", "卸载", () =>
    runSafe(() => post("/models/remove", { confirm: true }), "删除模型"),
  ),
);
nodes.clearJobs.addEventListener("click", onClearJobs);
nodes.lightbox.addEventListener("click", (event) => {
  // 点背景才关；图按原始大小可能比窗口还大，要看细节时不能一点就没了。
  if (event.target === nodes.lightbox) nodes.lightbox.hidden = true;
});
nodes.lightboxClose.addEventListener("click", () => {
  nodes.lightbox.hidden = true;
});
document.addEventListener("click", () => closeMenu());
document.addEventListener("contextmenu", (event) => {
  // 图上右键已自己处理；空白处的右键只负责把菜单关掉。
  if (!event.target.closest(".thumb")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
    if (!nodes.lightbox.hidden) nodes.lightbox.hidden = true;
  }
});
// 窗口宽度变了列数跟着变，重排一次。
window.addEventListener("resize", () => {
  if (galleryEntries.length) layoutGallery(galleryEntries);
});

async function boot() {
  syncTheme();
  try {
    hana.theme?.subscribe?.(() => syncTheme());
  } catch {
    /* 老宿主没有主题订阅 */
  }
  try {
    await withTimeout(hana.ready(), 5000);
  } catch {
    /* 非宿主环境 */
  }
  showView("canvas");
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
