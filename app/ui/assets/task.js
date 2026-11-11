// 苔室流内进度卡：工具提交出图后挂在对话里，跟着任务走。
// 身份：宿主 surface 上下文里的 cardInstanceId（卡页 route 静态，id 反查任务）；
// 数据：GET /hana-moss-studio/task?cardId=<卡实例 id>，轮询到终态后放慢。
import { hana } from "./sdk.js";
import { startLive, outputUrl } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";
const CARD_WIDTH = 460;

const root = document.getElementById("tk-root");
const lightbox = document.getElementById("tk-lightbox");
const lightboxImage = lightbox ? lightbox.querySelector("img") : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

let identity = null;
let resolving = null;
let lastData = null;
let pollTimer = null;
let tickTimer = null;
let shotUrl = null;
let shotName = null;

const TERMINAL = new Set(["done", "error", "cancelled"]);

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function syncTheme() {
  applyTheme(hana);
}

function formatDuration(ms) {
  if (!num(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function chipClass(status) {
  if (status === "done") return "chip ok";
  if (status === "error" || status === "cancelled") return "chip bad";
  if (status === "running" || status === "queued") return "chip run";
  return "chip";
}

function errorHint(text) {
  if (!text) return "";
  if (/out of memory|\boom\b|cuda.*memory|显存|内存不足/i.test(text)) {
    return "像是显存不足：把分辨率或步数降下来再试，或先关掉别的占显存程序。";
  }
  if (/模型目录|model_path|diffusers/i.test(text)) {
    return "模型目录没配好：到苔室「运行信息」里指向 diffusers 根目录（含 model_index.json）。";
  }
  if (/moss-server|可执行|spawn|ENOENT/i.test(text)) {
    return "引擎没起来：确认 moss-server 路径指向包内的 bin\\moss-server.exe。";
  }
  if (/cuBLASLt|cublaslt/i.test(text)) {
    return "缺 cuBLASLt：换自带 CUDA 的引擎包，或把 cublasLt64_13.dll 放进引擎 bin 目录。";
  }
  if (/取消|cancel|中断/i.test(text)) return "任务被取消；需要的话重新提交一次。";
  return "引擎日志里有完整原因；改好后重新提交即可。";
}

// ── 骨架：一次建好，之后只改文本与属性，避免整块重绘闪烁 ──────────────────
const view = {};
function build() {
  if (view.title?.isConnected) return;
  root.innerHTML = `
    <div class="tk-head">
      <span class="tk-title"></span>
      <span class="tk-elapsed"></span>
      <span class="chip"></span>
    </div>
    <p class="tk-prompt"></p>
    <div class="tk-meta"></div>
    <div class="bar"><i></i></div>
    <div class="tk-stages"></div>
    <div class="tk-stage-cap"></div>
    <div class="tk-result" hidden>
      <div class="tk-shot"></div>
      <div class="tk-facts"></div>
    </div>
    <div class="tk-err" hidden></div>
    <div class="tk-hint" hidden></div>
    <div class="tk-foot"><span class="tk-foot-left"></span><span class="tk-foot-right"></span></div>`;
  view.title = root.querySelector(".tk-title");
  view.elapsed = root.querySelector(".tk-elapsed");
  view.chip = root.querySelector(".chip");
  view.prompt = root.querySelector(".tk-prompt");
  view.meta = root.querySelector(".tk-meta");
  view.bar = root.querySelector(".bar");
  view.barFill = view.bar.querySelector("i");
  view.stages = root.querySelector(".tk-stages");
  view.stageCap = root.querySelector(".tk-stage-cap");
  view.result = root.querySelector(".tk-result");
  view.shot = root.querySelector(".tk-shot");
  view.facts = root.querySelector(".tk-facts");
  view.error = root.querySelector(".tk-err");
  view.hint = root.querySelector(".tk-hint");
  view.footLeft = root.querySelector(".tk-foot-left");
  view.footRight = root.querySelector(".tk-foot-right");
  view.stageEls = [];
  view.stageSig = "";
  view.factSig = "";
}

function renderNote(text) {
  view.title = null;
  root.innerHTML = `<div class="tk-head"><span class="tk-title">苔室出图</span><span class="chip">—</span></div><p class="tk-note">${esc(text)}</p>`;
  reportSize(true);
}

function renderStages(job) {
  const timeline = Array.isArray(job.timeline) ? job.timeline : [];
  const sig = timeline.map((stage) => `${stage.key}:${stage.state}`).join("|");
  if (!timeline.length) {
    view.stages.hidden = true;
    view.stageCap.hidden = true;
    return;
  }
  view.stages.hidden = false;
  view.stageCap.hidden = false;
  if (sig !== view.stageSig) {
    view.stageSig = sig;
    if (view.stageEls.length !== timeline.length) {
      view.stages.innerHTML = "";
      view.stageEls = timeline.map(() => {
        const node = document.createElement("div");
        view.stages.appendChild(node);
        return node;
      });
    }
    timeline.forEach((stage, index) => {
      view.stageEls[index].className = `tk-stage ${stage.state}`;
      view.stageEls[index].title = stage.label;
    });
  }
  const current = timeline.find((stage) => stage.state === "current");
  const parts = [];
  if (current) parts.push(current.label);
  else if (job.status === "done") parts.push("全部阶段完成");
  if (job.total) parts.push(`第 ${job.step}/${job.total} 步`);
  view.stageCap.textContent = parts.join(" · ");
}

function renderMeta(job) {
  const items = [];
  if (job.queuePosition) items.push(["队列", `前 ${job.queuePosition}`]);
  if (job.total) items.push(["步进", `${job.step}/${job.total}`]);
  if (num(job.etaMs)) items.push(["预计", `剩 ${formatDuration(job.etaMs)}`]);
  items.push(["尺寸", `${job.width}×${job.height}`]);
  // 采样面与 LoRA 也算「这张是怎么来的」，出图后要能一眼看到。
  if (job.sampler) items.push(["采样", `${job.sampler}${job.scheduler ? ` / ${job.scheduler}` : ""}`]);
  if (Array.isArray(job.loras) && job.loras.length) items.push(["LoRA", `${job.loras.length} 个`]);
  const html = items.map(([label, value]) => `<span class="m">${esc(label)}<b>${esc(value)}</b></span>`).join("");
  if (view.meta.innerHTML !== html) view.meta.innerHTML = html;
}

function ensureShot(name) {
  if (!name || shotName === name) return shotUrl;
  shotUrl = outputUrl(name);
  shotName = name;
  return shotUrl;
}

async function renderResult(job) {
  if (job.status !== "done" || !job.output) {
    view.result.hidden = true;
    return;
  }
  const url = await ensureShot(job.output);
  view.result.hidden = false;
  if (url) {
    if (!view.shot.querySelector("img")) {
      const image = document.createElement("img");
      image.alt = "出图结果";
      image.addEventListener("click", () => openLightbox(url));
      view.shot.replaceChildren(image);
    }
    const image = view.shot.querySelector("img");
    if (image.getAttribute("src") !== url) image.src = url;
  } else {
    view.shot.textContent = "预览不可用";
  }
  const facts = [
    `种子 <b>${esc(job.seed)}</b>`,
    `${esc(job.steps)} 步 · CFG ${esc(job.cfg)}`,
    `用时 <b>${esc(formatDuration(job.elapsedMs))}</b>`,
  ];
  const sig = facts.join("|");
  if (sig !== view.factSig) {
    view.factSig = sig;
    view.facts.innerHTML = `<span>${facts[0]}</span><span>${facts[1]}</span><span>${facts[2]}</span>`;
  }
}

function openLightbox(url) {
  if (!lightbox || !lightboxImage) return;
  lightboxImage.src = url;
  lightbox.hidden = false;
}

async function render(data) {
  lastData = data;
  if (!data || !data.ok) {
    renderNote(`读取失败：${data?.error ?? "未知错误"}`);
    return;
  }
  if (!data.found) {
    renderNote("找不到这条任务记录：可能已超出内存保留范围。出图结果仍在苔室画廊里。");
    return;
  }
  const job = data.job;
  build();
  const terminal = TERMINAL.has(job.status);

  view.title.textContent = `${job.width}×${job.height} · ${job.steps} 步`;
  view.title.title = job.prompt;
  view.chip.textContent = job.statusText;
  view.chip.className = chipClass(job.status);
  const elapsed = job.status === "running" && job.submittedAt ? Date.now() - Date.parse(job.submittedAt) : job.elapsedMs;
  view.elapsed.textContent = formatDuration(elapsed);

  view.prompt.textContent = job.prompt;
  view.prompt.title = job.prompt;

  renderMeta(job);
  renderStages(job);

  const percent = job.status === "done" ? 100 : job.percent || 0;
  view.bar.classList.toggle("indeterminate", percent <= 0 && !terminal);
  view.barFill.style.width = percent > 0 ? `${percent}%` : "36%";

  await renderResult(job);

  const errorText = job.status === "error" ? (job.error ?? "生成失败") : job.status === "cancelled" ? "任务已取消。" : "";
  view.error.textContent = errorText;
  view.error.hidden = !errorText;
  view.hint.textContent = errorText ? errorHint(job.error ?? "") : "";
  view.hint.hidden = !errorText;

  view.footLeft.textContent = terminal ? "任务已结束。" : job.statusText === "排队中" ? "排队中，轮到时自动开始。" : "自动刷新中…";
  view.footRight.textContent = job.taskNote ?? "";

  reportSize();
  if (terminal) [0, 900, 2200].forEach((delay) => setTimeout(() => reportSize(true), delay));
}

// ── 尺寸上报 ─────────────────────────────────────────────────────────────
let lastReportedHeight = 0;
function reportSize(force) {
  const height = Math.ceil(document.body ? document.body.scrollHeight : 0);
  if (!height || height < 40) return;
  if (!force && height === lastReportedHeight) return;
  lastReportedHeight = height;
  try {
    hana.ui?.resize?.({ height, width: CARD_WIDTH });
  } catch {
    /* 老宿主没这条路 */
  }
  try {
    window.parent.postMessage({ type: "hana.card-resize", height }, "*");
  } catch {
    /* 非 iframe 环境 */
  }
}

// ── 身份 ─────────────────────────────────────────────────────────────────
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
async function resolveIdentity() {
  const query = new URLSearchParams(location.search);
  const fromQuery = (query.get("id") || query.get("jobId") || "").trim();
  if (fromQuery) return { kind: "job", value: fromQuery };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (identity) return identity;
    let context = null;
    try {
      context = hana.surface?.getContext?.() ?? null;
    } catch {
      context = null;
    }
    const cardId = typeof context?.cardInstanceId === "string" ? context.cardInstanceId.trim() : "";
    if (cardId) return { kind: "card", value: cardId };
    await sleep(150);
  }
  return null;
}

function retryIdentity() {
  if (identity) return Promise.resolve(identity);
  if (!resolving) {
    resolving = resolveIdentity().then(
      (value) => {
        resolving = null;
        if (value) identity = value;
        return value;
      },
      () => {
        resolving = null;
        return null;
      },
    );
  }
  return resolving;
}

function subscribeContext() {
  try {
    hana.surface?.onContextChanged?.((context) => {
      const cardId = typeof context?.cardInstanceId === "string" ? context.cardInstanceId.trim() : "";
      if (!cardId || identity) return;
      identity = { kind: "card", value: cardId };
      void poll();
    });
  } catch {
    /* 订阅不可用，靠轮询自愈 */
  }
}

// ── 轮询 ─────────────────────────────────────────────────────────────────
let inFlight = false;
let liveDispose = null;
let liveReady = false;
let lastSignal = "";
/** 小帧驱动的拉取节流：progress 一步一条，不必每次都去问 /task。 */
let lastPollAt = 0;

function signalOf(state, cardId) {
  const job = state?.jobs?.find((item) => item.cardId === cardId);
  if (!job) return null;
  const progress = state.progress?.[job.id] ?? null;
  return [job.status, progress?.phase ?? "", progress?.step ?? "", progress?.percent ?? ""].join(":");
}

function ensureLive() {
  if (liveDispose || identity?.kind !== "card") return;
  liveDispose = startLive({
    hana,
    onState: (state) => {
      liveReady = true;
      const signal = signalOf(state, identity.value);
      if (!signal || signal === lastSignal) return;
      lastSignal = signal;
      void poll();
    },
    onEvent: (name) => {
      // 步进与下载不再推整帧 state，卡片靠这两条小帧跟上。
      if (name !== "progress" && name !== "transfer") return;
      if (Date.now() - lastPollAt < 600) return;
      lastPollAt = Date.now();
      void poll();
    },
    onError: () => {
      // 事件流不可用时保留慢轮询兜底。
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => void poll(), 1500);
    },
  });
}

async function poll() {
  if (inFlight) return;
  inFlight = true;
  try {
    if (!identity) identity = await retryIdentity();
    if (!identity) {
      renderNote("正在等待卡片上下文…");
      schedule(null);
      return;
    }
    ensureLive();
    const query = identity.kind === "card" ? `cardId=${encodeURIComponent(identity.value)}` : `job=${encodeURIComponent(identity.value)}`;
    try {
      // 本机偶发 ENOBUFS 时 fetch 会一直挂着，没有超时就会永远停在“读取中”。
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 8000);
      let response;
      try {
        response = await hana.api.fetch(`${API}/task?${query}`, { cache: "no-store", signal: controller.signal });
      } finally {
        clearTimeout(abortTimer);
      }
      const data = await response.json();
      await render(data);
      schedule(data);
    } catch (error) {
      // 单次请求失败（本机偶发 ENOBUFS / 连接被断）不抹掉已经画好的内容，稍后重试。
      noteFailure(error);
      schedule(null);
    }
  } finally {
    inFlight = false;
  }
}

