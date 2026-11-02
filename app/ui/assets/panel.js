// 苔室侧栏：生成设置与运行状态都在这条侧栏里，工作区那边只留画布与画廊。
// 数据：GET /hana-moss-studio/state（轮询 1.5s）；写操作走同前缀的 POST 路由。
import { hana } from "./sdk.js";
import { startLive } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";
/** 引擎的真实上限：单边 4096、总量 4.2 MP。 */
const MAX_MP = 4.2;
// 引擎的硬边界：单边最小 256（256×256 ≈ 0.066MP）。
const MIN_MP = 0.06;
const MAX_SIDE = 4096;
// 刻度两端按「外端向上、内端向下」取整，中间一格 0.1。
// 刻度只表示位置，实际像素量还要再夹回 [MIN_MP, MAX_MP]。
const MP_NOTCH_MIN = Math.floor(MIN_MP * 10) / 10;
const MP_NOTCH_MAX = Math.ceil(MAX_MP * 10) / 10;
const MP_STEPS = Math.max(1, Math.round((MP_NOTCH_MAX - MP_NOTCH_MIN) * 10));

function mpNotchAt(pct) {
  const index = Math.min(MP_STEPS, Math.max(0, Math.round(pct * MP_STEPS)));
  return Number((MP_NOTCH_MIN + index * 0.1).toFixed(1));
}

function mpFromNotch(notch) {
  return Math.max(MIN_MP, Math.min(MAX_MP, notch));
}

/** 手动改了宽高，滑块也跟着挪到对应的那一格。 */
function syncNotchFromSize() {
  mpNotch = Math.max(
    MP_NOTCH_MIN,
    Math.min(MP_NOTCH_MAX, Number((Math.round(currentMP() * 10) / 10).toFixed(1))),
  );
}
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
/** 对齐到 16 之后比例会有千分之几的偏移，这点偏差仍然报标准名。
 *  再大就是真的不同了：1872×1936 是 3.3% 的偏离，不能再写 1:1。 */
const LABEL_TOLERANCE = 0.02;
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
  ratioNote: el("pn-ratio-note"),
  mpNote: el("pn-mp-note"),
  slider: el("pn-slider"),
  sliderFill: el("pn-slider-fill"),
  sliderThumb: el("pn-slider-thumb"),
  sizeNote: el("pn-size-note"),
  width: el("pn-width"),
  height: el("pn-height"),
  steps: el("pn-steps"),
  hiresSlider: el("pn-hires-slider"),
  hiresFill: el("pn-hires-fill"),
  hiresThumb: el("pn-hires-thumb"),
  hiresNote: el("pn-hires-note"),
  hiresSteps: el("pn-hires-steps"),
  cfg: el("pn-cfg"),
  seed: el("pn-seed"),
  generate: el("pn-generate"),
  memoryMode: el("pn-memory-mode"),
  tier: el("pn-tier"),
  errors: el("pn-errors"),
  engineVersion: el("pn-engine-version"),
};

let latest = null;
// 高清修正倍率，1 等于关闭。滑块上限按当前基础尺寸算，存的是用户选的倍率。
let hiresScale = 1;
// 正在拖哪个滑块（ratio / mp / hires）。拖动中不去搬其他两个的拇指，
// 否则改一项会看到另两项跟着跳。
let draggingName = null;
// 拖动开始时锁住另一个维度：拖比例时像素量不动，拖像素量时比例不动。
let pinnedMP = null;
let pinnedRatio = null;
// 滑块自己记住落在哪一格，而不是从实际像素量反算。
// 标准比下合法尺寸是稀疏的，靠它拖动才跟手；实际做得出来的值另报。
let mpNotch = 1;
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
  hiresScale = Math.max(1, Number(settings.defaults.hiresScale) || 1);
  nodes.hiresSteps.value = settings.defaults.hiresSteps ?? 0;
  syncNotchFromSize();
  renderSize();
}

/** 高清修正的上限：换算出的目标尺寸不能越过引擎那条线。
 *  超了就拖不动，所以滑块的最大值按当前基础尺寸算。 */
function hiresMax() {
  const width = Number(nodes.width.value) || 768;
  const height = Number(nodes.height.value) || 768;
  const sideLimit = MAX_SIDE / Math.max(width, height);
  const pixelLimit = Math.sqrt((MAX_MP * 1e6) / (width * height));
  // 两个硬限取更严的那个：单边 4096、总量 4.2MP。256×256 时约能到 ×8。
  return Math.max(1, Math.min(sideLimit, pixelLimit));
}

