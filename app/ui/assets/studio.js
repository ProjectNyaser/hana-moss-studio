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
  canvasLayout: el("canvas-layout"),
  lay: el("lay"),
  layInfo: el("lay-info"),
  layStage: el("lay-stage"),
  laySheet: el("lay-sheet"),
  layBoxes: el("lay-boxes"),
  layDraft: el("lay-draft"),
  layForm: el("lay-form"),
  layLabel: el("lay-label"),
  layCaption: el("lay-caption"),
  layText: el("lay-text"),
  laySize: el("lay-size"),
  layRemove: el("lay-remove"),
  layImport: el("lay-import"),
  layClear: el("lay-clear"),
  layClose: el("lay-close"),
  layFile: el("lay-file"),
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
  engineRelease: el("versions-engine-release"),
  engineNote: el("versions-engine-note"),
  installed: el("versions-installed"),
  modelState: el("versions-model-state"),
  modelList: el("versions-model"),
  configList: el("config-list"),
  host: el("versions-host"),
  // 下载
  toast: el("toast"),
  downloadEngine: el("download-engine"),
  downloadAdapters: el("download-adapters"),
  downloadDits: el("download-dits"),
  downloadEncoders: el("download-encoders"),
  filesAdapterState: el("files-adapter-state"),
  filesDitState: el("files-dit-state"),
  filesEncoderState: el("files-encoder-state"),
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
async function api(path, init, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

function post(path, body, timeoutMs) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }, timeoutMs);
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
 * 一句话提示。
 *
 * 直接在页面里调宿主：oh-releases 就是这么用的（ui/src/releases.js:679）。
 * 之前绕了一圈去请求自己的 /toast 路由、再由服务端调 sdk.ui.toast，
 * 那条路上 sdk.ui 属于 UI 侧能力，服务端手里未必是同一个通道。
 *
 * type 取宿主认的三个值：info / success / warning。
 */
