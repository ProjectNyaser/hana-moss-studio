// 苔室侧栏：生成设置与运行状态都在这条侧栏里，工作区那边只留画布与画廊。
// 数据：GET /hana-moss-studio/state（轮询 1.5s）；写操作走同前缀的 POST 路由。
import { hana } from "./sdk.js";
import { startLive, inputUrl, outputUrl } from "./live.js";
import { applyTheme } from "./theme.js";

const API = "/hana-moss-studio";
/** 引擎的真实上限：单边 4096、总量 4.2 MP。 */
const MAX_MP = 4.2;
// 引擎的硬边界：单边最小 256（256×256 ≈ 0.066MP）。
const MIN_MP = 0.06;
const MAX_SIDE = 4096;
// 刻度两端都取上整：下端 0.1 就是真正能做到的那一格（0.11MP），
// 下整到 0.0 会多一格拖下去没变化的死格。
const MP_NOTCH_MIN = Math.ceil(MIN_MP * 10) / 10;
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
  cancel: el("pn-cancel"),
  memoryMode: el("pn-memory-mode"),
  tier: el("pn-tier"),
  model: el("pn-model"),
  modelField: el("pn-model-field"),
  modelHint: el("pn-model-hint"),
  dit: el("pn-dit"),
  ditNote: el("pn-dit-note"),
  te: el("pn-te"),
  errors: el("pn-errors"),
  sampler: el("pn-sampler"),
  scheduler: el("pn-scheduler"),
  shift: el("pn-shift"),
  stepCache: el("pn-step-cache"),
  stepThreshold: el("pn-step-threshold"),
  uncondLayers: el("pn-uncond-layers"),
  slgLayers: el("pn-slg-layers"),
  slgScale: el("pn-slg-scale"),
  slgStart: el("pn-slg-start"),
  slgStop: el("pn-slg-stop"),
  maxSeq: el("pn-max-seq"),
  flow: el("pn-flow"),
  noiseLayout: el("pn-noise-layout"),
  noiseSource: el("pn-noise-source"),
  eta: el("pn-eta"),
  sNoise: el("pn-s-noise"),
  dataspace: el("pn-dataspace"),
  distill: el("pn-distill"),
  advSamplingNote: el("pn-adv-sampling-note"),
  stepThresholdField: el("pn-threshold-field"),
  accelNote: el("pn-accel-note"),
  samplerNote: el("pn-sampler-note"),
  loraList: el("pn-lora-list"),
  loraNote: el("pn-lora-note"),
  loraImport: el("pn-lora-import"),
  loraFile: el("pn-lora-file"),
  loraPathShow: el("pn-lora-path-show"),
  loraPathRow: el("pn-lora-path-row"),
  loraPath: el("pn-lora-path"),
  loraPathAdd: el("pn-lora-path-add"),
  ref: el("pn-ref"),
  refImg: el("pn-ref-img"),
  refNote: el("pn-ref-note"),
  refClear: el("pn-ref-clear"),
  refPick: el("pn-ref-pick"),
  refFile: el("pn-ref-file"),
  dropHint: el("pn-drop"),
  refResize: el("pn-ref-resize"),
  strength: el("pn-strength"),
  maskEdit: el("pn-mask-edit"),
  mask: el("pn-mask"),
  maskInfo: el("pn-mask-info"),
  maskStage: el("pn-mask-stage"),
  maskCanvas: el("pn-mask-canvas"),
  maskSize: el("pn-mask-size"),
  maskPaint: el("pn-mask-paint"),
  maskErase: el("pn-mask-erase"),
  maskPct: el("pn-mask-pct"),
  maskClear: el("pn-mask-clear"),
  maskCancel: el("pn-mask-cancel"),
  maskSave: el("pn-mask-save"),
  maskZoomIn: el("pn-mask-zoom-in"),
  maskZoomOut: el("pn-mask-zoom-out"),
  maskZoomLabel: el("pn-mask-zoom-label"),
  editRefThumb: el("pn-editref-thumb"),
  editRefImg: el("pn-editref-img"),
  editRefNote: el("pn-editref-note"),
  editRefPick: el("pn-editref-pick"),
  editRefFile: el("pn-editref-file"),
  editRefClear: el("pn-editref-clear"),
  refControls: el("pn-ref-controls"),
  release: el("pn-release"),
  start: el("pn-start"),
  controlFold: el("pn-control-fold"),
  controlNote: el("pn-control-note"),
  controlAdapter: el("pn-control-adapter"),
  controlAdapterName: el("pn-control-adapter-name"),
  controlClear: el("pn-control-clear"),
  controlThumb: el("pn-control-thumb"),
  controlImg: el("pn-control-img"),
  controlImgClear: el("pn-control-img-clear"),
  controlImport: el("pn-control-import"),
  controlPick: el("pn-control-pick"),
  controlKind: el("pn-control-kind"),
  controlStrength: el("pn-control-strength"),
  controlLoraStrength: el("pn-control-lora-strength"),
  controlFile: el("pn-control-file"),
  controlImgFile: el("pn-control-img-file"),
  layoutNote: el("pn-layout-note"),
  layoutEdit: el("pn-layout-edit"),
  layoutImport: el("pn-layout-import"),
  layoutClear: el("pn-layout-clear"),
  layoutFile: el("pn-layout-file"),
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
async function api(path, init, timeoutMs = 10000) {
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

function say(text, kind) {
  nodes.message.textContent = text;
  nodes.message.className = kind ? `hint ${kind}` : "hint";
}

// ── 格式化 ─────────────────────────────────────────────────────────────

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
  fillMenus(settings.defaults);
  loras = Array.isArray(settings.defaults.loras) ? settings.defaults.loras.map((item) => ({ ...item })) : [];
  renderLoras();
  // 控制适配器是设置里的长期选择：上次用的那个接着用，直到用户清掉。
  const control = settings.defaults.control ?? {};
  if (control.adapter) setControlAdapter(control.adapter);
  if (control.kind) nodes.controlKind.value = control.kind;
  if (Number.isFinite(control.strength)) nodes.controlStrength.value = control.strength;
  if (Number.isFinite(control.loraStrength)) nodes.controlLoraStrength.value = control.loraStrength;
  updateControlNote();
  syncNotchFromSize();
  renderSize();
  // 设置是异步到的：宽高可能在这时被改成另一组值，框要跟着重新对一次。
  rescaleLayoutBoxes();
  // 上次画的框接回来：只存了百分比，按当前画幅还原成像素。
  restoreLayoutLocal();
}

function restoreLayoutLocal() {
  try {
    const raw = localStorage.getItem("hana-moss-studio:layout");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.boxes) || !data.boxes.length) return;
    const size = canvasSize();
    layoutBoxes = data.boxes.map((item) => {
      const box = Array.isArray(item.box) ? item.box.map(Number) : [0, 0, 0, 0];
      return {
        id: `box-${++layoutSeq}`,
        label: String(item.label ?? "object"),
        caption: String(item.caption ?? ""),
        text: String(item.text ?? ""),
        box: [box[0] * size.width, box[1] * size.height, box[2] * size.width, box[3] * size.height].map((value) => Math.round(value)),
      };
    });
    layoutSize = size;
    renderLayoutNote();
  } catch {
    /* 坏了当没有 */
  }
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
  const beforeClamp = hiresScale;
  hiresScale = quantizeHires(Math.min(Math.max(1, hiresScale), maxScale), maxScale);
  // 夹过的值要写回设置：否则工具与卡片提交时还在用旧的、当下做不到的倍率，
  // 界面显示关闭、引擎却跑了第二阶段。
  if (hiresScale !== beforeClamp) scheduleSave();
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
const SAMPLER_LABEL = {
  euler: "Euler（官方）",
  ab2: "AB2",
  euler_ancestral: "Euler a",
  heun: "Heun",
  dpmpp_2m: "DPM++ 2M",
  dpmpp_2m_sde: "DPM++ 2M SDE",
  er_sde: "ER SDE",
  res_multistep: "RES Multistep",
  dataspace: "Dataspace",
};
const SCHEDULER_LABEL = {
  moss: "MOSS（官方）",
  simple: "Simple",
  normal: "Normal",
  karras: "Karras",
  exponential: "Exponential",
  beta: "Beta",
  sgm_uniform: "SGM Uniform",
};

/** 引擎自报的枚举（hello.values）。没连引擎时用本地常量兜底。 */
let facets = null;
/** LoRA 库：[{path, strength, enabled}]，与设置里的 defaults.loras 同形。 */
let loras = [];
/** 参考图的原始位图；尺寸变了、适配方式变了都靠它重新准备。 */
let refImage = null;
/** 已按目标尺寸准备好并落盘的参考图：{path, url, width, height}。 */
let refPrepared = null;
/** 已保存的蒙版路径（必须与 refPrepared 同尺寸）。 */
let maskPath = null;
/** 同一张蒙版的 PNG：交给画布直接显示，不再取一次网络。 */
let maskBlob = null;
/** 蒙版覆盖的百分比，只用于说明文字。 */
let maskShare = 0;
/** 编辑适配器的源图与已准备好的参考图。 */
let editSource = null;
let editRef = null;
/** 控制适配器与它的控制图。 */
let controlAdapter = null;
let controlSource = null;
let controlImage = null;

function setOptions(select, values, labelOf, current) {
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labelOf(value);
      return option;
    }),
  );
  if (current && values.includes(current)) select.value = current;
}