function currentMP() {
  const width = Number(nodes.width.value) || 768;
  const height = Number(nodes.height.value) || 768;
  return (width * height) / 1e6;
}

function currentRatio() {
  return (Number(nodes.width.value) || 768) / (Number(nodes.height.value) || 768);
}

/** 像素量定了宽高就定了：两边都取最近的 16 倍数。
 *  16:9 在 4.2MP 下得到 2720×1520（比例 1.789，偏差 0.66%），像素用得满；
 *  卡成精确 16:9 就只有 2560×1440（3.69MP），白白浪费 0.4MP。 */
function sizeFor(ratio, megapixels) {
  const spread = ratio >= 1 ? ratio : 1 / ratio;
  const clamp16 = (value) => Math.max(256, Math.round(value / 16) * 16);
  const short = clamp16(Math.sqrt((megapixels * 1e6) / spread));
  const long = clamp16(short * spread);
  return ratio >= 1 ? [long, short] : [short, long];
}

function setSize(width, height) {
  // 输入框里永远写合法值：取整后擦线超上限的（2736×1536 = 4.20MP）在这里收掉。
  const fitted = fitToEngine(width, height);
  nodes.width.value = fitted.width;
  nodes.height.value = fitted.height;
  renderSize();
}

/** 比例到滑条位置的映射走 log2，中点自然落在 1:1。 */
function ratioToT(ratio) {
  return (Math.log2(ratio) - RATIO_LOG_LO) / RATIO_LOG_SPAN;
}

function tToRatio(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return snapRatio(2 ** (RATIO_LOG_LO + clamped * RATIO_LOG_SPAN));
}

/** 接近标准比就抬到标准比本身。
 *  拖动中会把它锁存起来重用，不抬的话 53:30 这种偏差会一直带着走。 */
function snapRatio(ratio) {
  for (const snap of RATIO_SNAPS) {
    if (Math.abs(ratio - snap.value) / snap.value <= SNAP_TOLERANCE) return snap.value;
  }
  return ratio;
}

/** 拇指只报拖动会落到的目标比：标准比优先，否则写数值。 */
function ratioLabel(ratio) {
  for (const snap of RATIO_SNAPS) {
    if (Math.abs(ratio - snap.value) / snap.value <= LABEL_TOLERANCE) return snap.label;
  }
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}

/** 右侧报实际宽高的约分比，不做标准比匹配、不限位数：2000×2080 就是 25:26。 */
function simplifyRatio(width, height) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(width, height) || 1;
  return `${width / g}:${height / g}`;
}

function placeThumb(container, thumb, pct) {
  // 拖动期间用按下那一刻量好的宽度：否则每次都要读 clientWidth，
  // 而旁边刚写过样式，会反复触发同步布局。
  const total = container.__dragWidth ?? container.clientWidth;
  const usable = Math.max(0, total - THUMB);
  const x = THUMB / 2 + pct * usable;
  thumb.style.left = `${x}px`;
  return x;
}

/** 滑块的右端取实际上限的上整：上限 ×1.35 时轨道铺到 ×1.4，
 *  拖到底就停在那里，那个刻度实际只做得到 ×1.35。 */
function hiresSteps(maxScale) {
  return Math.max(1, Math.ceil(maxScale * 10 - 1e-9) - 10);
}

function hiresAt(pct, maxScale) {
  const steps = hiresSteps(maxScale);
  const index = Math.min(steps, Math.max(0, Math.round(pct * steps)));
  return Number((1 + index * 0.1).toFixed(2));
}

function quantizeHires(value, maxScale) {
  if (maxScale <= 1.001) return 1;
  const index = Math.min(hiresSteps(maxScale), Math.max(0, Math.round((value - 1) / 0.1)));
  return Number((1 + index * 0.1).toFixed(2));
}

/** 跟后端同一套收敛规则：单边与总量取更严的缩放系数，比例不变。 */
function fitToEngine(width, height) {
  const MAX_PIXELS = 4.2e6;
  const floor16 = (value) => Math.max(256, Math.floor(value / 16) * 16);
  const sourceW = Math.max(256, width);
  const sourceH = Math.max(256, height);
  const sideScale = Math.min(1, MAX_SIDE / Math.max(sourceW, sourceH));
  const pixelScale = sourceW * sourceH > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (sourceW * sourceH)) : 1;
  const scale = Math.min(sideScale, pixelScale);
  let w = floor16(sourceW * scale);
  let h = floor16(sourceH * scale);
  while ((w * h > MAX_PIXELS || w > MAX_SIDE || h > MAX_SIDE) && w > 256 && h > 256) {
    if (w >= h) w = floor16(w - 16);
    else h = floor16(h - 16);
  }
  return { width: w, height: h, adjusted: w !== width || h !== height };
}

