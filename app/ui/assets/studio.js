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
  resultBar: el("result-bar"),
  canvasEmpty: el("canvas-empty"),
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
  layBase: el("lay-base"),
  layClear: el("lay-clear"),
  layClose: el("lay-close"),
  layFile: el("lay-file"),
  base: el("base"),
  baseInfo: el("base-info"),
  baseStage: el("base-stage"),
  baseFrame: el("base-frame"),
  baseImage: el("base-image"),
  baseMask: el("base-mask"),
  baseBrush: el("base-brush"),
  baseBrushValue: el("base-brush-value"),
  baseBrushField: el("base-brush-field"),
  basePaint: el("base-paint"),
  baseErase: el("base-erase"),
  baseMaskClear: el("base-mask-clear"),
  baseMaskSave: el("base-mask-save"),
  baseLayout: el("base-layout"),
  baseClose: el("base-close"),
  canvasDropHint: el("canvas-drop-hint"),
  galleryCount: el("gallery-count"),
  thumbs: el("thumbs"),
  ctxMenu: el("ctx-menu"),
  viewer: el("viewer"),
  viewerStage: el("viewer-stage"),
  viewerImage: el("viewer-image"),
  viewerIndex: el("viewer-index"),
  viewerInfo: el("viewer-info"),
  viewerEdit: el("viewer-edit"),
  viewerRef: el("viewer-ref"),
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

const views = ["chat", "gallery", "queue", "versions"];
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
/** 上一次的布局跟着底图恢复，不跟着页面加载恢复。 */
let layoutRestored = false;

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
 * 不经过自己的 /toast 路由：那条路上 sdk.ui 属于 UI 侧能力，服务端手里未必
 * 是同一个通道。
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
// 输入框上方那块画布：同一份 DOM，不复制第二套。
const DOCK_KEY = "moss-studio.canvas-dock";
let dockOpen = false;

function setDock(open) {
  const canvasEl = document.getElementById("canvas");
  const dockEl = document.getElementById("chat-dock");
  const dockBody = document.getElementById("chat-dock-body");
  const canvasHost = document.getElementById("view-canvas");
  if (!canvasEl || !dockEl || !dockBody || !canvasHost) return;
  dockOpen = Boolean(open);
  try {
    localStorage.setItem(DOCK_KEY, dockOpen ? "1" : "0");
  } catch {
    /* 存不了就每次默认展开 */
  }
  if (dockOpen) {
    if (currentView !== "chat") showView("chat");
    canvasHost.hidden = true;
    dockBody.append(canvasEl);
    dockEl.hidden = false;
  } else {
    dockEl.hidden = true;
    canvasHost.append(canvasEl);
    // 收起就回到常规高度，不留一个“下次打开还是全屏”的意外。
    document.body.classList.remove("dock-full");
    document.getElementById("chat-dock-full")?.classList.remove("on");
  }
  document.getElementById("dock-toggle")?.classList.toggle("on", dockOpen);
  // 画布改了高度，会话区跟着变：重排一次，滚到底的仍在底部。
  if (currentView === "chat") renderChat();
  // 画布按容器尺寸排布，换了父节点要让它重新量一次。
  requestAnimationFrame(() => window.dispatchEvent(new window.Event("resize")));
}

// 侧栏开新会话时会留一个 fresh-at 记号，这边只跟着它清空，
// 不自己猜，避免侧栏还停在旧段、这边已经空了。
try {
  const freshAt = Number(localStorage.getItem("hana-moss-studio.fresh-at") ?? 0);
  const seenAt = Number(localStorage.getItem("hana-moss-studio.seen-fresh-at") ?? 0);
  if (freshAt && freshAt !== seenAt) {
    convStartMs = freshAt;
    localStorage.setItem("hana-moss-studio.seen-fresh-at", String(freshAt));
  }
} catch {
  /* 存不了就按旧的来 */
}

document.getElementById("dock-toggle")?.addEventListener("click", () => setDock(!dockOpen));
document.getElementById("chat-dock-full")?.addEventListener("click", () => {
  const on = !document.body.classList.contains("dock-full");
  document.body.classList.toggle("dock-full", on);
  const fullBtn = document.getElementById("chat-dock-full");
  fullBtn?.classList.toggle("on", on);
  if (fullBtn) fullBtn.title = on ? "退出全屏" : "全屏画布";
  requestAnimationFrame(() => window.dispatchEvent(new window.Event("resize")));
});
document.getElementById("chat-dock-close")?.addEventListener("click", () => setDock(false));

// 开局收着：有底图时输入框上方会出现「画布 · 改这张」。
requestAnimationFrame(() => {
  if (localStorage.getItem(DOCK_KEY) === "1") setDock(true);
});

function showView(view) {
  if (!views.includes(view)) return;
  // 画布只有一个：切到画布页时，先把嵌在会话里的那块还回去。
  if (view !== "chat" && dockOpen) setDock(false);
  currentView = view;
  for (const tab of nodes.tabs.querySelectorAll(".studio-tab")) {
    tab.classList.toggle("on", tab.dataset.view === view);
  }
  for (const name of views) {
    const section = el(`view-${name}`);
    if (section) section.hidden = name !== view;
  }
  if (view === "versions") void loadReleases();
  if (view === "chat" && !galleryJobs.length) void loadGallery(true);
  if (view === "chat") renderChat();
  if (view === "gallery" && !galleryJobs.length) void loadGallery(true);
  // 画廊在隐藏状态下 clientWidth 是 0，首次算出来的列数偏少；显出来后重排一次。
  if (view === "gallery" && galleryEntries.length) {
    requestAnimationFrame(() => layoutGallery(galleryEntries));
  }
}

// ── 画布 ───────────────────────────────────────────────────────────────
let chatFilter = null;
let convStartMs = 0;
// 刚提交、服务端还没回来的那一条：先在会话里立住，不让界面空等。
let localPending = null;
// 会话 id 以侧栏为准：两个 surface 的存储不保证互通。
let currentConv = null;
// 首次渲染一定贴底；之后跟着用户是否停在底部走。
let chatAtBottom = true;
let chatBootstrapped = false;
// 从侧栏点开那一段的完整记录：主界面只拉了第一页，靠前的老图不在里面。
let convScopeJobs = null;

// 往远处看是页签的事：会话页只管当前这一段。

/** 参数一行。老图没存下参数的，直说没记录，不摆一串 undefined。 */
function paramLine(job) {
  const bits = [];
  if (job.width && job.height) bits.push(`${job.width}×${job.height}`);
  if (job.steps) bits.push(`${job.steps} 步`);
  if (job.cfg !== null && job.cfg !== undefined) bits.push(`CFG ${job.cfg}`);
  if (job.sampler) bits.push(job.sampler);
  return bits.join(" · ");
}

/** 会话页默认看的那一段：当前会话 id 名下的图；还没出图时退回最近一段。 */
function currentConvJobs() {
  let conv = null;
  try {
    conv = localStorage.getItem("hana-moss-studio.conv-id");
  } catch {
    conv = null;
  }
  // 有会话 id 就只认这一段的图：新会话是空的就是空的，
  // 不能顺手拿最近一段来填，否则侧栏说空、这边却有内容。
  if (conv) return galleryJobs.filter((job) => job.origin?.conv === conv);
  return galleryJobs.slice(0, 1);
}

function renderChat() {
  const log = document.getElementById("chat-log");
  if (!log) return;
  // 滚的是整个会话视图，不是消息列表本身。
  const scroller = document.getElementById("view-chat") ?? log;
  const source = chatFilter
    ? (convScopeJobs ?? galleryJobs.filter((job) => chatFilter.has(job.id)))
    : currentConvJobs();
  const scoped = convStartMs
    ? source.filter((job) => (Date.parse(job.createdAt ?? "") || 0) >= convStartMs)
    : source;
  // 列表已倒排，这里保持「最新在前」：DOM 第一项就贴在底部。
  const jobs = scoped.filter((job) => job.status === "done" && job.output);
  // 状态没变就不重建：轮询每三秒来一次，整体重绘会让图片重新加载、滚动跳动。
  const liveJob = localPending ?? liveChatJob();
  const sig = JSON.stringify({
    ids: jobs.map((job) => job.id),
    // 刚提交的那条还没有结果，只有它进了签名，占位才会立刻出现。
    live: liveJob
      ? `${liveJob.id}:${liveJob.status}:${latest?.engine?.active?.progress?.step ?? 0}/${latest?.engine?.active?.progress?.total ?? 0}:${latest?.engine?.active?.previewAt ?? ""}`
      : null,
    filter: chatFilter ? [...chatFilter] : null,
    scope: convScopeJobs ? convScopeJobs.length : null,
    start: convStartMs,
  });
  if (sig === renderChat.lastSig) return;
  renderChat.lastSig = sig;
  if (!jobs.length && !liveJob) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = "这一段还没有图。在下面写一句，出图会排在这里。";
    log.replaceChildren(empty);
    return;
  }
  const rows = [];
  // 用户本来在底部才跟着滚；否则留着位置，别把人正在看的地方抽走。
  if (!log.dataset.stickBound) {
    log.dataset.stickBound = "1";
    // 滚的是整个会话视图：监听也得挂在它身上，挂在列表上永远收不到事件。
    scroller.addEventListener("scroll", () => {
      chatAtBottom = scroller.scrollTop <= 8;
    });
  }
  const stick = !chatBootstrapped || chatAtBottom;
  for (const job of jobs) {
    const userRow = document.createElement("div");
    userRow.className = "chat-row user";
    userRow.append(buildUserBubble(job));

    const botRow = document.createElement("div");
    botRow.className = "chat-row bot";
    botRow.dataset.jobId = job.id;
    const shot = document.createElement("div");
    shot.className = "chat-shot";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = (job.prompt ?? "").slice(0, 40);
    // 宽高交给属性：浏览器按比例预留空间，不用等图加载也不顶位。
    if (job.width && job.height) {
      img.width = job.width;
      img.height = job.height;
    }
    const url = loadThumb(job.output, 420);
    if (url) img.src = url;
    img.addEventListener("click", () => openViewer(job.id));
    const acts = document.createElement("div");
    acts.className = "chat-acts";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "chat-act";
    again.textContent = "再生成";
    again.title = "用这条的参数再来一张";
    again.addEventListener("click", () => layChannel?.postMessage({ type: "reuse", job }));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "chat-act";    edit.textContent = "改这张";
    edit.title = "当底图，去画布抹一块重画";
    edit.addEventListener("click", () => useAsReference(job));
    const split = document.createElement("button");
    split.type = "button";
    split.className = "chat-act";
    split.textContent = "拆出";
    split.title = "把这一张拆成独立的会话";
    split.addEventListener("click", () => layChannel?.postMessage({ type: "split-job", id: job.id }));
    acts.append(again, edit, split);
    // 图没到之前先立一块骨架，占住同样的位置并转一个加载圈。
    const frame = document.createElement("div");
    frame.className = "chat-shot-frame";
    // 高度一次算定：加载前后同尺寸，往回翻历史时不会因为补图而抖。
    if (job.width && job.height) {
      const scale = Math.min(540 / job.width, 340 / job.height, 1);
      frame.style.width = `${Math.round(job.width * scale)}px`;
      frame.style.height = `${Math.round(job.height * scale)}px`;
    }
    const skeleton = document.createElement("div");
    skeleton.className = "chat-skeleton";
    frame.append(skeleton, img);
    img.addEventListener("load", () => frame.classList.add("loaded"));
    img.addEventListener("error", () => frame.classList.add("loaded"));
    shot.append(frame, acts);
    botRow.append(shot);
    // 一轮是一个整体：块之间倒排，块内仍是「我说话 → 它回图」。
    const turn = document.createElement("div");
    turn.className = "chat-turn";
    turn.append(userRow, botRow);
    rows.push(turn);
  }
  // 正在跑的那一条也挂在末尾：人在会话页等图，不该什么也看不到。
  const live = liveChatJob();
  // 从侧栏点开的是历史段，别把当前会话正在跑的占位塞进去。
  if (live && !convScopeJobs) rows.push(...pendingRows(live));
  // 看历史时以视口里最上面那条为锚：重建后用同一个锚点对位，位置不动。
  const anchorRow = chatAtBottom ? null : Array.from(log.querySelectorAll(".chat-row")).find((el) => el.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 4);
  const anchorId = anchorRow?.dataset.jobId ?? null;
  const anchorOffset = anchorRow ? anchorRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0;
  log.replaceChildren(...rows);
  if (!stick && anchorId) {
    const again = log.querySelector(`.chat-row[data-job-id="${anchorId}"]`);
    if (again) {
      // 倒排之下，scrollTop 越大越往上：元素下移多少，就把位置回退多少。
      scroller.scrollTop -= again.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchorOffset;
    }
  }
  if (stick) {
    // 图还没加载完时高度会变：先贴底，等两帧和图片解码后再贴一次。
    scroller.scrollTop = 0;
    requestAnimationFrame(() => {
      scroller.scrollTop = 0;
    });
    setTimeout(() => {
      scroller.scrollTop = 0;
      chatAtBottom = true;
    }, 120);
  }
  chatAtBottom = scroller.scrollTop <= 8;
  chatBootstrapped = true;
}

