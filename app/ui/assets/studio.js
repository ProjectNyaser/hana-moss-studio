// 苔室工作区：画布、画廊、队列、版本、下载五个视图。生成设置在左侧栏（panel.html）。
import { hana } from "./sdk.js";
import { startLive, outputUrl, previewUrl } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";

const el = (id) => document.getElementById(id);
const nodes = {
  tabs: el("studio-tabs"),
  tabCount: el("tab-count"),
  tabQueue: el("tab-queue"),
  stageChip: el("stage-chip"),
  stageCancel: el("stage-cancel"),
  topProgress: el("top-progress"),
  topProgressBar: el("top-progress-bar"),
  stageDot: el("stage-dot"),
  stageText: el("stage-text"),
  canvasMeta: el("canvas-meta"),
  canvas: el("canvas"),
  result: el("result"),
  resultImage: el("result-image"),
  resultCaption: el("result-caption"),
  canvasEmpty: el("canvas-empty"),
  galleryCount: el("gallery-count"),
  thumbs: el("thumbs"),
  ctxMenu: el("ctx-menu"),
  viewer: el("viewer"),
  viewerStage: el("viewer-stage"),
  viewerImage: el("viewer-image"),
  viewerIndex: el("viewer-index"),
  viewerInfo: el("viewer-info"),
  viewerPrev: el("viewer-prev"),
  viewerNext: el("viewer-next"),
  viewerClose: el("viewer-close"),
  viewerZoomIn: el("viewer-zoom-in"),
  viewerZoomOut: el("viewer-zoom-out"),
  viewerZoomFit: el("viewer-zoom-fit"),
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
  toast: el("toast"),
  downloadState: el("download-state"),
  downloadEngine: el("download-engine"),
  downloadModels: el("download-models"),
  versionsTabs: el("versions-tabs"),
  downloadCancel: el("download-cancel"),
  downloadMessage: el("download-message"),
  downloadFiles: el("download-files"),
  downloadAvailableState: el("download-available-state"),
  downloadAvailable: el("download-available"),
};

const views = ["canvas", "gallery", "queue", "versions", "download"];
const imageCache = new Map();
let latest = null;
// 耗时锚点：{ at, ms }，每次后端推送更新，两次之间由定时器补差。
let elapsedAnchor = null;
// 画廊单独分页：state 只带最近 24 条，剩下的从 /jobs 拉。
const GALLERY_PAGE = 60;
let galleryJobs = [];
let galleryTotal = 0;
let galleryLoading = false;
let lastActive = false;
let renderedJobsKey = null;
let selectedId = null;
let newestJobId = null;
/** 首次渲染不算「刚生成完」：打开 App 时画布应该是空的。 */
let bootstrapped = false;
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

let toastTimer = null;
/**
 * 一句话提示。优先走宿主的 ui.toast（和界面主题一致，不挡内容），
 * 宿主没这个能力时退回页面内浮层。
 */
async function toast(text, type = "info") {
  try {
    const result = await post("/toast", { message: text, type });
    if (result?.ok) return;
  } catch {
    // 落到本地浮层
  }
  if (!nodes.toast) return;
  nodes.toast.textContent = text;
  nodes.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    nodes.toast.hidden = true;
  }, 2600);
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
  if (view === "versions" || view === "download") void loadReleases();
  if (view === "gallery" && !galleryJobs.length) void loadGallery(true);
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
    const active = engine.active;
    const progress = active.progress ?? {};
    // 高清修正的第二阶段也是 denoise，单看阶段名分不清。
    // 这里把两段的步数分开算：先去噪采样 0/16，再高清修正 1/8。
    const passTwo = active.hiresScale > 1.001 && progress.total > active.steps;
    let head;
    if (passTwo && progress.step >= active.steps) {
      head = `高清修正 ${progress.step - active.steps}/${progress.total - active.steps}`;
    } else if (passTwo) {
      head = `${progress.phase ?? "生成中"} ${progress.step}/${active.steps}`;
    } else {
      head = `${progress.phase ?? "生成中"}${progress.total ? ` ${progress.step}/${progress.total}` : ""}`;
    }
    const bits = [];
    const ran = liveElapsed(active);
    if (typeof ran === "number") bits.push(`已跑 ${formatDuration(ran)}`);
    if (progress.etaMs) bits.push(`约剩 ${formatDuration(progress.etaMs)}`);
    label = bits.length ? `${head} · ${bits.join(" · ")}` : head;
  } else {
    dotClass = "dot on";
    label = engine.loaded ? "就绪 · 模型已加载" : "就绪 · 模型未加载";
  }
