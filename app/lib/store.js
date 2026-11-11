import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanOutputs } from "./outputs.js";
import { VALUES } from "./params.js";

/** 苔室的持久化。
 *
 *  记录跟着文件走：出图目录里的 PNG 自带生成参数，记录由它派生，不落台账。
 *  运行态（排队、运行中、失败）只放内存：进程重启，队列本来也一起没了。
 *  唯一写盘的是设置。 */

export const DEFAULT_SETTINGS = {
  serverPath: null,
  modelPath: null,
  // 两个仓库可以同时装着，modelPath 指向当前生效的那个。
  modelPaths: { sft: null, base: null },
  memoryMode: "min_memory",
  tier: "reference",
  device: 0,
  defaults: {
    width: 768,
    height: 768,
    steps: 8,
    cfg: 3,
    hiresScale: 0,
    hiresSteps: 0,
    hiresStrength: 0.45,
    // 采样面：MOSS-Image 的官方组合是 euler + moss + shift 5。
    sampler: "euler",
    scheduler: "moss",
    shift: 5,
    // 加速器默认关：它们是 lossy 的，得用户自己决定。
    stepCache: "off",
    stepCacheThreshold: null,
    // LoRA 库：[{path, strength, enabled}]，跟面板上的勾选一致。
    loras: [],
    // 控制适配器：路径 + kind（depth / canny / …），图每次再说。
    control: { adapter: null, kind: null, loraStrength: 1, strength: 1 },
  },
};

const MEMORY_MODES = ["min_memory", "balanced", "max_speed"];
/** 精度档就是引擎协议里的三个值，不做改名。 */
const TIERS = ["reference", "high", "turbo"];
const SCAN_TTL_MS = 1000;
const RUNTIME_KEEP = 300;

