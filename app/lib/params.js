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

import { existsSync } from "node:fs";

import { MOSSIMAGE } from "./mossimage.js";

/** 协议里的枚举名（hello.values 是运行时权威，这里是离线兜底与界面菜单的来源）。 */
export const VALUES = {
  sampler: ["euler", "ab2", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "er_sde", "res_multistep", "dataspace"],
  scheduler: ["moss", "simple", "normal", "karras", "exponential", "beta", "sgm_uniform"],
  stepCache: ["off", "fbcache"],
  loraPlacement: ["default", "merge", "side_branch"],
  maskEncoding: ["u8", "binary01"],
  resize: ["crop", "fit", "stretch"],
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

  return {
    sampler: pickEnum(input?.sampler, VALUES.sampler, pickEnum(base.sampler, VALUES.sampler, "euler")),
    scheduler: pickEnum(input?.scheduler, VALUES.scheduler, pickEnum(base.scheduler, VALUES.scheduler, "moss")),
    shift: finite(input?.shift ?? base.shift, 0.1, 20) ?? 5,
    stepCache,
    stepCacheThreshold: Number.isFinite(threshold) ? threshold : null,
    cfgTruncation: Number.isFinite(cfgTruncation) ? cfgTruncation : 1,
    loraPlacement: pickEnum(input?.loraPlacement, VALUES.loraPlacement, "default"),
    loras: input?.loras === undefined ? readLoras(base.loras, { lenient: true }) : readLoras(input.loras),
    control: readControl(input, base),
    references: readReferences(input),
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
  };
}

export { MOSSIMAGE };
