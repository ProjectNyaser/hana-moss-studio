// 苔室工作区：画布、画廊、下载管理三个视图。生成设置在左侧栏（panel.html），
// 侧栏会跟着这里切换的分页变（同一源的 BroadcastChannel）。
import { hana } from "./sdk.js";
import { startLive, outputUrl } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";

const el = (id) => document.getElementById(id);
const nodes = {
  tabs: el("studio-tabs"),
  tabCount: el("tab-count"),
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
  // 下载管理
  engineState: el("manage-engine-state"),
  engineToggle: el("manage-engine-toggle"),
  engineNote: el("manage-engine-note"),
  installed: el("manage-installed"),
  installEngine: el("manage-install-engine"),
  installWeights: el("manage-install-weights"),
  cancelInstall: el("manage-cancel"),
  bar: el("manage-bar"),
  download: el("manage-download"),
  releases: el("manage-releases"),
  available: el("manage-available"),
  modelState: el("manage-model-state"),
  modelList: el("manage-model"),
  removeModel: el("manage-remove-model"),
  host: el("manage-host"),
};

const views = ["canvas", "gallery", "manage"];
const imageCache = new Map();
let latest = null;
let renderedJobsKey = null;
let selectedId = null;
let lastNewestId = null;
let currentView = "canvas";
let releasesLoaded = false;

/** 同源广播：侧栏据此切自己的分组。 */
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;

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
  channel?.postMessage({ type: "view", view });
  if (view === "manage") void loadReleases();
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
async function renderGallery(data) {
  const visible = data.jobs.filter((job) => job.status !== "cancelled");
  await Promise.all(visible.filter((job) => job.status === "done" && job.output).map((job) => loadImage(job.output)));
  nodes.thumbs.replaceChildren();
  nodes.galleryCount.textContent = visible.length ? `${visible.length} 张` : "";
  nodes.tabCount.textContent = visible.length ? ` ${visible.length}` : "";
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
        image.title = job.prompt;
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
        // 单条删除：悬停才露出，点一下变「删?」，再点才真删。
        const remove = document.createElement("button");
        remove.className = "thumb-remove";
        remove.type = "button";
        remove.title = "删掉这条记录与图片";
        remove.textContent = "×";
        armable(remove, "删?", "×", () => removeJob(job.id));
        tile.appendChild(remove);
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

// ── 下载管理 ───────────────────────────────────────────────────────────
/** 一行：名字、附注、右侧按钮。 */
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
    nodes.download.textContent = `${label}失败：${error instanceof Error ? error.message : String(error)}`;
  }
};

function renderManage(data) {
  const { engine } = data;

  // 引擎状态
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
  nodes.engineNote.textContent = cublasError ? `缺 cuBLASLt：这个包能启动但出不了图，换 bundled 版本` : (engine.lastError ?? "");

  // 已装引擎
  const engines = Array.isArray(data.engines) ? data.engines : [];
  nodes.installed.replaceChildren(
    ...(engines.length
      ? engines.map((item) =>
          manageRow({
            name: `${item.version} · ${item.cuda ?? ""}${item.variant === "system-cuda" ? " · system-cuda" : ""}`,
            meta: formatSize(item.bytes),
            on: item.current,
            actions: item.current ? [] : [{ label: "切换", run: () => runSafe(() => post("/engine/use", { name: item.name }), "切换") }],
            remove: {
              label: "卸载",
              armedLabel: "确认卸载",
              run: () => runSafe(() => post("/engines/remove", { name: item.name }), "卸载"),
            },
          }),
        )
      : [manageRow({ name: "还没有装引擎" })]),
  );

  // 模型
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

  // 这台机器
  const gpu = data.gpu;
  const hostRows = [];
  if (gpu) {
    hostRows.push(manageRow({ name: gpu.name, meta: `驱动 ${gpu.driver}` }));
  }
  if (engine.device?.totalMemoryBytes) {
    hostRows.push(manageRow({ name: "显存", meta: formatSize(engine.device.totalMemoryBytes) }));
  }
  hostRows.push(manageRow({ name: "引擎协议", meta: `v${data.mossimage?.protocolVersion ?? "?"}` }));
  nodes.host.replaceChildren(...hostRows);

  // 下载
  const job = data.install;
  if (!job) {
    nodes.bar.hidden = true;
    nodes.cancelInstall.hidden = true;
    nodes.download.textContent = "";
  } else {
    const percent = Math.max(0, Math.min(100, job.percent ?? 0));
    nodes.bar.hidden = false;
    nodes.bar.querySelector("i").style.width = `${percent || 4}%`;
    nodes.cancelInstall.hidden = Boolean(job.finishedAt);
    nodes.download.textContent = job.error
      ? `${job.phase}：${job.error}`
      : `${job.label ?? ""} ${job.phase}${job.message ? `｜${job.message}` : ""}${job.totalBytes ? ` ${formatSize(job.bytes)} / ${formatSize(job.totalBytes)}` : ""}`;
  }
}

async function loadReleases() {
  if (nodes.releases.open && releasesLoaded) return;
  nodes.available.replaceChildren(manageRow({ name: "读取版本列表…" }));
  try {
    const data = await api("/engines/available");
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      nodes.available.replaceChildren(manageRow({ name: data?.error ?? "没有可装的版本" }));
      return;
    }
    releasesLoaded = true;
    nodes.available.replaceChildren(
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
    nodes.available.replaceChildren(
      manageRow({ name: `读取失败：${error instanceof Error ? error.message : String(error)}` }),
    );
  }
}

// ── 总渲染 ─────────────────────────────────────────────────────────────
function render(data) {
  latest = data;
  renderStage(data);
  renderProgress(data);
  renderManage(data);
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
nodes.releases.addEventListener("toggle", () => {
  if (nodes.releases.open) void loadReleases();
});
nodes.engineToggle.addEventListener("click", () => {
  const running = latest?.engine?.running;
  void runSafe(() => post(running ? "/engine/stop" : "/engine/start"), running ? "停止" : "启动");
});
nodes.installEngine.addEventListener("click", () => void runSafe(() => post("/install/engine"), "安装"));
nodes.installWeights.addEventListener("click", () => void runSafe(() => post("/install/weights"), "下载"));
nodes.cancelInstall.addEventListener("click", () => void runSafe(() => post("/install/cancel"), "取消"));
nodes.removeModel.addEventListener("click", () =>
  armable(nodes.removeModel, "再点一次删 25 GiB", "卸载", () => runSafe(() => post("/models/remove", { confirm: true }), "删除模型")),
);
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
