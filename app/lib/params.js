// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/params.js — 一次生成的参数面：采样器、调度器、偏移、加速器、LoRA、图生图输入。
 *
 * 这里只做取值与收敛，不碰尺寸（尺寸要按引擎上限等比缩放，那是 index.js 的事）。
 * 三条原则：
 *   1. 未知值不静默吞掉：认不出的采样器、缺文件的 LoRA 直接抛错，别让任务排进队列才失败；
 *   2. 引擎协议的默认值写在这里一份，界面与工具共用；
 *   3. 布尔/空值语义照协议，`0` 是合法值的地方不能当假值处理。
 */

import { existsSync, readFileSync } from "node:fs";

import { MOSSIMAGE } from "./mossimage.js";

/** 协议里的枚举名（hello.values 是运行时权威，这里是离线兜底与界面菜单的来源）。 */
export const VALUES = {
  sampler: ["euler", "ab2", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "er_sde", "res_multistep", "dataspace"],
  scheduler: ["moss", "simple", "normal", "karras", "exponential", "beta", "sgm_uniform"],
  stepCache: ["off", "fbcache"],
  loraPlacement: ["default", "merge", "side_branch"],
  maskEncoding: ["u8", "binary01"],
  resize: ["crop", "fit", "stretch"],
  noiseLayout: ["official", "batch_stream"],
  noiseSource: ["philox", "philox_device", "brownian_tree"],
};

/** 采样器的显示名。协议名照样传，界面只是多一层好读的标签。 */
export const SAMPLER_LABEL = {
  euler: "Euler",
  ab2: "AB2",
  euler_ancestral: "Euler a",
  heun: "Heun",
  dpmpp_2m: "DPM++ 2M",
  dpmpp_2m_sde: "DPM++ 2M SDE",
  er_sde: "ER SDE",
  res_multistep: "RES Multistep",
  dataspace: "Dataspace",
};

export const SCHEDULER_LABEL = {
  moss: "MOSS（官方）",
  simple: "Simple",
  normal: "Normal",
  karras: "Karras",
  exponential: "Exponential",
  beta: "Beta",
  sgm_uniform: "SGM Uniform",
};

const GENERATION_DEFAULTS = {
  sampler: "euler",
  scheduler: "moss",
  shift: 5,
  stepCache: "off",
  stepCacheThreshold: null,
  cfgTruncation: 1,
  loraPlacement: "default",
  // 采样面：协议缺省值直接写在这里，界面与工具共用一份。
  uncondSkipLayers: [22],
  slgLayers: [],
  slgScale: 0,
  slgStart: 0,
  slgStop: 1,
  maxSequenceLength: 4096,
  flowMultiplier: 1,
  noiseLayout: "official",
  noiseSource: "philox",
  eta: 1,
  sNoise: 1,
  dataspace: null,
  distill: null,
  loras: [],
  control: { adapter: null, kind: null, loraStrength: 1, strength: 1 },
};

export function generationDefaults() {
  return { ...GENERATION_DEFAULTS, loras: [], control: { ...GENERATION_DEFAULTS.control } };
}

function pickEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function finite(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < min || number > max) return null;
  return number;
}

function safeExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 文件参数统一在这里校验：路径必须是现成的普通文件，报错里带上是哪个参数。
 *  宿主的权限模型会拦掉太远处的路径（桌面上随手放的图），那就得先导进苔室。 */
export function requireFile(raw, label) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const path = raw.trim();
  let exists = false;
  try {
    exists = existsSync(path);
  } catch {
    throw new Error(`${label} 读不到：${path}（宿主只允许访问 HANA_HOME 与工作区，把它导入苔室再用）`);
  }
  if (!exists) throw new Error(`${label} 不存在：${path}`);
  return path;
}

/**
 * LoRA 列表。工具侧允许两种写法：`["a.safetensors"]` 与 `[{path, strength}]`，
 * 后者是协议的形状，也是界面与画廊回填用的形状。
 */
export function readLoras(raw, { lenient = false } = {}) {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > 64) throw new Error("LoRA 最多 64 个");
  const out = [];
  for (const [index, item] of list.entries()) {
    const source = typeof item === "string" ? { path: item } : item ?? {};
    if (typeof source.path !== "string" || !source.path.trim()) {
      if (lenient) continue;
      throw new Error(`第 ${index + 1} 个 LoRA 缺少 path`);
    }
    // 设置里留着的条目可能已经被用户从盘上删了：默认值照用，但别再为它报错。
    if (lenient && !safeExists(source.path.trim())) continue;
    const path = requireFile(source.path, `第 ${index + 1} 个 LoRA`);
    const strength = finite(source.strength ?? 1, -8, 8);
    if (strength === null) throw new Error(`第 ${index + 1} 个 LoRA 的 strength 必须是 -8 到 8 之间的数`);
    out.push({ path, strength });
  }
  return out;
}