function renderSize() {
  const width = Number(nodes.width.value) || 768;
  const height = Number(nodes.height.value) || 768;
  const megapixels = (width * height) / 1e6;
  const ratio = width / height;

  // 拖像素量时，16 对齐会让宽高比微变，比例滑块跟着抖。
  // 这种情况按拖动开始时锁住的比例显示，松手后再回到真实值。
  const shownRatio = draggingName === "mp" && pinnedRatio ? pinnedRatio : ratio;

  const rx = placeThumb(nodes.ratioSlider, nodes.ratioThumb, ratioToT(shownRatio));
  nodes.ratioFill.style.width = `${rx}px`;
  nodes.ratioThumb.textContent = ratioLabel(shownRatio);
  nodes.ratioThumb.setAttribute("aria-valuenow", Math.log2(shownRatio).toFixed(2));
  nodes.ratioNote.textContent = simplifyRatio(width, height);

  // 拇指按滑块自己那一格定位，不从实际像素量反算：
  // 标准比下 3.6 实际只能做出 2.99，反算会让拇指从指针底下弹回去。
  const notchTop = MP_NOTCH_MAX;
  const notch = Math.max(MP_NOTCH_MIN, Math.min(notchTop, mpNotch));
  mpNotch = notch;
  const mpPct = (notch - MP_NOTCH_MIN) / (notchTop - MP_NOTCH_MIN);
  const mx = placeThumb(nodes.slider, nodes.sliderThumb, mpPct);
  nodes.sliderFill.style.width = `${mx}px`;
  nodes.sliderThumb.textContent = notch.toFixed(1);
  nodes.sliderThumb.setAttribute("aria-valuenow", megapixels.toFixed(2));
  nodes.mpNote.textContent = `${megapixels.toFixed(2)}MP`;

  // 这个位置报的是**最终出图尺寸**：含高清修正收后的结果，而不只是基础图。
  const base = fitToEngine(width, height);
  // 满格刻度可能仍超过实际上限：刻度 ×1.4 实际只做得到 ×1.35。
  // 拇指位置按刻度铺，右侧报实际能做到的值。
  const maxScale = hiresMax();
  // 基础尺寸变了，刻度上限也跟着变，旧倍率可能已经超过它。
  // 这里把值收到新刻度内，否则拇指上的数字会停在早就做不到的值上。
  hiresScale = quantizeHires(Math.min(Math.max(1, hiresScale), maxScale), maxScale);
  const notchMax = maxScale > 1.001 ? Math.ceil(maxScale * 10 - 1e-9) / 10 : 1;
  const effectiveScale = Math.min(hiresScale, maxScale);
  const hiresPct = notchMax > 1 ? Math.min(1, (hiresScale - 1) / (notchMax - 1)) : 0;
  const hx = placeThumb(nodes.hiresSlider, nodes.hiresThumb, hiresPct);
  nodes.hiresFill.style.width = `${hx}px`;
  // 拇指上写刻度（一位小数），右侧写实际能做的值。
  nodes.hiresThumb.textContent = `×${hiresScale.toFixed(1)}`;
  nodes.hiresThumb.setAttribute("aria-valuenow", hiresScale.toFixed(2));
  nodes.hiresThumb.setAttribute("aria-valuemax", notchMax.toFixed(2));
  nodes.hiresNote.textContent = hiresScale > 1.001
    ? `×${Number(effectiveScale.toFixed(2))}`
    : "关闭";
  nodes.hiresThumb.title = maxScale <= 1.001
    ? "这张图已经贴到引擎上限，没法再放大"
    : `最多 ×${maxScale.toFixed(2)}`;

  let finalW = base.width;
  let finalH = base.height;
  if (effectiveScale > 1.001) {
    const round16 = (value) => Math.max(16, Math.round(value / 16) * 16);
    const target = fitToEngine(round16(base.width * effectiveScale), round16(base.height * effectiveScale));
    if (target.width > base.width || target.height > base.height) {
      finalW = target.width;
      finalH = target.height;
    }
  }
  const finalMP = (finalW * finalH) / 1e6;
  const differs = finalW !== base.width || finalH !== base.height;
  // 写成 w × h × 倍率 → 最终尺寸，一眼看出倍率起了多大作用。
  const scaleLabel = effectiveScale > 1.001 ? ` ×${Number(effectiveScale.toFixed(2))}` : "";
  nodes.sizeNote.textContent = differs || base.adjusted || scaleLabel
    ? `${width}×${height}${scaleLabel} → ${finalW}×${finalH} · ${finalMP.toFixed(2)}MP`
    : `${width}×${height} · ${finalMP.toFixed(2)}MP`;
  nodes.sizeNote.className = base.adjusted ? "hint bad" : "hint";

  // 容器还没撑开（切视图的中间帧）时，下一帧再量一次就够，
  // 不能在这里递归自己：宽度一直是 0 的话会每帧重跑一遍整块渲染。
  if (!nodes.slider.clientWidth) setTimeout(renderSize, 40);
}

