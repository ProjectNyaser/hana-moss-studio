// 苔室侧栏：生成设置与运行状态都在这条侧栏里，工作区那边只留画布与画廊。
// 数据：GET /hana-moss-studio/state（轮询 1.5s）；写操作走同前缀的 POST 路由。
import { hana } from "./sdk.js";
import { startLive } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";
/** 引擎的真实上限：单边 4096、总量 4.2 MP。 */
const MAX_MP = 4.2;
const MIN_MP = 0.3;
const MAX_SIDE = 4096;
/** 比例滑条的值域：9:16 到 16:9。取 log2 后左右对称，中点正好是 1:1。 */
const RATIO_MIN = 9 / 16;
const RATIO_MAX = 16 / 9;
const RATIO_LOG_LO = Math.log2(RATIO_MIN);
const RATIO_LOG_SPAN = Math.log2(RATIO_MAX) - RATIO_LOG_LO;
/** 拖到这七个点上自动吸住，免得 4:3 永远差一点。 */
const RATIO_SNAPS = [
  { value: 9 / 16, label: "9:16" },
  { value: 2 / 3, label: "2:3" },
  { value: 3 / 4, label: "3:4" },
  { value: 1, label: "1:1" },
  { value: 4 / 3, label: "4:3" },
  { value: 3 / 2, label: "3:2" },
  { value: 16 / 9, label: "16:9" },
];
const SNAP_TOLERANCE = 0.03;
/** 对齐到 16 后实际比例会略偏（短边越小偏得越多），标签要认这个偏差。 */
const LABEL_TOLERANCE = 0.04;
/** 滑块宽 42px，轨道两端要预留它的一半。 */
const THUMB = 42;
const ROLE_LABEL = { dit: "主模型", text_encoder: "文本编码器", vae: "VAE", support: "流水线" };

const el = (id) => document.getElementById(id);
const nodes = {
  dot: el("pn-dot"),
  state: el("pn-state"),
  message: el("pn-message"),
  jobBlock: el("pn-job-block"),
  jobPrompt: el("pn-job-prompt"),
  bar: el("pn-bar"),
  jobStage: el("pn-job-stage"),
  jobEta: el("pn-job-eta"),
  cancel: el("pn-cancel"),
  prompt: el("pn-prompt"),
  negative: el("pn-negative"),
  ratioSlider: el("pn-ratio-slider"),
  ratioFill: el("pn-ratio-fill"),
  ratioThumb: el("pn-ratio-thumb"),
  slider: el("pn-slider"),
  sliderFill: el("pn-slider-fill"),
  sliderThumb: el("pn-slider-thumb"),
  sizeNote: el("pn-size-note"),
  width: el("pn-width"),
  height: el("pn-height"),
  steps: el("pn-steps"),
  hires: el("pn-hires"),
  hiresSteps: el("pn-hires-steps"),
  cfg: el("pn-cfg"),
  seed: el("pn-seed"),
  reroll: el("pn-reroll"),
  generate: el("pn-generate"),
  memoryMode: el("pn-memory-mode"),
  tier: el("pn-tier"),
  errors: el("pn-errors"),
  engineVersion: el("pn-engine-version"),
};

let latest = null;
let settingsLoaded = false;
/** 正在发 /generate 请求的瞬间，按钮短暂禁用，避免连点堆任务。 */
let submitting = false;

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

function say(text, kind) {
  nodes.message.textContent = text;
  nodes.message.className = kind ? `hint ${kind}` : "hint";
}

// ── 格式化 ─────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

function setSettings(settings) {
  if (settingsLoaded) return;
  settingsLoaded = true;
  nodes.memoryMode.value = settings.memoryMode;
  nodes.tier.value = settings.tier;
  nodes.width.value = settings.defaults.width;
  nodes.height.value = settings.defaults.height;
  nodes.steps.value = settings.defaults.steps;
  nodes.cfg.value = settings.defaults.cfg;
  nodes.hires.value = String(settings.defaults.hiresScale ?? 0);
  nodes.hiresSteps.value = settings.defaults.hiresSteps ?? 0;
  renderSize();
}

function currentMP() {
  const width = Number(nodes.width.value) || 768;
  const height = Number(nodes.height.value) || 768;
  return (width * height) / 1e6;
}

function currentRatio() {
  return (Number(nodes.width.value) || 768) / (Number(nodes.height.value) || 768);
}