/**
 * 参考图（编辑适配器）：`references` 的协议形状是 {images, max_edge}。
 * 工具侧写成 referenceImages 数组 + referenceMaxEdge 更好用。
 */
export function readReferences(input) {
  const raw = input?.references;
  const list = Array.isArray(raw) ? raw : raw?.images ?? input?.referenceImages ?? null;
  if (!list) return null;
  const images = (Array.isArray(list) ? list : [list])
    .map((item, index) => requireFile(typeof item === "string" ? item : item?.path, `第 ${index + 1} 张参考图`))
    .filter(Boolean);
  if (!images.length) return null;
  if (images.length > 4) throw new Error("参考图最多 4 张");
  const edgeRaw = raw?.maxEdge ?? raw?.max_edge ?? input?.referenceMaxEdge;
  const maxEdge = edgeRaw === undefined || edgeRaw === null || edgeRaw === "" ? 512 : finite(edgeRaw, 16, 2048);
  if (maxEdge === null) throw new Error("referenceMaxEdge 要在 16~2048 之间");
  return { images, maxEdge: Math.max(16, Math.round(maxEdge / 16) * 16) };
}

/**
 * 控制适配器（depth / canny / pose 那一类）。
 * 协议形状：{adapter, lora_strength, images: [{kind, path, strength, start, end}]}。
 * 工具侧也可以给扁平参数：controlAdapter + controlKind + controlImage。
 */
export function readControl(input, base) {
  const fromDefaults = base?.control ?? {};
  const raw = input?.control && typeof input.control === "object" ? input.control : {};
  const adapterRaw = raw.adapter ?? input?.controlAdapter ?? fromDefaults.adapter ?? null;
  // 显式给的路径写错就报；设置里留着的旧路径已经不在了就当作没开控制。
  const explicit = Boolean(raw.adapter ?? input?.controlAdapter);
  let adapter = null;
  try {
    adapter = requireFile(adapterRaw, "控制适配器");
  } catch (error) {
    if (explicit) throw error;
    return null;
  }
  if (!adapter) return null;
  const kind =
    (typeof raw.kind === "string" && raw.kind.trim()) ||
    (typeof input?.controlKind === "string" && input.controlKind.trim()) ||
    (typeof fromDefaults.kind === "string" && fromDefaults.kind.trim()) ||
    null;
  // 图可以不给：适配器自带的 LoRA 部分也会作用于画面。
  const images = [];
  const source = raw.images ?? (input?.controlImage ? [{ path: input.controlImage }] : []);
  if (Array.isArray(source)) {
    for (const [index, item] of source.entries()) {
      const path = requireFile(item?.path, `第 ${index + 1} 张控制图`);
      if (!path) continue;
      if (!kind) throw new Error("给了控制图但没有 kind（用 control.kind 或 controlKind）");
      const start = finite(item?.start ?? 0, 0, 1);
      const end = finite(item?.end ?? 1, 0, 1);
      if (start === null || end === null || start > end) {
        throw new Error(`第 ${index + 1} 张控制图的 start / end 不合法（要 0 ≤ start ≤ end ≤ 1）`);
      }
      images.push({
        kind,
        path,
        strength: finite(item?.strength ?? raw.strength ?? fromDefaults.strength ?? 1, 0, 10) ?? 1,
        start,
        end,
      });
      if (images.length >= 16) break;
    }
  }
  return {
    adapter,
    loraStrength: finite(raw.loraStrength ?? input?.controlLoraStrength ?? fromDefaults.loraStrength ?? 1, 0, 10) ?? 1,
    images,
  };
}

/**
 * 布局提示（model-facing JSON layout，文档里叫 Layout prompts，实验性）。
 * 模型吃的就是一段 JSON，所以这里只负责把它拼对：
 *   - bbox_format 固定 yxyx，bbox_coord_space 固定 abs_centralized（画布中心为原点）；
 *   - 工具侧允许给人看得懂的屏幕坐标 boxes（左上角原点、[x0,y0,x1,y1]），在这里换算；
 *   - 没给 summary.caption 时拿 prompt 当 caption，两条路都能写出提示。
 */
export const LAYOUT_FORMAT = "yxyx";
export const LAYOUT_SPACE = "abs_centralized";