/** 菜单只建一次：之后用户选什么就以控件为准，不再被设置覆盖。 */
function fillMenus(defaults) {
  const samplers = facets?.menus?.sampler ?? Object.keys(SAMPLER_LABEL);
  const schedulers = facets?.menus?.scheduler ?? Object.keys(SCHEDULER_LABEL);
  setOptions(nodes.sampler, samplers, (value) => SAMPLER_LABEL[value] ?? value, defaults.sampler);
  setOptions(nodes.scheduler, schedulers, (value) => SCHEDULER_LABEL[value] ?? value, defaults.scheduler);
  nodes.shift.value = defaults.shift ?? 5;
  nodes.stepCache.value = defaults.stepCache ?? "off";
  nodes.stepThreshold.value = defaults.stepCacheThreshold ?? "";
  // 采样面：层号存成数组，界面上写成 22, 24。
  nodes.uncondLayers.value = Array.isArray(defaults.uncondSkipLayers) ? defaults.uncondSkipLayers.join(", ") : "22";
  nodes.slgLayers.value = Array.isArray(defaults.slgLayers) ? defaults.slgLayers.join(", ") : "";
  nodes.slgScale.value = defaults.slgScale ?? 0;
  nodes.slgStart.value = defaults.slgStart ?? 0;
  nodes.slgStop.value = defaults.slgStop ?? 1;
  nodes.maxSeq.value = defaults.maxSequenceLength ?? 4096;
  nodes.flow.value = defaults.flowMultiplier ?? 1;
  nodes.noiseLayout.value = defaults.noiseLayout ?? "official";
  nodes.noiseSource.value = defaults.noiseSource ?? "philox";
  nodes.eta.value = defaults.eta ?? 1;
  nodes.sNoise.value = defaults.sNoise ?? 1;
  nodes.dataspace.value = defaults.dataspace ?? "";
  nodes.distill.value = defaults.distill ?? "";
  syncAccel();
  summarizeAdvSampling();
}

/** 把 "22, 24" 这种串读成层号数组；写错的值直接丢掉，不把整张图拖崩。 */
function readLayerText(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((number) => Number.isInteger(number) && number >= 0);
}

/** 高级区折叠着，标题上得能看出有没有改过。 */
function summarizeAdvSampling() {
  const bits = [];
  if (readLayerText(nodes.uncondLayers.value).join(",") !== "22") bits.push("跳过层");
  if ((Number(nodes.slgScale.value) || 0) > 0) bits.push("SLG");
  if ((Number(nodes.slgScale.value) || 0) > 0) {
    nodes.slgLayers.disabled = false;
    nodes.slgStart.disabled = false;
    nodes.slgStop.disabled = false;
  } else {
    nodes.slgLayers.disabled = true;
    nodes.slgStart.disabled = true;
    nodes.slgStop.disabled = true;
  }
  if (Number(nodes.maxSeq.value) !== 4096) bits.push("序列长度");
  if (Math.abs((Number(nodes.flow.value) || 1) - 1) > 1e-6) bits.push("flow");
  if (nodes.noiseLayout.value !== "official") bits.push("噪声排布");
  if (nodes.noiseSource.value !== "philox") bits.push("随机源");
  if (Number(nodes.eta.value) !== 1) bits.push("eta");
  if (Number(nodes.sNoise.value) !== 1) bits.push("s_noise");
  if (nodes.dataspace.value.trim()) bits.push("dataspace");
  if (nodes.distill.value.trim()) bits.push("distill");
  nodes.advSamplingNote.textContent = bits.length ? `已改 ${bits.length} 项` : "默认";
  nodes.advSamplingNote.className = bits.length ? "hint bad" : "hint";
}

/** 加速器开着才需要阈值；关着就把那行收起来，不是禁用。 */
function syncAccel() {
  const on = nodes.stepCache.value !== "off";
  nodes.stepThresholdField.hidden = !on;
  nodes.accelNote.hidden = !on;
  nodes.samplerNote.textContent = on ? "lossy" : "";
}

// ── LoRA ────────────────────────────────────────────────────────────────
function loraName(path) {
  return String(path).split(/[\\/]/).pop() || String(path);
}

function renderLoras() {
  nodes.loraList.replaceChildren(
    ...loras.map((item) => {
      const li = document.createElement("li");
      li.className = "pn-lora";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = item.enabled !== false;
      check.title = "勾上就跟着这次生成一起跑";
      check.addEventListener("change", () => {
        item.enabled = check.checked;
        summarizeLoras();
        scheduleSave();
      });
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = loraName(item.path);
      name.title = item.path;
      const strength = document.createElement("input");
      strength.type = "number";
      strength.min = "-8";
      strength.max = "8";
      strength.step = "0.05";
      strength.value = item.strength ?? 1;
      strength.title = "强度";
      strength.addEventListener("input", () => {
        item.strength = Number(strength.value);
        scheduleSave();
      });
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "drop";
      drop.textContent = "×";
      drop.title = "从列表里移除（不删文件）";
      drop.addEventListener("click", () => {
        loras = loras.filter((entry) => entry !== item);
        renderLoras();
        scheduleSave();
      });
      li.append(check, name, strength, drop);
      return li;
    }),
  );
  if (!loras.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "还没有 LoRA。导入一个 safetensors 就会出现在这里。";
    nodes.loraList.append(li);
  }
  summarizeLoras();
}

function summarizeLoras() {
  const active = loras.filter((item) => item.enabled !== false);
  nodes.loraNote.textContent = active.length ? `${active.length} 个生效` : "未使用";
}

function addLora(path, strength = 1) {
  const clean = String(path ?? "").trim();
  if (!clean) return;
  const found = loras.find((item) => item.path === clean);
  if (found) {
    found.enabled = true;
    if (Number.isFinite(strength)) found.strength = strength;
  } else {
    loras.push({ path: clean, strength: Number.isFinite(strength) ? strength : 1, enabled: true });
  }
  renderLoras();
  scheduleSave();
}

async function uploadBinary(path, blob) {
  const response = await hana.api.fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: blob,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(data?.error ?? `上传失败（${response.status}）`);
  return data;
}