/** 像素量定了，宽高就定了：短边取 16 的倍数，长边按比例算。
 *  两边都向下取整：向上凑那一刻就会把总像素顶过上限（4.2MP → 2752×1536 = 4.23MP）。 */
function sizeFor(ratio, megapixels) {
  const spread = ratio >= 1 ? ratio : 1 / ratio;
  const short = Math.max(256, Math.floor(Math.sqrt((megapixels * 1e6) / spread) / 16) * 16);
  const long = Math.floor((short * spread) / 16) * 16;
  return ratio >= 1 ? [long, short] : [short, long];
}

function setSize(width, height) {
  nodes.width.value = width;
  nodes.height.value = height;
  renderSize();
}

/** 比例到滑条位置的映射走 log2，中点自然落在 1:1。 */
function ratioToT(ratio) {
  return (Math.log2(ratio) - RATIO_LOG_LO) / RATIO_LOG_SPAN;
}

function tToRatio(t) {
  const clamped = Math.min(1, Math.max(0, t));
  const ratio = 2 ** (RATIO_LOG_LO + clamped * RATIO_LOG_SPAN);
  for (const snap of RATIO_SNAPS) {
    if (Math.abs(ratio - snap.value) / snap.value <= SNAP_TOLERANCE) return snap.value;
  }
  return ratio;
}

/** 先认标准比，认不出才用连分数还原：宽高对齐到 16 之后，16:9 实际是 25:14 这种鬼数。 */
function ratioLabel(ratio) {
  for (const snap of RATIO_SNAPS) {
    if (Math.abs(ratio - snap.value) / snap.value <= LABEL_TOLERANCE) return snap.label;
  }
  let best = { n: 1, d: 1, err: Infinity };
  for (let d = 1; d <= 24; d += 1) {
    const n = Math.round(ratio * d);
    if (n < 1) continue;
    const err = Math.abs(ratio - n / d);
    if (err < best.err) best = { n, d, err };
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(best.n, best.d) || 1;
  return `${best.n / g}:${best.d / g}`;
}

function placeThumb(container, thumb, pct) {
  const usable = Math.max(0, container.clientWidth - THUMB);
  const x = THUMB / 2 + pct * usable;
  thumb.style.left = `${x}px`;
  return x;
}

function renderSize() {
  const width = Number(nodes.width.value) || 768;
  const height = Number(nodes.height.value) || 768;
  const megapixels = (width * height) / 1e6;
  const ratio = width / height;

  const rx = placeThumb(nodes.ratioSlider, nodes.ratioThumb, ratioToT(ratio));
  nodes.ratioFill.style.width = `${rx}px`;
  nodes.ratioThumb.textContent = ratioLabel(ratio);
  nodes.ratioThumb.setAttribute("aria-valuenow", Math.log2(ratio).toFixed(2));

  const mpPct = Math.min(1, Math.max(0, (megapixels - MIN_MP) / (MAX_MP - MIN_MP)));
  const mx = placeThumb(nodes.slider, nodes.sliderThumb, mpPct);
  nodes.sliderFill.style.width = `${mx}px`;
  nodes.sliderThumb.textContent = megapixels.toFixed(1);
  nodes.sliderThumb.setAttribute("aria-valuenow", megapixels.toFixed(1));

  const over = megapixels > MAX_MP || Math.max(width, height) > MAX_SIDE;
  nodes.sizeNote.textContent = over
    ? `${width}×${height} · ${megapixels.toFixed(2)}MP，超出引擎上限（4.2MP / 单边 4096）`
    : `${width}×${height} · ${megapixels.toFixed(2)}MP`;
  nodes.sizeNote.className = over ? "hint bad" : "hint";

  // 首次渲染时布局可能还没落定，宽度为零就等下一帧重算。
  if (!nodes.slider.clientWidth) requestAnimationFrame(renderSize);
}

function pctFromEvent(container, clientX) {
  const rect = container.getBoundingClientRect();
  const usable = Math.max(1, rect.width - THUMB);
  return Math.min(1, Math.max(0, (clientX - rect.left - THUMB / 2) / usable));
}

function bindSizeSliders() {
  // 拖比例时锁住像素量：横竖一换，付出去的算力不该跟着变。
  let pinnedMP = null;

  function applyRatio(clientX) {
    const ratio = tToRatio(pctFromEvent(nodes.ratioSlider, clientX));
    const megapixels = Math.min(MAX_MP, Math.max(MIN_MP, pinnedMP ?? currentMP()));
    const [w, h] = sizeFor(ratio, megapixels);
    setSize(w, h);
  }

  function applyMP(clientX) {
    const [w, h] = sizeFor(currentRatio(), MIN_MP + pctFromEvent(nodes.slider, clientX) * (MAX_MP - MIN_MP));
    setSize(w, h);
  }

  function bindDrag(container, apply) {
    let dragging = false;
    container.addEventListener("pointerdown", (event) => {
      dragging = true;
      pinnedMP = currentMP();
      container.setPointerCapture?.(event.pointerId);
      apply(event.clientX);
    });
    container.addEventListener("pointermove", (event) => {
      if (dragging) apply(event.clientX);
    });
    const stop = () => {
      dragging = false;
      pinnedMP = null;
    };
    container.addEventListener("pointerup", stop);
    container.addEventListener("pointercancel", stop);
  }

  bindDrag(nodes.ratioSlider, applyRatio);
  bindDrag(nodes.slider, applyMP);

  nodes.ratioThumb.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.08 : 0.02;
    let t = ratioToT(currentRatio());
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") t -= step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") t += step;
    else return;
    event.preventDefault();
    const megapixels = Math.min(MAX_MP, Math.max(MIN_MP, currentMP()));
    const [w, h] = sizeFor(tToRatio(t), megapixels);
    setSize(w, h);
  });

  nodes.sliderThumb.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.5 : 0.1;
    let next = currentMP();
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next += step;
    else return;
    event.preventDefault();
    const [w, h] = sizeFor(currentRatio(), Math.min(MAX_MP, Math.max(MIN_MP, next)));
    setSize(w, h);
  });
}