function readJsonSource(raw, label) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "object") return raw;
  const text = String(raw).trim();
  // 路径比 JSON 更便宜判断：以 { 开头的才是内联 JSON。
  if (!text.startsWith("{") && !text.startsWith("[")) {
    const path = requireFile(text, label);
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return JSON.parse(text);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 屏幕坐标（左上原点）→ 画布中心坐标，并按 yxyx 排序。 */
function boxToCenteredYxyx(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4) throw new Error("每个 box 要四个数：[x0, y0, x1, y1]");
  const [x0, y0, x1, y1] = box.map(num);
  if ([x0, y0, x1, y1].some((value) => value === null)) throw new Error("box 里必须都是数字");
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const clampX = (value) => Math.max(-width / 2, Math.min(width / 2, value));
  const clampY = (value) => Math.max(-height / 2, Math.min(height / 2, value));
  return [
    Math.round(clampY(top - height / 2)),
    Math.round(clampX(left - width / 2)),
    Math.round(clampY(bottom - height / 2)),
    Math.round(clampX(right - width / 2)),
  ];
}

/**
 * 返回 { prompt, caption, items } 或 null。prompt 就是交给引擎的那段 JSON。
 * `boxes` 优先级高于 `layout.items`：两者都给时，以画出来的框为准。
 */
export function readLayout(input, width, height) {
  const doc = readJsonSource(input?.layout ?? input?.layoutJson ?? input?.layoutPath, "布局 JSON");
  const boxes = Array.isArray(input?.boxes) ? input.boxes : null;
  if (!doc && !boxes) return null;
  const layout = doc && typeof doc === "object" ? { ...doc } : {};
  layout.summary = { ...(layout.summary ?? {}) };
  // caption 空着就拿 prompt 补：模板故意不编 caption，交给用户写的那句提示词。
  const caption = String(layout.summary.caption ?? "").trim() || String(input?.prompt ?? "").trim();
  if (caption) layout.summary.caption = caption;

  if (boxes) {
    layout.items = boxes.map((item, index) => {
      const box = Array.isArray(item?.box) ? item.box : [item?.x0, item?.y0, item?.x1, item?.y1];
      const entry = {
        label: String(item?.label ?? "object"),
        caption: String(item?.caption ?? "" ).trim() || String(item?.text ?? "").trim() || "",
        bbox: boxToCenteredYxyx(box, width, height),
      };
      if (item?.text) entry.text = String(item.text);
      if (!entry.caption && !entry.text) throw new Error(`第 ${index + 1} 个框缺少 caption 或 text`);
      return entry;
    });
  }

  if (!Array.isArray(layout.items) || !layout.items.length) throw new Error("布局里没有 items");
  layout.items = layout.items.map((item, index) => {
    const entry = { ...item };
    if (!Array.isArray(entry.bbox) || entry.bbox.length !== 4) {
      throw new Error(`第 ${index + 1} 个 item 的 bbox 要四个数`);
    }
    entry.bbox = entry.bbox.map((value) => Math.round(num(value) ?? 0));
    if (!entry.label) entry.label = "object";
    return entry;
  });
  layout.bbox_format = LAYOUT_FORMAT;
  layout.bbox_coord_space = LAYOUT_SPACE;
  return {
    prompt: JSON.stringify(layout),
    caption: caption || layout.items.length + " 个元素",
    items: layout.items.length,
    doc: layout,
  };
}