function toast(text, type = "info") {
  try {
    hana.toast?.show({ message: text, type });
    return;
  } catch {
    // 宿主通道不可用时别把流程挂住，落到下面的页面内浮层。
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

// ── 布局框选（主画布上）───────────────────────────────────────────────
// 框选放在主画布：侧栏只有三百多像素，对不准构图。这一层只管「位置 + 每块写什么」，
// 画幅与提交还归侧栏；完成后用广播把框交回去。
const lay = {
  open: false,
  /** {url, name, width, height}：只给对齐用，不上传。 */
  underlay: null,
  boxes: [],
  selected: null,
  /** 表单当前展示的是哪个框；换框才重填。 */
  formId: null,
  drag: null,
  seq: 0,
};

function layoutCanvasSize() {
  const defaults = latest?.settings?.defaults ?? {};
  return {
    width: Math.max(256, Math.round(Number(defaults.width) || 1024)),
    height: Math.max(256, Math.round(Number(defaults.height) || 1024)),
  };
}

function renderLayInfo() {
  const size = layoutCanvasSize();
  const under = lay.underlay ? ` · 底图 ${lay.underlay.width}×${lay.underlay.height}` : "";
  nodes.layInfo.textContent = `${size.width}×${size.height} · ${lay.boxes.length} 个框${under}`;
}

function laySheetSize() {
  const size = layoutCanvasSize();
  const stage = nodes.layStage;
  const ratio = size.width / Math.max(1, size.height);
  const fitWidth = Math.max(80, stage.clientWidth - 44);
  const fitHeight = Math.max(80, stage.clientHeight - 44);
  let width = fitWidth;
  let height = width / ratio;
  if (height > fitHeight) {
    height = fitHeight;
    width = height * ratio;
  }
  nodes.laySheet.style.width = `${Math.round(width)}px`;
  nodes.laySheet.style.height = `${Math.round(height)}px`;
}

function renderLayForm() {
  const item = lay.boxes.find((entry) => entry.id === lay.selected) ?? null;
  nodes.layForm.hidden = !item;
  if (!item) {
    lay.formId = null;
    return;
  }
  if (lay.formId !== item.id) {
    lay.formId = item.id;
    nodes.layLabel.value = item.label;
    nodes.layCaption.value = item.caption;
    nodes.layText.value = item.text;
  }
  const [x0, y0, x1, y1] = item.box;
  nodes.laySize.textContent = `${Math.round(x1 - x0)}×${Math.round(y1 - y0)} px`;
}

function renderLayBoxes() {
  const size = layoutCanvasSize();
  const heightPx = nodes.laySheet.clientHeight;
  const list = lay.boxes.map((item, index) => {
    const [x0, y0, x1, y1] = item.box;
    const box = document.createElement("div");
    box.className = "lay-box" + (item.id === lay.selected ? " on" : "");
    box.dataset.id = item.id;
    box.style.left = `${(x0 / size.width) * 100}%`;
    box.style.top = `${(y0 / size.height) * 100}%`;
    box.style.width = `${((x1 - x0) / size.width) * 100}%`;
    box.style.height = `${((y1 - y0) / size.height) * 100}%`;
    const tag = document.createElement("span");
    tag.className = "lay-tag";
    tag.textContent = `${index + 1} ${item.label || "object"}`;
    box.append(tag);
    const noteText = (item.caption || item.text || "").trim();
    if (noteText && (y1 - y0) / size.height * heightPx >= 34) {
      const note = document.createElement("span");
      note.className = "lay-note";
      note.textContent = noteText;
      box.append(note);
    }
    if (item.id === lay.selected) {
      for (const dir of ["nw", "ne", "sw", "se"]) {
        const grip = document.createElement("span");
        grip.className = `lay-grip ${dir}`;
        grip.dataset.dir = dir;
        box.append(grip);
      }
    }
    return box;
  });
  nodes.layBoxes.replaceChildren(...list);
  renderLayForm();
  syncLayoutToPanel();
}

/** 框一变就交给侧栏：不用点「完成」，画布上留着框直接生成。
 *  不做节流：拖拽中不重建 DOM，只有落点、输入、删除才会走到这里，直接发不会堵。 */
function syncLayoutToPanel() {
  const size = layoutCanvasSize();
  layChannel?.postMessage({
    type: "layout",
    width: size.width,
    height: size.height,
    boxes: lay.boxes.map((item) => ({
      label: item.label.trim() || "object",
      caption: item.caption.trim(),
      text: item.text.trim(),
      box: item.box.map((value) => Math.round(value)),
    })),
  });
}

function syncLayBox(item) {
  const size = layoutCanvasSize();
  const box = nodes.layBoxes.querySelector(`[data-id="${item.id}"]`);
  if (!box) return;
  const [x0, y0, x1, y1] = item.box;
  box.style.left = `${(x0 / size.width) * 100}%`;
  box.style.top = `${(y0 / size.height) * 100}%`;
  box.style.width = `${((x1 - x0) / size.width) * 100}%`;
  box.style.height = `${((y1 - y0) / size.height) * 100}%`;
  renderLayForm();
}

function renderLayDraft() {
  const draft = nodes.layDraft;
  const size = layoutCanvasSize();
  if (!lay.drag?.box) {
    draft.hidden = true;
    return;
  }
  const [x0, y0, x1, y1] = lay.drag.box;
  draft.hidden = false;
  draft.style.left = `${(x0 / size.width) * 100}%`;
  draft.style.top = `${(y0 / size.height) * 100}%`;
  draft.style.width = `${((x1 - x0) / size.width) * 100}%`;
  draft.style.height = `${((y1 - y0) / size.height) * 100}%`;
}

function openLayout(selectId) {
  lay.open = true;
  nodes.lay.hidden = false;
  nodes.laySheet.style.backgroundImage = lay.underlay ? `url(${lay.underlay.url})` : "";
  lay.selected = selectId ?? lay.boxes[0]?.id ?? null;
  lay.drag = null;
  laySheetSize();
  renderLayBoxes();
  renderLayInfo();
  toast("框会自动同步到左侧栏，直接点开始生成就行");
}

function closeLayout() {
  lay.open = false;
  nodes.lay.hidden = true;
  lay.drag = null;
  nodes.layDraft.hidden = true;
  if (latest) void renderCanvas(latest);
}

function removeLayBox(id) {
  const index = lay.boxes.findIndex((item) => item.id === id);
  if (index < 0) return;
  lay.boxes.splice(index, 1);
  lay.selected = lay.boxes[Math.min(index, lay.boxes.length - 1)]?.id ?? null;
  renderLayBoxes();
  renderLayInfo();
}

/** 屏幕坐标 ↔ 画布像素：框存像素，画在屏幕上是百分比。 */
function layPoint(event) {
  const size = layoutCanvasSize();
  const rect = nodes.laySheet.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * size.width;
  const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * size.height;
  return {
    x: Math.max(0, Math.min(size.width, Math.round(x))),
    y: Math.max(0, Math.min(size.height, Math.round(y))),
  };
}

function onLayPointerDown(event) {
  if (event.button !== 0) return;
  const point = layPoint(event);
  const grip = event.target.closest?.(".lay-grip") ?? null;
  const boxEl = event.target.closest?.(".lay-box") ?? null;
  const item = boxEl ? lay.boxes.find((entry) => entry.id === boxEl.dataset.id) : null;
  try {
    nodes.laySheet.setPointerCapture(event.pointerId);
  } catch {
    /* 合成的 PointerEvent 没有活动指针，捕获会抛；拖拽本身不靠它 */
  }
  // preventDefault 挡住了焦点转移：不主动收回，Del 会被表单的输入框吃掉。
  nodes.laySheet.focus({ preventScroll: true });
  if (item && grip) {
    lay.selected = item.id;
    lay.drag = { mode: "resize", id: item.id, dir: grip.dataset.dir, origin: [...item.box], start: point };
  } else if (item) {
    lay.selected = item.id;
    lay.drag = { mode: "move", id: item.id, origin: [...item.box], start: point };
  } else {
    lay.selected = null;
    lay.drag = { mode: "new", start: point, box: [point.x, point.y, point.x, point.y] };
  }
  renderLayBoxes();
  renderLayInfo();
  event.preventDefault();
}

function onLayPointerMove(event) {
  if (!lay.drag) return;
  const point = layPoint(event);
  const size = layoutCanvasSize();
  if (lay.drag.mode === "new") {
    lay.drag.box = [
      Math.min(lay.drag.start.x, point.x),
      Math.min(lay.drag.start.y, point.y),
      Math.max(lay.drag.start.x, point.x),
      Math.max(lay.drag.start.y, point.y),
    ];
    renderLayDraft();
    return;
  }
  const item = lay.boxes.find((entry) => entry.id === lay.drag.id);
  if (!item) return;
  if (lay.drag.mode === "move") {
    const [x0, y0, x1, y1] = lay.drag.origin;
    const width = x1 - x0;
    const height = y1 - y0;
    const nx = Math.max(0, Math.min(size.width - width, x0 + (point.x - lay.drag.start.x)));
    const ny = Math.max(0, Math.min(size.height - height, y0 + (point.y - lay.drag.start.y)));
    item.box = [nx, ny, nx + width, ny + height];
  } else {
    const origin = lay.drag.origin;
    let x0 = origin[0];
    let y0 = origin[1];
    let x1 = origin[2];
    let y1 = origin[3];
    if (lay.drag.dir.includes("w")) x0 = Math.min(Math.max(0, point.x), x1 - 8);
    if (lay.drag.dir.includes("e")) x1 = Math.max(Math.min(size.width, point.x), x0 + 8);
    if (lay.drag.dir.includes("n")) y0 = Math.min(Math.max(0, point.y), y1 - 8);
    if (lay.drag.dir.includes("s")) y1 = Math.max(Math.min(size.height, point.y), y0 + 8);
    item.box = [x0, y0, x1, y1];
  }
  syncLayBox(item);
}

function onLayPointerUp(event) {
  if (!lay.drag) return;
  const drag = lay.drag;
  lay.drag = null;
  try {
    nodes.laySheet.releasePointerCapture(event.pointerId);
  } catch {
    /* 同上：没有活动指针时不用释放 */
  }
  nodes.layDraft.hidden = true;
  let created = null;
  if (drag.mode === "new") {
    const [x0, y0, x1, y1] = drag.box;
    if (x1 - x0 >= 8 && y1 - y0 >= 8) {
      created = { id: `lay-${++lay.seq}`, label: "object", caption: "", text: "", box: drag.box };
      lay.boxes.push(created);
      lay.selected = created.id;
    }
  }
  renderLayBoxes();
  renderLayInfo();
  if (created) nodes.layCaption.focus();
}

/** 底图只给对齐用：不上传、不进生成。比例不同就跟着改画幅。 */
async function setUnderlay(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("这张图读不出来"));
    image.src = url;
  });
  if (lay.underlay?.url) URL.revokeObjectURL(lay.underlay.url);
  lay.underlay = { url, name: file.name, width: image.naturalWidth, height: image.naturalHeight };
  nodes.laySheet.style.backgroundImage = `url(${url})`;
  const size = layoutCanvasSize();
  const ratio = image.naturalWidth / Math.max(1, image.naturalHeight);
  const canvasRatio = size.width / Math.max(1, size.height);
  if (Math.abs(ratio - canvasRatio) / canvasRatio > 0.02) {
    // 保持像素总量不变，只换比例。
    const area = size.width * size.height;
    const width = Math.max(256, Math.round(Math.sqrt(area * ratio) / 8) * 8);
    const height = Math.max(256, Math.round(width / ratio / 8) * 8);
    await applyCanvasSize(width, height);
    toast(`画幅已按底图调成 ${width}×${height}`);
  } else {
    toast(`底图：${file.name}（${image.naturalWidth}×${image.naturalHeight}）`);
  }
  laySheetSize();
  renderLayBoxes();
  renderLayInfo();
}