/** serverPath → 引擎目录（去掉 bin/moss-server[.exe]）。 */
/** 侧栏只报状态：引擎跑没跑、模型加载了没。管理与下载都在主区域。 */
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
  nodes.dot.className = dotClass;
  nodes.state.textContent = label;
  nodes.state.title = engine.lastError ?? "";
  nodes.engineVersion.textContent = `引擎 ${data.mossimage?.version ?? "?"}`;
  nodes.engineVersion.title = `${data.mossimage?.repo ?? ""} · protocol ${data.mossimage?.protocolVersion ?? "?"}`;
}

function renderJob(data) {
  const active = data.engine.active;
  if (!active) {
    nodes.jobBlock.hidden = true;
    nodes.cancel.disabled = true;
    return;
  }
  const progress = active.progress ?? {};
  nodes.jobBlock.hidden = false;
  nodes.jobPrompt.textContent = progress.prompt ?? "";
  const percent = typeof progress.percent === "number" ? progress.percent : 0;
  nodes.bar.classList.toggle("indeterminate", percent <= 0);
  nodes.bar.querySelector("i").style.width = percent > 0 ? `${percent}%` : "36%";
  nodes.jobStage.textContent = `${progress.phase ?? "准备中"}${progress.total ? ` · ${progress.step}/${progress.total} 步` : ""}`;
  nodes.jobEta.textContent = progress.etaMs ? `剩 ${formatDuration(progress.etaMs)}` : progress.elapsedMs ? formatDuration(progress.elapsedMs) : "";
  nodes.cancel.disabled = false;
}

const PHASE_LABEL = {
  starting: "准备",
  probing: "探测显卡",
  release: "选包",
  listing: "读清单",
  download: "下载",
  verify: "校验",
  extracting: "解压",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
};

/** 安装区：没有任务时给一句提示，有任务时给进度与取消。 */
function render(data) {
  latest = data;
  setSettings(data.settings);
  renderEngine(data);
  renderJob(data);
  nodes.generate.disabled = submitting;
  // 忙的时候不禁用：串行队列排得下，按钮变成「加入队列」才有意义。
  const busy = Boolean(data.engine.active) || data.queue.length > 0;
  nodes.generate.textContent = busy ? "加入队列" : "开始生成";
  nodes.generate.title = busy ? "当前有任务在跑，点这里排到它后面" : "";
  const done = data.jobs.filter((job) => job.status === "done").length;
  const failed = data.jobs.filter((job) => job.status === "error").length;
  nodes.errors.textContent = failed ? `完成 ${done} · 失败 ${failed}` : done ? `完成 ${done}` : "";
}

async function refresh() {
  try {
    render(await api("/state"));
  } catch (error) {
    nodes.state.textContent = error instanceof Error ? error.message : String(error);
    nodes.dot.className = "dot err";
  }
}