/** 高清修正开着时，引擎的总步数会多出第二阶段：设 16 步会看到 24。 */
  nodes.stageDot.className = dotClass;
  nodes.stageText.textContent = label;
  // 进度条：有百分比就走百分比，算不出来时来回扫。
  const activeProgress = engine.active?.progress ?? null;
  nodes.topProgress.hidden = !engine.active;
  if (activeProgress) {
    const percent = typeof activeProgress.percent === "number" ? activeProgress.percent : 0;
    nodes.topProgress.classList.toggle("indeterminate", percent <= 0);
    nodes.topProgressBar.style.width = percent > 0 ? `${percent}%` : "";
  }
  // 生成中才给一个明确的取消按钮，不做「点状态块就取消」那种隐式交互。
  nodes.stageCancel.hidden = !engine.active;
  nodes.stageChip.title = engine.lastError ?? "";
  nodes.canvasMeta.textContent = `引擎 ${data.mossimage?.version ?? "?"} · 协议 v${data.mossimage?.protocolVersion ?? "?"} · 记录 ${data.jobTotal ?? data.jobs.length} 条`;
}


/** 生成中那行的文字：尺寸、步数、CFG、种子、实时耗时。
 *  耗时按墙钟算，与引擎回帧频率无关。 */
function activeCaption(active) {
  const parts = [];
  if (active.width && active.height) parts.push(`${active.width}×${active.height}`);
  if (active.steps) parts.push(`${active.steps} 步`);
  if (active.cfg) parts.push(`CFG ${active.cfg}`);
  if (active.seed != null) parts.push(`种子 ${active.seed}`);
  const used = formatDuration(liveElapsed(active));
  if (used) parts.push(`已用 ${used}`);
  return parts.join(" · ");
}

/** 实时耗时：后端每次推送给一个基准，两次之间自己走秒。 */
function liveElapsed(active) {
  if (elapsedAnchor) return elapsedAnchor.ms + (Date.now() - elapsedAnchor.at);
  return active.progress?.liveElapsedMs ?? active.progress?.elapsedMs ?? 0;
}

/** 画布上要显示的那张：只有显式载入或刚生成完才有，初始是空的。 */
function shownJob(data) {
  if (!selectedId) return null;
  return data.jobs.find((job) => job.id === selectedId && job.status === "done" && job.output) ?? null;
}

function loadImage(name) {
  if (!name) return null;
  if (!imageCache.has(name)) imageCache.set(name, outputUrl(name));
  return imageCache.get(name);
}

async function renderCanvas(data) {
  const active = data?.engine?.active;
  const img = nodes.resultImage;

  // 生成中：画面交给采样预览，下面那行换成参数与实时用时（排队时间不算）。
  if (active) {
    nodes.canvasEmpty.hidden = true;
    nodes.result.hidden = false;
    if (active.previewAt && img.dataset.preview !== String(active.previewAt)) {
      img.dataset.preview = String(active.previewAt);
      img.src = previewUrl(active.previewAt);
    }
    img.classList.toggle("preview", Boolean(active.previewAt));
    img.onclick = null;
    nodes.resultCaption.textContent = activeCaption(active);
    return;
  }

  img.classList.remove("preview");
  delete img.dataset.preview;

  const job = shownJob(data);
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
  if (img.getAttribute("src") !== url) img.src = url;
  const seed = job.report?.seedUsed ?? job.seed;
  nodes.resultCaption.textContent = `${job.width}×${job.height} · ${job.steps} 步 · CFG ${job.cfg} · 种子 ${seed} · ${formatDuration(job.elapsedMs)}`;
  img.onclick = () => openViewer(job.id);
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

/** 画廊分页：一次 60 条，滚到底再拉。 */
async function loadGallery(reset = false) {
  if (galleryLoading) return;
  galleryLoading = true;
  try {
    const offset = reset ? 0 : galleryJobs.length;
    const page = await api(`/jobs?offset=${offset}&limit=${GALLERY_PAGE}`);
    galleryJobs = reset ? page.jobs : galleryJobs.concat(page.jobs);
    galleryTotal = page.total ?? galleryJobs.length;
    if (latest) void renderGallery(latest);
  } catch (error) {
    nodes.galleryCount.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    galleryLoading = false;
  }
}

async function renderGallery(data) {
  // 记录数比 state 里带的多：画布/队列只关心最近的，画廊单独分页拉。
  const live = data.jobs.filter((job) => job.status === "queued" || job.status === "running");
  const liveIds = new Set(live.map((job) => job.id));
  const visible = live.concat(
    galleryJobs.filter((job) => !liveIds.has(job.id) && job.status !== "cancelled"),
  );
  await Promise.all(visible.filter((job) => job.status === "done" && job.output).map((job) => loadImage(job.output)));
  const shownCount = galleryTotal || visible.length;
  nodes.galleryCount.textContent = shownCount ? `${visible.length} / ${shownCount} 张` : "";
  nodes.tabCount.textContent = shownCount ? ` ${shownCount}` : "";
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
    const shown = shownJob(data);
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
        // 左键直接看大图，不切页；要把这张拿到画布去用右键。
        image.addEventListener("click", () => openViewer(job.id));
        tile.appendChild(image);
        const meta = document.createElement("div");
        meta.className = "thumb-meta";
        meta.textContent = `${job.width}×${job.height} · ${job.steps} 步`;
        tile.appendChild(meta);
      } else {
        // 记录还在但图不在了（手动删了 outputs 里的文件）：占位说明，不留空白。
        tile.classList.add("placeholder");
        const text = document.createElement("span");
        text.textContent = "图片已缺失";
        tile.appendChild(text);
      }
    } else if (job.status === "error") {
      tile.classList.add("placeholder", "bad");
      tile.textContent = job.error ?? "生成失败";
    } else {
      const active = data.engine.active;
      if (active && job.id === active.jobId && active.previewAt) {
        // 正在采样的那张也显示中间结果，而不是一个转圈。
        const preview = document.createElement("img");
        preview.className = "preview-thumb";
        preview.src = previewUrl(active.previewAt);
        preview.alt = "采样中";
        tile.appendChild(preview);
        const tag = document.createElement("div");
        tag.className = "thumb-meta";
        tag.textContent = "采样中";
        tile.appendChild(tag);
      } else {
        tile.classList.add("placeholder");
        const spinner = document.createElement("span");
        spinner.className = "spinner";
        const text = document.createElement("span");
        text.textContent = job.status === "queued" ? "排队中" : "生成中";
        tile.append(spinner, text);
      }
    }
    // 右键菜单：看大图、用这张的参数、删除。失败的记录也走这里。
    tile.addEventListener("contextmenu", (event) => openMenu(event, job));
    entries.push({ job, tile });
  }

  galleryEntries = entries;
  layoutGallery(entries);
}