/** 画幅改动落到设置，并告诉侧栏把输入框也改过来。 */
async function applyCanvasSize(width, height) {
  const defaults = { ...(latest?.settings?.defaults ?? {}), width, height };
  try {
    await post("/settings", { defaults });
    if (latest?.settings?.defaults) {
      latest.settings.defaults.width = width;
      latest.settings.defaults.height = height;
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
  layChannel?.postMessage({ type: "layout-size", width, height });
  laySheetSize();
  renderLayBoxes();
  renderLayInfo();
}


/** 拖到画布上也进布局：这是“导入底图”的第二条路。 */
function canvasHasFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

nodes.canvas.addEventListener("dragover", (event) => {
  if (!canvasHasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  nodes.canvas.classList.add("dropping");
});
nodes.canvas.addEventListener("dragleave", (event) => {
  if (event.relatedTarget && nodes.canvas.contains(event.relatedTarget)) return;
  nodes.canvas.classList.remove("dropping");
});
nodes.canvas.addEventListener("drop", async (event) => {
  if (!canvasHasFiles(event)) return;
  event.preventDefault();
  nodes.canvas.classList.remove("dropping");
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!String(file.type).startsWith("image/")) {
    toast("拖进来的不是图片");
    return;
  }
  showView("canvas");
  if (!lay.open) openLayout();
  try {
    await setUnderlay(file);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
});

nodes.canvasLayout.addEventListener("click", () => {
  showView("canvas");
  openLayout();
  // 没底图时直接把选图框拉起来：少点一步。
  if (!lay.underlay) nodes.layFile.click();
});
nodes.layImport.addEventListener("click", () => nodes.layFile.click());
nodes.layFile.addEventListener("change", async () => {
  const file = nodes.layFile.files?.[0];
  nodes.layFile.value = "";
  if (!file) return;
  try {
    await setUnderlay(file);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
});
nodes.layClear.addEventListener("click", () => {
  lay.boxes = [];
  lay.selected = null;
  renderLayBoxes();
  renderLayInfo();
  toast("框已清空");
});
nodes.layClose.addEventListener("click", closeLayout);
nodes.layRemove.addEventListener("click", () => removeLayBox(lay.selected));

nodes.layLabel.addEventListener("input", () => {
  const item = lay.boxes.find((entry) => entry.id === lay.selected);
  if (!item) return;
  item.label = nodes.layLabel.value;
  renderLayBoxes();
});
nodes.layCaption.addEventListener("input", () => {
  const item = lay.boxes.find((entry) => entry.id === lay.selected);
  if (!item) return;
  item.caption = nodes.layCaption.value;
  renderLayBoxes();
});
nodes.layText.addEventListener("input", () => {
  const item = lay.boxes.find((entry) => entry.id === lay.selected);
  if (!item) return;
  item.text = nodes.layText.value;
  renderLayBoxes();
});

nodes.laySheet.addEventListener("pointerdown", onLayPointerDown);
nodes.laySheet.addEventListener("pointermove", onLayPointerMove);
nodes.laySheet.addEventListener("pointerup", onLayPointerUp);
nodes.laySheet.addEventListener("pointercancel", onLayPointerUp);

document.addEventListener("keydown", (event) => {
  if (!lay.open) return;
  const tag = event.target?.tagName ?? "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeLayout();
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && lay.selected) {
    event.preventDefault();
    removeLayBox(lay.selected);
  }
});

window.addEventListener("resize", () => {
  if (lay.open) laySheetSize();
});

// 表单显隐、窗口缩放、字体变化都会改 stage 高度：跟着重算画布尺寸，免得出滚动条。
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    if (lay.open) laySheetSize();
  }).observe(nodes.layStage);
}