// ── 交互 ───────────────────────────────────────────────────────────────
async function onGenerate() {
  const prompt = nodes.prompt.value.trim();
  if (!prompt) {
    say("先写一句提示词。", "bad");
    nodes.prompt.focus();
    return;
  }
  submitting = true;
  nodes.generate.disabled = true;
  say("已提交，排队中…");
  // 步数只挡 0 与负数，别再按 768px 的经验托高。
  const steps = Math.min(80, Math.max(1, Math.round(Number(nodes.steps.value) || 1)));
  nodes.steps.value = steps;
  const payload = {
    prompt,
    negativePrompt: nodes.negative.value,
    width: Number(nodes.width.value),
    height: Number(nodes.height.value),
    steps,
    cfg: Number(nodes.cfg.value),
  };
  const hiresScale = Number(nodes.hires.value) || 0;
  if (hiresScale > 0) {
    payload.hiresScale = hiresScale;
    const hiresSteps = Math.round(Number(nodes.hiresSteps.value) || 0);
    if (hiresSteps > 0) payload.hiresSteps = hiresSteps;
  }
  const seed = nodes.seed.value.trim();
  if (seed) payload.seed = Number(seed);
  try {
    const result = await post("/generate", payload);
    say(`已入队 ${result.job?.jobId ?? ""}`, "ok");
    render(result.state);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    submitting = false;
    nodes.generate.disabled = false;
  }
}

async function onCancel() {
  const active = latest?.engine?.active;
  if (!active) return;
  try {
    await post("/cancel", { id: active.jobId });
    say("已请求取消");
    void refresh();
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

// ── 参数自动保存 ─────────────────────────────────────────────────
// 参数改了就算默认，不再要求用户理解「保存」这个动作。防抖 800ms，拖动时也不会
// 把磁盘写穿。
let saveTimer = null;

function collectDefaults() {
  return {
    width: Number(nodes.width.value) || 768,
    height: Number(nodes.height.value) || 768,
    steps: Number(nodes.steps.value) || 8,
    cfg: Number(nodes.cfg.value) || 3,
    hiresScale: Number(nodes.hires.value) || 0,
    hiresSteps: Math.round(Number(nodes.hiresSteps.value) || 0),
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void post("/settings", {
      memoryMode: nodes.memoryMode.value,
      tier: nodes.tier.value,
      defaults: collectDefaults(),
    }).catch(() => {
      /* 存不进去也不打断手头的操作 */
    });
  }, 800);
}

for (const node of [
  nodes.width,
  nodes.height,
  nodes.steps,
  nodes.cfg,
  nodes.hires,
  nodes.hiresSteps,
  nodes.memoryMode,
  nodes.tier,
]) {
  node.addEventListener("input", scheduleSave);
  node.addEventListener("change", scheduleSave);
}

nodes.generate.addEventListener("click", onGenerate);
nodes.cancel.addEventListener("click", onCancel);
bindSizeSliders();

// ── 主区域的“用这张的参数” ─────────────────────────────────────
const reuseChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;

function applyReuse(job) {
  if (typeof job.prompt === "string") nodes.prompt.value = job.prompt;
  if (typeof job.negativePrompt === "string") nodes.negative.value = job.negativePrompt;
  if (job.width && job.height) setSize(job.width, job.height);
  if (job.steps) nodes.steps.value = String(job.steps);
  if (job.cfg) nodes.cfg.value = String(job.cfg);
  nodes.seed.value = job.seed != null && job.seed !== "" ? String(job.seed) : "";
  say("已载入这张的参数", "ok");
}

reuseChannel?.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type !== "reuse" || !data.job) return;
  applyReuse(data.job);
});

async function boot() {
  syncTheme();
  try {
    hana.theme?.subscribe?.(() => syncTheme());
  } catch {
    /* 老宿主没有主题订阅 */
  }
  try {
    // 宿主握手可能卡住（换 App 实例后尤其常见），不能让它把首帧也拖死。
    await withTimeout(hana.ready(), 5000);
  } catch {
    /* 非宿主环境 */
  }
  await refresh();
  startLive({
    hana,
    onState: (state) => render(state),
    fetchState: () => api("/state"),
    source: "panel",
    onError: (error) => {
      if (latest) return;
      nodes.state.textContent = error instanceof Error ? error.message : String(error);
      nodes.dot.className = "dot err";
    },
  });
}

void boot();
