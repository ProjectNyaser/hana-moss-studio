// 苔室侧栏：生成设置与运行状态都在这条侧栏里，工作区那边只留画布与画廊。
// 数据：GET /hana-moss-studio/state（轮询 1.5s）；写操作走同前缀的 POST 路由。
import { hana } from "./sdk.js";
import { startLive, inputUrl, outputUrl, thumbUrl } from "./live.js";
import { applyTheme } from "./theme.js";

// 面板脚本一旦抛错，侧栏会整块空白：把第一条错误直接写到列表里。
window.addEventListener("error", (event) => {
  const box = document.getElementById("pn-history");
  if (!box) return;
  box.textContent = `脚本错误：${event.message} @ ${String(event.filename ?? "").split("/").pop()}:${event.lineno ?? 0}`;
});

const API = "/hana-moss-studio";
/** 主界面在 compose-send 里带来的底图路径，只对这一条请求有效。 */
let pendingBase = null;
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
  tierMini: el("pn-tier-mini"),
  modelChip: el("pn-model-chip"),
  pop: el("pn-pop"),
  popModel: el("pn-pop-model"),
  popTier: el("pn-pop-tier"),
  modelHint: el("pn-model-hint"),
  dit: el("pn-dit"),
  ditNote: el("pn-dit-note"),
  modelFoldNote: el("pn-model-fold-note"),
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
  latent: el("pn-latent"),
  latentNote: el("pn-latent-note"),
  batchField: el("pn-batch-field"),
  batch: el("pn-batch"),
  resumeRow: el("pn-resume-row"),
  resumeName: el("pn-resume-name"),
  resumeGo: el("pn-resume-go"),
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
  refResize: el("pn-ref-resize"),
  strength: el("pn-strength"),
  maskEdit: el("pn-mask-edit"),
  latentInpaint: el("pn-latent-inpaint"),
  chips: el("pn-chips"),
  paramsToggle: el("pn-params-toggle"),
  presets: el("pn-presets"),
  newConv: el("pn-new-conv"),
  history: el("pn-history"),
  addImage: el("pn-add-image"),
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
  editRefList: el("pn-editref-list"),
  editRefNote: el("pn-editref-note"),
  editRefPick: el("pn-editref-pick"),
  editRefFile: el("pn-editref-file"),
  editRefClear: el("pn-editref-clear"),
  refControls: el("pn-ref-controls"),
  release: el("pn-release"),
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
  nodes.batch.value = settings.defaults.batch ?? 1;
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
  // 尺寸不占着工具行：参数按钮的悬浮说明里报。
  nodes.paramsToggle.title = `参数：${finalW}×${finalH} · 画幅、步数、采样与模型`;

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
/** 编辑参考图：最多 4 张，第一张当源图。 */
/** 跟主界面聊参考图数量用；放在前面声明，初始化时就已有这个频道。 */
const editChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hana-moss-studio") : null;
let editSources = [];
/** 按目标尺寸 fit 好并上传过的那一批：{width, height, key, items}。 */
let editPrepared = null;
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
/** 编辑适配器的参考图：按目标尺寸 fit 好再上传，最多 4 张，第一张是源图。 */
async function prepareEditReferences(width, height) {
  if (!editSources.length) return [];
  const key = editSources.map((item) => item.url).join("|");
  if (editPrepared && editPrepared.width === width && editPrepared.height === height && editPrepared.key === key) {
    return editPrepared.items;
  }
  const items = [];
  for (const source of editSources) {
    const blob = await canvasBlob(drawFitted(source.image, width, height, "fit"));
    const result = await uploadBinary("/inputs/upload?kind=ref", blob);
    items.push({ path: result.path, url: inputUrl(result.name) });
  }
  editPrepared = { width, height, key, items };
  return items;
}

function updateRefNote() {
  if (!refPrepared) {
    nodes.refNote.textContent = "未选择";
    nodes.maskEdit.hidden = true;
    nodes.latentInpaint.hidden = true;
    // 没参考图时重绘强度与适配无处可用，不摆在那里让用户以为它们会生效。
    nodes.refControls.hidden = true;
    broadcastEditState();
    renderComposer();
    return;
  }
  const size = `${refPrepared.width}×${refPrepared.height}`;
  nodes.refNote.textContent = maskPath ? `局部重绘 · ${size}` : `图生图 · ${size}`;
  nodes.maskEdit.hidden = false;
  nodes.maskEdit.textContent = maskPath ? "改蒙版" : "画蒙版";
  // 蒙版与底图同尺寸时才能做 latent 级重绘（它要求 16 的倍数）。
  nodes.latentInpaint.hidden = !(maskPath && refPrepared.width % 16 === 0 && refPrepared.height % 16 === 0);
  nodes.refControls.hidden = false;
  broadcastEditState();
  renderComposer();
}