export function createStore(dataDir, outputsDir) {
  mkdirSync(dataDir, { recursive: true });
  const settingsFile = join(dataDir, "settings.json");

  let settings = null;
  // 内存里的运行态：排队、运行中、失败，以及完成记录的耗时与 report。
  let runtime = [];
  let scanCache = { at: 0, list: [] };

  function readJson(file, fallback) {
    try {
      if (!existsSync(file)) return fallback;
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  /** 磁盘扫描加一秒缓存：生成中 state 推得频，没必要每次都 stat 整个目录。 */
  function scan() {
    const now = Date.now();
    if (now - scanCache.at < SCAN_TTL_MS) return scanCache.list;
    scanCache = { at: now, list: outputsDir ? scanOutputs(outputsDir) : [] };
    return scanCache.list;
  }

  function invalidateScan() {
    scanCache = { at: 0, list: [] };
  }

  function normalize(input) {
    const merged = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
    const defaults = { ...DEFAULT_SETTINGS.defaults, ...(input?.defaults ?? {}) };
    const paths = {
      sft: typeof merged.modelPaths?.sft === "string" && merged.modelPaths.sft ? merged.modelPaths.sft : null,
      base: typeof merged.modelPaths?.base === "string" && merged.modelPaths.base ? merged.modelPaths.base : null,
    };
    // 旧设置只有一个 modelPath：按目录名认出它是哪个仓库的。
    const active = typeof merged.modelPath === "string" && merged.modelPath.trim() ? merged.modelPath.trim() : null;
    if (active && !paths.sft && /moss-image-sft/i.test(active)) paths.sft = active;
    if (active && !paths.base && /moss-image-base/i.test(active)) paths.base = active;
    return {
      serverPath: typeof merged.serverPath === "string" && merged.serverPath.trim() ? merged.serverPath.trim() : null,
      modelPath: active,
      modelPaths: paths,
      memoryMode: MEMORY_MODES.includes(merged.memoryMode) ? merged.memoryMode : DEFAULT_SETTINGS.memoryMode,
      tier: TIERS.includes(merged.tier) ? merged.tier : DEFAULT_SETTINGS.tier,
      device: Number.isInteger(merged.device) && merged.device >= 0 ? merged.device : 0,
      defaults: {
        width: clamp(defaults.width, 256, 4096, DEFAULT_SETTINGS.defaults.width),
        height: clamp(defaults.height, 256, 4096, DEFAULT_SETTINGS.defaults.height),
        steps: clamp(defaults.steps, 1, 80, DEFAULT_SETTINGS.defaults.steps),
        cfg: clampFloat(defaults.cfg, 0, 20, DEFAULT_SETTINGS.defaults.cfg),
        hiresScale: clampFloat(defaults.hiresScale, 0, 64, 0),
        hiresSteps: clamp(defaults.hiresSteps, 0, 80, 0),
        hiresStrength: clampFloat(defaults.hiresStrength, 0.05, 1, 0.45),
        sampler: VALUES.sampler.includes(defaults.sampler) ? defaults.sampler : DEFAULT_SETTINGS.defaults.sampler,
        scheduler: VALUES.scheduler.includes(defaults.scheduler) ? defaults.scheduler : DEFAULT_SETTINGS.defaults.scheduler,
        shift: clampFloat(defaults.shift, 0.1, 20, DEFAULT_SETTINGS.defaults.shift),
        stepCache: VALUES.stepCache.includes(defaults.stepCache) ? defaults.stepCache : "off",
        stepCacheThreshold:
          defaults.stepCacheThreshold == null ? null : clampFloat(defaults.stepCacheThreshold, 0.0001, 1, 0.03),
        loras: normalizeLoras(defaults.loras),
        control: {
          adapter: typeof defaults.control?.adapter === "string" && defaults.control.adapter ? defaults.control.adapter : null,
          kind: typeof defaults.control?.kind === "string" && defaults.control.kind ? defaults.control.kind : null,
          loraStrength: clampFloat(defaults.control?.loraStrength, 0, 10, 1),
          strength: clampFloat(defaults.control?.strength, 0, 10, 1),
        },
      },
    };
  }

  return {
    getSettings() {
      if (!settings) settings = normalize(readJson(settingsFile, {}));
      return settings;
    },
    saveSettings(patch) {
      settings = normalize({ ...this.getSettings(), ...patch });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf8");
      return settings;
    },

    /** 已完成 → 从图里读；排队、运行中、失败 → 内存里的运行态。 */
    listJobs() {
      const byId = new Map(scan().map((record) => [record.id, record]));
      const extras = [];
      for (const job of runtime) {
        if (job.status === "done") {
          // 完成记录只补耗时与 report；图不在了就整条作废。
          const record = byId.get(job.id);
          if (record) {
            byId.set(job.id, {
              ...record,
              elapsedMs: job.elapsedMs ?? null,
              report: job.report ?? null,
              seed: record.seed ?? job.seed ?? null,
            });
          }
          continue;
        }
        extras.push(job);
      }
      return [...extras, ...byId.values()].sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)),
      );
    },

    upsertJob(record) {
      const index = runtime.findIndex((job) => job.id === record.id);
      if (index >= 0) runtime[index] = { ...runtime[index], ...record };
      else runtime.unshift(record);
      runtime = runtime.slice(0, RUNTIME_KEEP);
      if (record.status === "done") invalidateScan();
      return runtime;
    },

    getJob(id) {
      return this.listJobs().find((job) => job.id === id) ?? null;
    },

    /** 删记录：图由调用方删，文件才是真相源。 */
    removeJob(id) {
      runtime = runtime.filter((job) => job.id !== id);
      invalidateScan();
      return runtime;
    },
  };
}

/** LoRA 库：路径去重、强度收进可用区间、坏条目丢掉。勾选状态是界面自己的事。 */
function normalizeLoras(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const path = typeof item?.path === "string" ? item.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, strength: clampFloat(item?.strength ?? 1, -8, 8, 1), enabled: item?.enabled !== false });
    if (out.length >= 64) break;
  }
  return out;
}

export function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 小数参数用这个：clamp 会把值四舍五入成整数，强度、CFG 这类会丢掉小数部分。 */
export function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