// ── 参考图与蒙版 ────────────────────────────────────────────────────
/** 把一张位图按目标尺寸画成 PNG：crop / fit / stretch 都在这里。 */
function drawFitted(image, width, height, mode) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, width, height);
  const scaleX = width / image.naturalWidth;
  const scaleY = height / image.naturalHeight;
  if (mode === "stretch") {
    ctx.drawImage(image, 0, 0, width, height);
  } else if (mode === "fit") {
    const scale = Math.min(scaleX, scaleY);
    const w = Math.round(image.naturalWidth * scale);
    const h = Math.round(image.naturalHeight * scale);
    ctx.drawImage(image, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
  } else {
    // crop：居中裁成目标比例
    const scale = Math.max(scaleX, scaleY);
    const w = Math.round(image.naturalWidth * scale);
    const h = Math.round(image.naturalHeight * scale);
    ctx.drawImage(image, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
  }
  return canvas;
}

async function canvasBlob(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("图片编码失败");
  return blob;
}

/** 把参考图按目标尺寸准备成 PNG 并上传：引擎拿到的 init_image 就等于任务尺寸，
 *  蒙版也只需按同一张画。 */
async function prepareRef(width, height) {
  if (!refImage) return null;
  if (refPrepared && refPrepared.width === width && refPrepared.height === height) return refPrepared;
  const blob = await canvasBlob(drawFitted(refImage, width, height, nodes.refResize.value));
  const result = await uploadBinary("/inputs/upload?kind=init", blob);
  refPrepared = { path: result.path, url: inputUrl(result.name), width, height, blob };
  // 尺寸换了的旧蒙版不能再用：它和新的 init_image 不同尺寸，引擎会拒。
  if (maskPath) {
    maskPath = null;
    say("尺寸变了，蒙版已清空，需要重新画。", "bad");
  }
  maskBlob = null;
  maskShare = 0;
  updateRefNote();
  return refPrepared;
}

/** 编辑适配器的参考图：不走蒙版，直接从画廊或文件带进来。 */
async function prepareEditReference(width, height) {
  if (!editSource) return null;
  if (editRef && editRef.width === width && editRef.height === height) return editRef;
  const blob = await canvasBlob(drawFitted(editSource, width, height, "fit"));
  const result = await uploadBinary("/inputs/upload?kind=ref", blob);
  editRef = { path: result.path, url: inputUrl(result.name), width, height };
  return editRef;
}

function updateRefNote() {
  if (!refPrepared) {
    nodes.refNote.textContent = "未选择";
    nodes.maskEdit.hidden = true;
    // 没参考图时重绘强度与适配无处可用，不摆在那里让用户以为它们会生效。
    nodes.refControls.hidden = true;
    broadcastEditState();
    return;
  }
  const size = `${refPrepared.width}×${refPrepared.height}`;
  nodes.refNote.textContent = maskPath ? `局部重绘 · ${size}` : `图生图 · ${size}`;
  nodes.maskEdit.hidden = false;
  nodes.maskEdit.textContent = maskPath ? "改蒙版" : "画蒙版";
  nodes.refControls.hidden = false;
  broadcastEditState();
}

async function setReference(blobOrUrl) {
  try {
    const image = new Image();
    const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("这张图读不出来"));
      image.src = url;
    });
    refImage = image;
    refPrepared = null;
    maskPath = null;
    maskBlob = null;
    maskShare = 0;
    nodes.ref.hidden = false;
    nodes.refImg.src = typeof blobOrUrl === "string" ? blobOrUrl : url;
    nodes.refNote.textContent = "准备中…";
    // 比例差得多就按底图改画幅：crop 掉一半构图，比多等几秒更糟。
    let resized = false;
    if (image.naturalWidth && image.naturalHeight) {
      const imageRatio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, image.naturalWidth / image.naturalHeight));
      if (Math.abs(imageRatio - currentRatio()) / imageRatio > 0.02) {
        const megapixels = Math.max(MIN_MP, Math.min(MAX_MP, currentMP()));
        const [width, height] = sizeFor(imageRatio, megapixels);
        setSize(width, height);
        // 画幅是长期设置：拖一张图改掉它，下次打开也该是这个尺寸。
        scheduleSave();
        resized = true;
      }
    }
    await prepareRef(Number(nodes.width.value), Number(nodes.height.value));
    const size = `${nodes.width.value}×${nodes.height.value}`;
    say(resized ? `底图已就绪，画幅按它的比例改成 ${size}。` : `底图已就绪（${size}），可以另写提示词，也可以直接跑。`, "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

function clearReference() {
  refImage = null;
  refPrepared = null;
  maskPath = null;
  maskBlob = null;
  maskShare = 0;
  nodes.ref.hidden = true;
  nodes.refImg.removeAttribute("src");
  updateRefNote();
}

/** 设置里由别处（下载页、工具）改的部分：LoRA 库与控制适配器。
 *  面板自己只加载一次设置（否则用户输到一半会被服务端回包覆盖），
 *  但下载页刚装好的适配器得能同步下来。 */
/**
 * 设置里由别处（下载页、工具）改的部分：LoRA 库与控制适配器。
 * 只由 settings 事件触发（同一源广播），不在每帧里比对。
 */
let lastControlEdit = 0;
/** 已经应用过的设置版本；只用来补漏掉的事件。 */
let seenSettingsRev = -1;

function catchUpSettings(state) {
  const rev = state?.settingsRev;
  if (rev == null || rev === seenSettingsRev) return;
  seenSettingsRev = rev;
  applySharedSettings(state.settings);
}

function applySharedSettings(settings) {
  if (!settings) return;
  const defaults = settings.defaults ?? {};
  const list = Array.isArray(defaults.loras) ? defaults.loras : [];
  const same =
    list.length === loras.length &&
    list.every((item, index) =>
      item.path === loras[index]?.path &&
      Number(item.strength) === Number(loras[index]?.strength) &&
      (item.enabled !== false) === (loras[index]?.enabled !== false),
    );
  if (!same) {
    loras = list.map((item) => ({ ...item }));
    renderLoras();
  }

  const adapter = defaults.control?.adapter ?? null;
  const local = controlAdapter?.path ?? null;
  // 本地刚改过就先等等：800ms 内的回包可能是旧值。
  if (adapter !== local && Date.now() - lastControlEdit > 2000) {
    if (adapter) setControlAdapter(adapter);
    else clearControlAdapter();
    if (defaults.control?.kind) nodes.controlKind.value = defaults.control.kind;
    if (Number.isFinite(defaults.control?.strength)) nodes.controlStrength.value = defaults.control.strength;
    if (Number.isFinite(defaults.control?.loraStrength)) nodes.controlLoraStrength.value = defaults.control.loraStrength;
    updateControlNote();
  }
}

/** 编辑参考图：只记源图，到出手那一刻再按当时尺寸准备。 */
async function setEditReference(source, name = "画廊图") {
  let url = null;
  try {
    url = typeof source === "string" ? source : URL.createObjectURL(source);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("这张图读不出来"));
      image.src = url;
    });
    editSource = image;
    editRef = null;
    nodes.editRefThumb.hidden = false;
    nodes.editRefImg.src = url;
    nodes.editRefNote.textContent = `${name} · ${image.naturalWidth}×${image.naturalHeight}`;
    nodes.editRefThumb.title = "需要 LoRA 列表里有编辑适配器（如 Moss-Image-Edit），它按这张图重画";
    const blocked = !loras.some((item) => item.enabled !== false && /edit/i.test(String(item.path ?? "")));
    say(
      blocked
        ? `参考图已就绪（${image.naturalWidth}×${image.naturalHeight}），但 LoRA 里没有编辑适配器，它还不会生效。`
        : `参考图已就绪（${image.naturalWidth}×${image.naturalHeight}），配合提示词一起跑。`,
      blocked ? "bad" : "ok",
    );
  } catch (error) {
    if (url && typeof source !== "string") URL.revokeObjectURL(url);
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

function clearEditReference() {
  editSource = null;
  editRef = null;
  nodes.editRefThumb.hidden = true;
  nodes.editRefImg.removeAttribute("src");
  nodes.editRefNote.textContent = "未选择";
}

// ── 控制适配器 ───────────────────────────────────────────────────────
function controlName(path) {
  return String(path).split(/[\\/]/).pop() || String(path);
}

function updateControlNote() {
  if (!controlAdapter) {
    nodes.controlNote.textContent = controlSource ? "有控制图 · 未选适配器" : "未开启";
    return;
  }
  const kind = nodes.controlKind.value.trim();
  nodes.controlNote.textContent = `${controlName(controlAdapter.path)}${kind ? ` · ${kind}` : ""}${controlSource ? " · 有图" : ""}`;
}

function setControlAdapter(path) {
  controlAdapter = { path };
  lastControlEdit = Date.now();
  nodes.controlAdapter.hidden = false;
  nodes.controlAdapterName.textContent = `适配器：${controlName(path)}`;
  nodes.controlAdapterName.title = path;
  updateControlNote();
}

function clearControlAdapter() {
  controlAdapter = null;
  lastControlEdit = Date.now();
  nodes.controlAdapter.hidden = true;
  nodes.controlAdapterName.textContent = "";
  updateControlNote();
}

/** 控制图按目标尺寸裁好再上传：引擎那张图会缩到 pass 尺寸，先对齐省一次脏猜。 */
async function prepareControlImage(width, height) {
  if (!controlSource) return null;
  if (controlImage && controlImage.width === width && controlImage.height === height) return controlImage;
  const blob = await canvasBlob(drawFitted(controlSource, width, height, "fit"));
  const result = await uploadBinary("/inputs/upload?kind=control", blob);
  controlImage = { path: result.path, url: inputUrl(result.name), width, height };
  return controlImage;
}

async function setControlImage(file) {  try {
    const image = new Image();
    const url = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("这张图读不出来"));
      image.src = url;
    });
    controlSource = image;
    controlImage = null;
    nodes.controlThumb.hidden = false;
    nodes.controlImg.src = url;
    updateControlNote();
    say("控制图已就绪，出图时按当时尺寸准备。", "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

// ── 布局（框选在主画布上）────────────────────────────────────────────
// 侧栏只有三百多像素，框选对不准构图，编辑器搬到了工作区。这里只存结果：
// 提交时把框交给 readLayout 换算成中心坐标；画幅变了按比例缩一次。
let layoutBoxes = [];
/** 导入的 JSON 里可能带着 summary.canvas 这类字段：原样带回去。 */
let layoutMeta = null;
/** 导入的 JSON 只剩一句整图描述、用户又没写提示词时，用它兑底。 */
let layoutCaption = "";
/** 这些框坐标对应的画布尺寸。 */
let layoutSize = null;
let layoutSeq = 0;

function canvasSize() {
  return {
    width: Math.max(256, Math.round(Number(nodes.width.value) || 768)),
    height: Math.max(256, Math.round(Number(nodes.height.value) || 768)),
  };
}

function renderLayoutNote() {
  const count = layoutBoxes.length;
  nodes.layoutNote.textContent = count ? `${count} 个框` : "未使用";
  nodes.layoutNote.title = count
    ? layoutBoxes.map((item, index) => `${index + 1}. ${item.label}：${item.caption || item.text || "没写"}`).join("\n")
    : "";
}

/** 画幅变了就按比例搬框：框的意思是「这一块占画面多少」，不是某一组像素。 */
function rescaleLayoutBoxes() {
  if (!layoutBoxes.length) return;
  const size = canvasSize();
  if (!layoutSize) {
    layoutSize = size;
    return;
  }
  if (layoutSize.width === size.width && layoutSize.height === size.height) return;
  const sx = size.width / layoutSize.width;
  const sy = size.height / layoutSize.height;
  layoutBoxes = layoutBoxes.map((item) => ({
    ...item,
    box: [
      Math.round(item.box[0] * sx),
      Math.round(item.box[1] * sy),
      Math.round(item.box[2] * sx),
      Math.round(item.box[3] * sy),
    ],
  }));
  layoutSize = size;
}

/** 导入的 JSON 只用来搬进来：中心 yxyx → 屏幕 xyxy。 */
function boxesFromDoc(doc) {
  const size = layoutSize ?? canvasSize();
  const space = String(doc?.bbox_coord_space ?? "abs_centralized");
  const format = String(doc?.bbox_format ?? "yxyx");
  const items = Array.isArray(doc?.items) ? doc.items : [];
  if (!items.length) throw new Error("items 是空的");
  return items.map((item, index) => {
    const raw = Array.isArray(item?.bbox) ? item.bbox.map(Number) : [];
    if (raw.length !== 4 || raw.some((value) => !Number.isFinite(value))) {
      throw new Error(`第 ${index + 1} 个 item 的 bbox 要四个数`);
    }
    // 先统一成 xyxy 的左下右上顺序，再按坐标系换到屏幕像素。
    const source = format === "yxyx" ? [raw[1], raw[0], raw[3], raw[2]] : raw;
    let x0 = source[0];
    let y0 = source[1];
    let x1 = source[2];
    let y1 = source[3];
    if (space === "abs_centralized") {
      x0 += size.width / 2;
      x1 += size.width / 2;
      y0 += size.height / 2;
      y1 += size.height / 2;
    } else if ([x0, y0, x1, y1].every((value) => value >= 0 && value <= 1)) {
      // 归一化坐标也放进来：别家给的布局多半是这个。
      x0 *= size.width;
      x1 *= size.width;
      y0 *= size.height;
      y1 *= size.height;
    }
    const clampX = (value) => Math.round(Math.max(0, Math.min(size.width, value)));
    const clampY = (value) => Math.round(Math.max(0, Math.min(size.height, value)));
    return {
      id: `box-${++layoutSeq}`,
      label: String(item?.label ?? "object"),
      caption: String(item?.caption ?? "").trim(),
      text: String(item?.text ?? ""),
      box: [
        clampX(Math.min(x0, x1)),
        clampY(Math.min(y0, y1)),
        clampX(Math.max(x0, x1)),
        clampY(Math.max(y0, y1)),
      ],
    };
  });
}

/** 导入的 JSON 里除 items 与 summary.caption 之外的字段原样带回去。 */
function metaFromDoc(doc) {
  const meta = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "items") continue;
    if (key === "summary") {
      const summary = {};
      for (const [inner, raw] of Object.entries(value ?? {})) {
        if (inner !== "caption") summary[inner] = raw;
      }
      if (Object.keys(summary).length) meta.summary = summary;
      continue;
    }
    meta[key] = value;
  }
  return Object.keys(meta).length ? meta : null;
}