/** 底部输入区的附件芯片：这次请求带了什么图，一眼看得到，点 × 就去掉。 */
function renderComposer() {
  const chips = [];
  if (refPrepared) {
    chips.push({
      label: `底图 ${refPrepared.width}×${refPrepared.height}`,
      url: refPrepared.url,
      drop: () => clearReference(),
    });
  }
  if (maskPath) {
    chips.push({
      label: maskShare ? `蒙版 ${Math.round(maskShare * 100)}%` : "蒙版",
      drop: () => {
        maskPath = null;
        maskBlob = null;
        maskShare = 0;
        updateRefNote();
      },
    });
  }
  editSources.forEach((item, index) => {
    chips.push({
      label: `参考 ${index + 1}`,
      url: item.url,
      drop: () => removeEditReference(index),
    });
  });
  nodes.chips.replaceChildren(
    ...chips.map((chip) => {
      const row = document.createElement("span");
      row.className = "pn-chip";
      if (chip.url) {
        const image = document.createElement("img");
        image.src = chip.url;
        image.alt = "";
        row.appendChild(image);
      }
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = chip.label;
      row.appendChild(name);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "pn-chip-x";
      close.textContent = "×";
      close.title = "去掉";
      close.addEventListener("click", () => chip.drop());
      row.appendChild(close);
      return row;
    }),
  );
  nodes.chips.hidden = chips.length === 0;
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
function renderEditRefs() {
  const list = nodes.editRefList;
  list.hidden = !editSources.length;
  list.replaceChildren(
    ...editSources.map((item, index) => {
      const cell = document.createElement("div");
      cell.className = "item";
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.name;
      img.title = item.name;
      const tag = document.createElement("span");
      tag.className = "ix";
      tag.textContent = index === 0 ? "源" : String(index + 1);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "x";
      remove.textContent = "×";
      remove.title = "移除这张";
      remove.addEventListener("click", () => removeEditReference(index));
      cell.append(img, tag, remove);
      return cell;
    }),
  );
  nodes.editRefNote.textContent = editSources.length ? `${editSources.length} 张` : "未选择";
  editChannel?.postMessage({
    type: "edit-refs",
    count: editSources.length,
    names: editSources.map((item) => item.name),
  });
  renderComposer();
}

function removeEditReference(index) {
  const [removed] = editSources.splice(index, 1);
  if (removed && String(removed.url).startsWith("blob:")) URL.revokeObjectURL(removed.url);
  editPrepared = null;
  renderEditRefs();
}

async function addEditReference(source, name = "画廊图") {
  if (editSources.length >= 4) {
    say("参考图最多 4 张。", "bad");
    return;
  }
  let url = null;
  try {
    url = typeof source === "string" ? source : URL.createObjectURL(source);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("这张图读不出来"));
      image.src = url;
    });
    editSources.push({ image, name, url });
    editPrepared = null;
    renderEditRefs();
    const blocked = !loras.some((item) => item.enabled !== false && /edit/i.test(String(item.path ?? "")));
    say(
      blocked
        ? `参考图 ${editSources.length} 张就绪，但 LoRA 里没有编辑适配器，它不会生效。`
        : `参考图 ${editSources.length} 张就绪（第一张是源图），配合提示词一起跑。`,
      blocked ? "bad" : "ok",
    );
  } catch (error) {
    if (url && typeof source !== "string") URL.revokeObjectURL(url);
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

function clearEditReference() {
  for (const item of editSources) {
    if (String(item.url).startsWith("blob:")) URL.revokeObjectURL(item.url);
  }
  editSources = [];
  editPrepared = null;
  renderEditRefs();
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
    // 不写「未启动」：这易让人以为要先去点按钮。引擎是出图时自动拉起的。
    label = "空闲 · 出图时自动启动";
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
  // 折叠起来的摘要：不展开也能看出现在跑的是哪套权重。
  const tierNow = data?.settings?.tier ?? "reference";
  const ditNow = ditFile ? shortDitName(ditFile.name) : "bundle 自带";
  // 文件名里已经写了档位（INT4 ConvRot（turbo 档））就不重复一遍。
  nodes.modelFoldNote.textContent = ditNow.includes(tierNow) ? ditNow : `${ditNow} · ${tierNow}`;
  nodes.modelFoldNote.title = ditFile?.path ?? "bundle 自带的 bf16 DiT";

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

  // 输入框旁那格是精度档，跟参数区里的 tier 同一份设置。
  nodes.tierMini.value = tierNow;
  // 手上这份 DiT 只能跑一个档时，标题里直说，别让人选了又弹回。
  nodes.tierMini.disabled = false;
  nodes.tierMini.title = ditFile?.tier
    ? `当前 DiT 只能跑 ${ditFile.tier} 档`
    : "精度档：turbo 最快、high 居中、reference 最准";
  // 输入框右下那格只报名字：模型与精度档合在一起，点它浮出面板。
  const modelLabel = current?.label ?? "MOSS-Image";
  // 前缀在这栏里重复出现四次，去掉只留变体名。
  const shortLabel = modelLabel.replace(/^MOSS-Image[-_ ]?/i, "") || modelLabel;
  nodes.modelChip.textContent = `${shortLabel} · ${tierNow}`;
  nodes.modelChip.title = ditFile?.tier
    ? `${modelLabel} · 当前 DiT 只能跑 ${ditFile.tier} 档`
    : `${modelLabel} · 精度档 ${tierNow}`;
  // 浮层里的两个选择器跟参数区同源。
  nodes.popModel.replaceChildren(
    ...Array.from(nodes.model.options).map((option) => new window.Option(option.textContent, option.value)),
  );
  nodes.popModel.value = nodes.model.value;
  nodes.popModel.disabled = !models.length;
  nodes.popTier.value = tierNow;
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
let checkpointCache = { at: 0, item: null };

/** 可续画的断点：只报还没跑完的那一个，跑完的不占位置。 */
async function refreshCheckpoint(force = false) {
  if (!force && Date.now() - checkpointCache.at < 8000) return;
  checkpointCache.at = Date.now();
  try {
    const data = await api("/latent/checkpoints", undefined, 8000);
    const pending = (data.items ?? []).find((item) => !item.done) ?? null;
    checkpointCache.item = pending;
    if (!pending) {
      nodes.resumeRow.hidden = true;
      return;
    }
    nodes.resumeRow.hidden = false;
    nodes.resumeName.textContent = `断点 ${pending.stepIndex}/${pending.steps} · ${pending.width}×${pending.height}`;
    nodes.resumeName.title = pending.prompt || "";
  } catch {
    /* 老版本没有这条路由 */
  }
}

/** 侧栏是会话列表：当前会话从「新对话」那一刻算起，更早的按间隔归段。 */
let sessionsCache = [];
let sessionsAt = 0;
let activeConv = null;
const CONV_KEY = "hana-moss-studio.conv-start";
const CONV_ID_KEY = "hana-moss-studio.conv-id";
// 隔一阵再打开就是新对话：短时间内刷新沿用当前这段。
// 打开就开一段新会话；除非上一次主动选了「继续这一段」。
try {
  if (localStorage.getItem("hana-moss-studio.conv-pinned") !== "1") {
    const now = Date.now();
    localStorage.setItem(CONV_ID_KEY, `conv-${now.toString(36)}`);
    localStorage.setItem("hana-moss-studio.fresh-at", String(now));
  }
} catch {
  /* 存不了就沿用旧的 */
}

/** 当前会话的 id：开新对话时换一个，出图时随请求写进元数据。 */
function convId() {
  try {
    const existing = localStorage.getItem(CONV_ID_KEY);
    if (existing) return existing;
    const fresh = `conv-${Date.now().toString(36)}`;
    localStorage.setItem(CONV_ID_KEY, fresh);
    return fresh;
  } catch {
    return `conv-${Date.now().toString(36)}`;
  }
}

function convStart() {
  try {
    return Number(localStorage.getItem(CONV_KEY)) || 0;
  } catch {
    return 0;
  }
}

function groupSessions(jobs) {
  const sorted = jobs
    .filter((job) => job.status === "done" && job.output)
    .sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0));
  // 依据是图片自己声明的会话 id：有的并到一段，没的各自独立。
  const groups = new Map();
  const singles = [];
  for (const job of sorted) {
    const t = Date.parse(job.createdAt ?? "") || 0;
    const conv = job.origin?.conv ?? null;
    if (!conv) {
      singles.push({ key: `solo:${job.id}`, t, jobs: [job] });
      continue;
    }
    const found = groups.get(conv);
    if (found) {
      found.jobs.push(job);
      continue;
    }
    groups.set(conv, { key: conv, conv, t, jobs: [job] });
  }
  // 严格按最后活跃时间倒序：这个会话里最新一张出图的时间，就是它坐的位置。
  const stamp = (item) => (item.jobs.length ? Math.max(...item.jobs.map((job) => Date.parse(job.createdAt ?? "") || 0)) : 0);
  return [...groups.values(), ...singles]
    .map((item) => ({ ...item, t: stamp(item) }))
    .sort((a, b) => b.t - a.t);
}