/** 队列里正在跑或排第一的那一条。 */
function liveChatJob() {
  const jobs = latest?.jobs ?? [];
  const hit = jobs.find((job) => job.status === "running") ?? jobs.find((job) => job.status === "queued");
  if (hit) return hit;
  // 引擎已经在跑、但记录还没进列表时，用它兜住这一条占位。
  const active = latest?.engine?.active;
  if (!active) return null;
  return {
    id: active.jobId ?? "live",
    status: "running",
    prompt: active.prompt ?? "",
    width: active.width,
    height: active.height,
    steps: active.steps,
  };
}

/** 生成中的那条：用户消息立刻出现，回复侧先立一块与成图同尺寸的占位。 */
function pendingRows(job) {
  const userRow = document.createElement("div");
  userRow.className = "chat-row user";
  userRow.append(buildUserBubble(job));

  const botRow = document.createElement("div");
  botRow.className = "chat-row bot";
  const box = document.createElement("div");
  box.className = "chat-pending";

  const width = job.width ?? latest?.settings?.width;
  const height = job.height ?? latest?.settings?.height;
  // 占位框按目标尺寸定比例：图从这一步开始在同一个位置长出来。
  const frame = document.createElement("div");
  frame.className = "chat-pending-frame";
  // 与成图用同一套上限：占位多大，图出来就多大。
  if (width && height) {
    const scale = Math.min(540 / width, 340 / height, 1);
    frame.style.width = `${Math.round(width * scale)}px`;
    frame.style.height = `${Math.round(height * scale)}px`;
  }

  const skeleton = document.createElement("div");
  skeleton.className = "chat-skeleton";
  const shot = document.createElement("img");
  shot.className = "chat-pending-img";
  shot.alt = "";
  frame.append(skeleton, shot);

  const previewAt = job.status === "running" ? latest?.engine?.active?.previewAt : null;
  if (previewAt) {
    shot.src = previewUrl(previewAt);
    frame.classList.add("loaded");
  }

  const progress = job.status === "running" ? (latest?.engine?.active?.progress ?? job.progress ?? {}) : {};
  const label = document.createElement("p");
  label.className = "chat-pending-label";
  label.textContent =
    job.status === "running"
      ? `${progress.phase ?? "生成中"}${progress.total ? ` ${progress.step ?? 0}/${progress.total}` : "…"}`
      : "排队中";

  box.append(frame, label);
  botRow.append(box);

  const turn = document.createElement("div");
  turn.className = "chat-turn";
  turn.append(userRow, botRow);
  return [turn];
}

/** 一条用户消息：summary 是提示词与分辨率，展开另开一层放参数。 */
function buildUserBubble(job) {
  const rows = [];
  if (job.steps) rows.push(["步数", String(job.steps)]);
  if (job.cfg) rows.push(["CFG", String(job.cfg)]);
  if (job.sampler) rows.push(["采样器", String(job.sampler)]);
  if (job.scheduler) rows.push(["调度器", String(job.scheduler)]);
  if (job.seed != null) rows.push(["种子", String(job.seed)]);
  if (job.engineTier) rows.push(["档位", String(job.engineTier)]);
  if (job.elapsedMs) rows.push(["耗时", `${(job.elapsedMs / 1000).toFixed(1)} 秒`]);
  const negative = String(job.negativePrompt ?? job.negative ?? "").trim();
  if (negative) rows.push(["反向", negative]);
  const origin = job.origin ?? {};
  if (origin.base) rows.push(["底图", String(origin.base)]);
  if (Array.isArray(origin.refs) && origin.refs.length) rows.push(["参考", origin.refs.join("、")]);

  const size = job.width && job.height ? `${job.width}×${job.height}` : "";
  const text = document.createElement("p");
  text.className = "chat-text";
  text.textContent = job.prompt || "（无提示词）";

  const sub = document.createElement("p");
  sub.className = "chat-sub";
  if (size) {
    const meta = document.createElement("span");
    meta.className = "chat-meta";
    meta.textContent = size;
    sub.append(meta);
  }

  // 没有额外信息就只是一块普通气泡。
  if (!rows.length) {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.append(text);
    if (size) bubble.append(sub);
    return bubble;
  }

  const arrow = document.createElement("span");
  arrow.className = "chat-arrow";
  arrow.setAttribute("aria-hidden", "true");
  const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chev.setAttribute("viewBox", "0 0 16 16");
  chev.setAttribute("width", "12");
  chev.setAttribute("height", "12");
  chev.setAttribute("fill", "none");
  chev.setAttribute("stroke", "currentColor");
  chev.setAttribute("stroke-width", "1.8");
  chev.setAttribute("stroke-linecap", "round");
  chev.setAttribute("stroke-linejoin", "round");
  const tip = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tip.setAttribute("d", "M6.2 3.8 10.4 8l-4.2 4.2");
  chev.append(tip);
  arrow.append(chev);
  // 箭头在分辨率那一行的行首：提示词顶格，尺寸让出箭头的位置。
  sub.prepend(arrow);

  const summary = document.createElement("summary");
  summary.className = "chat-summary";
  summary.title = "展开这次的全部参数";
  summary.append(text);
  if (size) summary.append(sub);

  const extra = document.createElement("div");
  extra.className = "chat-extra";
  for (const [key, value] of rows) {
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "v";
    v.textContent = value;
    extra.append(k, v);
  }

  const box = document.createElement("details");
  box.className = "chat-bubble chat-bubble-more";
  // 展开时底部锚定的列表会往上顶：把这部分高度补回滚动位置。
  box.addEventListener("toggle", () => {
    const scroller = document.getElementById("view-chat");
    if (!scroller || !box.open) return;
    const before = box.getBoundingClientRect().top;
    requestAnimationFrame(() => {
      scroller.scrollTop -= box.getBoundingClientRect().top - before;
    });
  });
  box.append(summary, extra);
  return box;
}

/** 采样预览直接刷进占位图：列表不重建也能看到画面在长。 */
function updateChatPreview() {
  const img = document.querySelector(".chat-pending-img");
  const active = latest?.engine?.active;
  if (!img || !active?.previewAt) return;
  const at = String(active.previewAt);
  if (img.dataset.at === at) return;
  img.dataset.at = at;
  img.src = previewUrl(at);
  img.parentElement?.classList.add("loaded");
}

