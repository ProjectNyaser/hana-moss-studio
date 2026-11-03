// 苔室工作区：画布、画廊、队列、版本、下载五个视图。生成设置在左侧栏（panel.html）。
import { hana } from "./sdk.js";
import { startLive, outputUrl, previewUrl, thumbUrl } from "./live.js";
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
  viewerZoomActual: el("viewer-zoom-actual"),
  // 队列
  queueCount: el("queue-count"),
  queueList: el("queue-list"),
  // 版本
  engineState: el("versions-engine-state"),
  engineToggle: el("versions-engine-toggle"),
  engineNote: el("versions-engine-note"),
  installed: el("versions-installed"),
  modelState: el("versions-model-state"),
  modelList: el("versions-model"),
  host: el("versions-host"),
  // 下载
  toast: el("toast"),
  downloadEngine: el("download-engine"),
  downloadModels: el("download-models"),
  versionsTabs: el("versions-tabs"),
  downloadAvailableState: el("download-available-state"),
  downloadAvailable: el("download-available"),
};

const views = ["canvas", "gallery", "queue", "versions"];
const imageCache = new Map();
let latest = null;
// 耗时锚点：{ at, ms }，每次后端推送更新，两次之间由定时器补差。
let elapsedAnchor = null;
// 画廊单独分页：state 只带未收尾的与最近两张完成的，剩下从 /jobs 拉。
const GALLERY_PAGE = 60;
let galleryJobs = [];
let galleryTotal = 0;
/** 已经拉到的位置。不用 galleryJobs.length：删掉一条后会错位，跳过未加载的那一张。 */
let galleryOffset = 0;
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
  if (view === "versions") void loadReleases();
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
  nodes.canvasMeta.textContent = `引擎 ${data.engine?.hello?.version ?? data.engines?.find((item) => item.current)?.version ?? "未安装"} · 协议 v${data.engine?.hello?.protocol_version ?? data.mossimage?.protocolVersion ?? "?"} · 记录 ${data.jobTotal ?? data.jobs.length} 条`;
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
  const inState = data.jobs.find((job) => job.id === selectedId && job.status === "done" && job.output);
  if (inState) return inState;
  // state 只带最近两条完成，选中的若是旧图就去画廊那份里找。
  return galleryJobs.find((job) => job.id === selectedId && job.status === "done" && job.output) ?? null;
}

function loadImage(name) {
  if (!name) return null;
  if (!imageCache.has(name)) imageCache.set(name, outputUrl(name));
  return imageCache.get(name);
}