const CONV_NAMES_KEY = "hana-moss-studio.conv-names";

function convNameMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONV_NAMES_KEY) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function setConvName(key, name) {
  const map = convNameMap();
  if (name) map[key] = name;
  else delete map[key];
  try {
    localStorage.setItem(CONV_NAMES_KEY, JSON.stringify(map));
  } catch {
    /* 存不了就算了，只影响显示 */
  }
}

async function loadSessions() {
  // 一张图一段，全量从 /jobs 拿：state 只带最近两条，不够当记录看。
  try {
    const response = await hana.api.fetch(`${API}/jobs?offset=0&limit=100`);
    if (!response.ok) throw new Error(`jobs ${response.status}`);
    const page = await response.json();
    sessionsCache = groupSessions(Array.isArray(page.jobs) ? page.jobs : []);
    // 当前会话已经有图了：占位就该让位给那一行。
    try {
      const current = localStorage.getItem(CONV_ID_KEY);
      if (current && sessionsCache.some((item) => item.conv === current)) blankConversation = false;
    } catch {
      /* 读不到就维持原状 */
    }
    paintSessions();
  } catch (error) {
    const box = nodes.history;
    if (box) box.textContent = `记录拉取失败：${error?.message ?? error}`;
  }
}

let convMenu = null;
// 菜单属于哪个⋯按钮：再点同一个就收回去，不用去别处点。
let convMenuAnchor = null;