function renderStage(data) {
  const { engine } = data;
  let dotClass = "dot";
  let label;
  if (!engine.serverFound) {
    dotClass = "dot err";
    label = "未找到 moss-server";
  } else if (!engine.running) {
    label = "空闲";
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
  // 协议版本对用户没有意义，留给日志；这里只说清楚引擎在不在、画过几张。
  const engineVersion = data.engine?.hello?.version ?? data.engines?.find((item) => item.current)?.version ?? "未安装";
  nodes.canvasMeta.textContent = `引擎 ${engineVersion} · ${data.jobTotal ?? data.jobs.length} 张`;
  nodes.canvasMeta.title = `协议 v${data.engine?.hello?.protocol_version ?? data.mossimage?.protocolVersion ?? "?"}`;
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

  // 改图台开着就由它占画布；生成中先让给采样预览。
  const showEdit = edit.open && !active;
  nodes.base.hidden = !showEdit;
  if (showEdit) {
    nodes.result.hidden = true;
    nodes.canvasEmpty.hidden = true;
    return;
  }

  // 生成中：画面交给采样预览，下面那行换成参数与实时用时（排队时间不算）。
  if (active) {
    nodes.canvasEmpty.hidden = true;
    nodes.result.hidden = false;
    // 采样预览不是成品，那排动作（另存、删除…）此刻碰不得。
    nodes.resultBar.hidden = true;
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
  nodes.resultBar.hidden = false;
  if (img.getAttribute("src") !== url) img.src = url;
  const seed = job.report?.seedUsed ?? job.seed;
  nodes.resultCaption.textContent = `${job.width}×${job.height} · ${job.steps} 步 · CFG ${job.cfg} · 种子 ${seed} · ${formatDuration(job.elapsedMs)}`;
  img.onclick = () => openViewer(job.id);
}

// 结果图底部那排动作：右键菜单里也有一份，这里让常用的那几个一眼就看到。
function resultJob() {
  const job = latest ? shownJob(latest) : null;
  return job && job.status === "done" && job.output ? job : null;
}

async function saveResult(job) {
  try {
    const anchor = document.createElement("a");
    anchor.href = outputUrl(job.output);
    anchor.download = job.output;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    toast(`已开始另存：${job.output}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "bad");
  }
}

nodes.resultBar.addEventListener("click", (event) => {
  const button = event.target.closest(".rb");
  if (!button) return;
  const job = resultJob();
  if (!job) return;
  const act = button.dataset.act;
  if (act === "base") useAsReference(job);
  else if (act === "ref") useAsEditReference(job);
  else if (act === "reuse") loadJob(job);
  else if (act === "view") openViewer(job.id);
  else if (act === "save") void saveResult(job);
  else if (act === "delete") void removeJob(job.id);
});

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
  /** 正在把比例拉回底图，避免改尺寸的回声再触发一次。 */
  fixing: false,
  seq: 0,
};

function layoutCanvasSize() {
  const defaults = latest?.settings?.defaults ?? {};
  return {
    width: Math.max(256, Math.round(Number(defaults.width) || 1024)),
    height: Math.max(256, Math.round(Number(defaults.height) || 1024)),
  };
}

/** 比例文字：常见的几种直接给名字，其余写成 x:1。 */
const RATIO_LABELS = [
  { value: 16 / 9, label: "16:9" },
  { value: 9 / 16, label: "9:16" },
  { value: 3 / 2, label: "3:2" },
  { value: 2 / 3, label: "2:3" },
  { value: 4 / 3, label: "4:3" },
  { value: 3 / 4, label: "3:4" },
  { value: 1, label: "1:1" },
];

function ratioText(width, height) {
  const ratio = width / Math.max(1, height);
  let best = null;
  for (const item of RATIO_LABELS) {
    const diff = Math.abs(item.value - ratio) / item.value;
    if (!best || diff < best.diff) best = { diff, label: item.label };
  }
  if (best && best.diff <= 0.02) return best.label;
  return `${ratio.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}:1`;
}

function renderLayInfo() {
  const size = layoutCanvasSize();
  const canvasRatio = ratioText(size.width, size.height);
  // 底图的实际分辨率是它自己的属性，不是画幅设定；比例只写一次。
  const under = lay.underlay ? ` · 底图 ${lay.underlay.width}×${lay.underlay.height}` : "";
  nodes.layInfo.textContent = `${canvasRatio} · ${lay.boxes.length} 个框${under}`;
  nodes.layInfo.removeAttribute("title");
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
    setLayLabel(item.label);
    nodes.layCaption.value = item.caption;
    nodes.layText.value = item.text;
  }
  const [x0, y0, x1, y1] = item.box;
  const size = layoutCanvasSize();
  nodes.laySize.textContent = `${Math.round(((x1 - x0) / size.width) * 100)}% × ${Math.round(((y1 - y0) / size.height) * 100)}%`;
}

function renderLayBoxes() {
  const size = layoutCanvasSize();
  const heightPx = nodes.laySheet.clientHeight;
  const list = lay.boxes.map((item, index) => {
    const [x0, y0, x1, y1] = item.box;
    const box = document.createElement("div");
    box.className = "lay-box" + (item.id === lay.selected ? " on" : "");
    box.dataset.id = item.id;
    box.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      startInlineLayEdit(box, item);
    });
    box.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      lay.selected = item.id;
      renderLayBoxes();
      openLayBoxMenu(event, item);
    });
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
  saveLayoutLocal();
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

/** 框上直接改字：双击就能写，Enter 落定，Esc 退出。 */
function startInlineLayEdit(box, item) {
  if (!box || box.querySelector(".lay-edit")) return;
  const area = document.createElement("textarea");
  area.className = "lay-edit";
  area.value = item.caption || item.text || "";
  area.placeholder = "这块画什么";
  box.appendChild(area);
  area.focus();
  area.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      item.caption = area.value.trim();
      lay.selected = item.id;
    }
    renderLayBoxes();
    renderLayInfo();
  };
  area.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  area.addEventListener("blur", () => finish(true));
  area.addEventListener("pointerdown", (event) => event.stopPropagation());
  area.addEventListener("dblclick", (event) => event.stopPropagation());
}

/** 复制一块：位置错开一点，方便成对摆。 */
function duplicateLayBox(id) {
  const source = lay.boxes.find((item) => item.id === id);
  if (!source) return;
  const [x0, y0, x1, y1] = source.box;
  const size = layoutCanvasSize();
  const shift = Math.round(Math.min(size.width, size.height) * 0.02);
  const box = [x0 + shift, y0 + shift, x1 + shift, y1 + shift].map((value, index) =>
    Math.max(0, Math.min(index % 2 === 0 ? size.width : size.height, value)),
  );
  lay.seq += 1;
  const copy = { id: `b${lay.seq}`, label: source.label, caption: source.caption, text: source.text, box };
  lay.boxes.push(copy);
  lay.selected = copy.id;
  renderLayBoxes();
  renderLayInfo();
}

function openLayBoxMenu(event, item) {
  showMenu(event, [
    {
      label: "改文字",
      run: () => {
        const box = nodes.layBoxes.querySelector(`.lay-box[data-id="${item.id}"]`);
        startInlineLayEdit(box, item);
      },
    },
    { label: "复制一块", run: () => duplicateLayBox(item.id) },
    {
      label: "清空文字",
      run: () => {
        item.caption = "";
        item.text = "";
        renderLayBoxes();
        renderLayInfo();
      },
    },
    { sep: true },
    { label: "删除这块", danger: true, run: () => removeLayBox(item.id) },
  ]);
}

const LAYOUT_KEY = "hana-moss-studio:layout";
/** 框归属于哪张底图：换图就该从零开始，同一张图回来框还在。 */
function layoutUnderlayKey(underlay) {
  if (!underlay) return "";
  return `${underlay.name}:${underlay.width}x${underlay.height}`;
}

/** 框存本地：刷新、重装不丢。存百分比，换画幅也不会偏；跟着底图走，不跟全局走。 */
function saveLayoutLocal() {
  try {
    const key = layoutUnderlayKey(lay.underlay);
    if (!key) {
      localStorage.removeItem(LAYOUT_KEY);
      return;
    }
    const size = layoutCanvasSize();
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        underlay: key,
        boxes: lay.boxes.map((item) => ({
          label: item.label,
          caption: item.caption,
          text: item.text,
          box: [
            item.box[0] / size.width,
            item.box[1] / size.height,
            item.box[2] / size.width,
            item.box[3] / size.height,
          ],
        })),
      }),
    );
  } catch {
    /* 存储不可用就算了，不阻碍画框 */
  }
}

/** 只恢复同一张底图的框；换了图就从空开始。 */
function restoreLayoutFor(underlay) {
  lay.boxes = [];
  lay.selected = null;
  lay.seq = 0;
  const key = layoutUnderlayKey(underlay);
  if (!key) return;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.boxes) || !data.boxes.length) return;
    if (data.underlay !== key) return;
    const size = layoutCanvasSize();
    lay.boxes = data.boxes.map((item) => {
      const box = Array.isArray(item.box) ? item.box.map(Number) : [0, 0, 0, 0];
      return {
        id: `lay-${++lay.seq}`,
        label: String(item.label ?? "object"),
        caption: String(item.caption ?? ""),
        text: String(item.text ?? ""),
        box: [box[0] * size.width, box[1] * size.height, box[2] * size.width, box[3] * size.height].map((value) => Math.round(value)),
      };
    });
    toast(`这张图上次的 ${lay.boxes.length} 个框已恢复`);
  } catch {
    /* 坏了当没有 */
  }
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
  // 画布只有一块：框选与改图台不共存，但底图与蒙版都留着。
  if (edit.open) closeEditSheet(true);
  lay.open = true;
  nodes.lay.hidden = false;
  nodes.laySheet.style.backgroundImage = lay.underlay ? `url(${lay.underlay.url})` : "";
  lay.selected = selectId ?? lay.boxes[0]?.id ?? null;
  lay.drag = null;
  laySheetSize();
  renderLayBoxes();
  renderLayInfo();
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

/** 底图就是图生图的源图（initImage）：能对齐构图，也会参与生成。比例不同就跟着改画幅。 */
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
  // 框跟着底图走：换图清空，同一张图回来再从本地接上。
  restoreLayoutFor(lay.underlay);
  // 底图就是图生图的源图（initImage）：传上去，让侧栏那张也跟着换成它。
  try {
    const uploaded = await api("/inputs/upload?kind=init", { method: "POST", body: file }, 60000);
    if (uploaded?.name) layChannel?.postMessage({ type: "layout-underlay", name: uploaded.name });
      // 提交时这条路径跟着 compose-send 一起过去，不再单独跟侧栏握手。
      edit.remotePath = uploaded?.path ?? null;
  } catch (error) {
    toast(`底图没传上去：${error instanceof Error ? error.message : String(error)}`, "error");
  }
  const resized = await alignCanvasToRatio(image.naturalWidth, image.naturalHeight);
  const size = layoutCanvasSize();
  if (resized) {
    toast(`画幅已按底图调成 ${ratioText(size.width, size.height)}`);
  } else {
    toast(`底图：${file.name}（${ratioText(image.naturalWidth, image.naturalHeight)}），已作为图生图底图`);
  }
  laySheetSize();
  renderLayBoxes();
  renderLayInfo();
}

/** 画幅比例往底图上靠：像素总量不变，只换比例。 */
async function alignCanvasToRatio(width, height) {
  const size = layoutCanvasSize();
  const ratio = width / Math.max(1, height);
  const canvasRatio = size.width / Math.max(1, size.height);
  if (Math.abs(ratio - canvasRatio) / canvasRatio <= 0.02) return false;
  // 保持像素总量不变，只换比例。
  const area = size.width * size.height;
  const w = Math.max(256, Math.round(Math.sqrt(area * ratio) / 8) * 8);
  const h = Math.max(256, Math.round(w / ratio / 8) * 8);
  await applyCanvasSize(w, h);
  return true;
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

/** 布局开着时把画幅比例锁在底图上：像素总量可以换，比例不能被改乱。 */
function pinLayoutRatio() {
  if (!lay.open || !lay.underlay || lay.fixing) return;
  const size = layoutCanvasSize();
  const ratio = size.width / Math.max(1, size.height);
  const underRatio = lay.underlay.width / Math.max(1, lay.underlay.height);
  if (Math.abs(ratio - underRatio) / underRatio <= 0.02) return;
  // 同一组尺寸只试一次：写设置失败时不要跟着每次状态刷新重试。
  const key = `${size.width}x${size.height}`;
  if (lay.pinnedFor === key) return;
  lay.pinnedFor = key;
  const area = size.width * size.height;
  const width = Math.max(256, Math.round(Math.sqrt(area * underRatio) / 8) * 8);
  const height = Math.max(256, Math.round(width / underRatio / 8) * 8);
  lay.fixing = true;
  void applyCanvasSize(width, height)
    .then(() => toast(`比例跟底图走，已调回 ${ratioText(width, height)}`))
    .finally(() => {
      lay.fixing = false;
    });
}


// ── 改图台（底图 + 蒙版，在主画布上）──────────────────────────────
// 底图就是 init_image，蒙版直接抹在它上面。上传与提交仍然归侧栏，
// 这边只负责显示与涂抹，存好的 PNG 通过广播交回去。
const edit = {
  open: false,
  url: null,
  /** 底图的原始 File：布局与改图台之间切来切去不用重选。 */
  file: null,
  name: "",
  width: 0,
  height: 0,
  /** 蒙版覆盖的百分比，只用于说明。 */
  share: 0,
  /** null：不画；paint / erase：当前笔。 */
  mode: null,
  /** 侧栏交回来的那张蒙版（已保存的那份）。 */
  maskBlob: null,
};
let maskDrawing = false;
let maskLastPoint = null;
let maskLoadToken = 0;
// 实色画，整层用 CSS 半透明：反复涂抹不会越涂越实。
const MASK_STROKE = "rgb(255, 96, 96)";

/** 蒙版画布的内部尺寸就是出图尺寸：与侧栏裁好的 init 图一一对应。 */
function baseCanvasSize() {
  return layoutCanvasSize();
}

function baseSheetSize() {
  if (!edit.open) return;
  const size = baseCanvasSize();
  const stage = nodes.baseStage;
  const ratio = size.width / Math.max(1, size.height);
  const fitWidth = Math.max(80, stage.clientWidth - 44);
  const fitHeight = Math.max(80, stage.clientHeight - 44);
  let width = fitWidth;
  let height = width / ratio;
  if (height > fitHeight) {
    height = fitHeight;
    width = height * ratio;
  }
  nodes.baseFrame.style.width = `${Math.round(width)}px`;
  nodes.baseFrame.style.height = `${Math.round(height)}px`;
}

/** 画幅变了就重设蒙版画布；返回是否真的换了尺寸（旧蒙版作废）。 */
function resetBaseMaskCanvas() {
  const size = baseCanvasSize();
  if (nodes.baseMask.width === size.width && nodes.baseMask.height === size.height) return false;
  nodes.baseMask.width = size.width;
  nodes.baseMask.height = size.height;
  edit.share = 0;
  return true;
}

function renderBaseBar() {
  const size = baseCanvasSize();
  const bits = [`${edit.width}×${edit.height}`, `目标 ${size.width}×${size.height}`];
  bits.push(edit.share ? `蒙版重画 ${edit.share}%` : edit.maskBlob ? "蒙版已保存" : "抹出要重画的地方，保存后在下面输入框发送");
  nodes.baseInfo.textContent = bits.join(" · ");
  const painting = edit.mode !== null;
  nodes.basePaint.classList.toggle("on", painting);
  nodes.basePaint.textContent = painting ? "完成" : "蒙版";
  nodes.basePaint.title = painting ? "结束涂抹，保留已画的部分" : "在底图上抹出要重画的地方";
  nodes.baseErase.hidden = !painting;
  nodes.baseErase.classList.toggle("on", edit.mode === "erase");
  nodes.baseBrushField.hidden = !painting;
  nodes.baseMaskClear.hidden = !painting;
  nodes.baseMaskSave.hidden = !painting;
  nodes.baseMask.classList.toggle("painting", painting);
}

// 笔刷大小写出来：滑杆上的圆点看不出具体多少像素。
nodes.baseBrush.addEventListener("input", () => {
  nodes.baseBrushValue.textContent = nodes.baseBrush.value;
});

/** 已保存的蒙版是黑白图：直接叠上去看不清，按亮度换成红色半透明。 */
function paintMaskOverlay(image) {
  const canvas = nodes.baseMask;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) return;
  const scratch = document.createElement("canvas");
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const sctx = scratch.getContext("2d");
  sctx.drawImage(image, 0, 0, scratch.width, scratch.height);
  const frame = sctx.getImageData(0, 0, scratch.width, scratch.height);
  const data = frame.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] <= 8) {
      data[i + 3] = 0;
      continue;
    }
    data[i] = 255;
    data[i + 1] = 96;
    data[i + 2] = 96;
    data[i + 3] = 140;
  }
  sctx.putImageData(frame, 0, 0);
  ctx.drawImage(scratch, 0, 0);
}

async function showMaskBlob(blob) {
  const token = ++maskLoadToken;
  const canvas = nodes.baseMask;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!blob) return;
  try {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("蒙版读不出来"));
      image.src = url;
    });
    URL.revokeObjectURL(url);
    // 加载是异步的：期间画幅又换了就不要回填旧蒙版。
    if (token !== maskLoadToken) return;
    paintMaskOverlay(image);
  } catch {
    /* 旧蒙版读不出就当没有 */
  }
}

/** 底图落进改图台：同一张图交给侧栏当 init_image，不重复上传两次。 */
async function openEditSheet(file) {
  let url = null;
  try {
    url = URL.createObjectURL(file);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("这张图读不出来"));
      image.src = url;
    });
    if (edit.url) URL.revokeObjectURL(edit.url);
    edit.url = url;
    edit.name = file.name || "底图";
    // 留着这份 File：从布局切回「抹蒙版」时不用再选一次图。
    edit.file = file;
    edit.width = image.naturalWidth;
    edit.height = image.naturalHeight;
    edit.share = 0;
    edit.mode = null;
    edit.maskBlob = null;
    try {
      const uploaded = await api("/inputs/upload?kind=init", { method: "POST", body: file }, 60000);
      if (uploaded?.name) layChannel?.postMessage({ type: "layout-underlay", name: uploaded.name });
      // 提交时这条路径跟着 compose-send 一起过去，不再单独跟侧栏握手。
      edit.remotePath = uploaded?.path ?? null;
    } catch (error) {
      toast(`底图没传上去：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    // 布局那边也用这张：两条路共一个底图，不各传一份。
    lay.underlay = { url, name: file.name, width: edit.width, height: edit.height };
    restoreLayoutFor(lay.underlay);
    closeLayout();
    edit.open = true;
    nodes.base.hidden = false;
    nodes.baseImage.src = url;
    resetBaseMaskCanvas();
    baseSheetSize();
    renderBaseBar();
    void renderCanvas(latest);
    const resized = await alignCanvasToRatio(edit.width, edit.height);
    resetBaseMaskCanvas();
    baseSheetSize();
    renderBaseBar();
    const size = baseCanvasSize();
    toast(
      resized
        ? `画幅已按底图调成 ${ratioText(size.width, size.height)}，抹出要重画的地方`
        : `${edit.name}：底图已就位，抹出要重画的地方`,
    );
  } catch (error) {
    if (url && url !== edit.url) URL.revokeObjectURL(url);
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

function closeEditSheet(keepBase = false) {
  edit.open = false;
  edit.mode = null;
  // 关掉就不再带底图：下一次发送回到纯文生图。切去框选时底图还留着。
  if (!keepBase) edit.remotePath = null;
  maskDrawing = false;
  maskLastPoint = null;
  nodes.base.hidden = true;
  renderBaseBar();
  void renderCanvas(latest);
}

/** 侧栏报过来的底图/蒙版状态。 */
function applyEditState(state) {
  if (!state) return;
  if (!state.hasBase) {
    if (edit.open) closeEditSheet();
    return;
  }
  const changed = resetBaseMaskCanvas();
  edit.share = Number(state.share) || 0;
  const next = state.maskBlob ?? null;
  const isNew = next && next !== edit.maskBlob;
  edit.maskBlob = next;
  if (edit.open) {
    if (changed) {
      baseSheetSize();
      if (edit.mode === null) toast("画幅变了，蒙版已清空");
    }
    // 正在抹的时候不抢画面：那几笔还没保存。
    if (isNew && edit.mode === null) void showMaskBlob(next);
    renderBaseBar();
  }
  renderComposerChips(state);
}

// ── 底部输入区 ─────────────────────────────────────────────────────
// 提示词与发送按钮在主界面；真正提交仍由侧栏那一侧完成，它拿着全部参数。
// 输入框要跨页签常驻：把它从画布视图里提到 main 末尾。
const composerHost = document.getElementById("composer");
if (composerHost) document.querySelector("main")?.append(composerHost);
// 输入框是浮层：把它真实高度写进变量，内容按这个值让位。
if (composerHost) {
  const syncComposerHeight = () => {
    document.documentElement.style.setProperty("--composer-h", `${Math.round(composerHost.getBoundingClientRect().height)}px`);
  };
  syncComposerHeight();
  if (typeof ResizeObserver === "function") new ResizeObserver(syncComposerHeight).observe(composerHost);
  window.addEventListener("resize", syncComposerHeight);
}

const composer = {
  input: document.getElementById("composer-input"),
  negative: document.getElementById("composer-negative"),
  seed: document.getElementById("composer-seed"),
  send: document.getElementById("composer-send"),
  plus: document.getElementById("composer-plus"),
  menu: document.getElementById("cmenu"),
  params: document.getElementById("composer-params"),
  sample: document.getElementById("composer-sample"),
  model: document.getElementById("composer-model"),
  chips: document.getElementById("composer-chips"),
};

let composerTimer = null;
let lastEditState = null;
// 主界面自己拿着参考图的本地副本，缩略图与放大都在这一侧。
const refFiles = [];

function pushRefFile(file) {
  refFiles.push({ name: file.name, url: URL.createObjectURL(file) });
  renderComposerChips(lastEditState);
}

function openRefBox(url, name) {
  const box = document.getElementById("refbox");
  const img = document.getElementById("refbox-img");
  if (!box || !img) return;
  img.src = url;
  img.alt = name ?? "参考图";
  box.hidden = false;
}

document.getElementById("refbox-close")?.addEventListener("click", () => {
  const box = document.getElementById("refbox");
  if (box) box.hidden = true;
});
document.getElementById("refbox")?.addEventListener("click", (event) => {
  if (event.target.id === "refbox") event.currentTarget.hidden = true;
});
function composerText() {
  return composer.input?.value ?? "";
}

function pushComposerPrompt() {
  clearTimeout(composerTimer);
  composerTimer = setTimeout(() => {
    layChannel?.postMessage({ type: "compose-prompt", text: composerText() });
  }, 120);
}

/** 上传一张图到 inputs/，返回 { path, name }。 */
async function uploadInput(blob, kind) {
  const response = await hana.api.fetch(API + "/inputs/upload?kind=" + kind, { method: "POST", body: blob });
  if (!response.ok) throw new Error("上传失败 " + response.status);
  return response.json();
}

let submitting = false;

/** 主界面自己提交：参数来自这里，不再让侧栏按隐藏控件拼。 */
async function submitGenerate() {
  if (submitting) return;
  const prompt = composerText().trim();
  if (!prompt) {
    composer.input?.focus();
    return;
  }
  // 布局框那条路还在侧栏，交给它。
  if (lay.boxes.length) {
    layChannel?.postMessage({ type: "compose-send", text: prompt, base: edit.remotePath ?? null });
    return;
  }
  // 发出新的一句就是回到当前会话：不再停在从侧栏点开的历史段。
  convScopeJobs = null;
  chatFilter = null;
  // 先把这次的话挂到会话里，再收起画布：第一眼看到的是自己的消息。
  localPending = {
    id: `local-${Date.now()}`,
    prompt,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  // 只退出全屏：画布是工具层，跟着这次提交收起，不占用消息。
  if (document.body.classList.contains("dock-full")) {
    document.body.classList.remove("dock-full");
    document.getElementById("chat-dock-full")?.classList.remove("on");
  }
  if (dockOpen) setDock(false);
  chatAtBottom = true;
  renderChat.lastSig = "";
  renderChat();
  submitting = true;
  if (composer.send) composer.send.disabled = true;
  try {
    const payload = { prompt, negativePrompt: composer.negative?.value ?? "" };
    // 会话 id 跟着走：出图后才知道该归到哪一段。
    try {
      const conv = currentConv ?? localStorage.getItem("hana-moss-studio.conv-id");
      if (conv) payload.conv = conv;
    } catch {
      /* 没有也罢 */
    }
    const seedText = (composer.seed?.value ?? "").trim();
    if (seedText) payload.seed = Number(seedText);
    if (edit.remotePath) {
      payload.initImage = edit.remotePath;
      payload.strength = 0.6;
      payload.resize = "stretch";
    }
    if (edit.maskBlob) {
      const mask = await uploadInput(edit.maskBlob, "mask");
      if (mask && mask.path) {
        payload.mask = mask.path;
        payload.maskEncoding = "u8";
      }
    }
    if (refFiles.length) {
      const paths = [];
      for (const item of refFiles) {
        try {
          const blob = await window.fetch(item.url).then((response) => response.blob());
          const ref = await uploadInput(blob, "ref");
          if (ref && ref.path) paths.push(ref.path);
        } catch {
          /* 单张传不上去不拦整条 */
        }
      }
      if (paths.length) {
        payload.referenceImages = paths;
        payload.referenceMaxEdge = 512;
      }
    }
    await api("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, 60000);
    // 提交本身就有回执：会话末尾立刻出现那条占位，不再额外弹一句话。
    void api("/state").then((data) => render(data)).catch(() => {});
    // 话已经进了会话，输入框回到空态；底图与参考图留着，接着改同一张。
    if (composer.input) {
      composer.input.value = "";
      composer.input.style.height = "";
    }
    pushComposerPrompt();
  } catch (error) {
    toast("提交失败：" + (error instanceof Error ? error.message : String(error)), "error");
  } finally {
    submitting = false;
    if (composer.send) composer.send.disabled = false;
  }
}
function sendCompose() {
  void submitGenerate();
}

composer.input?.addEventListener("input", () => {
  composer.input.style.height = "auto";
  composer.input.style.height = `${Math.min(composer.input.scrollHeight, 132)}px`;
  pushComposerPrompt();
});

composer.input?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendCompose();
  }
});

// 反向提示词与种子也交给侧栏，提交时一并带上。
let extraTimer = null;
function pushExtras() {
  clearTimeout(extraTimer);
  extraTimer = setTimeout(() => {
    layChannel?.postMessage({ type: "compose-negative", text: composer.negative?.value ?? "" });
    layChannel?.postMessage({ type: "compose-seed", value: composer.seed?.value ?? "" });
    markHiddenExtra();
  }, 120);
}

composer.negative?.addEventListener("input", pushExtras);
composer.seed?.addEventListener("input", pushExtras);

// 反向提示词与种子的展开状态只初始化一次，之后归用户。
let extrasBootstrapped = false;

// 两行各自收起：反向提示词与种子互不影响。
for (const id of ["composer-negative-close", "composer-seed-close"]) {
  document.getElementById(id)?.addEventListener("click", (event) => {
    const row = event.currentTarget.closest(".composer-extra");
    if (row) row.hidden = true;
    markHiddenExtra();
  });
}

/** 收起后如果有值，给加号一个圆点，不让参数无声无息藏着。 */
function markHiddenExtra() {
  const negRow = document.getElementById("composer-extra-negative");
  const seedRow = document.getElementById("composer-extra-seed");
  const hiddenNeg = Boolean(negRow?.hidden) && (composer.negative?.value ?? "").trim() !== "";
  const hiddenSeed = Boolean(seedRow?.hidden) && (composer.seed?.value ?? "").trim() !== "";
  composer.plus?.classList.toggle("has-extra", hiddenNeg || hiddenSeed);
}

composer.send?.addEventListener("click", sendCompose);

// 底图与参考图都是「加图」，合在加号那张菜单里。
function closeComposerMenu() {
  if (composer.menu) composer.menu.hidden = true;
}

composer.plus?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!composer.menu) return;
  const willOpen = composer.menu.hidden;
  closeAllPanels();
  composer.menu.hidden = !willOpen;
});

composer.menu?.addEventListener("click", (event) => {
  event.stopPropagation();
  const item = event.target.closest(".cmenu-item");
  if (!item) return;
  const act = item.dataset.act;
  closeComposerMenu();
  // 两种图都在主界面自己选，不绕到侧栏的文件框。
  if (act === "base") {
    setDock(true);
    fileIntent = "edit";
    nodes.layFile.click();
  } else if (act === "reference") {
    document.getElementById("composer-ref-file")?.click();
  } else if (act === "negative" || act === "seed") {
    // 两者各自一行、各自收起，不连坐。
    const box =
      act === "negative"
        ? document.getElementById("composer-extra-negative")
        : document.getElementById("composer-extra-seed");
    if (!box) return;
    const field = act === "negative" ? composer.negative : composer.seed;
    const filled = (field?.value ?? "").trim() !== "";
    if (!box.hidden && !filled) {
      box.hidden = true;
    } else {
      box.hidden = false;
      field?.focus();
    }
    markHiddenExtra();
  }
});

const refFile = document.getElementById("composer-ref-file");
refFile?.addEventListener("change", () => {
  const file = refFile.files?.[0];
  refFile.value = "";
  if (!file) return;
  layChannel?.postMessage({ type: "compose-drop-reference", file });
  pushRefFile(file);
  toast(`${file.name} 已加入参考图`);
});

document.addEventListener("click", (event) => {
  if (!composer.menu || composer.menu.hidden) return;
  if (composer.menu.contains(event.target) || composer.plus?.contains(event.target)) return;
  closeComposerMenu();
});

// 拖到输入框当参考图，拖到画布当底图。
const composerBox = document.querySelector(".composer");
let composerDragDepth = 0;
composerBox?.addEventListener("dragenter", (event) => {
  event.preventDefault();
  composerDragDepth += 1;
  composerBox.classList.add("dragging");
});
composerBox?.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
composerBox?.addEventListener("dragleave", () => {
  composerDragDepth = Math.max(0, composerDragDepth - 1);
  if (!composerDragDepth) composerBox.classList.remove("dragging");
});
composerBox?.addEventListener("drop", (event) => {
  event.preventDefault();
  event.stopPropagation();
  composerDragDepth = 0;
  composerBox.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (!file || !String(file.type).startsWith("image/")) return;
  layChannel?.postMessage({ type: "compose-drop-reference", file });
  pushRefFile(file);
  toast(`${file.name} 已加入参考图`);
});

// 空态只剩「从底图开始」；写提示词本来就在输入框里。

// 两个浮层：模型名点开是模型与精度档；左侧参数图标点开是尺寸、步数、CFG。
const panels = {
  model: {
    box: document.getElementById("cpop"),
    title: document.getElementById("cpop-title"),
    back: document.getElementById("cpop-back"),
    body: document.getElementById("cpop-body"),
    head: document.getElementById("cpop-title")?.parentElement,
    view: "root",
  },
  params: {
    box: document.getElementById("ppop"),
    title: document.getElementById("ppop-title"),
    back: document.getElementById("ppop-back"),
    body: document.getElementById("ppop-body"),
    head: document.getElementById("ppop-title")?.parentElement,
    view: "root",
  },
  sample: {
    box: document.getElementById("spop"),
    title: document.getElementById("spop-title"),
    back: document.getElementById("spop-back"),
    body: document.getElementById("spop-body"),
    head: document.getElementById("spop-title")?.parentElement,
    view: "root",
  },
};

const TIER_OPTIONS = [
  ["turbo", "turbo", "最快"],
  ["high", "high", "居中"],
  ["reference", "reference", "最准"],
];

// 尺寸分两级：先选比例，再选这比例下的分辨率。
const RATIOS = [
  ["1:1", 1, 1],
  ["3:2", 3, 2],
  ["2:3", 2, 3],
  ["16:9", 16, 9],
  ["9:16", 9, 16],
  ["4:3", 4, 3],
  ["3:4", 3, 4],
];

const SIZE_TABLE = {
  "1:1": [[1024, 1024], [1536, 1536], [1920, 1920], [2048, 2048]],
  "3:2": [[1536, 1024], [1824, 1216], [2304, 1536]],
  "2:3": [[1024, 1536], [1216, 1824], [1536, 2304]],
  "16:9": [[1280, 720], [1536, 864], [1920, 1080], [2560, 1440]],
  "9:16": [[720, 1280], [864, 1536], [1080, 1920], [1440, 2560]],
  "4:3": [[1024, 768], [1408, 1056], [1600, 1200], [2048, 1536]],
  "3:4": [[768, 1024], [1056, 1408], [1200, 1600], [1536, 2048]],
};

/** 当前尺寸属于哪个比例：取最接近的一档。 */
function ratioOf(width, height) {
  if (!width || !height) return "1:1";
  const value = width / height;
  let best = RATIOS[0][0];
  let diff = Infinity;
  for (const [id, rw, rh] of RATIOS) {
    const d = Math.abs(rw / rh - value);
    if (d < diff) {
      diff = d;
      best = id;
    }
  }
  return best;
}

/** 当前 DiT 只支持某一档时返回它，bundle 自带则为空。 */
function ditLimit() {
  const target = latest?.settings?.modelFiles?.dit;
  if (!target) return null;
  const file = (Array.isArray(latest?.files) ? latest.files : []).find(
    (item) => item.role === "dit" && item.installed && item.target === target,
  );
  return file?.tier ?? null;
}

/** 每一档能用哪份权重：bundle 自带的 bf16 先兼 reference 与 high，单文件再补 turbo。 */
function ditChoices() {
  const bundleReady = (Array.isArray(latest?.models) ? latest.models : []).some((item) => item.installed);
  const choices = {};
  if (bundleReady) {
    // 完整包里的 DiT 是 bf16：reference 与 high 能跑，turbo 需要 4bit 权重。
    choices.reference = { dit: null, note: "bundle 自带" };
    choices.high = { dit: null, note: "bundle 自带" };
  }
  const files = (Array.isArray(latest?.files) ? latest.files : []).filter(
    (item) => item.role === "dit" && item.installed && item.target,
  );
  for (const file of files) {
    if (file.tier && !choices[file.tier]) choices[file.tier] = { dit: file.target, note: "单文件权重" };
  }
  return choices;
}

const STEP_OPTIONS = [8, 16, 20, 28, 40];
const CFG_OPTIONS = [1, 2, 3, 4, 6];

function cpopModels() {
  return (Array.isArray(latest?.models) ? latest.models : []).filter((item) => item.installed);
}

/** MOSS-Image- 在这栏里重复四次，列表里只留变体名。 */
function shortModel(label) {
  const text = String(label ?? "MOSS-Image");
  return text.replace(/^MOSS-Image[-_ ]?/i, "") || text;
}

function closePanel(which) {
  const panel = panels[which];
  if (!panel?.box) return;
  panel.box.hidden = true;
  panel.view = "root";
  panel.stack = [];
}

function closeAllPanels() {
  for (const which of Object.keys(panels)) closePanel(which);
}

function openPanel(which) {
  const panel = panels[which];
  if (!panel?.box) return;
  closeComposerMenu();
  closeAllPanels();
  panel.stack = [];
  panel.view = "root";
  renderPanel(which);
  panel.box.hidden = false;
}

composer.model?.addEventListener("click", (event) => {
  event.stopPropagation();
  const panel = panels.model;
  if (!panel?.box) return;
  if (panel.box.hidden) openPanel("model");
  else closePanel("model");
});

composer.params?.addEventListener("click", (event) => {
  event.stopPropagation();
  const panel = panels.params;
  if (!panel?.box) return;
  if (panel.box.hidden) openPanel("params");
  else closePanel("params");
});

composer.sample?.addEventListener("click", (event) => {
  event.stopPropagation();
  const panel = panels.sample;
  if (!panel?.box) return;
  if (panel.box.hidden) openPanel("sample");
  else closePanel("sample");
});

for (const which of Object.keys(panels)) {
  panels[which].back?.addEventListener("click", (event) => {
    event.stopPropagation();
    const panel = panels[which];
    panel.view = panel.stack?.pop() ?? "root";
    renderPanel(which);
  });
}
document.addEventListener("click", (event) => {
  const inside = Object.values(panels).some(
    (panel) => panel.box && !panel.box.hidden && panel.box.contains(event.target),
  );
  if (!inside) closeAllPanels();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAllPanels();
});

async function useModel(variant) {
  try {
    await post("/weights/use", { variant });
    toast("模型已切换，下次出图重新加载");
    closePanel("model");
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

async function saveDefaults(patch) {
  const defaults = { ...(latest?.settings?.defaults ?? {}), ...patch };
  try {
    await post("/settings", { defaults });
    if (latest?.settings?.defaults) Object.assign(latest.settings.defaults, defaults);
    renderComposerModel();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

async function setTier(tier) {
  const choice = ditChoices()[tier];
  const patch = { tier };
  if (choice) {
    // 当前 DiT 本来就能跑这档时就留着，不必把单文件换成 bundle。
    const keep = ditLimit() === tier && latest?.settings?.modelFiles?.dit;
    patch.modelFiles = {
      ...(latest?.settings?.modelFiles ?? {}),
      dit: keep ? latest.settings.modelFiles.dit : (choice.dit ?? null),
    };
  }
  try {
    await post("/settings", patch);
    if (latest?.settings) {
      latest.settings.tier = tier;
      if (patch.modelFiles) latest.settings.modelFiles = patch.modelFiles;
    }
    toast(`精度档 ${tier}，配套权重已就位，下次出图重新加载`);
    renderComposerModel();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

function panelRow(which, label, value, kind) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "cpop-row";
  const name = document.createElement("span");
  name.className = "cpop-name";
  name.textContent = label;
  const val = document.createElement("span");
  val.className = "cpop-val";
  val.textContent = value;
  row.append(name, val);
  row.addEventListener("click", (event) => {
    // 这行马上会被替换掉；不拦住，冒泡到 document 就成了「点在浮层外」。
    event.stopPropagation();
    const panel = panels[which];
    if (!panel) return;
    // 记住来处，返回时才知道退回哪一层。
    panel.stack = panel.stack ?? [];
    panel.stack.push(panel.view);
    panel.view = kind;
    renderPanel(which);
  });
  return row;
}

function renderPanelRoot(which) {
  const panel = panels[which];
  if (!panel?.body) return;
  panel.view = "root";
  if (panel.head) panel.head.hidden = true;
  if (panel.back) panel.back.hidden = true;
  if (panel.title) {
    panel.title.hidden = true;
    panel.title.textContent = "";
  }
  const defaults = latest?.settings?.defaults ?? {};
  if (which === "model") {
    const models = cpopModels();
    const active = models.find((item) => item.active) ?? models[0];
    panel.body.replaceChildren(
      panelRow(which, "模型", active ? shortModel(active.label ?? active.variant) : "未安装", "model"),
      panelRow(which, "精度档", latest?.settings?.tier ?? "reference", "tier"),
    );
    return;
  }
  if (which === "sample") {
    panel.body.replaceChildren(
      panelRow(which, "采样器", defaults.sampler ?? "euler", "sampler"),
      panelRow(which, "调度器", defaults.scheduler ?? "moss", "scheduler"),
    );
    return;
  }
  panel.body.replaceChildren(
    panelRow(which, "比例", ratioOf(Number(defaults.width), Number(defaults.height)), "ratio"),
    panelRow(which, "分辨率", `${defaults.width ?? 1024} × ${defaults.height ?? 1024}`, `size:${ratioOf(Number(defaults.width), Number(defaults.height))}`),
    panelRow(which, "步数", String(defaults.steps ?? 20), "steps"),
    panelRow(which, "CFG", String(defaults.cfg ?? 3), "cfg"),
  );
}

function renderPanelList(which, kind) {
  const panel = panels[which];
  if (!panel?.body) return;
  const titles = { model: "模型", tier: "精度档", steps: "步数", cfg: "CFG", sampler: "采样器", scheduler: "调度器" };
  if (panel.head) panel.head.hidden = false;
  if (panel.back) panel.back.hidden = false;
  if (panel.title) {
    panel.title.hidden = false;
    panel.title.textContent = kind === "ratio" ? "比例" : kind.startsWith("size:") ? `${kind.slice(5)} 的分辨率` : (titles[kind] ?? "");
  }
  const items = [];
  if (kind === "model") {
    for (const item of cpopModels()) {
      items.push({
        text: shortModel(item.label ?? item.variant),
        selected: Boolean(item.active),
        apply: () => useModel(item.variant),
      });
    }
  } else if (kind === "tier") {
    const current = latest?.settings?.tier ?? "reference";
    const choices = ditChoices();
    for (const [value, text, note] of TIER_OPTIONS) {
      // 没有能干这档的权重就不列；有的话选中会自动把 DiT 换成对应的那份。
      const choice = choices[value];
      if (!choice) continue;
      items.push({
        text,
        note: choice.dit ? choice.note : `${note} · ${choice.note}`,
        selected: current === value,
        apply: () => setTier(value),
      });
    }
  } else if (kind === "ratio") {
    const defaults = latest?.settings?.defaults ?? {};
    const current = ratioOf(Number(defaults.width), Number(defaults.height));
    for (const [id] of RATIOS) {
      items.push({
        text: id,
        selected: id === current,
        keep: true,
        apply: () => {
          const panel = panels.params;
          panel.stack = panel.stack ?? [];
          panel.stack.push("ratio");
          panel.view = `size:${id}`;
          renderPanel("params");
        },
      });
    }
  } else if (kind.startsWith("size:")) {
    const ratio = kind.slice(5);
    const defaults = latest?.settings?.defaults ?? {};
    const curW = Number(defaults.width ?? 1024);
    const curH = Number(defaults.height ?? 1024);
    const list = [...(SIZE_TABLE[ratio] ?? [])].filter(
      // 引擎硬限制：单边 4096、总量 4.2 MP，超了的档不列出来。
      ([w, h]) => w <= 4096 && h <= 4096 && w * h <= 4.2e6,
    );
    // 当前尺寸不在表里也要能看到自己，否则整列没有一项是选中的。
    if (ratioOf(curW, curH) === ratio && !list.some(([w, h]) => w === curW && h === curH)) {
      list.unshift([curW, curH]);
    }
    for (const [width, height] of list) {
      items.push({
        text: `${width} × ${height}`,
        selected: width === curW && height === curH,
        apply: () => saveDefaults({ width, height }),
      });
    }
  } else if (kind === "sampler" || kind === "scheduler") {
    const menus = latest?.facets?.menus ?? {};
    const list =
      (kind === "sampler" ? menus.sampler : menus.scheduler) ??
      (kind === "sampler" ? ["euler"] : ["moss"]);
    const current = latest?.settings?.defaults?.[kind] ?? list[0];
    for (const value of list) {
      items.push({
        text: String(value),
        selected: current === value,
        apply: () => saveDefaults({ [kind]: value }),
      });
    }
  } else if (kind === "steps") {
    const current = Number(latest?.settings?.defaults?.steps ?? 20);
    const options = STEP_OPTIONS.includes(current) ? STEP_OPTIONS : [current, ...STEP_OPTIONS];
    for (const steps of options) {
      items.push({ text: String(steps), selected: current === steps, apply: () => saveDefaults({ steps }) });
    }
  } else if (kind === "cfg") {
    const current = Number(latest?.settings?.defaults?.cfg ?? 3);
    const options = CFG_OPTIONS.includes(current) ? CFG_OPTIONS : [current, ...CFG_OPTIONS];
    for (const cfg of options) {
      items.push({ text: String(cfg), selected: current === cfg, apply: () => saveDefaults({ cfg }) });
    }
  }
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "cpop-empty";
    empty.textContent = kind === "model" ? "没有已安装的模型" : "没有可选项";
    panel.body.replaceChildren(empty);
    return;
  }
  panel.body.replaceChildren(
    ...items.map((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = item.selected ? "cpop-item on" : "cpop-item";
      if (item.disabled) {
        btn.disabled = true;
        btn.classList.add("off");
      }
      const text = document.createElement("span");
      text.textContent = item.text;
      btn.append(text);
      if (item.note) {
        const note = document.createElement("em");
        note.textContent = item.note;
        btn.append(note);
      }
      if (item.selected) {
        const mark = document.createElement("i");
        mark.className = "cpop-check";
        btn.append(mark);
      }
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (item.disabled) return;
        if (!item.keep) closePanel(which);
        void item.apply();
      });
      return btn;
    }),
  );
}

function renderPanel(which) {
  const panel = panels[which];
  if (!panel) return;
  if (panel.view === "root") renderPanelRoot(which);
  else renderPanelList(which, panel.view);
}

function renderCpop() {
  for (const which of Object.keys(panels)) {
    const panel = panels[which];
    if (panel.box && !panel.box.hidden) renderPanel(which);
  }
}

/** 模型名与精度档跟着设置走。 */
function renderComposerModel() {
  if (!composer.model) return;
  const models = Array.isArray(latest?.models) ? latest.models : [];
  const active = models.find((item) => item.active) ?? models[0];
  const modelLabel = active?.label ?? "MOSS-Image";
  const short = modelLabel.replace(/^MOSS-Image[-_ ]?/i, "") || modelLabel;
  const tier = latest?.settings?.tier ?? "reference";
  composer.model.textContent = `${short} · ${tier}`;
  const defaults = latest?.settings?.defaults ?? {};
  if (composer.negative && document.activeElement !== composer.negative) {
    composer.negative.value = defaults.negativePrompt ?? "";
  }
  if (composer.seed && document.activeElement !== composer.seed) {
    composer.seed.value = defaults.seed != null && defaults.seed !== "" ? String(defaults.seed) : "";
  }
  // 已经有值的那一行自己展开，只做一次：之后的展开/收起由用户决定，
  // 每次状态推送都重设会把人刚点开的行按回去。
  if (!extrasBootstrapped) {
    const negBox = document.getElementById("composer-extra-negative");
    if (negBox) negBox.hidden = !String(defaults.negativePrompt ?? "").trim();
    const seedBox = document.getElementById("composer-extra-seed");
    if (seedBox) seedBox.hidden = !(defaults.seed != null && defaults.seed !== "");
    extrasBootstrapped = true;
  }
  renderCpop();
}

/** 底图、蒙版、布局各自的状态。 */
function renderComposerChips(state) {
  lastEditState = state ?? lastEditState;
  if (!composer.chips) return;
  const items = [];
  // 参考图每张一张缩略图卡，点开看大图。
  for (const item of refFiles) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "composer-chip ref";
    card.title = `${item.name} · 点击放大`;
    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.name;
    const label = document.createElement("span");
    label.textContent = item.name;
    const remove = document.createElement("span");
    remove.className = "x";
    remove.textContent = "×";
    remove.title = "移出参考图";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      layChannel?.postMessage({ type: "compose-remove-reference", index: refFiles.indexOf(item) });
    });
    card.append(img, label, remove);
    card.addEventListener("click", () => openRefBox(item.url, item.name));
    items.push(card);
  }
  const plain = (text) => {
    const chip = document.createElement("span");
    chip.className = "composer-chip";
    chip.textContent = text;
    return chip;
  };
  const share = Number(state?.share) || 0;
  if (share > 0) items.push(plain(`蒙版 ${Math.round(share * 100)}%`));
  if (lay.boxes?.length) items.push(plain(`布局 ${lay.boxes.length} 块`));
  composer.chips.replaceChildren(...items);
  composer.chips.hidden = items.length === 0;
}