function pctFromEvent(container, clientX) {
  const rect = container.__dragRect ?? container.getBoundingClientRect();
  const usable = Math.max(1, rect.width - THUMB);
  return Math.min(1, Math.max(0, (clientX - rect.left - THUMB / 2) / usable));
}

function bindSizeSliders() {
  // 拖比例时锁住像素量、拖像素量时锁住比例：
  // 每次拿刚取整过的宽高比再算一遍，floor 的误差会一步步累积，
  // 拖一会儿比例就塌到 1:1。锁存变量在模块级，renderSize 也要读。

  function applyRatio(clientX) {
    const ratio = tToRatio(pctFromEvent(nodes.ratioSlider, clientX));
    const notch = Math.min(MP_NOTCH_MAX, Math.max(MP_NOTCH_MIN, pinnedMP ?? mpNotch));
    const [w, h] = sizeFor(ratio, mpFromNotch(notch));
    setSize(w, h);
  }

  function applyMP(clientX) {
    // 当前比例接近标准比就先抬到标准比：不然 2544×1440 这类偏差会一直传下去。
    const ratio = snapRatio(pinnedRatio ?? currentRatio());
    mpNotch = mpNotchAt(pctFromEvent(nodes.slider, clientX));
    const [w, h] = sizeFor(ratio, mpFromNotch(mpNotch));
    setSize(w, h);
  }

  function applyHires(clientX) {
    const maxScale = hiresMax();
    hiresScale = maxScale <= 1.001 ? 1 : hiresAt(pctFromEvent(nodes.hiresSlider, clientX), maxScale);
    renderSize();
    scheduleSave();
  }

  function bindDrag(container, name, apply) {
    let dragging = false;
    let rafId = 0;
    let pendingX = 0;
    // pointermove 每秒会给上百个事件，每个都跑一遍渲染会明显拖手。
    // 只记最新坐标，下一帧统一处理。
    const flush = () => {
      rafId = 0;
      apply(pendingX);
    };
    container.addEventListener("pointerdown", (event) => {
      dragging = true;
      draggingName = name;
      pinnedMP = mpNotch;
      pinnedRatio = currentRatio();
      // 量一次就够：拖动中容器尺寸不会变。
      container.__dragRect = container.getBoundingClientRect();
      container.__dragWidth = container.clientWidth;
      container.setPointerCapture?.(event.pointerId);
      pendingX = event.clientX;
      apply(pendingX);
    });
    container.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      pendingX = event.clientX;
      if (!rafId) rafId = requestAnimationFrame(flush);
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      draggingName = null;
      pinnedMP = null;
      pinnedRatio = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      delete container.__dragRect;
      delete container.__dragWidth;
      // 松手后把三个滑块一起归位，拖动期间没搬的那两个在这里补上。
      renderSize();
    };
    container.addEventListener("pointerup", stop);
    container.addEventListener("pointercancel", stop);
  }

  bindDrag(nodes.ratioSlider, "ratio", applyRatio);
  bindDrag(nodes.slider, "mp", applyMP);
  bindDrag(nodes.hiresSlider, "hires", applyHires);

  nodes.hiresThumb.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.5 : 0.1;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") hiresScale -= step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") hiresScale += step;
    else return;
    event.preventDefault();
    hiresScale = quantizeHires(hiresScale, hiresMax());
    renderSize();
    scheduleSave();
  });
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
  const effectiveScale = Math.min(hiresScale, hiresMax());
  if (effectiveScale > 1.001) {
    payload.hiresScale = Math.round(effectiveScale * 100) / 100;
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
  nodes.hiresSteps,
  nodes.memoryMode,
  nodes.tier,
]) {
  node.addEventListener("input", scheduleSave);
  node.addEventListener("change", scheduleSave);
}

// 手敲宽高滑块不动，这里把刻度跟着实际像素量对齐。
for (const node of [nodes.width, nodes.height]) {
  node.addEventListener("input", () => {
    syncNotchFromSize();
    renderSize();
  });
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