function closeConvMenu() {
  convMenu?.remove();
  convMenu = null;
  convMenuAnchor = null;
}

/** 之后出图都归到这一段；刷新也留在这里，直到再开新对话。 */
function continueSession(session) {
  try {
    if (session.conv) localStorage.setItem(CONV_ID_KEY, session.conv);
    localStorage.setItem("hana-moss-studio.conv-pinned", "1");
  } catch {
    /* 存不了就只在这次生效 */
  }
  blankConversation = false;
  activeConv = session.jobs.map((job) => job.id);
  editChannel?.postMessage({ type: "open-conversation", jobs: session.jobs });
  paintSessions();
  say(`后续出图归到「${sessionTitle(session)}」`);
}

/** 解除归属：图还在画廊，只是不再算某一段。 */
async function dissolveSession(session) {
  const names = session.jobs
    .map((job) => job.output)
    .filter(Boolean)
    .map((output) => String(output).split(/[\\/]/).pop());
  if (!names.length) return;
  try {
    const response = await fetch(`${base}/outputs/conv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names, conv: "" }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    say("已解散这一段，图仍在画廊");
    if (session.conv) {
      try {
        if (localStorage.getItem(CONV_ID_KEY) === session.conv) blankConversation = true;
      } catch {
        /* 读不到就算了 */
      }
    }
    await loadSessions();
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  }
}

function openConvMenu(session, anchor) {
  closeConvMenu();
  const menu = document.createElement("div");
  menu.className = "pn-conv-menu";
  const add = (label, run) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "pn-conv-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      closeConvMenu();
      void run();
    });
    menu.append(item);
  };
  add("继续这一段", () => continueSession(session));
  add("重命名", () => startRename(session, anchor));
  // 只有一张的段拆不出东西。
  if (session.jobs.length > 1) {
    add("把最新一张拆成新会话", () => splitSession(session));
  }
  add("解散这一段", () => dissolveSession(session));
  document.body.append(menu);
  convMenuAnchor = anchor;
  const rect = anchor.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
  const left = Math.max(8, Math.min(rect.left - 96, window.innerWidth - menu.offsetWidth - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  convMenu = menu;
}

document.addEventListener("click", () => closeConvMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeConvMenu();
});
nodes.history?.addEventListener("scroll", () => closeConvMenu());

function startRename(session, anchor) {
  const row = anchor.closest(".pn-conv-row");
  const text = row?.querySelector(".pn-hist-text");
  if (!text) return;
  const input = document.createElement("input");
  input.className = "pn-conv-rename";
  // 框里预填当前名字：改过名就是那个名字，没改过就是原标题。
  // 全选着，直接打字就是替换；清空保存等于退回原标题。
  // 取第一条带提示词的记录，和列表标题同一个来源，不是 jobs[0]。
  const basePrompt = session.jobs.find((job) => job.prompt)?.prompt ?? "";
  const currentName = convNameMap()[session.key] ?? basePrompt;
  input.value = currentName;
  input.placeholder = basePrompt || "无提示词";
  input.title = input.value;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) setConvName(session.key, input.value.trim());
    paintSessions.lastSig = "";
    paintSessions();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  // 只换标题那一行，张数与时间还在原位。
  const line = text.querySelector(".pn-hist-prompt");
  if (line) line.replaceWith(input);
  else text.replaceChildren(input);
  input.focus();
  input.select();
}

async function assignConv(names, conv) {
  const list = names.filter(Boolean);
  if (!list.length) return;
  try {
    await post("/outputs/conv", { names: list, conv });
  } catch (error) {
    say?.(`改归组失败：${error?.message ?? error}`, "bad");
  }
  await loadSessions();
}

/** 一段的显示名：改过的名字优先，否则取首条提示词。 */
function sessionTitle(session) {
  const raw = convNameMap()[session.key] ?? session.jobs.find((job) => job.prompt)?.prompt ?? "无提示词";
  const text = String(raw).trim() || "无提示词";
  return text.length > 10 ? `${text.slice(0, 10)}…` : text;
}

/** 把这一段与目标段写成同一个会话 id：目标没有 id 就现编一个。 */
async function mergeInto(session, target) {
  if (!target || target === session) return;
  const conv = target.conv ?? `conv-${Date.now().toString(36)}`;
  const names = [...target.jobs, ...session.jobs].map((job) => job.output);
  await assignConv(names, conv);
  say(`已并入「${sessionTitle(target)}」`);
  // 归属变了，旧的筛选集合不再对应任何一段。
  activeConv = null;
  editChannel?.postMessage({ type: "clear-conversation" });
  paintSessions();
}

/** 单张拆出：这一张成新会话，同段其它图不动。 */
async function splitOne(job) {
  const conv = `conv-${Date.now().toString(36)}`;
  await assignConv([job.output], conv);
  say("已拆成新会话");
  activeConv = null;
  editChannel?.postMessage({ type: "clear-conversation" });
  paintSessions();
}

/** 把最新的一张拆出去独立成段，其余的留在原来的段里。 */
async function splitSession(session) {
  if (session.jobs.length < 2) return;
  const [newest, ...rest] = session.jobs;
  const fresh = `conv-${Date.now().toString(36)}`;
  await assignConv([newest.output], fresh);
  // 原段没有 id（历史图）时补一个，否则剩下的图会被拆成各自独立。
  if (rest.length) {
    const keep = session.conv ?? `conv-${Date.now().toString(36)}-k`;
    await assignConv(
      rest.map((job) => job.output),
      keep,
    );
  }
  // 拆出来的那段直接成为当前会话，主界面跟着过去，不用自己再找。
  try {
    localStorage.setItem(CONV_ID_KEY, fresh);
    localStorage.setItem("hana-moss-studio.conv-pinned", "1");
  } catch {
    /* 存不了就只切这一次 */
  }
  blankConversation = false;
  activeConv = [newest.id];
  editChannel?.postMessage({ type: "open-conversation", jobs: [newest] });
  say("已把最新一张拆成新会话，并切了过去");
  paintSessions();
  await loadSessions();
}

// 会话行的拖放合并：dragSession 是正在被拖的那一段。
let dragSession = null;

function clearDropMarks() {
  document.querySelectorAll(".pn-conv-row.drop-target, .pn-conv-row.dragging").forEach((el) => {
    el.classList.remove("drop-target", "dragging");
  });
}

// 当前这一段还是空的：显式记着，不靠比较推断。
let blankConversation = (() => {
  try {
    return localStorage.getItem("hana-moss-studio.conv-pinned") !== "1";
  } catch {
    return true;
  }
})();

/** 空会话在列表顶部留一行占位；有图或去点历史就收起。 */
function withPlaceholder(sessions) {
  if (!blankConversation) return sessions;
  let current = null;
  try {
    current = localStorage.getItem(CONV_ID_KEY);
  } catch {
    current = null;
  }
  if (!current) return sessions;
  if (sessions.some((item) => item.conv === current)) return sessions;
  return [{ key: current, conv: current, jobs: [], placeholder: true }, ...sessions];
}

function paintSessions() {
  const list = nodes.history;
  if (!list) return;
  const rows = withPlaceholder(sessionsCache);
  // 数据没变就不动 DOM：轮询每三秒来一次，整体重建会让缩略图闪、菜单被收、
  // 正在改的名字被抹掉。
  const sig = JSON.stringify({
    rows: rows.map((item) => [
      item.key,
      item.conv ?? "",
      item.placeholder ?? false,
      item.jobs.length,
      item.jobs[item.jobs.length - 1]?.status ?? "",
      item.jobs.find((job) => job.prompt)?.prompt ?? "",
    ]),
    active: activeConv,
    blank: blankConversation,
    current: (() => {
      try {
        return localStorage.getItem(CONV_ID_KEY);
      } catch {
        return null;
      }
    })(),
    names: convNameMap(),
  });
  if (sig === paintSessions.lastSig) return;
  paintSessions.lastSig = sig;
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "pn-hist-empty";
    empty.textContent = "还没有出过图。";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...rows.map((session) => {
      const isBlank = Boolean(session.placeholder);
      // 一段一行；空会话也用这一行，只把内容换成占位。
      const btn = document.createElement("button");
      btn.type = "button";
      const currentConv = (() => {
        try {
          return localStorage.getItem(CONV_ID_KEY);
        } catch {
          return null;
        }
      })();
      btn.className = "pn-conv-row";
      // 空会话就是当前这一段，与选中同一个标记。
      if (isBlank) btn.classList.add("on");
      const ids = session.jobs.map((job) => job.id);
      if (activeConv && activeConv.length === ids.length && ids.every((id) => activeConv.includes(id))) {
        btn.classList.add("on");
      }
      if (session.conv && session.conv === currentConv) btn.classList.add("on");
      const head = session.jobs[0];
      let thumb;
      if (isBlank) {
        thumb = document.createElement("span");
        thumb.className = "pn-hist-thumb blank";
        thumb.textContent = "+";
      } else {
        thumb = document.createElement("img");
        thumb.className = "pn-hist-thumb";
        thumb.loading = "lazy";
        thumb.alt = "";
        if (head.output) {
          thumb.src = thumbUrl(head.output, 96);
          // 缩略图取不到就给个可见的占位，不要留一块空白让人以为图丢了。
          thumb.addEventListener("error", () => thumb.classList.add("blank"));
        } else {
          thumb.classList.add("blank");
        }
      }
      const text = document.createElement("span");
      text.className = "pn-hist-text";
      const firstPrompt = isBlank ? "新对话" : (session.jobs.find((job) => job.prompt)?.prompt ?? "");
      const line = document.createElement("span");
      line.className = "pn-hist-prompt";
      line.textContent = convNameMap()[session.key] ?? firstPrompt ?? "（无提示词）";
      if (!line.textContent) line.textContent = "（无提示词）";
      const meta = document.createElement("span");
      meta.className = "pn-hist-meta";
      if (isBlank) {
        const born = Number(localStorage.getItem("hana-moss-studio.fresh-at") ?? 0) || Date.now();
        meta.textContent = `0 张 · ${new Date(born).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
        text.append(line, meta);
        btn.append(thumb, text);
        btn.addEventListener("click", () => {
          activeConv = null;
          editChannel?.postMessage({ type: "new-conversation" });
          paintSessions();
        });
        return btn;
      }
      const when = head.createdAt
        ? new Date(head.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : "";
      // 正在跑或排队的那条也算活跃：这一段的时长就是最后一条消息的时刻。
      const shotCount = session.jobs.filter((job) => job.status === "done").length;
      const live = session.jobs.some((job) => job.status === "running")
        ? "生成中"
        : session.jobs.some((job) => job.status === "queued")
          ? "排队中"
          : "";
      meta.textContent = [shotCount ? `${shotCount} 张` : live || "还没有图", live, when]
        .filter(Boolean)
        .join(" · ");
      text.append(line, meta);
      btn.append(thumb, text);
      // 整理这一段放右键：列表上不摆一个常驻按钮。
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openConvMenu(session, btn);
      });
      // 双击标题就地改名。
      text.addEventListener("dblclick", (event) => {
        event.preventDefault();
        startRename(session, text);
      });
      // 缩略图是手柄：只从它起手，但拖的是整行，不是那张图。
      btn.draggable = false;
      thumb.draggable = false;
      thumb.title = "按住缩略图拖到另一段上并进去";
      thumb.addEventListener("pointerdown", () => {
        btn.draggable = true;
      });
      const releaseHandle = () => {
        btn.draggable = false;
      };
      thumb.addEventListener("pointerup", releaseHandle);
      thumb.addEventListener("pointercancel", releaseHandle);
      btn.addEventListener("dragstart", (event) => {
        dragSession = session;
        btn.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        // 拖影用整行，才看得出搬的是一段会话。
        event.dataTransfer.setDragImage(btn, 24, 24);
        event.dataTransfer.setData("text/plain", session.key);
      });
      btn.addEventListener("dragend", () => {
        dragSession = null;
        btn.draggable = false;
        btn.classList.remove("dragging");
        clearDropMarks();
      });
      btn.addEventListener("dragover", (event) => {
        if (!dragSession || dragSession === session) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        btn.classList.add("drop-target");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("drop-target"));
      btn.addEventListener("drop", (event) => {
        if (!dragSession) return;
        event.preventDefault();
        event.stopPropagation();
        const source = dragSession;
        dragSession = null;
        clearDropMarks();
        if (source === session) return;
        void mergeInto(source, session);
      });
      btn.addEventListener("click", () => {
        // 去点历史了：那个空的新对话占位就不再举着。
        blankConversation = false;
        // 点开就是接续这一段：之后的生成归到这里，不会另起一段。
        try {
          if (session.conv) {
            localStorage.setItem(CONV_ID_KEY, session.conv);
            localStorage.setItem("hana-moss-studio.conv-pinned", "1");
          }
        } catch {
          /* 存不了就只这一次 */
        }
        // 重复点同一段也要能把人带回会话页；只是不改筛选范围。
        activeConv = ids.slice();
        editChannel?.postMessage({
          type: "open-conversation",
          ids: activeConv,
          title: sessionTitle(session),
          // 带上整段记录：主界面只拉了第一页，靠前的老图不在里面。
          jobs: session.jobs,
        });
        paintSessions();
      });
      return btn;
    }),
  );
  // 选中的那段留在视野里：从会话页点回来时不用找。
  list.querySelector(".pn-conv-row.on")?.scrollIntoView({ block: "nearest" });
}