/** 画幅改了（侧栏改尺寸、或比例跟底图对齐）就在这里跟上。 */
function syncBaseSheet() {
  if (!edit.open) return;
  if (resetBaseMaskCanvas()) {
    nodes.baseMask.getContext("2d").clearRect(0, 0, nodes.baseMask.width, nodes.baseMask.height);
    baseSheetSize();
    renderBaseBar();
  }
}

function basePoint(event) {
  const canvas = nodes.baseMask;
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    scale: canvas.width / Math.max(1, rect.width),
  };
}

function paintBaseMask(point) {
  const canvas = nodes.baseMask;
  const ctx = canvas.getContext("2d");
  // 笔刷尺寸是屏幕像素，画到画布上要按显示比例放大。
  const radius = ((Number(nodes.baseBrush.value) || 60) / 2) * point.scale;
  ctx.globalCompositeOperation = edit.mode === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = MASK_STROKE;
  ctx.fillStyle = MASK_STROKE;
  ctx.lineWidth = radius * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (!maskLastPoint) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(maskLastPoint.x, maskLastPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  maskLastPoint = { x: point.x, y: point.y };
}

async function saveBaseMask() {
  if (!edit.open || edit.mode === null) return;
  const source = nodes.baseMask;
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0);
  // 二值化：笔触是白（叠在黑底上约 217），没碰过的地方是 0。
  // 看亮度而不是 alpha：整张已铺了不透明黑底，alpha 处处是 255。
  const frame = ctx.getImageData(0, 0, out.width, out.height);
  const data = frame.data;
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) {
    const on = data[i] > 8;
    data[i] = on ? 255 : 0;
    data[i + 1] = on ? 255 : 0;
    data[i + 2] = on ? 255 : 0;
    data[i + 3] = 255;
    if (on) painted += 1;
  }
  if (!painted) {
    toast("蒙版是空的：至少抹一块要重画的区域");
    return;
  }
  ctx.putImageData(frame, 0, 0);
  const share = Math.round((painted / (out.width * out.height)) * 1000) / 10;
  const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
  if (!blob) {
    toast("蒙版编码失败");
    return;
  }
  nodes.baseMaskSave.disabled = true;
  edit.mode = null;
  maskDrawing = false;
  maskLastPoint = null;
  edit.share = share;
  edit.maskBlob = blob;
  renderBaseBar();
  layChannel?.postMessage({ type: "canvas-mask", blob, share });
  nodes.baseMaskSave.disabled = false;
  toast(`蒙版已交给侧栏，重画面积 ${share}%。回侧栏点生成`);
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
  nodes.canvasDropHint.hidden = false;
});
nodes.canvas.addEventListener("dragleave", (event) => {
  if (event.relatedTarget && nodes.canvas.contains(event.relatedTarget)) return;
  nodes.canvas.classList.remove("dropping");
  nodes.canvasDropHint.hidden = true;
});
nodes.canvas.addEventListener("drop", async (event) => {
  if (!canvasHasFiles(event)) return;
  event.preventDefault();
  nodes.canvas.classList.remove("dropping");
  nodes.canvasDropHint.hidden = true;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!String(file.type).startsWith("image/")) {
    toast("拖进来的不是图片");
    return;
  }
  setDock(true);
  // 拖进来就是「接着这张改」：落进改图台，蒙版直接在上面抹。
  // 想框选布局就在台子上点「框选布局」，底图不会重传。
  try {
    await openEditSheet(file);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  }
});