function clearLayout() {
  if (layoutBoxes.length && !window.confirm(`清掉这 ${layoutBoxes.length} 个框？`)) return;
  layoutBoxes = [];
  layoutMeta = null;
  layoutCaption = "";
  layoutSize = canvasSize();
  renderLayoutNote();
  say("布局已清空。");
}

/** 主画布交回的框：按当前画幅等比换算。 */
function applyLayoutFromCanvas(msg) {
  try {
    const boxes = Array.isArray(msg.boxes) ? msg.boxes : [];
    const fromWidth = Number(msg.width) || canvasSize().width;
    const fromHeight = Number(msg.height) || canvasSize().height;
    const size = canvasSize();
    const sx = size.width / Math.max(1, fromWidth);
    const sy = size.height / Math.max(1, fromHeight);
    layoutBoxes = boxes.map((item) => {
      const box = Array.isArray(item.box) ? item.box.map(Number) : [0, 0, 0, 0];
      return {
        id: `box-${++layoutSeq}`,
        label: String(item.label ?? "object"),
        caption: String(item.caption ?? ""),
        text: String(item.text ?? ""),
        box: [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy].map((value) => Math.round(value)),
      };
    });
    layoutSize = size;
    layoutCaption = "";
    renderLayoutNote();
    say(`已收下画布上的 ${layoutBoxes.length} 个框。`, "ok");
  } catch (error) {
    say(`画布上的框没接上：${error instanceof Error ? error.message : String(error)}`, "bad");
  }
}