/** 侧栏点「去画布框选」时把这一层打开。 */
const layChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;
layChannel?.addEventListener("message", (event) => {
  const msg = event.data ?? {};
  if (msg.type !== "layout-open") return;
  showView("canvas");
  const target = Number.isFinite(msg.index) ? lay.boxes[msg.index]?.id : undefined;
  openLayout(target);
  if (!lay.underlay) nodes.layFile.click();
  else if (target) nodes.layCaption.focus();
});

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
  // 分母要跟分子同一个口径。分子 visible 里除了成图，还包括正在跑的那一条；
  // 分母只数 doneTotal 就会算出 49 / 48。
  const doneCount = data.doneTotal ?? galleryTotal ?? 0;
  const total = Math.max(visible.length, doneCount + live.length);
  nodes.galleryCount.textContent = total ? `${visible.length} / ${total} 张` : "";
  nodes.tabCount.textContent = total ? ` ${total}` : "";
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
        // 非缺省的采样面才打标：缺省的 euler + moss 不占地方的标签。
        const badges = [];
        if (job.sampler && job.sampler !== "euler") badges.push(job.sampler);
        if (job.scheduler && job.scheduler !== "moss") badges.push(job.scheduler);
        if (job.stepCache && job.stepCache !== "off") badges.push("加速");
        if (Array.isArray(job.loras) && job.loras.length) badges.push(`LoRA ${job.loras.length}`);
        if (job.hasMask) badges.push("重绘");
        else if (job.hasInitImage) badges.push("图生图");
        if (badges.length) {
          const wrap = document.createElement("div");
          wrap.className = "thumb-badges";
          for (const text of badges.slice(0, 3)) {
            const badge = document.createElement("i");
            badge.className = "thumb-badge";
            badge.textContent = text;
            wrap.appendChild(badge);
          }
          tile.appendChild(wrap);
        }
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
    } else if (job.status === "queued") {
      tile.classList.add("placeholder");
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      const text = document.createElement("span");
      text.textContent = "排队中";
      tile.append(spinner, text);
    } else {
      // 采样卡。结构先搭好，图等 previewAt 到了再填：preview 事件比步进稀疏，
      // 按 previewAt 决定要不要建这块，会让整张卡在两个形状之间来回跳。
      tile.classList.add("sampling");
      const active = data.engine.active;
      const progress = data.progress?.[job.id] ?? active?.progress ?? null;
      const view = { ...job, progress };
      const preview = document.createElement("img");
      preview.className = "preview-thumb";
      preview.alt = "采样中";
      // 还没收到第一帧预览时 src 为空，height: auto 会把这一格塔成一条缝。
      // 用提交时的宽高先把地方占住。
      if (job.width && job.height) preview.style.aspectRatio = `${job.width} / ${job.height}`;
      if (active && active.jobId === job.id && active.previewAt) {
        preview.src = previewUrl(active.previewAt);
      }
      tile.appendChild(preview);
      const tag = document.createElement("div");
      tag.className = "thumb-meta";
      tag.textContent = samplingText(view);
      tile.appendChild(tag);
      // 底边一条细进度，一眼看出这是半成品、走到哪一步了。
      const bar = document.createElement("i");
      bar.className = "thumb-progress";
      bar.style.width = `${Math.max(2, Math.min(100, progress?.percent ?? 0))}%`;
      tile.appendChild(bar);
    }
    // 右键菜单：看大图、用这张的参数、删除。失败的记录也走这里。
    tile.addEventListener("contextmenu", (event) => openMenu(event, job));
    entries.push({ job, tile });
  }

  galleryEntries = entries;
  layoutGallery(entries);
}