/** 画廊用的小图。原图留给画布与查看器，铺一屏几十张原图能把带宽吃干净。 */
const thumbCache = new Map();
function loadThumb(name, size = 320) {
  if (!name) return null;
  const key = `${name}@${size}`;
  if (!thumbCache.has(key)) thumbCache.set(key, thumbUrl(name, size));
  return thumbCache.get(key);
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
    const offset = reset ? 0 : galleryOffset;
    const page = await api(`/jobs?offset=${offset}&limit=${GALLERY_PAGE}`);
    galleryJobs = reset ? page.jobs : galleryJobs.concat(page.jobs);
    galleryOffset = offset + page.jobs.length;
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
  // 首帧还没有 /jobs 的结果，但 state 已经带了成图数：角标先按它显示，
  // 等分页回来自然对齐。用 doneTotal 而不是 jobTotal：后者含失败与取消。
  const shownCount = data.doneTotal ?? (galleryTotal || visible.length);
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
    tile.dataset.jobId = job.id;
    const shown = shownJob(data);
    if (job.status === "done" && job.output) {
      if (shown && shown.id === job.id) tile.classList.add("on");
      const url = loadThumb(job.output, 320);
      if (url) {
        const image = document.createElement("img");
        image.src = url;
        image.alt = job.prompt.slice(0, 40);
        image.loading = "lazy";
        image.title = job.prompt;
        if (job.width && job.height) image.style.aspectRatio = `${job.width} / ${job.height}`;
        tile.appendChild(image);
        // 点整块都算：底部的分辨率与步数是盖在上面的，不能让它拦住点击。
        tile.addEventListener("click", () => openViewer(job.id));
        const meta = document.createElement("div");
        meta.className = "thumb-meta";
        // 单行，装不下就省略号。完整写法与耗时在查看器底部那行。
        meta.textContent = `${job.width}×${job.height} · ${job.steps}步 · CFG${job.cfg} · #${job.report?.seedUsed ?? job.seed ?? "?"}`;
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
        tile.classList.add("sampling");
        const preview = document.createElement("img");
        preview.className = "preview-thumb";
        preview.src = previewUrl(active.previewAt);
        preview.alt = "采样中";
        tile.appendChild(preview);
        const tag = document.createElement("div");
        tag.className = "thumb-meta";
        tag.textContent = samplingText(active);
        tile.appendChild(tag);
        // 底边一条细进度，一眼看出这是半成品、走到哪一步了。
        const bar = document.createElement("i");
        bar.className = "thumb-progress";
        bar.style.width = `${Math.max(2, Math.min(100, active.progress?.percent ?? 0))}%`;
        tile.appendChild(bar);
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
  if (meta) {
    const metaNode = document.createElement("span");
    metaNode.className = "meta";
    metaNode.textContent = meta;
    row.append(metaNode);
  }
  // 标记靠右、紧贴操作按钮：状态和能做的事在同一头，不再一端一个。
  for (const badge of badges) {
    const tag = document.createElement("span");
    tag.className = "badge";
    tag.textContent = badge;
    row.append(tag);
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
    void toast(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
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
function queueCard({ title, meta, percent, thumb, on, stateText, actions = [] }) {
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
  const head = document.createElement("div");
  head.className = "qc-head";
  const titleNode = document.createElement("div");
  titleNode.className = "qc-title";
  titleNode.textContent = title;
  titleNode.title = title;
  head.appendChild(titleNode);
  // 状态写在行内右侧，不再靠分块说明自己是哪一类。
  if (stateText) {
    const badge = document.createElement("span");
    badge.className = "qc-state";
    badge.textContent = stateText;
    head.appendChild(badge);
  }
  main.appendChild(head);
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
  const failed = data.jobs.filter((job) => job.status === "error").slice(0, 8);
  const total = queue.length + (active ? 1 : 0);
  // 角标等下载行一起算，放到函数末尾。

  // 一条任务一行，状态写在行内，不再分「正在跑 / 排队 / 失败」三段。
  const rows = [];
  if (active) {
    const percent = active.progress?.percent;
    rows.push(
      queueCard({
        title: active.prompt || "(无提示词)",
        stateText: typeof percent === "number" ? `${Math.round(percent)}%` : "正在跑",
        meta: `${active.phase ?? "生成中"}${active.progress?.total ? ` · ${active.progress.step}/${active.progress.total}` : ""}${active.progress?.etaMs ? ` · 约剩 ${formatDuration(active.progress.etaMs)}` : ""}`,
        percent,
        thumb: active.previewAt ? previewUrl(active.previewAt) : null,
        on: true,
        actions: [
          {
            label: "取消",
            run: () => runSafe(() => post("/cancel", { id: active.jobId }), "取消"),
          },
        ],
      }),
    );
  }
  queue.forEach((job, index) => {
    rows.push(
      queueCard({
        title: job.prompt || "(无提示词)",
        stateText: `排队 ${index + 1}`,
        meta: `${job.width}×${job.height} · ${job.steps} 步`,
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
    );
  });
  for (const job of failed) {
    const card = queueCard({
      title: job.prompt || "(无提示词)",
      stateText: "失败",
      meta: (job.error ?? "失败").slice(0, 60),
    });
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = "删除";
    armable(button, "确认", "删除", () => removeJob(job.id));
    card.appendChild(button);
    rows.push(card);
  }

  // 下载任务和生图任务同一个列表：在跑的事一页看完。
  const downloading = downloadRows(data.install);
  // install 没任务时是 null，有这个对象就是有任务在跑。
  const downloadBusy = Boolean(data.install);

  nodes.queueCount.textContent = [
    active ? "1 正在跑" : null,
    queue.length ? `${queue.length} 排队` : null,
    downloading.length ? `${downloading.length} 下载中` : null,
    failed.length ? `${failed.length} 失败` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!rows.length && !downloading.length) {
    const empty = document.createElement("p");
    empty.className = "empty-line";
    empty.textContent = "队列是空的。";
    rows.push(empty);
  }
  nodes.queueList.replaceChildren(...rows, ...downloading);
  nodes.tabQueue.textContent = total || downloadBusy ? ` ${total + (downloadBusy ? downloading.length : 0)}` : "";
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

  // 模型：上面这块只列已装的（标题写的就是「N 个已装」，每行再标一遍是废话）。
  // 未装的在下面「可下载」那块。
  const models = Array.isArray(data.models) ? data.models : [];
  const installedModels = models.filter((item) => item.installed);
  nodes.modelState.textContent = installedModels.length ? `${installedModels.length} 个已装` : "未安装";
  nodes.modelList.replaceChildren(
    ...(installedModels.length
      ? installedModels.map((item) =>
          manageRow({
            name: item.label,
            badges: [item.active ? "当前" : null].filter(Boolean),
            meta: formatSize(item.bytes),
            detail: item.components?.map((part) => ({ label: part.label, value: formatSize(part.bytes) })) ?? null,
            on: item.active,
            actions: item.active
              ? []
              : [
                  {
                    label: "切换",
                    run: () => runSafe(() => post("/weights/use", { variant: item.variant }), "切换模型"),
                  },
                ],
            // 卸载放在行内，跟引擎那块一致：想删哪个点哪个，不用先切过去再删。
            remove: {
              label: "卸载",
              question: `卸载 ${item.label}？（${formatSize(item.bytes)}）`,
              run: () =>
                runSafe(() => post("/models/remove", { confirm: true, variant: item.variant }), "卸载模型"),
            },
          }),
        )
      : [manageRow({ name: "还没有装模型，去下面下载" })]),
  );

  const hostRows = [];
  if (data.gpu) hostRows.push(manageRow({ name: data.gpu.name, meta: `驱动 ${data.gpu.driver}` }));
  if (engine.device?.totalMemoryBytes) hostRows.push(manageRow({ name: "显存", meta: formatSize(engine.device.totalMemoryBytes) }));
  hostRows.push(manageRow({ name: "引擎协议", meta: `v${data.mossimage?.protocolVersion ?? "?"}` }));
  nodes.host.replaceChildren(...hostRows);
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
  nodes.downloadEngine.disabled = false;

  // 模型：下面这块列全部两个仓库，和引擎那块一致——上面是已装的（能切、能卸），
  // 这里是完整清单。
  const models = Array.isArray(data.models) ? data.models : [];
  const perRepo = data.plan?.totalBytes ? `约 ${formatSize(data.plan.totalBytes)}` : "约 25 GiB";
  nodes.downloadModels.replaceChildren(
    ...models.map((item) => {
      const row = manageRow({
        name: item.label,
        // 不标「已装」：按钮本身已经说了——「校验」就是已装，「下载」就是没装，
        // 上面那块标题又写了一遍「N 个已装」。
        // 也不传 on：当前生效的强调只留在上面那张已装清单里。
        meta: item.installed ? formatSize(item.bytes) : `${perRepo} · ${item.note}`,
      });
      const button = document.createElement("button");
      button.className = "btn ghost small";
      button.type = "button";
      // 文案不随任务状态变。点下去就是进安装队列，排上了去队列页看，
      // 按钮自己不需要再说一遍「排队」。
      button.textContent = item.installed ? "校验" : "下载";
      if (item.installed) button.title = "重新比对每个文件的 sha256，不一致的会重下";
      button.addEventListener("click", () =>
        void startInstall(
          "/install/weights",
          { variant: item.variant },
          `${item.installed ? "校验" : "下载"} ${item.label}`,
        ),
      );
      row.appendChild(button);
      return row;
    }),
  );

  // 下载任务已经并进队列页，这里只管版本页的模型下载入口。
}

/**
 * 下载任务 → 队列行。和生图任务用同一套卡片，一个页面里就看完全部在跑的事。
 */
function downloadRows(job) {
  if (!job?.tasks?.length) return [];
  // 已经收尾的任务不再列活跃行，否则取消后还挂着一条跑着的进度。
  const tasks = job.finishedAt
    ? job.tasks.filter((task) => task.status !== "active" && task.status !== "waiting")
    : job.tasks;
  return tasks.map((task) => {
    const size = Number(task.size) || 0;
    const got = Number(task.got) || 0;
    const speed = Number(task.speed) || 0;
    const percent = size ? Math.min(100, (got / size) * 100) : 0;
    // 校验时 completedLength 已经是满的，但任务还没结束。不单独标出来就会看着像卡住。
    // aria2 只在 --check-integrity 模式下报 verifiedLength，--checksum 模式下没有，
    // 所以这里只写「校验中」，不编一个永远停在 0% 的进度。
    const verifying = Boolean(task.verifying);
    const meta = verifying
      ? `${formatSize(size)} · 校验中`
      : [
          size ? `${formatSize(got)} / ${formatSize(size)}` : formatSize(got),
          speed > 0 ? `${formatSize(speed)}/s` : null,
          speed > 0 && size > got ? `剩 ${formatDuration(((size - got) / speed) * 1000)}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
    const stateText =
      task.status === "complete"
        ? "已完成"
        : task.status === "paused"
          ? "已暂停"
          : task.status === "error"
            ? "失败"
            : task.status === "removed"
              ? "已取消"
              : task.status === "waiting"
                ? `排队${task.queue ? ` ${task.queue}` : ""}`
                : verifying
                  ? "校验"
                  : `${Math.round(percent)}%`;
    const act = (action, label) => ({
      label,
      run: () => runSafe(() => post("/install/task", { out: task.out, action }), label),
    });
    const actions =
      task.status === "active"
        ? [act("pause", "暂停"), act("remove", "移除")]
        : task.status === "paused"
          ? [act("resume", "继续"), act("remove", "移除")]
          : task.status === "waiting"
            ? [act("remove", "移除")]
            : [];
    return queueCard({
      title: task.out,
      stateText,
      meta,
      percent: task.status === "active" || task.status === "paused" ? (verifying ? undefined : percent) : undefined,
      actions,
    });
  });
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
    nodes.downloadAvailableState.textContent = `${items.length} 个版本`;
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
          // 不传 on：已装用 badge 标就够了，这里不是「当前生效」那张清单。
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
/** 缩放档位，一律相对图片原始像素：1 就是 1:1，不是「适应窗口」。 */
const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
let viewerList = [];
let viewerIndex = 0;
let viewerZoom = 1;
// 刚打开或翻页时先按窗口整图，之后倍率就只跟原图比。
let viewerNeedsFit = true;

function openViewer(id) {
  // state 只带未收尾的与最近两张完成的，画廊是分页拉的。两处合起来才是真列表，
  // 否则靠后的图点了没反应（findIndex 返回 -1 就直接退出了）。
  const merged = new Map();
  for (const job of galleryJobs) merged.set(job.id, job);
  for (const job of latest?.jobs ?? []) merged.set(job.id, { ...merged.get(job.id), ...job });
  viewerList = [...merged.values()]
    .filter((job) => job.status === "done" && job.output)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const index = viewerList.findIndex((job) => job.id === id);
  if (index < 0) return;
  viewerIndex = index;
  viewerZoom = 1;
  viewerNeedsFit = true;
  nodes.viewer.hidden = false;
  applyViewer();
}

function closeViewer() {
  nodes.viewer.hidden = true;
}

/** 倍率直接乘原图像素：100% 就是原大。打开与翻页先算一次适应值。 */
function layoutViewerImage() {
  const img = nodes.viewerImage;
  const stage = nodes.viewerStage;
  const natW = img.naturalWidth || 1;
  const natH = img.naturalHeight || 1;
  const boxW = Math.max(120, stage.clientWidth - 128);
  const boxH = Math.max(120, stage.clientHeight - 24);
  const fit = Math.min(1, Math.min(boxW / natW, boxH / natH));
  // 遮罩刚显示时尺寸可能还是 0，那一次不算数，等下一次布局。
  if (viewerNeedsFit && stage.clientWidth > 50 && stage.clientHeight > 50) {
    viewerZoom = fit;
    viewerNeedsFit = false;
  }
  img.style.width = `${Math.max(1, Math.round(natW * viewerZoom))}px`;
  img.style.height = `${Math.max(1, Math.round(natH * viewerZoom))}px`;
  // 图超出视口才有东西可平移，光标跟着变。
  stage.classList.toggle(
    "can-pan",
    stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1,
  );
  nodes.viewerIndex.textContent = `${viewerIndex + 1} / ${viewerList.length} · ${Math.round(viewerZoom * 100)}%`;
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
  viewerNeedsFit = true;
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
    // 记录就在 PNG 的元数据里，删图即删记录。
    label: job.output ? "删除这张图" : "删除这条记录",
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
  // key 带上「有没有预览」：从没有到有的时候要重画那格，之后同状态内只换图。
  const previewing = data.engine.active?.previewAt ? "p" : "";
  const key = `${data.jobs.map((job) => `${job.id}:${job.status}`).join("|")}#${previewing}`;
  if (key !== renderedJobsKey) {
    renderedJobsKey = key;
    const selectedAlive =
      data.jobs.some((job) => job.id === selectedId && job.status === "done") ||
      galleryJobs.some((job) => job.id === selectedId && job.status === "done");
    if (selectedId && !selectedAlive) selectedId = null;
    void renderGallery(data);
  } else {
    // 状态没变但采样在出预览：只换那张图，不重建整面墙。
    updateGalleryPreview(data);
  }
  broadcastState(data);
}

/**
 * 把整帧状态广播给侧栏。同源推送比自己开一条连接便宜：侧栏收到后就不再
 * 轮询、也不再占 SSE 的位子。节流 250ms，生成中每秒最多四帧。
 */
let broadcastAt = 0;
function broadcastState(data) {
  if (!channel || typeof BroadcastChannel !== "function") return;
  const now = Date.now();
  if (now - broadcastAt < 250) return;
  broadcastAt = now;
  try {
    channel.postMessage({ type: "state", state: data });
  } catch {
    /* 结构化克隆失败（含函数之类）就这一帧不发，不影响主界面 */
  }
}

/** 采样中那格的文字：阶段、步数、百分比。 */
function samplingText(active) {
  const progress = active.progress ?? {};
  const bits = [progress.phase ?? "采样中"];
  if (progress.total) bits.push(`${progress.step}/${progress.total}`);
  if (typeof progress.percent === "number") bits.push(`${Math.round(progress.percent)}%`);
  return bits.join(" · ");
}

/** 采样中的那张，缩略图跟着引擎的中间结果走。 */
function updateGalleryPreview(data) {
  const active = data.engine.active;
  if (!active?.previewAt) return;
  const tile = nodes.thumbs.querySelector(`[data-job-id="${active.jobId}"]`);
  if (!tile) return;
  const image = tile.querySelector(".preview-thumb");
  if (image) {
    const url = previewUrl(active.previewAt);
    if (image.getAttribute("src") !== url) image.src = url;
  }
  const meta = tile.querySelector(".thumb-meta");
  if (meta) meta.textContent = samplingText(active);
  const bar = tile.querySelector(".thumb-progress");
  if (bar) bar.style.width = `${Math.max(2, Math.min(100, active.progress?.percent ?? 0))}%`;
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
    const next = await post("/jobs/remove", { id });
    // 画廊的数据源是分页拉来的 galleryJobs，不是 state。不把这条从这里剔掉，
    // 后端已经删了、界面还在，看着就像没生效。
    const gone = galleryJobs.find((job) => job.id === id);
    galleryJobs = galleryJobs.filter((job) => job.id !== id);
    // 分页游标跟着退一格，否则下次加载会跳过一条。
    if (gone) galleryOffset = Math.max(0, galleryOffset - 1);
    if (gone) {
      galleryTotal = Math.max(0, galleryTotal - 1);
      if (gone.output) {
        imageCache.delete(gone.output);
        thumbCache.delete(`${gone.output}@320`);
      }
    }
    renderedJobsKey = null;
    render(next);
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
nodes.viewerImage.addEventListener("load", layoutViewerImage);
nodes.viewerClose.addEventListener("click", closeViewer);
nodes.viewerPrev.addEventListener("click", () => stepViewer(-1));
nodes.viewerNext.addEventListener("click", () => stepViewer(1));
nodes.viewerZoomIn.addEventListener("click", () => zoomAtCenter(1));
nodes.viewerZoomOut.addEventListener("click", () => zoomAtCenter(-1));
nodes.viewerZoomFit.addEventListener("click", () => {
  viewerNeedsFit = true;
  layoutViewerImage();
});
nodes.viewerZoomActual.addEventListener("click", () => {
  viewerZoom = 1;
  viewerNeedsFit = false;
  layoutViewerImage();
});
// 点图的周围空白处关掉；点图本身不关。
let panMoved = false;
nodes.viewerStage.addEventListener("click", (event) => {
  // 平移结束时浏览器也会补一个 click，那一下不该当成「点空白」。
  if (panMoved) {
    panMoved = false;
    return;
  }
  if (event.target === nodes.viewerStage) closeViewer();
});

/**
 * 左键按住平移，仅限图超出视口时（can-pan）。
 *
 * 图装得下时保留浏览器原生的图片拖拽，那是把图拖到别的程序的正规路径；
 * 放大后左键让给平移，否则一拖就飞。原生拖放只能由左键发起，右键做不了。
 */
let panning = null;

nodes.viewerStage.addEventListener("pointerdown", (event) => {
  const stage = nodes.viewerStage;
  if (event.button !== 0 || nodes.viewer.hidden || !stage.classList.contains("can-pan")) return;
  panning = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.classList.add("panning");
  stage.setPointerCapture(event.pointerId);
});

nodes.viewerStage.addEventListener("pointermove", (event) => {
  if (!panning) return;
  const dx = event.clientX - panning.x;
  const dy = event.clientY - panning.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
  const stage = nodes.viewerStage;
  stage.scrollLeft = panning.left - dx;
  stage.scrollTop = panning.top - dy;
});

function endPan(event) {
  if (!panning) return;
  panning = null;
  const stage = nodes.viewerStage;
  stage.classList.remove("panning");
  try {
    stage.releasePointerCapture(event.pointerId);
  } catch {
    /* 指针已经没了 */
  }
}

nodes.viewerStage.addEventListener("pointerup", endPan);
nodes.viewerStage.addEventListener("pointercancel", endPan);
// 查看器里的右键直接关掉。
nodes.viewerStage.addEventListener("contextmenu", (event) => {
  if (nodes.viewer.hidden) return;
  event.preventDefault();
  closeViewer();
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
    viewerNeedsFit = true;
    layoutViewerImage();
  } else if (event.key === "1") {
    // 原大：一个 CSS 像素对应一个图像像素。
    viewerZoom = 1;
    viewerNeedsFit = false;
    layoutViewerImage();
  }
});
// 窗口尺寸变了，适应窗口的基准跟着变；已手动缩放过就保持原倍率。
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
  // 首屏靠事件流的首帧，不再单独拉一次 /state。万一流一时连不上，两秒后再补一次。
  let gotFrame = false;
  setTimeout(() => {
    if (!gotFrame) void refresh();
  }, 2000);
  startLive({
    hana,
    onState: (state) => {
      gotFrame = true;
      render(state);
    },
    onEvent: (name, payload) => {
      if (!latest) return;
      // 进度与下载都走小帧，不再为每一步重推整份 state。
      if (name === "progress") {
        const active = latest.engine?.active;
        if (!active || active.jobId !== payload.jobId) return;
        active.progress = payload.progress ?? active.progress;
        if (payload.phase) active.phase = payload.phase;
        renderStage(latest);
        broadcastState(latest);
        return;
      }
      if (name === "transfer") {
        latest.install = payload.install ?? latest.install;
        renderQueue(latest);
        broadcastState(latest);
        return;
      }
      // 预览走事件，不靠 state 轮询。
      if (name !== "preview") return;
      const active = latest.engine?.active;
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
      updateGalleryPreview(latest);
    },
    fetchState: () => api("/state"),
    onError: (error) => {
      if (latest) return;
      nodes.stageText.textContent = error instanceof Error ? error.message : String(error);
      nodes.stageDot.className = "dot err";
    },
  });
}

void boot();