// ── 行与确认 ───────────────────────────────────────────────────────────
function manageRow({ name, meta, on, dim, badges = [], detail, actions = [], remove }) {
  const row = document.createElement("div");
  row.className = on ? "manage-row on" : dim ? "manage-row dim" : "manage-row";
  const nameNode = document.createElement("span");
  nameNode.className = "name";
  nameNode.textContent = name;
  nameNode.title = name;
  row.append(nameNode);
  for (const badge of badges) {
    const tag = document.createElement("span");
    tag.className = "badge";
    tag.textContent = badge;
    row.append(tag);
  }
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
    button.addEventListener("click", () => {
      // 整行换成确认条，不复用这个按钮：行会被重建，靠按钮自己的状态记住「待确认」
      // 很容易看起来像别的行变成了待确认。
      const bar = document.createElement("div");
      bar.className = "confirm-bar";
      const text = document.createElement("span");
      text.textContent = remove.question ?? `${remove.label}？`;
      const yes = document.createElement("button");
      yes.className = "btn small";
      yes.type = "button";
      yes.textContent = "确认";
      yes.addEventListener("click", () => void remove.run());
      const no = document.createElement("button");
      no.className = "btn ghost small";
      no.type = "button";
      no.textContent = "取消";
      no.addEventListener("click", () => {
        versionsKey = "";
        void refresh();
      });
      bar.append(text, yes, no);
      row.replaceChildren(bar);
    });
    row.append(button);
  }

  // 有明细的行可以点开：组件体积这类信息平时收着，需要时才展开。
  if (detail?.length) {
    row.classList.add("expandable");
    const box = document.createElement("div");
    box.className = "manage-detail";
    box.hidden = true;
    for (const item of detail) {
      const line = document.createElement("div");
      line.className = "manage-detail-line";
      const label = document.createElement("span");
      label.textContent = item.label;
      const value = document.createElement("span");
      value.textContent = item.value;
      line.append(label, value);
      box.appendChild(line);
    }
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      box.hidden = !box.hidden;
      row.classList.toggle("open", !box.hidden);
    });
    const wrap = document.createElement("div");
    wrap.className = "manage-row-wrap";
    wrap.append(row, box);
    return wrap;
  }

  return row;
}

/** 两段式确认：再点一次才真删，四秒不复位就恢复原样。 */
function armable(button, armedLabel, idleLabel, run) {
  button.dataset.idle = idleLabel;
  if (button.dataset.armed === "1") {
    delete button.dataset.armed;
    button.classList.remove("armed");
    button.textContent = idleLabel;
    void run();
    return;
  }
  button.dataset.armed = "1";
  button.textContent = armedLabel;
  button.classList.add("armed");
  setTimeout(() => {
    if (button.dataset.armed !== "1") return;
    delete button.dataset.armed;
    button.classList.remove("armed");
    button.textContent = idleLabel;
  }, 4000);
}

/**
 * 点别处就把待确认状态收回去。
 * 否则一行停在「确认卸载」上，用户去点另一行的按钮，看着像是那个按钮自己变红的。
 */
function disarmOthers(target) {
  for (const button of document.querySelectorAll("[data-armed='1']")) {
    if (button === target) continue;
    delete button.dataset.armed;
    button.classList.remove("armed");
    button.textContent = button.dataset.idle ?? button.textContent;
  }
}

document.addEventListener(
  "pointerdown",
  (event) => {
    const hit = event.target.closest("button");
    disarmOthers(hit);
  },
  true,
);

const runSafe = async (fn, label) => {
  try {
    const next = await fn();
    if (next) render(next);
  } catch (error) {
    nodes.downloadMessage.textContent = `${label}失败：${error instanceof Error ? error.message : String(error)}`;
  }
};

