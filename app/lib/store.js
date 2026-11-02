import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanOutputs } from "./outputs.js";

/** 苔室的持久化。
 *
 *  记录跟着文件走：出图目录里的 PNG 自带生成参数，记录由它派生。
 *  jobs.json 只存文件里没有的那部分（排队中、运行中、失败的记录，
 *  以及完成记录上补的耗时与 report），不存能重新扫出来的东西。 */

export const DEFAULT_SETTINGS = {
  serverPath: null,
  modelPath: null,
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
  },
};

const MEMORY_MODES = ["min_memory", "balanced", "max_speed"];
/** 精度档就是引擎协议里的三个值，不做改名。 */
const TIERS = ["reference", "high", "turbo"];
const SCAN_TTL_MS = 1000;

export function createStore(dataDir, outputsDir) {
  mkdirSync(dataDir, { recursive: true });
  const settingsFile = join(dataDir, "settings.json");
  const jobsFile = join(dataDir, "jobs.json");

  let settings = null;
  let jobs = null;
  let scanCache = { at: 0, list: [] };

  function readJson(file, fallback) {
    try {
      if (!existsSync(file)) return fallback;
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  function readJobs() {
    if (!jobs) {
      const raw = readJson(jobsFile, []);
      jobs = Array.isArray(raw) ? raw : [];
    }
    return jobs;
  }

  /** 磁盘扫描加一秒缓存：state 每 180ms 推一次，没必要每次都 stat 整个目录。 */
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
    return {
      serverPath: typeof merged.serverPath === "string" && merged.serverPath.trim() ? merged.serverPath.trim() : null,
      modelPath: typeof merged.modelPath === "string" && merged.modelPath.trim() ? merged.modelPath.trim() : null,
      memoryMode: MEMORY_MODES.includes(merged.memoryMode) ? merged.memoryMode : DEFAULT_SETTINGS.memoryMode,
      tier: TIERS.includes(merged.tier) ? merged.tier : DEFAULT_SETTINGS.tier,
      device: Number.isInteger(merged.device) && merged.device >= 0 ? merged.device : 0,
      defaults: {
        width: clamp(defaults.width, 256, 4096, DEFAULT_SETTINGS.defaults.width),
        height: clamp(defaults.height, 256, 4096, DEFAULT_SETTINGS.defaults.height),
        steps: clamp(defaults.steps, 1, 80, DEFAULT_SETTINGS.defaults.steps),
        cfg: clampFloat(defaults.cfg, 0, 20, DEFAULT_SETTINGS.defaults.cfg),
        hiresScale: clamp(defaults.hiresScale, 0, 64, 0),
        hiresSteps: clamp(defaults.hiresSteps, 0, 80, 0),
        hiresStrength: clampFloat(defaults.hiresStrength, 0.05, 1, 0.45),
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

    /** 已完成 → 从图里读；未完成或失败 → 从 jobs.json 读。 */
    listJobs() {
      const records = scan();
      const byId = new Map(records.map((record) => [record.id, record]));
      const extras = [];
      for (const job of readJobs()) {
        if (job.status === "done") {
          // 完成记录只用来补耗时与 report；图不在了就整条作废。
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

    saveJobs(next) {
      // 已完成只留文件里没有的两样：耗时与 report。其余全从 PNG 扫。
      jobs = next
        .map((job) =>
          job.status === "done"
            ? { id: job.id, status: "done", elapsedMs: job.elapsedMs ?? null, report: job.report ?? null }
            : job,
        )
        .slice(0, 300);
      writeFileSync(jobsFile, JSON.stringify(jobs, null, 2), "utf8");
      return jobs;
    },

    upsertJob(record) {
      const list = readJobs();
      const index = list.findIndex((job) => job.id === record.id);
      if (index >= 0) list[index] = { ...list[index], ...record };
      else list.unshift(record);
      if (record.status === "done") invalidateScan();
      return this.saveJobs(list);
    },

    getJob(id) {
      return this.listJobs().find((job) => job.id === id) ?? null;
    },

    /** 删记录：图跟着一起删，文件才是真相源。 */
    removeJob(id) {
      const list = readJobs().filter((job) => job.id !== id);
      invalidateScan();
      return this.saveJobs(list);
    },

    /** 清掉指向已不存在文件的完成记录。 */
    pruneMissing() {
      const onDisk = new Set(scan().map((record) => record.id));
      const kept = readJobs().filter((job) => job.status !== "done" || onDisk.has(job.id));
      return this.saveJobs(kept);
    },
  };
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