/** 层号列表：接受数组或 "22, 24" 这种串。空串与 null 都当「不用」。 */
export function readLayers(raw, fallback, label) {
  if (raw === undefined) return [...fallback];
  if (raw === null) return [];
  const source = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/).filter(Boolean);
  const out = [];
  for (const item of source) {
    const value = Number(item);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} 里只能写非负整数（第 ${out.length + 1} 个是 ${item}）`);
    }
    out.push(value);
  }
  return out;
}

/**
 * 把工具/界面传进来的参数收敛成任务记录里的那几项。
 * `defaults` 是设置里的 defaults，缺省值从那里来（这样面板改一次就长期生效）。
 */
export function readGeneration(input, defaults = {}) {
  const base = { ...GENERATION_DEFAULTS, ...defaults };
  const stepCache = pickEnum(input?.stepCache, VALUES.stepCache, pickEnum(base.stepCache, VALUES.stepCache, "off"));
  // 阈值只在缓存开着时有意义：关掉缓存还留着阈值，下次一开就是旧值，容易困惑。
  const thresholdRaw = input?.stepCacheThreshold ?? base.stepCacheThreshold;
  const threshold = stepCache === "off" ? null : finite(thresholdRaw, 0.0001, 1);

  const cfgTruncation = finite(input?.cfgTruncation, 0, 1);

  const initImage = requireFile(input?.initImage, "参考图");
  const mask = requireFile(input?.mask, "蒙版");
  if (mask && !initImage) throw new Error("局部重绘需要先给一张参考图（蒙版要和它同尺寸）");

  const sampler = pickEnum(input?.sampler, VALUES.sampler, pickEnum(base.sampler, VALUES.sampler, "euler"));
  const references = readReferences(input);
  const slgScale = finite(input?.slgScale ?? base.slgScale, 0, 20) ?? 0;
  // 引擎明确规定：参考图与 SLG 不同时开。两样都是「额外的注意力行」，同时开会撑爆或跑偏。
  if (references && slgScale > 0) throw new Error("编辑参考图和 SLG 不能同时开（引擎不支持）：把 slgScale 调回 0");
  const dataspaceRaw = input?.dataspace ?? base.dataspace ?? null;
  const dataspace = dataspaceRaw ? requireFile(dataspaceRaw, "dataspace 参数文件") : null;
  if (sampler === "dataspace" && !dataspace) throw new Error("dataspace 采样器要一份参数文件（dataspace）");
  const distillRaw = input?.distill ?? base.distill ?? null;
  let distill = null;
  if (distillRaw) {
    distill = String(distillRaw).trim();
    if (!safeExists(distill)) throw new Error(`distill 目录不存在：${distill}`);
  }

  return {
    sampler,
    scheduler: pickEnum(input?.scheduler, VALUES.scheduler, pickEnum(base.scheduler, VALUES.scheduler, "moss")),
    shift: finite(input?.shift ?? base.shift, 0.1, 20) ?? 5,
    stepCache,
    stepCacheThreshold: Number.isFinite(threshold) ? threshold : null,
    cfgTruncation: Number.isFinite(cfgTruncation) ? cfgTruncation : 1,
    loraPlacement: pickEnum(input?.loraPlacement, VALUES.loraPlacement, "default"),
    uncondSkipLayers: readLayers(input?.uncondSkipLayers, base.uncondSkipLayers ?? [22], "uncondSkipLayers"),
    slgLayers: readLayers(input?.slgLayers, base.slgLayers ?? [], "slgLayers"),
    slgScale,
    slgStart: finite(input?.slgStart ?? base.slgStart, 0, 1) ?? 0,
    slgStop: finite(input?.slgStop ?? base.slgStop, 0, 1) ?? 1,
    maxSequenceLength: Math.round(finite(input?.maxSequenceLength ?? base.maxSequenceLength, 1, 4096) ?? 4096),
    flowMultiplier: finite(input?.flowMultiplier ?? base.flowMultiplier, 0.01, 100) ?? 1,
    noiseLayout: pickEnum(input?.noiseLayout, VALUES.noiseLayout, pickEnum(base.noiseLayout, VALUES.noiseLayout, "official")),
    noiseSource: pickEnum(input?.noiseSource, VALUES.noiseSource, pickEnum(base.noiseSource, VALUES.noiseSource, "philox")),
    eta: finite(input?.eta ?? base.eta, 0, 100) ?? 1,
    sNoise: finite(input?.sNoise ?? base.sNoise, 0, 100) ?? 1,
    dataspace,
    distill,
    loras: input?.loras === undefined ? readLoras(base.loras, { lenient: true }) : readLoras(input.loras),
    control: readControl(input, base),
    references,
    initImage,
    mask,
    maskEncoding: pickEnum(input?.maskEncoding, VALUES.maskEncoding, "u8"),
  };
}

/** 引擎 hello 报的枚举：运行在哪个引擎上，菜单就该是哪个引擎的名字。 */
export function menuValues(hello) {
  const reported = hello?.values ?? {};
  const take = (key, fallback) =>
    Array.isArray(reported[key]) && reported[key].length ? reported[key] : fallback;
  return {
    sampler: take("sampler", VALUES.sampler),
    scheduler: take("scheduler", VALUES.scheduler),
    stepCache: take("step_cache", VALUES.stepCache),
    loraPlacement: take("lora_placement", VALUES.loraPlacement),
    maskEncoding: take("mask_encoding", VALUES.maskEncoding),
    resize: take("resize", VALUES.resize),
    noiseLayout: take("noise_layout", VALUES.noiseLayout),
    noiseSource: take("noise_source", VALUES.noiseSource),
    memoryMode: take("mode", ["min_memory", "balanced", "max_speed"]),
    tier: take("tier", ["reference", "high", "turbo"]),
  };
}

/** 引擎能力标志：界面按这个决定某项功能显不显示。 */
export function capabilityMap(hello) {
  const caps = hello?.capabilities ?? null;
  if (!caps || typeof caps !== "object") return null;
  return {
    lora: Boolean(caps.lora),
    control: Boolean(caps.control),
    references: Boolean(caps.references),
    accel: Boolean(caps.accel),
    imageInput: Boolean(caps.image_input),
    hires: Boolean(caps.hires),
    preload: Boolean(caps.preload),
    release: Boolean(caps.release),
    inspect: Boolean(caps.inspect),
    check: Boolean(caps.check),
    preview: Boolean(caps.preview),
    components: Boolean(caps.components),
  };
}

export { MOSSIMAGE };