// ── 队列 ───────────────────────────────────────────────────────────────
/** 左侧类别切换：同一套结构给版本页与下载页共用。 */
function bindSplitTabs(container) {
  if (!container) return;
  container.addEventListener("click", (event) => {
    const tab = event.target.closest(".split-tab");
    if (!tab?.dataset.pane) return;
    for (const item of container.querySelectorAll(".split-tab")) {
      item.classList.toggle("on", item === tab);
    }
    const body = container.parentElement?.querySelector(".split-body");
    if (!body) return;
    for (const pane of body.querySelectorAll(".split-pane")) {
      pane.hidden = pane.dataset.pane !== tab.dataset.pane;
    }
  });
}

/** 队列里的一张卡：缩略图、标题、元信息、可选进度条与操作按钮。 */
function queueCard({ title, meta, percent, thumb, on, actions = [] }) {
  const card = document.createElement("div");
  card.className = on ? "queue-card on" : "queue-card";
  const box = document.createElement("div");
  box.className = "qc-thumb";
  if (thumb) {
    const img = document.createElement("img");
    img.src = thumb;
    img.alt = "";
    box.appendChild(img);
  } else {
    box.textContent = on ? "采样" : "";
  }
  const main = document.createElement("div");
  main.className = "qc-main";
  const titleNode = document.createElement("div");
  titleNode.className = "qc-title";
  titleNode.textContent = title;
  titleNode.title = title;
  main.appendChild(titleNode);
  if (meta) {
    const metaNode = document.createElement("div");
    metaNode.className = "qc-meta";
    metaNode.textContent = meta;
    main.appendChild(metaNode);
  }
  if (typeof percent === "number") {
    const bar = document.createElement("div");
    bar.className = "qc-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
    bar.appendChild(fill);
    main.appendChild(bar);
  }
  card.append(box, main);
  for (const action of actions) {
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = action.label;
    button.title = action.title ?? "";
    button.addEventListener("click", () => void action.run());
    card.appendChild(button);
  }
  return card;
}

function renderQueue(data) {
  const active = data.engine.active;
  const queue = Array.isArray(data.queue) ? data.queue : [];
  const failed = data.jobs.filter((job) => job.status === "error");
  nodes.tabQueue.textContent = active || queue.length ? ` ${queue.length + (active ? 1 : 0)}` : "";

  nodes.queueRunningState.textContent = active ? "" : "空闲";
  nodes.queueRunning.replaceChildren(
    ...(active
      ? [
          queueCard({
            title: active.prompt || "(无提示词)",
            meta: `${active.phase ?? "生成中"}${active.progress?.total ? ` · ${active.progress.step}/${active.progress.total}` : ""}${active.progress?.etaMs ? ` · 约剩 ${formatDuration(active.progress.etaMs)}` : ""}`,
            percent: active.progress?.percent,
            thumb: active.previewAt ? previewUrl(active.previewAt) : null,
            on: true,
            actions: [
              {
                label: "取消",
                run: () => runSafe(() => post("/cancel", { id: active.jobId }), "取消"),
              },
            ],
          }),
        ]
      : [queueCard({ title: "没有正在跑的任务" })]),
  );

  nodes.queueCount.textContent = queue.length ? `${queue.length} 条` : "";
  nodes.queueList.replaceChildren(
    ...(queue.length
      ? queue.map((job, index) =>
          queueCard({
            title: job.prompt || "(无提示词)",
            meta: `第 ${index + 1} 位 · ${job.width}×${job.height} · ${job.steps} 步`,
            actions: [
              index > 0
                ? {
                    label: "↑",
                    title: "提前一位",
                    run: () => runSafe(() => post("/queue/move", { id: job.id, delta: -1 }), "上移"),
                  }
                : null,
              index < queue.length - 1
                ? {
                    label: "↓",
                    title: "后移一位",
                    run: () => runSafe(() => post("/queue/move", { id: job.id, delta: 1 }), "下移"),
                  }
                : null,
              {
                label: "取消",
                run: () => runSafe(() => post("/cancel", { id: job.id }), "取消"),
              },
            ].filter(Boolean),
          }),
        )
      : [queueCard({ title: "队列是空的" })]),
  );

  nodes.queueFailedCount.textContent = failed.length ? `${failed.length} 条` : "";
  nodes.queueFailed.replaceChildren(
    ...(failed.length
      ? failed.slice(0, 8).map((job) => {
          const card = queueCard({
            title: job.prompt || "(无提示词)",
            meta: (job.error ?? "失败").slice(0, 60),
          });
          const button = document.createElement("button");
          button.className = "btn ghost small";
          button.type = "button";
          button.textContent = "删除";
          armable(button, "确认", "删除", () => removeJob(job.id));
          card.appendChild(button);
          return card;
        })
      : [queueCard({ title: "没有失败的记录" })]),
  );
}

// ── 版本 ───────────────────────────────────────────────────────────────
/** 发起一次下载：回一句提示，排队的说清在第几位。 */
async function startInstall(path, body, label) {
  try {
    const result = await post(path, body);
    if (result?.error) {
      void toast(`${label}没开始：${result.error}`);
      return;
    }
    if (result?.duplicate) void toast(`${label}已经在队列里（第 ${result.position} 位）`);
    else if (result?.queued) void toast(`${label}已加入队列，第 ${result.position} 位`);
    else void toast(`开始${label}`);
  } catch (error) {
    void toast(`${label}没开始：${error.message ?? error}`);
  }
}