// ── 行与确认 ───────────────────────────────────────────────────────────
/** 整行换成确认条。不复用原按钮：行会被重建，靠按钮状态记住「待确认」容易看错。 */
function askConfirm(row, { label, question, run, yesText }) {
  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const text = document.createElement("span");
  text.textContent = question ?? `${label}？`;
  const yes = document.createElement("button");
  yes.className = "btn small danger";
  yes.type = "button";
  yes.textContent = yesText ?? "确认卸载";
  yes.addEventListener("click", () => void run());
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
  yes.focus({ preventScroll: true });
}

function manageRow({ name, meta, on, dim, badges = [], detail, actions = [], detailActions = [], remove }) {
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
  // 标记与动作各占一个固定宽的槽：每行右侧对齐，不会因为有没有标记而一路平移。
  const statusBox = document.createElement("span");
  statusBox.className = "status";
  for (const badge of badges) {
    const tag = document.createElement("span");
    tag.className = "badge";
    tag.textContent = badge;
    statusBox.appendChild(tag);
  }
  row.append(statusBox);
  const actionsBox = document.createElement("span");
  actionsBox.className = "manage-actions";
  for (const action of actions) {
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => void action.run());
    actionsBox.appendChild(button);
  }
  for (const action of [...(detailActions ?? [])]) {
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => void action.run());
    actionsBox.appendChild(button);
  }
  if (remove) {
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = remove.label;
    button.addEventListener("click", () => askConfirm(row, remove));
    actionsBox.appendChild(button);
  }
  row.append(actionsBox);

  // 有明细的行可以点开：组件体积这类信息平时收着，需要时才展开。
  if (detail?.length) {
    row.classList.add("expandable");
    const box = document.createElement("div");
    box.className = "manage-detail";
    box.hidden = true;
    for (const item of detail ?? []) {
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

/** 行尾附图动作（下载 / 使用）也放进同一个槽，否则列宽会跳到行外。 */
function appendAction(row, button) {
  const box = row.querySelector?.(".manage-actions");
  (box ?? row).appendChild(button);
}

const runSafe = async (fn, label) => {
  try {
    const next = await fn();
    if (next) render(next);
  } catch (error) {
    void toast(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
  }
};

/** 校验结果只读不重下：结果一句话就够。 */
const runVerify = async (path, body, label) => {
  try {
    const next = await post(path, body ?? {});
    const verify = next?.verify;
    if (!verify) throw new Error(next?.error ?? "没有结果");
    if (verify.ok) void toast(`${label}：校验通过`);
    else if (verify.reason) void toast(`${label}：${verify.reason}`);
    else void toast(`${label}：${verify.bad?.length ?? 0} 个文件不一致`);
  } catch (error) {
    void toast(`${label}校验失败：${error instanceof Error ? error.message : String(error)}`);
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
function queueCard({ title, meta, percent, thumb, glyph, on, stateText, actions = [] }) {
  const card = document.createElement("div");
  card.className = on ? "queue-card on" : "queue-card";
  const box = document.createElement("div");
  box.className = "qc-thumb";
  if (thumb) {
    const img = document.createElement("img");
    img.src = thumb;
    img.alt = "";
    box.appendChild(img);
  } else if (glyph) {
    // 下载任务没有图，但也不该留一个空灰块。给一个字符标记。
    box.textContent = glyph;
    box.classList.add("glyph");
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
    // 百分比跟着进度条走，不放在标题那一行。它在 head 行时与条分属两行，
    // 右端看着就是两处边界；放在同一个 flex 行里，数字和条一起收右。
    const barRow = document.createElement("div");
    barRow.className = "qc-bar-row";
    const bar = document.createElement("div");
    bar.className = "qc-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
    bar.appendChild(fill);
    const pct = document.createElement("span");
    pct.className = "qc-pct";
    pct.textContent = `${Math.round(percent)}%`;
    barRow.append(bar, pct);
    main.appendChild(barRow);
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
        stateText: typeof percent === "number" ? null : "正在跑",
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
  const downloading = downloadRows(data.installs ?? []);
  const downloadBusy = (data.installs ?? []).some((item) => !item.finishedAt);

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
  const badge = total + downloading.length;
  nodes.tabQueue.textContent = badge ? ` ${badge}` : "";
}

// ── 版本 ───────────────────────────────────────────────────────────────
/** 发起一次下载。文件全部交给 aria2，多个仓库同时下就是各自跑各自的。 */
async function startInstall(path, body, label) {
  try {
    const result = await post(path, body);
    if (result?.error) {
      void toast(`${label}没开始：${result.error}`);
      return;
    }
    void toast(`开始${label}`);
  } catch (error) {
    void toast(`${label}没开始：${error.message ?? error}`);
  }
}

let versionsKey = "";
function renderVersions(data) {
  const { engine } = data;
  // 数据没变就别重建：每帧 replaceChildren 会把点击中的按钮换掉，交互会发抖。
  const key = JSON.stringify({ engine, engines: data.engines, models: data.models, gpu: data.gpu, config: data.configPack });
  if (key === versionsKey) return;
  versionsKey = key;

  // 自管清单：配置与分词器是单独一条，不依附哪个整包。
  // 单独包一层：这个行就算画不出来，也不能把下面的模型表一起拖死。
  try {
    renderConfigPack(data);
  } catch {
    /* 缺件时宁可少一行 */
  }

  nodes.engineState.textContent = engine.running
    ? engine.loaded
      ? "运行中 · 模型已加载"
      : "运行中"
    : engine.serverFound
      ? "空闲（出图时自动启动）"
      : "未安装";
  // 不需要手动启动：出图会自己拉起。只留一个「停止」给想立刻腾显存的人。
  nodes.engineToggle.hidden = false;
  nodes.engineToggle.textContent = engine.running ? "停止引擎" : "启动引擎";
  nodes.engineToggle.disabled = false;
  nodes.engineRelease.hidden = !(engine.running && engine.loaded && !engine.active);
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
            badges: [
              item.cuda ?? null,
              item.variant === "system-cuda" ? "系统" : "自带",
              item.current ? "当前" : null,
            ].filter(Boolean),
            meta: formatSize(item.bytes),
            detail: [
              { label: "变体", value: item.variant === "system-cuda" ? "system-cuda" : "bundled" },
              { label: "CUDA", value: item.cuda ?? "—" },
            ],
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

  // 模型：一张表列完整仓库。装了就看体积与当前状态，没装的直接下载——
  // 同一个仓库不再在「模型」和「全部仓库」各出现一次。
  const models = Array.isArray(data.models) ? data.models : [];
  const installedModelCount = models.filter((item) => item.installed).length;
  nodes.modelState.textContent = models.length ? `${installedModelCount}/${models.length} 已装` : "";
  nodes.modelList.replaceChildren(
    ...models.map((item) => {
      const row = manageRow({
        name: item.label,
        badges: [item.active ? "当前" : null, item.lite ? "轻量" : null].filter(Boolean),
        meta: item.installed
          ? item.lite
            ? `${formatSize(item.bytes)} · 只有配置与分词器，权重靠单文件`
            : formatSize(item.bytes)
          : [item.estimate ? `约 ${formatSize(item.estimate)}` : null, item.note].filter(Boolean).join(" · "),
        detail: item.components?.map((part) => ({ label: part.label, value: formatSize(part.bytes) })) ?? null,
        on: item.active,
        // 版本页只管增删：选哪个模型、用哪份 DiT 权重都在侧栏。
        actions: [],
        // 卸载与校验都直接摆行上：一行就这两个动作，没必要藏进展开。
        detailActions: item.installed
          ? item.lite
            ? [
                {
                  label: "校验",
                  run: () => runVerify("/config/verify", {}, item.label),
                },
                {
                  label: "补下完整权重",
                  run: () => startInstall("/install/weights", { variant: item.variant }, `下载 ${item.label}`),
                },
              ]
            : [
                {
                  label: "校验",
                  run: () =>
                    startInstall("/install/weights", { variant: item.variant }, `校验 ${item.label}`),
                },
              ]
          : [
              {
                label: "只下配置与分词器（约 258 MB）",
                run: () => startInstall("/install/config", { variant: item.variant }, `配置 ${item.label}`),
              },
            ],
        remove: item.installed
          ? {
              label: "卸载",
              question: `卸载 ${item.label}？（${formatSize(item.bytes)}）`,
              run: () =>
                runSafe(() => post("/models/remove", { confirm: true, variant: item.variant }), "卸载模型"),
            }
          : null,
      });
      if (!item.installed) {
        const button = document.createElement("button");
        button.className = "btn ghost small";
        button.type = "button";
        button.textContent = "下载";
        button.addEventListener("click", () =>
          startInstall("/install/weights", { variant: item.variant }, `下载 ${item.label}`),
        );
        appendAction(row, button);
      }
      return row;
    }),
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

async function taskAction(taskId, path, action) {
  const verb = action === "pause" ? "暂停" : action === "resume" ? "继续" : "移除";
  try {
    await post("/install/task", { taskId, path, action });
    void toast(`已${verb} ${path.split("/").pop()}`);
  } catch (error) {
    void toast(`${verb}失败：${error.message ?? error}`);
  }
}

// ── 下载 ───────────────────────────────────────────────────────────────
function renderDownload(data) {
  nodes.downloadEngine.disabled = false;

  // 单文件按用途分三组：适配器 / DiT / 文本编码器与 VAE。卸载也在行里，
  // 展开区里给（详情为空时只写一个卸载行），和模型那张表一致。
  const files = Array.isArray(data.files) ? data.files : [];
  const groups = [
    { roles: ["control", "lora"], list: nodes.downloadAdapters, state: nodes.filesAdapterState },
    { roles: ["dit"], list: nodes.downloadDits, state: nodes.filesDitState },
    { roles: ["text_encoder"], list: nodes.downloadEncoders, state: nodes.filesEncoderState },
  ];
  for (const group of groups) {
    const items = files.filter((item) => group.roles.includes(item.role));
    // 「替掉 bundle 里哪一份」是整组的事，写在组标题上，不在每行重复三遍。
    const bundle = items.find((item) => item.bundle)?.bundle ?? null;
    const mismatch = group.roles.includes("dit") ? data.tierMismatch : null;
    group.state.textContent = [
      items.length ? `${items.filter((item) => item.installed).length}/${items.length} 已装` : null,
      bundle ? `替代 bundle 里的 ${bundle.label}（${formatSize(bundle.bytes)}）` : null,
      mismatch ? `需要 ${mismatch.need} 档（当前 ${mismatch.current}）` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    group.list.replaceChildren(
      ...items.map((item) => {
        const row = manageRow({
          name: item.name,
          meta: formatSize(item.bytes),
          badges: item.active ? ["在用"] : [],
          on: item.active,
          // 版本页只管增删；装好就自动用上，用不用、怎么用在它自己的地方选。
          actions: [],
          detailActions: item.installed
            ? [{ label: "校验", run: () => runVerify("/files/verify", { id: item.id }, item.name) }]
            : [],
          remove: item.installed
            ? {
                label: "卸载",
                question: `卸载 ${item.name}？（${formatSize(item.bytes)}）`,
                run: () =>
                  runSafe(() => post("/files/remove", { id: item.id, confirm: true }), "卸载文件"),
              }
            : null,
        });
        row.title = item.note ?? "";
        if (!item.installed) {
          const button = document.createElement("button");
          button.className = "btn ghost small";
          button.type = "button";
          button.textContent = "下载";
          button.addEventListener("click", () => startInstall("/files/install", { id: item.id }, `下载 ${item.name}`));
          appendAction(row, button);
        }
        return row;
      }),
    );
  }
}

/** 配置与分词器：装了它就能用单文件权重，不必下 27 GB 的整包。 */
function renderConfigPack(data) {
  const pack = data?.configPack ?? { installed: false };
  const inUse = Boolean(pack.installed && data?.settings?.modelPath === pack.path);
  const row = manageRow({
    name: "配置、分词器与 VAE",
    meta: pack.installed ? "约 258 MB" : "约 258 MB · DiT 与文本编码器用单文件",
    badges: inUse ? ["在用"] : [],
    on: inUse,
    remove: pack.installed
      ? {
          label: "卸载",
          question: "卸载配置与分词器？（单文件权重不受影响）",
          run: () => runSafe(() => post("/config/remove", { confirm: true }), "卸载配置"),
        }
      : null,
    detailActions: pack.installed
      ? [{ label: "校验", run: () => runVerify("/config/verify", {}, "配置与分词器") }]
      : [],
  });
  if (!pack.installed) {
    const button = document.createElement("button");
    button.className = "btn ghost small";
    button.type = "button";
    button.textContent = "下载";
    button.addEventListener("click", () => runSafe(() => post("/config/install", {}), "下载配置与分词器"));
    appendAction(row, button);
  }
  nodes.configList.replaceChildren(row);
}

/**
 * 下载任务 → 队列行。和生图任务用同一套卡片，一个页面里就看完全部在跑的事。
 */
function downloadRows(installs) {
  const rows = [];
  for (const job of installs) {
    // 收尾后不再占队列：跑完了去版本页看，取消了就当没发生过，只有失败留一行说明。
    if (job.finishedAt && job.phase !== "error") continue;
    if (job.finishedAt) {
      rows.push(
        queueCard({
          title: job.label ?? "下载",
          glyph: "↓",
          stateText: "失败",
          meta: (job.error ?? "").slice(0, 80),
        }),
      );
      continue;
    }
    // 校验阶段不经过 aria2，tasks 里全是 complete。列二十条「已完成」占满整页，
    // 真正在干的事（读盘算 sha256）反而看不到。判据不写死 phase：没有活着的行就折叠。
    const alive = (job.tasks ?? []).filter(
      (task) => task.status === "active" || task.status === "waiting" || task.status === "paused",
    );
    if (!alive.length) {
      rows.push(
        queueCard({
          title: job.label ?? "下载",
          glyph: "↓",
          stateText: job.message || job.phase || "进行中",
          meta:
            job.phase === "verify" ? `${job.tasks.length} 个文件校验中` : `${job.tasks.length} 个文件已就位`,
        }),
      );
      continue;
    }
    for (const file of alive) {
      const size = Number(file.size) || 0;
      const got = Number(file.got) || 0;
      const speed = Number(file.speed) || 0;
      const percent = size ? Math.min(100, (got / size) * 100) : 0;
      // completedLength 已经等于目标大小，要么在算 sha256，要么刚刚算完。
      // 这两种情况都不该显示一个「100%」——那是在说「已经好了」，但实际还没确认。
      const draining = Boolean(file.verifying) || (size > 0 && got >= size);
      const meta = draining
        ? formatSize(size)
        : [
            size ? `${formatSize(got)} / ${formatSize(size)}` : formatSize(got),
            speed > 0 ? `${formatSize(speed)}/s` : null,
            speed > 0 && size > got ? `剩 ${formatDuration(((size - got) / speed) * 1000)}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
      const stateText = file.status === "paused" ? "已暂停" : draining ? "校验" : null;
      // 每行自带 taskId：两个仓库的目录结构一样、文件名逐个对得上，
      // 只靠相对路径分不出该控制哪一条。
      const act = (action, label) => ({
        label,
        run: () => runSafe(() => post("/install/task", { taskId: job.id, path: file.path, action }), label),
      });
      const actions =
        file.status === "active"
          ? [act("pause", "暂停"), act("remove", "移除")]
          : file.status === "paused"
            ? [act("resume", "继续"), act("remove", "移除")]
            : [];
      rows.push(
        queueCard({
          title: file.path ?? file.out,
          glyph: "↓",
          stateText,
          meta,
          percent: draining ? undefined : percent,
          actions,
        }),
      );
    }
  }
  return rows;
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
  if (job.sampler) parts.push(job.scheduler ? `${job.sampler} + ${job.scheduler}` : job.sampler);
  if (job.shift != null && Number(job.shift) !== 5) parts.push(`shift ${job.shift}`);
  if (Array.isArray(job.loras) && job.loras.length) {
    const names = job.loras.map((item) => String(item.path ?? item.name ?? "").split(/[\\/]/).pop() || "LoRA");
    parts.push(names.length > 2 ? `${names.slice(0, 2).join("+")}+${names.length - 2}` : names.join("+"));
  }
  if (job.stepCache && job.stepCache !== "off") parts.push(job.stepCache);
  if (job.hasMask) parts.push("局部重绘");
  else if (job.hasInitImage) parts.push("图生图");
  if (job.elapsedMs) parts.push(formatDuration(job.elapsedMs));
  nodes.viewerInfo.textContent = parts.join(" · ");
  // 完整提示词放 title：这一行再塞下去就看不完了。
  nodes.viewerInfo.title = [job.prompt, job.negativePrompt ? `反向：${job.negativePrompt}` : ""].filter(Boolean).join("\n");
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
    // 图生图的入口就在这里：看到一张想接着改的图，直接送进侧栏当参考。
    items.push({ label: "以这张为参考", run: () => useAsReference(job) });
    // 编辑适配器（Moss-Image-Edit 一类）的入口：源图 + 指令。
    items.push({ label: "用这张做编辑参考", run: () => useAsEditReference(job) });
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
      sampler: job.sampler ?? null,
      scheduler: job.scheduler ?? null,
      shift: job.shift ?? null,
      stepCache: job.stepCache ?? "off",
      loras: Array.isArray(job.loras) ? job.loras : [],
    },
  });
  void refresh();
}

/** 以这张为参考：侧栏把文件读成位图，按当前目标尺寸裁好后当 init_image。 */
function useAsReference(job) {
  if (!job?.output) return;
  channel?.postMessage({ type: "reference", name: job.output });
  showView("canvas");
}

/** 编辑参考：交给侧栏当 references 的第一张（需要编辑适配器在 LoRA 里）。 */
function useAsEditReference(job) {
  if (!job?.output) return;
  channel?.postMessage({ type: "edit-reference", name: job.output });
  showView("canvas");
}

// ── 总渲染 ─────────────────────────────────────────────────────────────
function render(data) {
  latest = data;
  // 开跑就收起布局层：让预览和结果露出来，框数据留着。
  if (data.engine?.active && lay.open) {
    lay.open = false;
    nodes.lay.hidden = true;
    lay.drag = null;
    nodes.layDraft.hidden = true;
  }
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
  // 不能因为没 previewAt 就整个退出：阶段切换（文本编码 → 去噪）不发生 preview
  // 事件，但步数与百分比已经变了。那样画廊那张卡的进度就停在上一帧，
  // 而队列里的同一条还在走。
  if (!active) return;
  const tile = nodes.thumbs.querySelector(`[data-job-id="${active.jobId}"]`);
  if (!tile) return;
  const image = tile.querySelector(".preview-thumb");
  if (image && active.previewAt) {
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
  // 引擎没起来时这个按钮就该是「启动」：之前它只会停，用户只能靠出图把引擎拉起来。
  const running = Boolean(latest?.engine?.running);
  void runSafe(() => post(running ? "/engine/stop" : "/engine/start"), running ? "停止" : "启动");
});
nodes.engineRelease.addEventListener("click", () => {
  nodes.engineRelease.disabled = true;
  void runSafe(() => post("/engine/release", {}, 180000), "释放显存").finally(() => {
    nodes.engineRelease.disabled = false;
  });
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
      // 设置变了：直接把新设置转给侧栏（同一源广播），不靠它自己比对。
      if (name === "settings") {
        if (!payload?.settings) return;
        latest.settings = payload.settings;
        if (payload.rev != null) latest.settingsRev = payload.rev;
        channel?.postMessage({ type: "settings", settings: payload.settings });
        broadcastState(latest);
        return;
      }
      // 进度与下载都走小帧，不再为每一步重推整份 state。
      if (name === "progress") {
        const active = latest.engine?.active;
        if (!active || active.jobId !== payload.jobId) return;
        active.progress = payload.progress ?? active.progress;
        if (payload.phase) active.phase = payload.phase;
        // 队列卡读的是 state.progress[jobId]，画廊那格读 engine.active。
        // 两处数据源不同，只更新一处就会一个走一个停。
        if (payload.progress) {
          latest.progress = latest.progress ?? {};
          latest.progress[payload.jobId] = payload.progress;
        }
        renderStage(latest);
        renderQueue(latest);
        updateGalleryPreview(latest);
        broadcastState(latest);
        return;
      }
      if (name === "transfer") {
        latest.installs = payload.installs ?? latest.installs;
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