function render(data) {
  latest = data;
  facets = data.facets ?? facets;
  setSettings(data.settings);
  // 事件是主路（studio 转发 settings）；这一句只做补课：漏了事件也能对上。
  catchUpSettings(data);
  renderEngine(data);
  renderModels(data);
  void loadSessions();
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
  void refreshCheckpoint();
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
nodes.latent.addEventListener("change", () => {
  nodes.latentNote.hidden = !nodes.latent.checked;
  nodes.batchField.hidden = !nodes.latent.checked;
  scheduleSave();
});
nodes.resumeGo.addEventListener("click", async () => {
  const item = checkpointCache.item;
  if (!item) return;
  nodes.resumeGo.disabled = true;
  try {
    const result = await post("/latent/resume", { id: item.id });
    say(`已从断点入队 ${result.job?.jobId ?? ""}（第 ${item.stepIndex}/${item.steps} 步接着跑）`, "ok");
    if (result.state) render(result.state);
    void refreshCheckpoint(true);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    nodes.resumeGo.disabled = false;
  }
});

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
  if (nodes.latent.checked) {
    // 引擎的组件会话只做纯文生图：混着底图/控制图进去只会得到一条报错。
    if (refImage || editSources.length || controlAdapter) {
      say("可续画只做文生图：先把底图、参考图、控制图去掉。", "bad");
      return;
    }
    if (nodes.sampler.value !== "euler") {
      say("可续画只支持 euler + moss。", "bad");
      return;
    }
  }
  submitting = true;
  nodes.generate.disabled = true;
  say("已提交，排队中…");
  // 步数只挡 0 与负数，别再按 768px 的经验托高。
  const steps = Math.min(80, Math.max(1, Math.round(Number(nodes.steps.value) || 1)));
  nodes.steps.value = steps;
  const payload = {
    // 会话 id 跟着请求走，出图后落进 PNG 元数据，分组不靠猜。
    conv: convId(),
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
  if (nodes.latent.checked) payload.mode = "latent";
  if (nodes.latent.checked && Number(nodes.batch.value) > 1) {
    payload.batch = Math.min(4, Math.max(1, Math.round(Number(nodes.batch.value))));
  }
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
    if (pendingBase) {
      // 主界面已经把这张图上传过了，路径直接用。
      payload.initImage = pendingBase;
      payload.strength = Math.min(1, Math.max(0.05, Number(nodes.strength.value) || 0.6));
      payload.resize = "stretch";
      if (maskPath) {
        payload.mask = maskPath;
        payload.maskEncoding = "u8";
      }
      pendingBase = null;
    } else if (refImage) {
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
    if (editSources.length) {
      const prepared = await prepareEditReferences(Number(nodes.width.value), Number(nodes.height.value));
      if (prepared.length) {
        payload.referenceImages = prepared.map((item) => item.path);
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
    batch: Math.min(4, Math.max(1, Math.round(Number(nodes.batch.value) || 1))),
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
  } finally {
    // 被退回旧档位时，输入框旁那格也得跟着退。
    nodes.tierMini.value = nodes.tier.value;
  }
});

// 精度档：跟参数区那个选择器走同一套校验（权重不匹配时会把值退回去）。
nodes.tierMini.addEventListener("change", () => {
  nodes.tier.value = nodes.tierMini.value;
  nodes.tier.dispatchEvent(new window.Event("change"));
});
// 输入框旁的模型格子不直接开菜单：跳到参数区那一栏，那里能改的东西更多。
nodes.modelChip.addEventListener("click", () => {
  const fold = document.getElementById("pn-model-fold");
  if (!fold) return;
  fold.open = true;
  fold.scrollIntoView({ block: "center", behavior: "smooth" });
});
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

nodes.refFile.addEventListener("change", async () => {
  const file = nodes.refFile.files?.[0];
  nodes.refFile.value = "";
  if (file) await setReference(file);
});
nodes.refClear.addEventListener("click", () => clearReference());
// 还没有底图时，加进来的第一张就是底图；已经有了就追加成参考图。
nodes.addImage.addEventListener("click", () => {
  if (refPrepared) nodes.editRefFile.click();
  else nodes.refFile.click();
});
// 「参数」把人带到画幅那一栏，闪一下底让他们看清落在哪。
function focusParams() {
  const block = document.getElementById("pn-size-note")?.closest(".pn-block");
  if (!block) return;
  block.scrollIntoView({ block: "start", behavior: "smooth" });
  block.classList.remove("pn-flash");
  void block.offsetWidth;
  block.classList.add("pn-flash");
  setTimeout(() => block.classList.remove("pn-flash"), 900);
}
nodes.paramsToggle.addEventListener("click", focusParams);
nodes.editRefClear.addEventListener("click", () => clearEditReference());
nodes.editRefPick.addEventListener("click", () => nodes.editRefFile.click());
nodes.editRefFile.addEventListener("change", async () => {
  const files = Array.from(nodes.editRefFile.files ?? []);
  nodes.editRefFile.value = "";
  for (const file of files) await addEditReference(file, file.name);
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
// latent 级重绘：底图与蒙版都在手上，直接发给后端跑，不走队列（它是一次同步调用）。
nodes.latentInpaint.addEventListener("click", async () => {
  if (!refPrepared || !maskPath) {
    say("先选底图、再画一块蒙版", "bad");
    return;
  }
  const width = refPrepared.width;
  const height = refPrepared.height;
  if (width % 16 || height % 16) {
    say(`latent 重绘要求尺寸是 16 的倍数（现在是 ${width}×${height}），把画幅改一下再试`, "bad");
    return;
  }
  nodes.latentInpaint.disabled = true;
  say("latent 重绘中：只跑蒙版那块，其余 latent 不动…");
  try {
    const result = await post(
      "/latent/inpaint",
      {
        imagePath: refPrepared.path,
        maskPath,
        prompt: nodes.prompt.value,
        negativePrompt: nodes.negative.value,
        width,
        height,
        steps: Number(nodes.steps.value) || undefined,
        strength: Number(nodes.strength.value) || 0.6,
        seed: Number(nodes.seed.value) || undefined,
      },
      600000,
    );
    const region = result?.region ?? {};
    say(`已重画 ${region.width}×${region.height} 那一块（左上 ${region.x},${region.y}），跑了 ${result?.stepsRun ?? "?"} 步`);
    if (result?.name) void refresh();
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "bad");
  } finally {
    nodes.latentInpaint.disabled = false;
  }
});
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

// ── 主界面底部的输入区 ─────────────────────────────────────
// 提示词与发送按钮在主界面，提交仍由这一侧完成：参数、底图、蒙版都在这里。
reuseChannel?.addEventListener("message", (event) => {
  const msg = event.data ?? {};
  if (msg.type === "compose-prompt") {
    nodes.prompt.value = String(msg.text ?? "");
    return;
  }
  if (msg.type === "compose-negative") {
    nodes.negative.value = String(msg.text ?? "");
    scheduleSave();
    return;
  }
  if (msg.type === "compose-seed") {
    nodes.seed.value = String(msg.value ?? "");
    scheduleSave();
    return;
  }
  if (msg.type === "split-job") {
    // 从会话页对单张图点「拆出」：只把这一张写成新会话。
    const id = String(msg.id ?? "");
    const job = sessionsCache.flatMap((item) => item.jobs).find((item) => item.id === id) ?? null;
    if (job) void splitOne(job);
    return;
  }
  if (msg.type === "compose-send") {
    if (typeof msg.text === "string") nodes.prompt.value = msg.text;
    pendingBase = typeof msg.base === "string" && msg.base ? msg.base : null;
    void onGenerate();
    return;
  }
  if (msg.type === "clear-conversation") {
    activeConv = null;
    paintSessions();
    return;
  }
  if (msg.type === "compose-add-base") {
    nodes.refFile.click();
    return;
  }
  if (msg.type === "compose-add-reference") {
    nodes.editRefFile.click();
    return;
  }
  if (msg.type === "compose-add-image") {
    nodes.addImage.click();
    return;
  }
  if (msg.type === "compose-drop-reference") {
    if (msg.file) void addEditReference(msg.file, msg.file.name ?? "拖进来的图");
    return;
  }
  if (msg.type === "compose-remove-reference") {
    removeEditReference(Number(msg.index) || 0);
    return;
  }
  if (msg.type === "compose-focus-params") {
    focusParams();
    return;
  }
  if (msg.type === "compose-insert") {
    const insert = String(msg.text ?? "").trim();
    if (!insert) return;
    const current = nodes.prompt.value.trim();
    nodes.prompt.value = current ? `${current}，${insert}` : insert;
    reuseChannel.postMessage({ type: "compose-prompt", text: nodes.prompt.value });
  }
});

// ── 片段：点一下接到主界面那段后面 ───────────────────────────
const PROMPT_PRESETS = ["晨雾", "柔光", "浅景深", "低饱和", "胶片颗粒", "逆光", "湿润的空气", "极简构图"];
// 事件流靠不住时用轮询兜底：三秒拉一次 state，数据一样就直接铺。
setInterval(async () => {
  try {
    const response = await hana.api.fetch(`${API}/state`);
    if (!response.ok) throw new Error(`state ${response.status}`);
    render(await response.json());
  } catch (error) {
    // 拉不到或渲染抛错都要看得见，而不是一片空白。
    const box = nodes.history;
    if (box) box.textContent = `面板拉数据失败：${error?.message ?? error}`;
  }
}, 3000);
nodes.newConv?.addEventListener("click", () => {
  try {
    const now = Date.now();
    localStorage.setItem(CONV_KEY, String(now));
    localStorage.setItem(CONV_ID_KEY, `conv-${now.toString(36)}`);
    localStorage.setItem("hana-moss-studio.fresh-at", String(now));
    localStorage.removeItem("hana-moss-studio.conv-pinned");
    blankConversation = true;
  } catch {
    /* 存不了就只刷新列表 */
  }
  editChannel?.postMessage({ type: "new-conversation" });
  activeConv = null;
  paintSessions();
  void loadSessions();
});

nodes.presets?.replaceChildren(
  ...PROMPT_PRESETS.map((text) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pn-preset";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      reuseChannel?.postMessage({ type: "compose-insert", text });
    });
    return btn;
  }),
);

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
    void addEditReference(outputUrl(data.name), data.name);
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

// 装机后旧页面不会自己长出新代码：构建号变了就刷一次。
void (async () => {
  try {
    const response = await fetch("./build.json", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const stamp = String(data?.stamp ?? "");
    if (!stamp) return;
    const key = "hana-moss-studio:build:panel";
    const seen = localStorage.getItem(key);
    localStorage.setItem(key, stamp);
    if (seen && seen !== stamp) location.reload();
  } catch {
    /* 没有这个文件就当没有这回事 */
  }
})();