function noteFailure(error) {
  const text = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  if (!lastData?.ok) {
    renderNote(text);
    return;
  }
  if (view.footLeft) view.footLeft.textContent = `${text}，重试中…`;
}

function schedule(data) {
  const done = data?.ok && data.found && TERMINAL.has(data.job.status);
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (done) {
    // 任务落定后不再轮询：结果已经在手里了。
    liveDispose?.();
    liveDispose = null;
    return;
  }
  // 请求失败就自己排一次重试；事件流在推的时候不排定时器，没连上才用慢轮询兜底。
  if (!data) {
    pollTimer = setTimeout(() => void poll(), 2000);
    return;
  }
  if (!liveReady) pollTimer = setTimeout(() => void poll(), 1500);
}

async function main() {
  syncTheme();
  try {
    hana.theme?.subscribe?.(() => syncTheme());
  } catch {
    /* 忽略 */
  }
  try {
    // 宿主握手可能卡住（换 App 实例后尤其常见），不能让它把首帧渲染也拖死。
    await withTimeout(hana.ready(), 5000);
  } catch {
    /* 非宿主环境 */
  }
  if (typeof ResizeObserver !== "undefined") {
    try {
      new ResizeObserver(() => reportSize()).observe(root);
    } catch {
      /* 忽略 */
    }
  }
  tickTimer = setInterval(() => {
    const job = lastData?.job;
    if (!view.elapsed?.isConnected || !job) return;
    if (job.status === "running" && job.submittedAt) view.elapsed.textContent = formatDuration(Date.now() - Date.parse(job.submittedAt));
  }, 1000);
  if (lightbox) lightbox.addEventListener("click", () => {
    lightbox.hidden = true;
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lightbox && !lightbox.hidden) lightbox.hidden = true;
  });
  subscribeContext();
  void poll();
}

void main();
