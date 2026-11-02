import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 苔室自己的持久化：一份设置、一份任务台账。都落在 App 数据目录里。 */

export const DEFAULT_SETTINGS = {
  serverPath: null,
  modelPath: null,
  memoryMode: "min_memory",
  tier: "high",
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
const TIERS = ["reference", "high", "turbo"];

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const settingsFile = join(dataDir, "settings.json");
  const jobsFile = join(dataDir, "jobs.json");

  let settings = null;
  let jobs = null;

  function readJson(file, fallback) {
    try {
      if (!existsSync(file)) return fallback;
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
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
        hiresScale: clamp(defaults.hiresScale, 0, 3, 0),
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
    listJobs() {
      if (!jobs) {
        const raw = readJson(jobsFile, []);
        jobs = Array.isArray(raw) ? raw : [];
      }
      return jobs;
    },
    saveJobs(next) {
      jobs = next.slice(0, 300);
      writeFileSync(jobsFile, JSON.stringify(jobs, null, 2), "utf8");
      return jobs;
    },
    upsertJob(record) {
      const list = this.listJobs();
      const index = list.findIndex((job) => job.id === record.id);
      if (index >= 0) list[index] = { ...list[index], ...record };
      else list.unshift(record);
      return this.saveJobs(list);
    },
    getJob(id) {
      return this.listJobs().find((job) => job.id === id) ?? null;
    },
    removeJob(id) {
      return this.saveJobs(this.listJobs().filter((job) => job.id !== id));
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