// 选一张图进来后去哪儿：改图台，还是布局框选。同一个选图框，两种用途。
let fileIntent = "layout";

nodes.layImport.addEventListener("click", () => {
  fileIntent = "layout";
  nodes.layFile.click();
});
// 布局与改图台不共存，但底图是同一张：切回去只多一步点击，不用重传图。
nodes.layBase.addEventListener("click", () => {
  if (!edit.file) {
    toast("先用「换底图」选一张，再抹蒙版");
    return;
  }
  // 同一张底图：直接开回改图台，蒙版原样接着用。
  if (edit.url) {
    closeLayout();
    edit.open = true;
    edit.mode = null;
    nodes.base.hidden = false;
    nodes.baseImage.src = edit.url;
    baseSheetSize();
    if (edit.maskBlob) void showMaskBlob(edit.maskBlob);
    renderBaseBar();
    void renderCanvas(latest);
    return;
  }
  void openEditSheet(edit.file).catch((error) => {
    toast(error instanceof Error ? error.message : String(error), "error");
  });
});
nodes.layFile.addEventListener("change", async () => {
  const file = nodes.layFile.files?.[0];
  nodes.layFile.value = "";
  if (!file) return;
  try {
    if (fileIntent === "edit") await openEditSheet(file);
    else await setUnderlay(file);
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

nodes.layLabel.addEventListener("change", () => {
  const item = lay.boxes.find((entry) => entry.id === lay.selected);
  if (!item) return;
  item.label = nodes.layLabel.value;
  renderLayBoxes();
});
/** 下拉里没有的值（自定义标签）临时补一项，不把用户填的内容抹掉。 */
function setLayLabel(value) {
  const next = String(value ?? "object") || "object";
  const options = Array.from(nodes.layLabel.options).map((option) => option.value);
  if (!options.includes(next)) {
    const option = document.createElement("option");
    option.value = next;
    option.textContent = next;
    nodes.layLabel.append(option);
  }
  nodes.layLabel.value = next;
}

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

// ── 改图台的按钮与涂抹 ─────────────────────────────────────────────
nodes.basePaint.addEventListener("click", () => {
  if (!edit.open) return;
  edit.mode = edit.mode === null ? "paint" : null;
  maskDrawing = false;
  maskLastPoint = null;
  renderBaseBar();
  if (edit.mode) toast("在底图上抹出要重画的区域，抹完点「保存蒙版」");
});
nodes.baseErase.addEventListener("click", () => {
  edit.mode = edit.mode === "erase" ? "paint" : "erase";
  maskLastPoint = null;
  renderBaseBar();
});
nodes.baseMaskClear.addEventListener("click", () => {
  const ctx = nodes.baseMask.getContext("2d");
  ctx.clearRect(0, 0, nodes.baseMask.width, nodes.baseMask.height);
  edit.share = 0;
  renderBaseBar();
  toast("画布上的笔触已清空，保存新的才会换掉侧栏那份");
});
nodes.baseMaskSave.addEventListener("click", () => void saveBaseMask());
nodes.baseClose.addEventListener("click", closeEditSheet);
nodes.baseLayout.addEventListener("click", () => {
  if (!edit.open) return;
  // 底图已经传给侧栏了：布局直接接这张走，不再重传。
  const hasUnderlay = Boolean(lay.underlay);
  closeEditSheet();
  openLayout();
  if (!hasUnderlay) {
    fileIntent = "layout";
    nodes.layFile.click();
  }
});
nodes.baseMask.addEventListener("pointerdown", (event) => {
  if (edit.mode === null) return;
  event.preventDefault();
  nodes.baseMask.setPointerCapture?.(event.pointerId);
  maskDrawing = true;
  maskLastPoint = null;
  paintBaseMask(basePoint(event));
});
nodes.baseMask.addEventListener("pointermove", (event) => {
  if (!maskDrawing) return;
  paintBaseMask(basePoint(event));
});
const endMaskStroke = () => {
  maskDrawing = false;
  maskLastPoint = null;
};
nodes.baseMask.addEventListener("pointerup", endMaskStroke);
nodes.baseMask.addEventListener("pointercancel", endMaskStroke);
nodes.baseMask.addEventListener("pointerleave", () => {
  // 拖出画面再回来不该把上一笔连上去。
  maskLastPoint = null;
});
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
  if (edit.open) baseSheetSize();
});

// 表单显隐、窗口缩放、字体变化都会改 stage 高度：跟着重算画布尺寸，免得出滚动条。
if (typeof ResizeObserver === "function") {
  const observer = new ResizeObserver(() => {
    if (lay.open) laySheetSize();
    if (edit.open) baseSheetSize();
  });
  observer.observe(nodes.layStage);
  observer.observe(nodes.baseStage);
}

/** 侧栏点「去画布框选」时把这一层打开。 */
const layChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;
layChannel?.addEventListener("message", (event) => {
  const msg = event.data ?? {};
  if (msg.type === "conv") {
    currentConv = typeof msg.conv === "string" && msg.conv ? msg.conv : null;
    return;
  }
  if (msg.type === "edit-state") {
    applyEditState(msg.state);
    return;
  }
  if (msg.type === "edit-refs") {
    const names = Array.isArray(msg.names) ? msg.names : null;
    if (names) {
      const pool = [...refFiles];
      const kept = [];
      for (const name of names) {
        const index = pool.findIndex((item) => item.name === name);
        if (index >= 0) kept.push(pool.splice(index, 1)[0]);
      }
      for (const item of pool) URL.revokeObjectURL(item.url);
      refFiles.length = 0;
      refFiles.push(...kept);
      renderComposerChips(lastEditState);
    }
    return;
  }
  if (msg.type === "new-conversation") {
    // 新会话从空白开始：这一页只显示之后生成的图。
    convStartMs = Date.now();
    chatFilter = null;
    convScopeJobs = null;
    if (composer.input) composer.input.value = "";
    if (composer.negative) composer.negative.value = "";
    if (composer.seed) composer.seed.value = "";
    showView("chat");
    renderChat();
    return;
  }
  if (msg.type === "clear-conversation") {
    // 归组变了：回到当前会话，别停在已经不存在的旧范围上。
    chatFilter = null;
    convScopeJobs = null;
    convStartMs = 0;
    renderChat();
    return;
  }
  if (msg.type === "open-conversation") {
    const ids = Array.isArray(msg.ids) ? msg.ids : [];
    convStartMs = 0;
    chatFilter = ids.length ? new Set(ids) : null;
    convScopeJobs = Array.isArray(msg.jobs) ? msg.jobs : null;
    // 换了一段就从最新的那条看起，不沿用上一段的滚动位置。
    chatBootstrapped = false;
    chatAtBottom = true;
    renderChat.lastSig = "";
    showView("chat");
    renderChat();
    return;
  }
  if (msg.type === "open-job") {
    showView("chat");
    const row = document.querySelector(`.chat-row[data-job-id="${msg.id}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1200);
    }
    return;
  }
  if (msg.type === "compose-prompt") {
    const text = String(msg.text ?? "");
    if (composer.input && text !== composer.input.value) {
      composer.input.value = text;
      composer.input.focus();
    }
    return;
  }
  if (msg.type !== "layout-open") return;
  setDock(true);
  const target = Number.isFinite(msg.index) ? lay.boxes[msg.index]?.id : undefined;
  openLayout(target);
  if (!lay.underlay) {
    fileIntent = "layout";
    nodes.layFile.click();
  } else if (target) nodes.layCaption.focus();
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
    renderChat();
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
        // 悬停就能「接着改这张」：比右键菜单早一步。
        const quick = document.createElement("button");
        quick.type = "button";
        quick.className = "thumb-quick";
        quick.textContent = "改这张";
        quick.title = "当底图，去画布抹一块重画";
        quick.addEventListener("click", (event) => {
          event.stopPropagation();
          useAsReference(job);
        });
        tile.appendChild(quick);
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
  // 引擎由出图流程拉起；这个按钮只管停。
  nodes.engineToggle.hidden = !engine.running;
  nodes.engineToggle.textContent = "停止引擎";
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
  const parts = [];
  if (job.width && job.height) parts.push(`${job.width}×${job.height}`);
  if (job.steps) parts.push(`${job.steps} 步`);
  if (job.cfg !== null && job.cfg !== undefined) parts.push(`CFG ${job.cfg}`);
  if (seed !== null && seed !== undefined) parts.push(`种子 ${seed}`);
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
    items.push({ label: "用这张做底图", run: () => useAsReference(job) });
    // 编辑适配器（Moss-Image-Edit 一类）的入口：源图 + 指令。
    items.push({ label: "用这张做参考图", run: () => useAsEditReference(job) });
    items.push({ sep: true });
  }
  items.push({
    // 记录就在 PNG 的元数据里，删图即删记录。
    label: job.output ? "删除这张图" : "删除这条记录",
    danger: true,
    run: () => removeJob(job.id),
  });
  showMenu(event, items);
}

/** 上下文菜单的渲染与贴边定位：图片和布局框共用这一份。 */
function showMenu(event, items) {
  const menu = nodes.ctxMenu;
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
  setDock(true);
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
/** 把一张已出的图当底图：侧栏管提交参数，画布这边同时把图摆上。 */
function useAsReference(job) {
  if (!job?.output) return;
  setDock(true);
  void openEditFromJob(job);
}

/** 从输出文件取回像素，走和拖图进去同一条改图台路径。 */
async function openEditFromJob(job) {
  try {
    const response = await fetch(outputUrl(job.output));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    await openEditSheet(new window.File([blob], job.output, { type: blob.type || "image/png" }));
  } catch (error) {
    toast(`这张图打不开：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** 编辑参考：交给侧栏当 references 的第一张（需要编辑适配器在 LoRA 里）。 */
function useAsEditReference(job) {
  if (!job?.output) return;
  channel?.postMessage({ type: "edit-reference", name: job.output });
  setDock(true);
}

// ── 总渲染 ─────────────────────────────────────────────────────────────
function render(data) {
  latest = data;
  // 框属于底图：设置晚到时，已恢复过的框需要按当前画幅重算一次位置。
  if (!layoutRestored && data.settings && lay.boxes.length) {
    layoutRestored = true;
    if (lay.open) {
      laySheetSize();
      renderLayBoxes();
      renderLayInfo();
    }
  }
  // 开跑就收起布局层：让预览和结果露出来，框数据留着。
  if (data.engine?.active && lay.open) {
    lay.open = false;
    nodes.lay.hidden = true;
    lay.drag = null;
    nodes.layDraft.hidden = true;
  }
  // 布局开着时比例跟着底图：像素可以换，比例不能被改乱。
  pinLayoutRatio();
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
  renderChat();
  updateChatPreview();
  renderComposerModel();
  renderDownload(data);
  const newest = data.jobs.find((job) => job.status === "done" && job.output)?.id ?? null;
  if (newest && newest !== newestJobId) {
    newestJobId = newest;
    // 刚出一张：画布回到结果；正在抹蒙版时不抢画面。
    if (bootstrapped && edit.open && edit.mode === null) closeEditSheet();
    if (bootstrapped) selectedId = newest;
    // 结果要看的是会话里那条，不是画布上旧的那格：没在涂抹或框选就收起画布。
    if (bootstrapped && !edit.open && !lay.open && (dockOpen || document.body.classList.contains("dock-full"))) {
      document.body.classList.remove("dock-full");
      document.getElementById("chat-dock-full")?.classList.remove("on");
      setDock(false);
      if (currentView !== "chat") showView("chat");
      chatAtBottom = true;
      renderChat();
    }
  }
  // 服务端已经有这条在排：本地占位让位给真实记录。
  if (localPending) {
    const same = (data.jobs ?? []).some(
      (job) => (job.status === "running" || job.status === "queued") && (!localPending.prompt || job.prompt === localPending.prompt),
    );
    if (same) {
      localPending = null;
      renderChat.lastSig = "";
    }
  }
  bootstrapped = true;
  syncBaseSheet();
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
  void runSafe(() => post("/engine/stop"), "停止");
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
nodes.viewerEdit.addEventListener("click", () => {
  const job = viewerList[viewerIndex];
  if (!job) return;
  closeViewer();
  useAsReference(job);
});
nodes.viewerRef.addEventListener("click", () => {
  const job = viewerList[viewerIndex];
  if (!job) return;
  closeViewer();
  useAsEditReference(job);
});
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
  showView("chat");
  void loadGallery(true);
  // 侧栏那边存着底图与蒙版，起来之后问一遍当前状态。
  layChannel?.postMessage({ type: "edit-hello" });
  // 会话 id 由侧栏决定，起来先问一次。
  layChannel?.postMessage({ type: "conv-ask" });
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

// 装机后旧页面不会自己长出新代码：构建号变了就刷一次。
void (async () => {
  try {
    const response = await fetch("./build.json", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const stamp = String(data?.stamp ?? "");
    if (!stamp) return;
    const key = "hana-moss-studio:build:studio";
    const seen = localStorage.getItem(key);
    localStorage.setItem(key, stamp);
    if (seen && seen !== stamp) location.reload();
  } catch {
    /* 没有这个文件就当没有这回事 */
  }
})();