let versionsKey = "";
function renderVersions(data) {
  const { engine } = data;
  // 数据没变就别重建：每帧 replaceChildren 会把点击中的按钮换掉，交互会发抖。
  const key = JSON.stringify({ engine, engines: data.engines, models: data.models, gpu: data.gpu });
  if (key === versionsKey) return;
  versionsKey = key;

  nodes.engineState.textContent = engine.running
    ? engine.loaded
      ? "运行中 · 模型已加载"
      : "运行中"
    : engine.serverFound
      ? "空闲（出图时自动启动）"
      : "未安装";
  // 不需要手动启动：出图会自己拉起。只留一个「停止」给想立刻腾显存的人。
  nodes.engineToggle.hidden = !engine.running;
  nodes.engineToggle.textContent = "停止引擎";
  nodes.engineToggle.disabled = false;
  const cublasError = engine.device?.cublaslt?.error;
  nodes.engineNote.textContent = cublasError
    ? "缺 cuBLASLt：这个包能启动但出不了图，换 bundled 版本"
    : (engine.lastError ?? "");

  const engines = Array.isArray(data.engines) ? data.engines : [];
  nodes.installed.replaceChildren(
    ...(engines.length
      ? engines.map((item) =>
          manageRow({
            name: `${item.version}`,
            badges: [item.cuda ?? null, item.variant === "system-cuda" ? "system-cuda" : "bundled", item.current ? "当前" : null].filter(
              Boolean,
            ),
            meta: formatSize(item.bytes),
            on: item.current,
            actions: item.current
              ? []
              : [{ label: "切换", run: () => runSafe(() => post("/engine/use", { name: item.name }), "切换") }],
            remove: {
              label: "卸载",
              question: `卸载 ${item.version}？`,
              run: () => runSafe(() => post("/engines/remove", { name: item.name }), "卸载"),
            },
          }),
        )
      : [manageRow({ name: "还没有装引擎，去「下载」页装一个" })]),
  );

  // 模型：两个仓库并列，装了几个就列几个，激活的那个标出来。
  const models = Array.isArray(data.models) ? data.models : [];
  const installedCount = models.filter((item) => item.installed).length;
  nodes.modelState.textContent = installedCount ? `${installedCount} 个已装` : "未安装";
  const activeModel = models.find((item) => item.active) ?? null;
  nodes.removeModel.hidden = !activeModel;
  nodes.modelList.replaceChildren(
    ...models.map((item) =>
      manageRow({
        name: `${item.label}${item.active ? " · 当前" : ""}`,
        badges: [item.installed ? "已装" : null].filter(Boolean),
        meta: item.installed ? formatSize(item.bytes) : `${item.note} · 未安装`,
        detail: item.components?.map((part) => ({ label: part.label, value: formatSize(part.bytes) })) ?? null,
        on: item.active,
        dim: !item.installed,
        actions:
          item.installed && !item.active
            ? [
                {
                  label: "用这个",
                  run: () => runSafe(() => post("/weights/use", { variant: item.variant }), "切换模型"),
                },
              ]
            : [],
      }),
    ),
  );

  const hostRows = [];
  if (data.gpu) hostRows.push(manageRow({ name: data.gpu.name, meta: `驱动 ${data.gpu.driver}` }));
  if (engine.device?.totalMemoryBytes) hostRows.push(manageRow({ name: "显存", meta: formatSize(engine.device.totalMemoryBytes) }));
  hostRows.push(manageRow({ name: "引擎协议", meta: `v${data.mossimage?.protocolVersion ?? "?"}` }));
  nodes.host.replaceChildren(...hostRows);
}


/** 每个文件一行；同时只下几个，所以按状态分组，正在下的排前面。 */
function renderDownloadTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) {
    nodes.downloadFiles.replaceChildren();
    return;
  }

  const order = { active: 0, paused: 1, waiting: 2, error: 3, complete: 4 };
  const sorted = [...tasks].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const groups = [
    { status: "active", title: "正在下载" },
    { status: "paused", title: "已暂停" },
    { status: "waiting", title: "排队中" },
    { status: "error", title: "失败" },
    { status: "complete", title: "已完成" },
  ];

  const out = [];
  for (const group of groups) {
    const rows = sorted.filter((task) => task.status === group.status);
    if (!rows.length) continue;
    const head = document.createElement("div");
    head.className = "dl-group";
    head.textContent = `${group.title} ${rows.length}`;
    out.push(head, ...rows.map(renderTaskRow));
  }
  nodes.downloadFiles.replaceChildren(...out);
}