/** 主画布改了画幅：输入框跟上，框也按比例挪。 */
function applyLayoutSize(msg) {
  const width = Number(msg.width);
  const height = Number(msg.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  setSize(width, height);
  rescaleLayoutBoxes();
  renderLayoutNote();
}

// 去画布框选：主界面收到就把画布切到布局层。
nodes.layoutEdit.addEventListener("click", () => {
  layoutChannel?.postMessage({ type: "layout-open" });
});
nodes.layoutClear.addEventListener("click", clearLayout);
nodes.layoutImport.addEventListener("click", () => nodes.layoutFile.click());
nodes.layoutFile.addEventListener("change", async () => {
  const file = nodes.layoutFile.files?.[0];
  nodes.layoutFile.value = "";
  if (!file) return;
  try {
    const doc = JSON.parse(await file.text());
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("要是一个 JSON 对象");
    layoutSize = canvasSize();
    layoutBoxes = boxesFromDoc(doc);
    layoutMeta = metaFromDoc(doc);
    layoutCaption = String(doc.summary?.caption ?? "").trim();
    renderLayoutNote();
    say(`已导入 ${layoutBoxes.length} 个框。`, "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
});

const layoutChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;
layoutChannel?.addEventListener("message", (event) => {
  const data = event.data ?? {};
  if (data.type === "layout") applyLayoutFromCanvas(data);
  else if (data.type === "layout-size") applyLayoutSize(data);
  // 画布上导入的底图就是图生图的源图：这边也换成同一张。
  else if (data.type === "layout-underlay" && typeof data.name === "string") void setReference(inputUrl(data.name));
});

/** 底图与蒙版的全貌：画布那边只按这份数据画。blob 不做变化键，广播时单看 size。 */
function editStatePayload() {
  return {
    hasBase: Boolean(refPrepared),
    width: refPrepared?.width ?? null,
    height: refPrepared?.height ?? null,
    maskBlob: maskBlob ?? null,
    share: maskShare,
  };
}

let lastEditSent = "";

function broadcastEditState(force = false) {
  const state = editStatePayload();
  const key = JSON.stringify({ ...state, maskBlob: state.maskBlob ? state.maskBlob.size : 0 });
  if (!force && key === lastEditSent) return;
  lastEditSent = key;
  layoutChannel?.postMessage({ type: "edit-state", state });
}

/** 画布上画好的蒙版回到这里：上传只在这边做，提交时用的也还是这一个 maskPath。 */
async function adoptCanvasMask(blob, share) {
  if (!refPrepared) return;
  try {
    const result = await uploadBinary("/inputs/upload?kind=mask", blob);
    maskPath = result.path;
    maskBlob = blob;
    maskShare = Number(share) || 0;
    updateRefNote();
    say(`画布上的蒙版已保存，重画面积 ${maskShare}%。`, "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

// 蒙版画布：白色笔触就是「重画这里」。保存时按 alpha 阈值二值化，避免半透明边。
let maskCtx = null;
let maskPainting = false;
let maskMode = "paint";
/** 1 是「适应栏宽」，更大的倍数给细部笔刷用。 */
let maskZoom = 1;
const MASK_ZOOMS = [1, 1.5, 2, 3, 4];

function openMaskEditor() {
  if (!refPrepared) {
    say("先选一张底图。", "bad");
    return;
  }
  const canvas = nodes.maskCanvas;
  canvas.width = refPrepared.width;
  canvas.height = refPrepared.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  maskCtx = ctx;
  maskMode = "paint";
  maskZoom = 1;
  nodes.maskPaint.classList.add("on");
  nodes.maskErase.classList.remove("on");
  nodes.maskInfo.textContent = `${refPrepared.width}×${refPrepared.height}`;
  nodes.maskPct.textContent = "";
  // 画布当背景图用：init 图作 CSS 背景，笔触在透明画布上叠。
  canvas.style.backgroundImage = `url(${refPrepared.url})`;
  canvas.style.backgroundSize = "100% 100%";
  nodes.mask.hidden = false;
  layoutMaskCanvas();
  say("在图上抹出要重画的区域，保存后就能跑局部重绘。");
}

function layoutMaskCanvas() {
  const canvas = nodes.maskCanvas;
  const stage = nodes.maskStage;
  const ratio = canvas.width / canvas.height;
  // 适应：先按宽度铺满，再按高度回退；缩放：在此基础上乘倍数，交给 stage 滚动。
  const fitWidth = Math.max(40, stage.clientWidth - 10);
  let width = fitWidth;
  let height = width / ratio;
  if (height > window.innerHeight * 0.62) {
    height = window.innerHeight * 0.62;
    width = height * ratio;
  }
  canvas.style.width = `${Math.round(width * maskZoom)}px`;
  canvas.style.height = `${Math.round(height * maskZoom)}px`;
  nodes.maskZoomLabel.textContent = maskZoom > 1 ? `${Math.round(maskZoom * 100)}%` : "适应";
}

function maskPoint(event) {
  const canvas = nodes.maskCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    scale: canvas.width / Math.max(1, rect.width),
  };
}

let maskLast = null;

function paintTo(point) {
  if (!maskCtx) return;
  // 笔刷尺寸是屏幕像素，画到画布上要按显示比例放大。
  const radius = ((Number(nodes.maskSize.value) || 60) / 2) * point.scale;
  maskCtx.globalCompositeOperation = maskMode === "erase" ? "destination-out" : "source-over";
  // 半透明红：能看清底下画的是什么。保存时会统一换成白（引擎只认亮度）。
  maskCtx.strokeStyle = "rgba(255, 96, 96, 0.55)";
  maskCtx.fillStyle = "rgba(255, 96, 96, 0.55)";
  maskCtx.lineWidth = radius * 2;
  maskCtx.lineCap = "round";
  maskCtx.lineJoin = "round";
  if (!maskLast) {
    maskCtx.beginPath();
    maskCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    maskCtx.fill();
  } else {
    // 连成线：快速拖动时 pointermove 之间的空隙才不会断成一串点。
    maskCtx.beginPath();
    maskCtx.moveTo(maskLast.x, maskLast.y);
    maskCtx.lineTo(point.x, point.y);
    maskCtx.stroke();
  }
  maskLast = { x: point.x, y: point.y };
}

async function saveMask() {
  if (!maskCtx || !refPrepared) return;
  const source = nodes.maskCanvas;
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0);
  // 二值化：笔触是白（叠在黑底上约 217），没碰过的地方是 0。
  // 判提看亮度而不是 alpha：整张已铺了不透明黑底，alpha 处处是 255。
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const data = image.data;
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
    say("蒙版是空的：至少抹一块要重画的区域。", "bad");
    return;
  }
  ctx.putImageData(image, 0, 0);
  const share = Math.round((painted / (out.width * out.height)) * 1000) / 10;
  const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
  try {
    nodes.maskSave.disabled = true;
    const result = await uploadBinary("/inputs/upload?kind=mask", blob);
    maskPath = result.path;
    maskBlob = blob;
    maskShare = share;
    nodes.mask.hidden = true;
    updateRefNote();
    say(`蒙版已保存，重画面积 ${share}%。`, "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    nodes.maskSave.disabled = false;
  }
}


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
  // 显存只在「引擎在跑、模型已加载、没有任务」时才存在可释放的东西。
  nodes.release.hidden = !(engine.running && engine.loaded && !engine.active);
  // 引擎没起来、但路径已经配好时给一个拉起入口（出图也会自动拉起）。
  nodes.start.hidden = !(engine.serverFound && !engine.running);
}

/**
 * 侧侧模型区的两个选择：
 *   模型 = 哪个 bundle（SFT / Base）；DiT 权重 = 用 bundle 自带的 bf16，还是已装的单文件。
 * 两件事分开说，所以是两个框；单文件 DiT 不是另一个模型。
 */
let modelsKey = "";
let ditsKey = "";
let tesKey = "";

function makeOption(value, text) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
}
function renderModels(data) {
  const models = (Array.isArray(data?.models) ? data.models : []).filter((item) => item.installed);
  const current = models.find((item) => item.active) ?? null;
  const key = models.map((item) => `${item.variant}:${item.label}`).join("|") + `#${current?.variant ?? ""}`;
  if (key !== modelsKey) {
    modelsKey = key;
    nodes.model.replaceChildren(
      ...models.map((item) => {
        const option = document.createElement("option");
        option.value = item.variant;
        option.textContent = item.label;
        return option;
      }),
    );
    if (!models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "还没有装模型";
      nodes.model.replaceChildren(option);
    }
    nodes.model.disabled = !models.length;
    nodes.model.value = models.length && current ? current.variant : nodes.model.value;
  // 自管清单：没装整包时「模型」这一格没有意义（两个仓库的配置与分词器相同），直接收起来。
  nodes.modelField.hidden = !models.length;
  // 轻量包（只有配置与分词器）：模型差异全在 DiT 权重里。
  const lite = data?.modelLite ?? null;
  // 轻量包时也给一个出口：上面仍列着已装的完整模型，能直接切回去。
  nodes.model.disabled = !models.length;
  const configReady = Boolean(data?.configPack?.installed);
  nodes.modelHint.hidden = !(lite || (!models.length && configReady));
  if (lite) {
    const lacking = lite.missing.length ? `，还缺：${lite.missing.join("、")}` : "";
    nodes.modelHint.textContent = `配置包与 SFT/Base 同款，模型差异全在 DiT 权重里${lacking}`;
  } else if (!models.length && configReady) {
    nodes.modelHint.textContent = "只装了配置与分词器：模型差异全在 DiT 权重里";
  }
  }

  // DiT 权重：空值就是 bundle 自带。只列装好的，没装的去版本页下载。
  const dits = (data?.files ?? []).filter((item) => item.role === "dit" && item.installed);
  const ditPath = data?.settings?.modelFiles?.dit ?? null;
  const ditFile = ditPath ? (dits.find((item) => item.target === ditPath) ?? null) : null;
  const ditKey = dits.map((item) => `${item.id}:${item.target}`).join("|") + `#${ditFile?.id ?? ""}`;
  if (ditKey !== ditsKey) {
    ditsKey = ditKey;
    const options = [];
    const option = (value, text) => {
      const node = document.createElement("option");
      node.value = value;
      node.textContent = text;
      return node;
    };
    options.push(option("", "bundle 自带（bf16）"));
    for (const item of dits) options.push(option(item.target, shortDitName(item.name)));
    nodes.dit.replaceChildren(...options);
    nodes.dit.disabled = !dits.length;
  }
  nodes.dit.value = ditFile?.target ?? "";
  nodes.ditNote.textContent =
    ditFile?.tier && ditFile.tier !== data?.settings?.tier ? `它只能跑 ${ditFile.tier} 档` : "";
  nodes.ditNote.title = ditFile?.path ?? "";

  // 文本编码器：bundle 自带的 bf16，或已装的 INT8 / W4A8。只影响显存占用。
  const tes = (data?.files ?? []).filter((item) => item.role === "text_encoder" && item.installed);
  const tePath = data?.settings?.modelFiles?.textEncoder ?? null;
  const teFile = tePath ? (tes.find((item) => item.target === tePath) ?? null) : null;
  const teKey = tes.map((item) => `${item.id}:${item.target}`).join("|") + `#${teFile?.id ?? ""}`;
  if (teKey !== tesKey) {
    tesKey = teKey;
    nodes.te.replaceChildren(
      makeOption("", "bundle 自带（bf16）"),
      ...tes.map((item) => makeOption(item.target, item.name)),
    );
    nodes.te.disabled = !tes.length;
  }
  nodes.te.value = teFile?.target ?? "";
}

/**
 * 档位是用户的选择，但不一定和当前单文件 DiT 合得上：INT4 只能跑 turbo。
 * 选了别的档位就把 DiT 退回 bundle 自带权重（bf16），不去锁选择框。
 */
let lastTierEdit = 0;
function syncTier(data) {
  const tier = data?.settings?.tier;
  if (!tier || tier === nodes.tier.value) return;
  if (document.activeElement === nodes.tier) return;
  if (Date.now() - lastTierEdit < 2000) return;
  nodes.tier.value = tier;
}

function basenameOf(path) {
  return String(path ?? "").split(/[\\/]/).pop() ?? "";
}

/** 文件展示名再把开头的「DiT」去掉：上下的句子已经说了这是 DiT。 */
function shortDitName(name) {
  return String(name ?? "").replace(/^DiT\s*/, "");
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
  facets = data.facets ?? facets;
  setSettings(data.settings);
  // 事件是主路（studio 转发 settings）；这一句只做补课：漏了事件也能对上。
  catchUpSettings(data);
  renderEngine(data);
  renderModels(data);
  syncTier(data);
  nodes.generate.disabled = submitting;
  // 忙的时候不禁用：串行队列排得下，按钮变成「加入队列」才有意义。
  const busy = Boolean(data.engine.active) || data.queue.length > 0;
  nodes.generate.textContent = busy ? "加入队列" : "开始生成";
  nodes.generate.title = busy ? "当前有任务在跑，点这里排到它后面" : "";
  // 生成中才出取消按钮；空闲时不占位置。
  nodes.cancel.hidden = !data.engine.active;
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
  if (layoutBoxes.length) {
    // 手输尺寸还没失焦时 change 不会触发：提交前先把框搬到当前画幅。
    rescaleLayoutBoxes();
    const blank = layoutBoxes.findIndex((item) => !item.caption.trim() && !item.text.trim());
    if (blank >= 0) {
      say(`第 ${blank + 1} 个框还没写提示词：去画布上补一句。`, "bad");
      layoutChannel?.postMessage({ type: "layout-open", index: blank });
      return;
    }
  }
  // 提示词与布局最后都是同一段 JSON：框写全了，整图速写可以不写，
  // 拿各框的提示词拼一句当 summary.caption。
  const caption =
    prompt ||
    layoutCaption ||
    layoutBoxes
      .map((item) => item.caption.trim() || item.text.trim())
      .filter(Boolean)
      .join("；");
  if (!caption) {
    say("写一句提示词，或者在画布上框出至少一块。", "bad");
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
    prompt: caption,
    negativePrompt: nodes.negative.value,
    width: Number(nodes.width.value),
    height: Number(nodes.height.value),
    steps,
    cfg: Number(nodes.cfg.value),
  };
  // 采样面：层号、SLG、序列长度与随机项都跟着提交。
  payload.uncondSkipLayers = readLayerText(nodes.uncondLayers.value);
  const slgLayers = readLayerText(nodes.slgLayers.value);
  if (slgLayers.length) payload.slgLayers = slgLayers;
  const slgScale = Math.min(20, Math.max(0, Number(nodes.slgScale.value) || 0));
  if (slgScale > 0) {
    payload.slgScale = slgScale;
    payload.slgStart = Math.min(1, Math.max(0, Number(nodes.slgStart.value) || 0));
    payload.slgStop = Math.min(1, Math.max(0, nodes.slgStop.value === "" ? 1 : Number(nodes.slgStop.value)));
  }
  payload.maxSequenceLength = Math.round(Number(nodes.maxSeq.value) || 4096);
  payload.flowMultiplier = Number(nodes.flow.value) || 1;
  payload.noiseLayout = nodes.noiseLayout.value;
  payload.noiseSource = nodes.noiseSource.value;
  payload.eta = nodes.eta.value === "" ? 1 : Number(nodes.eta.value);
  payload.sNoise = nodes.sNoise.value === "" ? 1 : Number(nodes.sNoise.value);
  if (nodes.dataspace.value.trim()) payload.dataspace = nodes.dataspace.value.trim();
  if (nodes.distill.value.trim()) payload.distill = nodes.distill.value.trim();
  // 布局只传左上角坐标的框：中心坐标与 yxyx 排序由 readLayout 换算。
  if (layoutBoxes.length) {
    payload.boxes = layoutBoxes.map((item) => {
      const box = {
        label: item.label.trim() || "object",
        caption: item.caption.trim(),
        box: item.box.map((value) => Math.round(value)),
      };
      if (item.text.trim()) box.text = item.text.trim();
      return box;
    });
    // summary.canvas 这类字段从导入的 JSON 里带过来，编辑器不碰它们。
    if (layoutMeta) payload.layout = layoutMeta;
  }
  const effectiveScale = Math.min(hiresScale, hiresMax());
  if (effectiveScale > 1.001) {
    payload.hiresScale = Math.round(effectiveScale * 100) / 100;
    const hiresSteps = Math.round(Number(nodes.hiresSteps.value) || 0);
    if (hiresSteps > 0) payload.hiresSteps = hiresSteps;
  }
  const seed = nodes.seed.value.trim();
  if (seed) payload.seed = Number(seed);
  payload.sampler = nodes.sampler.value;
  payload.scheduler = nodes.scheduler.value;
  payload.shift = Number(nodes.shift.value) || 5;
  payload.stepCache = nodes.stepCache.value;
  const threshold = Number(nodes.stepThreshold.value);
  if (nodes.stepCache.value !== "off" && Number.isFinite(threshold) && threshold > 0) {
    payload.stepCacheThreshold = threshold;
  }
  const activeLoras = loras.filter((item) => item.enabled !== false && item.path);
  if (activeLoras.length) payload.loras = activeLoras.map(({ path, strength }) => ({ path, strength: Number(strength) }));
  try {
    // 参考图按当前尺寸现准备：改了尺寸也能直接跑，不用用户再选一次。
    if (refImage) {
      say("正在准备底图…");
      const prepared = await prepareRef(Number(nodes.width.value), Number(nodes.height.value));
      if (prepared) {
        payload.initImage = prepared.path;
        payload.strength = Math.min(1, Math.max(0.05, Number(nodes.strength.value) || 0.6));
        // 参考图已经按目标尺寸裁/缩好了，引擎那边不需要再适配一次。
        payload.resize = "stretch";
        if (maskPath) {
          payload.mask = maskPath;
          payload.maskEncoding = "u8";
        }
      }
    }
    if (editSource) {
      const prepared = await prepareEditReference(Number(nodes.width.value), Number(nodes.height.value));
      if (prepared) {
        payload.referenceImages = [prepared.path];
        payload.referenceMaxEdge = 512;
      }
    }
    if (controlAdapter) {
      payload.controlAdapter = controlAdapter.path;
      const kind = nodes.controlKind.value.trim();
      if (kind) payload.controlKind = kind;
      payload.controlStrength = Number(nodes.controlStrength.value) || 1;
      payload.controlLoraStrength = Number(nodes.controlLoraStrength.value) || 1;
      if (controlSource) {
        const prepared = await prepareControlImage(Number(nodes.width.value), Number(nodes.height.value));
        if (prepared) payload.controlImage = prepared.path;
      }
    }
  } catch (error) {
    submitting = false;
    nodes.generate.disabled = false;
    say(error instanceof Error ? error.message : String(error), "bad");
    return;
  }
  try {
    const result = await post("/generate", payload);
    const notices = Array.isArray(result?.notices) ? result.notices : [];
    say(notices.length ? notices.join("；") : `已入队 ${result.job?.jobId ?? ""}`, notices.length ? "bad" : "ok");
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
  // 以库里的那份为底：面板没暴露的参数（控制适配器、LoRA 作用位置、CFG 截断）不能被一次保存抹掉。
  const base = latest?.settings?.defaults ?? {};
  return {
    ...base,
    width: Number(nodes.width.value) || 768,
    height: Number(nodes.height.value) || 768,
    steps: Number(nodes.steps.value) || 8,
    cfg: Number(nodes.cfg.value) || 3,
    hiresScale: Math.round(Math.min(hiresScale, hiresMax()) * 100) / 100,
    hiresSteps: Math.round(Number(nodes.hiresSteps.value) || 0),
    sampler: nodes.sampler.value,
    scheduler: nodes.scheduler.value,
    shift: Number(nodes.shift.value) || 5,
    stepCache: nodes.stepCache.value,
    stepCacheThreshold: nodes.stepThreshold.value === "" ? null : Number(nodes.stepThreshold.value) || null,
    uncondSkipLayers: readLayerText(nodes.uncondLayers.value),
    slgLayers: readLayerText(nodes.slgLayers.value),
    slgScale: Number(nodes.slgScale.value) || 0,
    slgStart: Number(nodes.slgStart.value) || 0,
    slgStop: nodes.slgStop.value === "" ? 1 : Number(nodes.slgStop.value),
    maxSequenceLength: Math.round(Number(nodes.maxSeq.value) || 4096),
    flowMultiplier: Number(nodes.flow.value) || 1,
    noiseLayout: nodes.noiseLayout.value,
    noiseSource: nodes.noiseSource.value,
    eta: nodes.eta.value === "" ? 1 : Number(nodes.eta.value),
    sNoise: nodes.sNoise.value === "" ? 1 : Number(nodes.sNoise.value),
    dataspace: nodes.dataspace.value.trim() || null,
    distill: nodes.distill.value.trim() || null,
    loras: loras.map((item) => ({ path: item.path, strength: Number(item.strength) || 1, enabled: item.enabled !== false })),
    control: {
      // 不再回退到旧值：控制适配器在面板上是可读可清的，回退会把刚清掉的又写回去。
      adapter: controlAdapter?.path ?? null,
      kind: nodes.controlKind.value.trim() || null,
      strength: Number(nodes.controlStrength.value) || 1,
      loraStrength: Number(nodes.controlLoraStrength.value) || 1,
    },
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // 档位不在这里提：它有自己的 change 处理器（可能要连 DiT 一起换），
    // 也不再拿旧值把服务端的修正盖回去。
    const patch = { memoryMode: nodes.memoryMode.value, defaults: collectDefaults() };
    void post("/settings", patch).catch(() => {
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
  nodes.sampler,
  nodes.scheduler,
  nodes.shift,
  nodes.stepCache,
  nodes.stepThreshold,
  nodes.uncondLayers,
  nodes.slgLayers,
  nodes.slgScale,
  nodes.slgStart,
  nodes.slgStop,
  nodes.maxSeq,
  nodes.flow,
  nodes.noiseLayout,
  nodes.noiseSource,
  nodes.eta,
  nodes.sNoise,
  nodes.dataspace,
  nodes.distill,
  nodes.controlStrength,
  nodes.controlLoraStrength,
]) {
  node.addEventListener("input", () => {
    summarizeAdvSampling();
    scheduleSave();
  });
  node.addEventListener("change", () => {
    summarizeAdvSampling();
    scheduleSave();
  });
}

nodes.stepCache.addEventListener("change", syncAccel);

// 参考图：换了尺寸就把旧蒙版作废（它和新的 init_image 不同尺寸）。
for (const node of [nodes.width, nodes.height]) {
  node.addEventListener("change", () => {
    rescaleLayoutBoxes();
    if (!refImage) return;
    refPrepared = null;
    if (maskPath) {
      maskPath = null;
      updateRefNote();
    }
  });
}

// 切 DiT 权重：bundle 自带（bf16）或已装的单文件。单文件自带档位，切它时档位跟着走。
nodes.dit.addEventListener("change", async () => {
  const target = nodes.dit.value;
  const files = Array.isArray(latest?.files) ? latest.files : [];
  try {
    if (!target) {
      // 回到 bundle 的 bf16：turbo 要 4-bit 权重，跑不了时降到 high。
      const tier = nodes.tier.value === "turbo" ? "high" : nodes.tier.value;
      await post("/settings", { modelFiles: { ...(latest?.settings?.modelFiles ?? {}), dit: null }, tier });
      if (tier !== nodes.tier.value) {
        nodes.tier.value = tier;
        lastTierEdit = Date.now();
        say("已改成 bundle 自带权重；turbo 要 4-bit，档位降到 high", "warn");
      } else {
        say("DiT 权重：bundle 自带（bf16）", "ok");
      }
    } else {
      const file = files.find((item) => item.target === target);
      if (!file) throw new Error("这个文件不在清单里");
      await post("/files/use", { id: file.id });
      if (file.tier) {
        nodes.tier.value = file.tier;
        lastTierEdit = Date.now();
      }
      say(`DiT 权重：${shortDitName(file.name)}${file.tier ? `（${file.tier} 档）` : ""}`, "ok");
    }
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
});

// 文本编码器：只换权重文件，档位不受影响。
nodes.te.addEventListener("change", async () => {
  const target = nodes.te.value;
  const files = Array.isArray(latest?.files) ? latest.files : [];
  try {
    if (!target) {
      await post("/settings", { modelFiles: { ...(latest?.settings?.modelFiles ?? {}), textEncoder: null } });
      say("文本编码器：bundle 自带（bf16）", "ok");
    } else {
      const file = files.find((item) => item.target === target);
      if (!file) throw new Error("这个文件不在清单里");
      await post("/files/use", { id: file.id });
      // reference 拒绝量化文本编码器（引擎原话：refused for a quantized text encoder file），
      // 选了就把它带到 high。
      if (nodes.tier.value === "reference") {
        nodes.tier.value = "high";
        lastTierEdit = Date.now();
        await post("/settings", { tier: "high" });
        say(`文本编码器：${file.name}；reference 不收量化文本编码器，档位已改成 high`, "warn");
        return;
      }
      say(`文本编码器：${file.name}`, "ok");
    }
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
});

nodes.tier.addEventListener("change", async () => {
  lastTierEdit = Date.now();
  const tier = nodes.tier.value;
  const modelFiles = latest?.settings?.modelFiles ?? {};
  const ditPath = modelFiles.dit ?? null;
  const ditFile = ditPath ? ((latest?.files ?? []).find((item) => item.target === ditPath) ?? null) : null;
  const teActive = modelFiles.textEncoder ?? null;
  try {
    const lite = Boolean(latest?.modelLite?.lite);
    // 轻量配置包没有自带权重：任何档位都得先有单文件 DiT，否则引擎直接报目录不完整。
    if (lite && !ditPath) {
      const back = latest?.settings?.tier ?? "reference";
      nodes.tier.value = back;
      say("这个配置包没有 DiT 权重：先在「DiT 权重」里选一个文件", "warn");
      return;
    }
    // turbo 要 4-bit 权重：手上没有单文件 DiT 时选它，引擎只会报 invalid_argument。
    if (tier === "turbo" && !ditPath) {
      const back = latest?.settings?.tier ?? "reference";
      nodes.tier.value = back;
      say("turbo 要 4-bit DiT：先在「DiT 权重」里选一个 INT4 文件", "warn");
      return;
    }
    // 三档对权重的要求：turbo 要 4-bit，reference 要 bf16，high 只要不是 4-bit。
    const dropDit = ditFile
      ? tier === "turbo"
        ? ditFile.tier !== "turbo"
        : tier === "reference"
          ? Boolean(ditFile.tier)
          : ditFile.tier === "turbo"
      : false;
    // reference 也不收量化文本编码器。
    const dropTe = tier === "reference" && Boolean(teActive);
    // 轻量包里没有可退回的权重：不能“清掉不匹配的文件”，只能把档位退回去。
    if (lite && (dropDit || dropTe)) {
      const back = latest?.settings?.tier ?? "reference";
      nodes.tier.value = back;
      say(
        dropDit
          ? `${shortDitName(ditFile.name)} 只能跑 ${ditFile.tier} 档，档位没改`
          : "reference 不收量化文本编码器，先把「文本编码器」换成 bf16 或 bundle 自带",
        "warn",
      );
      return;
    }
    if (dropDit || dropTe) {
      const patch = { tier, modelFiles: { ...modelFiles } };
      if (dropDit) patch.modelFiles.dit = null;
      if (dropTe) patch.modelFiles.textEncoder = null;
      await post("/settings", patch);
      const why = [
        dropDit ? `${shortDitName(ditFile.name)} 只能跑 ${ditFile.tier} 档` : null,
        dropTe ? "reference 不收量化文本编码器" : null,
      ]
        .filter(Boolean)
        .join("；");
      say(`已退回 bundle 自带权重：${why}`, "warn");
    } else {
      await post("/settings", { tier });
      say(`档位：${tier}`);
    }
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
});

// 切模型：只改设置，引擎下次 load 时按新目录读；已加载的缓存由服务端作废。
nodes.model.addEventListener("change", async () => {
  const variant = nodes.model.value;
  if (!variant) return;
  try {
    await post("/weights/use", { variant });
    say("模型已切换，下次出图重新加载", "ok");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
});

// 导入 LoRA：二进制直传，落在 app-data/loras 里，路径稳定。
nodes.loraImport.addEventListener("click", () => nodes.loraFile.click());
nodes.loraFile.addEventListener("change", async () => {
  const file = nodes.loraFile.files?.[0];
  nodes.loraFile.value = "";
  if (!file) return;
  try {
    nodes.loraImport.disabled = true;
    say(`正在导入 ${file.name}…`);
    const result = await uploadBinary(`/loras/import?name=${encodeURIComponent(file.name)}`, file);
    addLora(result.path);
    say(`已导入 ${file.name}，已勾选。`, "ok");
    // 顺手问一句它是什么：base 不对或读不出来，现在知道比出图失败才知道好。
    void post("/inspect", { path: result.path }).then(
      (info) => {
        if (!info?.loadable) say(`${file.name}：${info?.note ?? "引擎读不了这个文件"}`, "bad");
        else if (info.kind === "lora") say(`已导入 ${file.name}（rank ${info.lora_rank ?? "?"}，${info.adapter_types?.join("/") ?? "lora"}）`, "ok");
      },
      () => {},
    );
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    nodes.loraImport.disabled = false;
  }
});
nodes.loraPathShow.addEventListener("click", () => {
  nodes.loraPathRow.hidden = !nodes.loraPathRow.hidden;
  if (!nodes.loraPathRow.hidden) nodes.loraPath.focus();
});
nodes.loraPathAdd.addEventListener("click", () => {
  addLora(nodes.loraPath.value);
  nodes.loraPath.value = "";
});
nodes.loraPath.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addLora(nodes.loraPath.value);
  nodes.loraPath.value = "";
});

// 控制适配器：导入后先问引擎一句它是什么，kind 直接填进去。
nodes.controlImport.addEventListener("click", () => nodes.controlFile.click());
nodes.controlFile.addEventListener("change", async () => {
  const file = nodes.controlFile.files?.[0];
  nodes.controlFile.value = "";
  if (!file) return;
  try {
    nodes.controlImport.disabled = true;
    say(`正在导入 ${file.name}…`);
    const result = await uploadBinary(`/control/import?name=${encodeURIComponent(file.name)}`, file);
    setControlAdapter(result.path);
    const info = await post("/inspect", { path: result.path }).catch(() => null);
    if (info?.control_kinds?.length) {
      if (!nodes.controlKind.value.trim()) nodes.controlKind.value = info.control_kinds[0];
      say(`已导入控制适配器（${info.control_kinds.join(" / ")}）。`, "ok");
    } else if (info) {
      // 引擎认了它、但说它不是控制适配器：别留一个每次都要报错的设置。
      clearControlAdapter();
      say(`这个文件不是控制适配器（${info.kind ?? "未知"}）：换带 video_embedder 的完整适配器，或把它放进 LoRA。`, "bad");
    } else {
      say(`已导入 ${file.name}，但没能向引擎校验（引擎未启动？）。`, "warn");
    }
    updateControlNote();
    scheduleSave();
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    nodes.controlImport.disabled = false;
  }
});
nodes.controlClear.addEventListener("click", () => {
  clearControlAdapter();
  scheduleSave();
});
nodes.controlPick.addEventListener("click", () => nodes.controlImgFile.click());
nodes.controlImgFile.addEventListener("change", async () => {
  const file = nodes.controlImgFile.files?.[0];
  nodes.controlImgFile.value = "";
  if (file) await setControlImage(file);
});
nodes.controlImgClear.addEventListener("click", () => {
  controlSource = null;
  controlImage = null;
  nodes.controlThumb.hidden = true;
  nodes.controlImg.removeAttribute("src");
  updateControlNote();
});
nodes.controlKind.addEventListener("input", () => {
  updateControlNote();
  scheduleSave();
});

// 参考图
nodes.refPick.addEventListener("click", () => nodes.refFile.click());

// 侧栏整页都是拖放落点：文件从桌面拖进来就当作底图。
// 计数是为了在子元素之间移动时不被误判成离开（dragleave 会连发）。
let dropDepth = 0;
const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
const hideDropHint = () => {
  dropDepth = 0;
  if (nodes.dropHint) nodes.dropHint.hidden = true;
};
window.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dropDepth += 1;
  if (nodes.dropHint) nodes.dropHint.hidden = false;
});
window.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  // 落在「参考图」块上就是编辑适配器的源图，其余地方当底图。
  const overRef = Boolean(event.target?.closest?.("#pn-editref-block"));
  if (nodes.dropHint) nodes.dropHint.textContent = overRef ? "松手当作参考图" : "松手当作底图";
});
window.addEventListener("dragleave", (event) => {
  if (!carriesFiles(event)) return;
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth) hideDropHint();
});
window.addEventListener("drop", async (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  const overRef = Boolean(event.target?.closest?.("#pn-editref-block"));
  hideDropHint();
  const files = Array.from(event.dataTransfer?.files ?? []);
  const file = files.find((item) => (item.type ? item.type.startsWith("image/") : /\.(png|jpe?g|webp|bmp|avif)$/i.test(item.name ?? "")));
  if (!file) {
    say("拖进来的不是图片（要 png / jpg / webp）。", "bad");
    return;
  }
  if (overRef) await setEditReference(file, file.name);
  else await setReference(file);
});
nodes.refFile.addEventListener("change", async () => {
  const file = nodes.refFile.files?.[0];
  nodes.refFile.value = "";
  if (file) await setReference(file);
});
nodes.refClear.addEventListener("click", () => clearReference());
nodes.editRefClear.addEventListener("click", () => clearEditReference());
nodes.editRefPick.addEventListener("click", () => nodes.editRefFile.click());
nodes.editRefFile.addEventListener("change", async () => {
  const file = nodes.editRefFile.files?.[0];
  nodes.editRefFile.value = "";
  if (file) await setEditReference(file, file.name);
});
nodes.refResize.addEventListener("change", async () => {
  if (!refImage) return;
  refPrepared = null;
  maskPath = null;
  try {
    await prepareRef(Number(nodes.width.value), Number(nodes.height.value));
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
});

// 蒙版编辑
nodes.maskEdit.addEventListener("click", openMaskEditor);
nodes.maskCancel.addEventListener("click", () => {
  nodes.mask.hidden = true;
});
nodes.maskClear.addEventListener("click", () => {
  if (!maskCtx) return;
  maskCtx.clearRect(0, 0, nodes.maskCanvas.width, nodes.maskCanvas.height);
});
nodes.maskSave.addEventListener("click", () => void saveMask());
nodes.maskPaint.addEventListener("click", () => {
  maskMode = "paint";
  nodes.maskPaint.classList.add("on");
  nodes.maskErase.classList.remove("on");
});
nodes.maskErase.addEventListener("click", () => {
  maskMode = "erase";
  nodes.maskErase.classList.add("on");
  nodes.maskPaint.classList.remove("on");
});

const maskDown = (event) => {
  if (nodes.mask.hidden) return;
  event.preventDefault();
  maskPainting = true;
  maskLast = null;
  nodes.maskCanvas.setPointerCapture?.(event.pointerId);
  paintTo(maskPoint(event));
};
nodes.maskCanvas.addEventListener("pointerdown", maskDown);
nodes.maskCanvas.addEventListener("pointermove", (event) => {
  if (!maskPainting) return;
  paintTo(maskPoint(event));
});
const maskUp = (event) => {
  if (!maskPainting) return;
  maskPainting = false;
  maskLast = null;
  try {
    nodes.maskCanvas.releasePointerCapture?.(event.pointerId);
  } catch {
    /* 指针没了 */
  }
};
nodes.maskCanvas.addEventListener("pointerup", maskUp);
nodes.maskCanvas.addEventListener("pointercancel", maskUp);
nodes.maskZoomIn.addEventListener("click", () => {
  const index = MASK_ZOOMS.indexOf(maskZoom);
  maskZoom = MASK_ZOOMS[Math.min(MASK_ZOOMS.length - 1, index + 1)];
  layoutMaskCanvas();
});
nodes.maskZoomOut.addEventListener("click", () => {
  const index = MASK_ZOOMS.indexOf(maskZoom);
  maskZoom = MASK_ZOOMS[Math.max(0, index - 1)];
  layoutMaskCanvas();
});
window.addEventListener("resize", () => {
  if (!nodes.mask.hidden) layoutMaskCanvas();
});

// 手敲宽高滑块不动，这里把刻度跟着实际像素量对齐。
for (const node of [nodes.width, nodes.height]) {
  node.addEventListener("input", () => {
    syncNotchFromSize();
    renderSize();
  });
}

nodes.generate.addEventListener("click", onGenerate);
nodes.cancel.addEventListener("click", onCancel);
nodes.start.addEventListener("click", async () => {
  nodes.start.disabled = true;
  say("正在启动引擎…");
  try {
    const result = await post("/engine/start", {}, 120000);
    say("引擎已启动。", "ok");
    render(result);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    nodes.start.disabled = false;
  }
});

nodes.release.addEventListener("click", async () => {
  nodes.release.disabled = true;
  say("正在把权重读回内存并释放显存…");
  try {
    const result = await post("/engine/release", {}, 180000);
    const freed = result.release?.vram_released_bytes ?? 0;
    say(`已释放 ${(freed / 1024 ** 3).toFixed(2)} GB 显存，下次出图自动重新加载。`, "ok");
    render(result);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    nodes.release.disabled = false;
  }
});
bindSizeSliders();

// ── 主区域的“用这张的参数” ─────────────────────────────────────
const reuseChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;

function applyReuse(job) {
  if (typeof job.prompt === "string") nodes.prompt.value = job.prompt;
  if (typeof job.negativePrompt === "string") nodes.negative.value = job.negativePrompt;
  if (job.width && job.height) setSize(job.width, job.height);
  if (job.steps) nodes.steps.value = String(job.steps);
  // CFG 取 0 是合法值，不能当假值跳过。
  if (job.cfg != null && job.cfg !== "") nodes.cfg.value = String(job.cfg);
  nodes.seed.value = job.seed != null && job.seed !== "" ? String(job.seed) : "";
  // 采样面一并带回来：只回提示词会把「这张怎么来的」弄丢。
  if (job.sampler && nodes.sampler.querySelector(`option[value="${job.sampler}"]`)) nodes.sampler.value = job.sampler;
  if (job.scheduler && nodes.scheduler.querySelector(`option[value="${job.scheduler}"]`)) nodes.scheduler.value = job.scheduler;
  if (job.shift != null) nodes.shift.value = String(job.shift);
  if (job.stepCache) nodes.stepCache.value = job.stepCache;
  if (Array.isArray(job.uncondSkipLayers)) nodes.uncondLayers.value = job.uncondSkipLayers.join(", ");
  if (Array.isArray(job.slgLayers)) nodes.slgLayers.value = job.slgLayers.join(", ");
  if (job.slgScale != null) nodes.slgScale.value = String(job.slgScale);
  if (job.slgStart != null) nodes.slgStart.value = String(job.slgStart);
  if (job.slgStop != null) nodes.slgStop.value = String(job.slgStop);
  if (job.maxSequenceLength != null) nodes.maxSeq.value = String(job.maxSequenceLength);
  if (job.flowMultiplier != null) nodes.flow.value = String(job.flowMultiplier);
  if (job.noiseLayout) nodes.noiseLayout.value = job.noiseLayout;
  if (job.noiseSource) nodes.noiseSource.value = job.noiseSource;
  if (job.eta != null) nodes.eta.value = String(job.eta);
  if (job.sNoise != null) nodes.sNoise.value = String(job.sNoise);
  if (job.dataspace) nodes.dataspace.value = job.dataspace;
  if (job.distill) nodes.distill.value = job.distill;
  summarizeAdvSampling();
  syncAccel();
  for (const item of Array.isArray(job.loras) ? job.loras : []) {
    if (item?.path) addLora(item.path, Number(item.strength) || 1);
  }
  say("已载入这张的参数", "ok");
}

reuseChannel?.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type === "reuse" && data.job) applyReuse(data.job);
  // 下载页或工具改了设置：主界面把它当事件转过来。
  if (data?.type === "settings") {
    applySharedSettings(data.settings);
    return;
  }
  // 作品区的右键菜单：把这图当参考图送进来。
  if (data?.type === "reference" && typeof data.name === "string") {
    void setReference(outputUrl(data.name));
  }
  // 编辑适配器：这张图当 instructions 的源图。
  if (data?.type === "edit-reference" && typeof data.name === "string") {
    void setEditReference(outputUrl(data.name), data.name);
  }
  // 画布上画好的蒙版：上传交给这里，提交时用的还是同一个 maskPath。
  if (data?.type === "canvas-mask" && data.blob) {
    void adoptCanvasMask(data.blob, data.share);
    return;
  }
  if (data?.type === "canvas-clear") {
    clearReference();
    return;
  }
  // 画布刚起来，问一遍当前底图。
  if (data?.type === "edit-hello") broadcastEditState(true);
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
  // 主界面会把它收到的整帧状态广播过来。侧栏主动去开连接是白费：
  // 主界面本来就在拉，拉完一推就完事。所以这里先等广播，等不到再自己接管。
  const startOwnLive = () =>
    startLive({
      hana,
      onState: (state) => render(state),
      fetchState: () => api("/state"),
      onError: (error) => {
        if (latest) return;
        nodes.state.textContent = error instanceof Error ? error.message : String(error);
        nodes.dot.className = "dot err";
      },
    });
  let ownLive = null;
  const stopOwnLive = () => {
    ownLive?.();
    ownLive = null;
  };
  let lastBroadcast = 0;
  const takeOver = async () => {
    if (ownLive) return;
    await refresh().catch(() => {});
    ownLive = startOwnLive();
  };

  reuseChannel?.addEventListener("message", (event) => {
    if (event.data?.type !== "state" || !event.data.state) return;
    lastBroadcast = Date.now();
    stopOwnLive();
    render(event.data.state);
  });

  // 两秒内没等到广播（主界面还没起来、或者跨 origin 发不过来）就自己接管。
  setTimeout(() => {
    if (!lastBroadcast) void takeOver();
  }, 2000);
  // 主界面可能比侧栏晚起来：它到时候会发 edit-hello，这里先把底图报一次。
  broadcastEditState(true);
  // 主界面关闭后广播会断，超过十五秒没收到就自己重新接上。
  setInterval(() => {
    if (ownLive) return;
    if (!lastBroadcast) return;
    if (Date.now() - lastBroadcast < 15000) return;
    void takeOver();
  }, 5000);
}

void boot();