function renderTaskRow(task) {
  const total = Number(task.size) || 0;
  const got = Number(task.got) || 0;
  const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;
  const speed = Number(task.speed) || 0;
  const done = task.status === "complete";
  const active = task.status === "active";
  const paused = task.status === "paused";
  const waiting = task.status === "waiting";

  const row = document.createElement("div");
  row.className = done
    ? "dl-row done"
    : task.status === "error" || task.status === "removed"
      ? "dl-row bad"
      : pct < 12
        ? "dl-row low"
        : "dl-row";

  const line = document.createElement("div");
  line.className = "dl-line";
  const dot = document.createElement("span");
  dot.className = active ? "dl-dot on" : "dl-dot";
  const name = document.createElement("span");
  name.className = "dl-name";
  name.textContent = task.out.split("/").pop();
  name.title = task.out;

  const right = document.createElement("span");
  right.className = "dl-speed";
  if (done) right.textContent = "完成";
  else if (paused) right.textContent = "已暂停";
  else if (waiting) right.textContent = task.queue ? `排队 ${task.queue}` : "排队";
  else if (speed > 0) right.textContent = `${formatSize(speed)}/s`;
  else right.textContent = active ? "…" : "";

  const acts = document.createElement("span");
  acts.className = "dl-acts";
  if (active || paused) {
    acts.append(actionButton(paused ? "继续" : "暂停", () => taskAction(task.out, paused ? "resume" : "pause")));
  }
  if (active || paused || waiting) {
    acts.append(actionButton("移除", () => taskAction(task.out, "remove")));
  }

  line.append(dot, name, right, acts);

  if (!done && !waiting) {
    const track = document.createElement("div");
    track.className = "dl-track";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0.5, pct)}%`;
    const label = document.createElement("span");
    label.className = "dl-pct";
    label.textContent = `${pct}%`;
    track.append(fill, label);
    row.append(line, track);
  } else {
    row.append(line);
  }

  const foot = document.createElement("div");
  foot.className = "dl-foot";
  const bits = [`${formatSize(got)} / ${formatSize(total)}`];
  if (active && speed > 0 && total > got) bits.push(`剩 ${formatDuration(((total - got) / speed) * 1000)}`);
  foot.textContent = bits.join(" · ");
  row.append(foot);

  return row;
}

function actionButton(label, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void run();
  });
  return button;
}

async function taskAction(out, action) {
  const verb = action === "pause" ? "暂停" : action === "resume" ? "继续" : "移除";
  try {
    await post("/install/task", { out, action });
    void toast(`已${verb} ${out.split("/").pop()}`);
  } catch (error) {
    void toast(`${verb}失败：${error.message ?? error}`);
  }
}

// ── 下载 ───────────────────────────────────────────────────────────────
function renderDownload(data) {
  const job = data.install;
  const busy = Boolean(job && !job.finishedAt);
  const waiting = Array.isArray(job?.queue) ? job.queue : [];
  nodes.downloadEngine.disabled = false;

  // 模型：每个仓库一行，没装的给下载按钮。
  const models = Array.isArray(data.models) ? data.models : [];
  nodes.downloadModels.replaceChildren(
    ...models.map((item) => {
      const row = manageRow({
        name: item.label,
        meta: item.installed
          ? `已装 ${formatSize(item.bytes)}${item.active ? " · 当前" : ""}`
          : `约 27 GB · ${item.note}`,
        on: item.active,
      });
      if (!item.installed) {
        const button = document.createElement("button");
        button.className = "btn ghost small";
        button.type = "button";
        button.textContent = busy ? "排队" : "下载";
        button.addEventListener("click", () =>
          void startInstall("/install/weights", { variant: item.variant }, `下载 ${item.label}`),
        );
        row.appendChild(button);
      }
      return row;
    }),
  );

  // 快照可能只带 queue（还没开始过任何安装）。
  if (!job?.phase) {
    nodes.downloadCancel.hidden = true;
    nodes.downloadState.textContent = "";
    nodes.downloadFiles.replaceChildren();
    nodes.downloadMessage.textContent = waiting.length ? `等待中：${waiting.join("、")}` : "没有进行中的下载。去「版本」页选一个。";
    return;
  }
  renderDownloadTasks(job.tasks);
  nodes.downloadCancel.hidden = Boolean(job.finishedAt);
  nodes.downloadState.textContent = job.finishedAt ? "已结束" : "下载中";
  // 按 aria2 CLI 的口径排：SIZE → 百分比 → 速度 → 剩余 → 连接数。
  const parts = [];
  if (job.totalBytes) {
    const pct = Math.min(100, Math.floor(((job.bytes ?? 0) / job.totalBytes) * 100));
    parts.push(`${formatSize(job.bytes ?? 0)} / ${formatSize(job.totalBytes)}`);
    parts.push(`${pct}%`);
  }
  if (job.speed > 0) parts.push(`${formatSize(job.speed)}/s`);
  if (job.speed > 0 && job.totalBytes > (job.bytes ?? 0)) {
    parts.push(`剩 ${formatDuration(((job.totalBytes - (job.bytes ?? 0)) / job.speed) * 1000)}`);
  }
  if (job.connections > 0) parts.push(`${job.connections} 连接`);
  if (Array.isArray(job.files) && job.files[1]) parts.push(`${job.files[0]}/${job.files[1]} 个文件`);

  const head = job.label ? `${job.label}：` : "";
  const base = job.error
    ? `${job.phase}：${job.error}`
    : parts.length
      ? `${head}${parts.join(" · ")}`
      : (job.message ?? "");
  const current = job.current && parts.length ? `　当前 ${job.current.split("/").pop()}` : "";
  nodes.downloadMessage.textContent = waiting.length
    ? `${base}${current}　等待中：${waiting.join("、")}`
    : `${base}${current}`;
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
          badges: [
            item.installed ? "已装" : null,
            item.windowsAssets ? `${item.windowsAssets} 个变体` : null,
          ].filter(Boolean),
          meta: [item.publishedAt?.slice(0, 10), item.bundledBytes ? formatSize(item.bundledBytes) : null]
            .filter(Boolean)
            .join(" · "),
          on: item.installed,
          actions: item.installed
            ? []
            : [{ label: "安装", run: () => startInstall("/install/engine", { tag: item.tag }, `安装引擎 ${item.version}`) }],
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

// ── 图片查看器 ─────────────────────────────────────────────────────────
/** 缩放档位；1 就是适应窗口。 */
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
let viewerList = [];
let viewerIndex = 0;
let viewerZoom = 1;

function openViewer(id) {
  viewerList = (latest?.jobs ?? []).filter((job) => job.status === "done" && job.output);
  const index = viewerList.findIndex((job) => job.id === id);
  if (index < 0) return;
  viewerIndex = index;
  viewerZoom = 1;
  nodes.viewer.hidden = false;
  applyViewer();
}

function closeViewer() {
  nodes.viewer.hidden = true;
}

/** 先算出「适应窗口」的尺寸，再乘缩放倍率。 */
function layoutViewerImage() {
  const img = nodes.viewerImage;
  const stage = nodes.viewerStage;
  const natW = img.naturalWidth || 1;
  const natH = img.naturalHeight || 1;
  const boxW = Math.max(120, stage.clientWidth - 128);
  const boxH = Math.max(120, stage.clientHeight - 24);
  // 默认按原始像素显示；只有超出窗口才缩到适应。小图不放大，放大按了算。
  const fit = Math.min(1, Math.min(boxW / natW, boxH / natH));
  img.style.width = `${Math.round(natW * fit * viewerZoom)}px`;
  img.style.height = `${Math.round(natH * fit * viewerZoom)}px`;
  const zoom = viewerZoom === 1 ? "" : ` · ${Math.round(viewerZoom * 100)}%`;
  nodes.viewerIndex.textContent = `${viewerIndex + 1} / ${viewerList.length}${zoom}`;
}

function applyViewer() {
  const job = viewerList[viewerIndex];
  if (!job) return;
  nodes.viewerImage.src = loadImage(job.output) ?? "";
  const seed = job.report?.seedUsed ?? job.seed;
  const parts = [`${job.width}×${job.height}`, `${job.steps} 步`, `CFG ${job.cfg}`, `种子 ${seed}`];
  if (job.elapsedMs) parts.push(formatDuration(job.elapsedMs));
  nodes.viewerInfo.textContent = parts.join(" · ");
  nodes.viewerPrev.hidden = viewerList.length < 2;
  nodes.viewerNext.hidden = viewerList.length < 2;
  if (nodes.viewerImage.complete) layoutViewerImage();
}

function stepViewer(delta) {
  if (viewerList.length < 2) return;
  viewerIndex = (viewerIndex + delta + viewerList.length) % viewerList.length;
  viewerZoom = 1;
  applyViewer();
}

function stepZoom(direction) {
  const next =
    direction > 0
      ? (ZOOM_STEPS.find((value) => value > viewerZoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
      : ([...ZOOM_STEPS].reverse().find((value) => value < viewerZoom - 0.001) ?? ZOOM_STEPS[0]);
  viewerZoom = next;
  layoutViewerImage();
}

/**
 * 以屏幕上的某一点为锚缩放：缩放后该点下的图像位置不动。
 * 鼠标滚轮用光标位置，按钮与键盘用视口中心。
 */
function zoomAt(direction, clientX, clientY) {
  const stage = nodes.viewerStage;
  const img = nodes.viewerImage;
  const before = img.getBoundingClientRect();
  const relX = before.width ? (clientX - before.left) / before.width : 0.5;
  const relY = before.height ? (clientY - before.top) / before.height : 0.5;
  const previous = viewerZoom;
  stepZoom(direction);
  if (viewerZoom === previous) return;
  // width/height 是同步改的，这里拿到的已经是新布局，直接补滚动差就行。
  const after = img.getBoundingClientRect();
  stage.scrollLeft += after.left + relX * after.width - clientX;
  stage.scrollTop += after.top + relY * after.height - clientY;
}

function zoomAtCenter(direction) {
  const rect = nodes.viewerStage.getBoundingClientRect();
  zoomAt(direction, rect.left + rect.width / 2, rect.top + rect.height / 2);
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
    items.push({ label: "载入这张", run: () => loadJob(job) });
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

/**
 * 载入这张：画布上显示它，同时把参数送回侧栏。
 * 这两件事本来就是同一个意图（拿这张继续改），不拆成两个菜单项。
 */
function loadJob(job) {
  selectedId = job.id;
  renderedJobsKey = null;
  showView("canvas");
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
  void refresh();
}

// ── 总渲染 ─────────────────────────────────────────────────────────────
function render(data) {
  latest = data;
  // 刚跑完一个：画廊要重新拉首页，新图在最前面。
  if (lastActive && !data.engine.active) void loadGallery(true);
  lastActive = Boolean(data.engine.active);
  // 锚点只在这里对表：定时器重调 renderStage 时不能再改它，否则秒数会被拉回去。
  const liveProgress = data.engine.active?.progress ?? null;
  if (liveProgress) {
    const measured = liveProgress.liveElapsedMs ?? liveProgress.elapsedMs;
    if (typeof measured === "number") elapsedAnchor = { at: Date.now(), ms: measured };
  } else {
    elapsedAnchor = null;
  }
  renderStage(data);
  renderQueue(data);
  renderVersions(data);
  renderDownload(data);
  const newest = data.jobs.find((job) => job.status === "done" && job.output)?.id ?? null;
  if (newest && newest !== newestJobId) {
    newestJobId = newest;
    if (bootstrapped) selectedId = newest;
  }
  bootstrapped = true;
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
  void runSafe(() => post("/engine/stop"), "停止");
});
nodes.downloadEngine.addEventListener("click", () => void startInstall("/install/engine", {}, "安装最新引擎"));
bindSplitTabs(nodes.versionsTabs);
nodes.downloadCancel.addEventListener("click", () => void runSafe(() => post("/install/cancel"), "取消"));
nodes.removeModel.addEventListener("click", () =>
  armable(nodes.removeModel, "再点一次删 25 GiB", "卸载", () => {
    const active = latest?.models?.find((item) => item.active);
    return runSafe(() => post("/models/remove", { confirm: true, variant: active?.variant ?? "sft" }), "删除模型");
  }),
);
nodes.viewerImage.addEventListener("load", layoutViewerImage);
nodes.viewerClose.addEventListener("click", closeViewer);
nodes.viewerPrev.addEventListener("click", () => stepViewer(-1));
nodes.viewerNext.addEventListener("click", () => stepViewer(1));
nodes.viewerZoomIn.addEventListener("click", () => zoomAtCenter(1));
nodes.viewerZoomOut.addEventListener("click", () => zoomAtCenter(-1));
nodes.viewerZoomFit.addEventListener("click", () => {
  viewerZoom = 1;
  layoutViewerImage();
});
// 点图的周围空白处关掉；点图本身不关。
nodes.viewerStage.addEventListener("click", (event) => {
  if (event.target === nodes.viewerStage) closeViewer();
});
// 滚轮缩放：以光标所在位置为锚，这才是看图时的直觉。
nodes.viewerStage.addEventListener(
  "wheel",
  (event) => {
    if (nodes.viewer.hidden) return;
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
  },
  { passive: false },
);
// 画廊滚到底再拉一页。
nodes.thumbs.addEventListener("scroll", () => {
  if (galleryLoading || galleryJobs.length >= galleryTotal) return;
  const { scrollTop, scrollHeight, clientHeight } = nodes.thumbs;
  if (scrollHeight - scrollTop - clientHeight < 480) void loadGallery();
});

document.addEventListener("click", () => closeMenu());
// 引擎回帧间隔可能好几秒，这里每秒把「已用」自己走一格。
setInterval(() => {
  const active = latest?.engine?.active;
  if (!active) return;
  nodes.resultCaption.textContent = activeCaption(active);
  // chip 的「已跑」也要走秒。
  renderStage(latest);
}, 1000);
nodes.stageCancel.addEventListener("click", () => {
  const active = latest?.engine?.active;
  if (!active) return;
  void post("/cancel", { id: active.jobId });
});
document.addEventListener("contextmenu", (event) => {
  // 图上右键已自己处理；空白处的右键只负责把菜单关掉。
  if (!event.target.closest(".thumb")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
    if (!nodes.viewer.hidden) closeViewer();
    return;
  }
  if (nodes.viewer.hidden) return;
  if (event.key === "ArrowLeft") stepViewer(-1);
  else if (event.key === "ArrowRight") stepViewer(1);
  else if (event.key === "+" || event.key === "=") zoomAtCenter(1);
  else if (event.key === "-") zoomAtCenter(-1);
  else if (event.key === "0") {
    viewerZoom = 1;
    layoutViewerImage();
  }
});
// 窗口尺寸变了，适应窗口的基准跟着变。
window.addEventListener("resize", () => {
  if (!nodes.viewer.hidden) layoutViewerImage();
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
    onEvent: (name, payload) => {
      // 预览走事件，不靠 state 轮询。
      if (name !== "preview") return;
      const active = latest?.engine?.active;
      if (!active) return;
      active.previewAt = payload.at;
      // 画布上的预览图直接换，不必等下一帧 state。
      const img = nodes.resultImage;
      if (img.dataset.preview !== String(payload.at)) {
        img.dataset.preview = String(payload.at);
        img.src = previewUrl(payload.at);
        img.classList.add("preview");
      }
      // 画廊里那张正在采样的缩略图也跟着换，不重建整个网格。
      const thumb = nodes.thumbs.querySelector("img.preview-thumb");
      if (thumb) thumb.src = previewUrl(payload.at);
    },
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
