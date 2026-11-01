import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 从 vendor/MossStudio（git submodule）抽取苔室真正依赖的上游契约：
 * 模型目录、引擎仓、moss-server 协议版本、引擎包命名样例。
 * 产物 app/lib/upstream.js 是生成物，不手改。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const vendor = join(repoRoot, "vendor", "MossStudio");
const target = join(repoRoot, "app", "lib", "upstream.js");

const MODEL_FIELDS = ["id", "name", "repo", "revision", "role", "precision", "sizeBytes", "files", "subfolder", "format", "tags", "notes"];

function fail(message) {
  console.error(`sync-upstream: ${message}`);
  process.exit(1);
}

if (!existsSync(join(vendor, "release", "models.json"))) {
  fail("没有找到 vendor/MossStudio/release/models.json；先跑 git submodule update --init --recursive");
}

function submoduleCommit() {
  try {
    return execFileSync("git", ["-C", vendor, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function submoduleDate() {
  try {
    return execFileSync("git", ["-C", vendor, "log", "-1", "--format=%cI"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function readCatalog() {
  const raw = JSON.parse(readFileSync(join(vendor, "release", "models.json"), "utf8"));
  const models = Array.isArray(raw.models) ? raw.models : [];
  return {
    schemaVersion: raw.schema_version ?? null,
    updatedAt: raw.updated_at ?? null,
    models: models.map((model) => {
      const entry = {};
      for (const field of MODEL_FIELDS) {
        if (field === "sizeBytes") entry.sizeBytes = model.size_bytes ?? 0;
        else if (model[field] !== undefined) entry[field] = model[field];
      }
      return entry;
    }),
  };
}

function readProtocol() {
  const file = join(vendor, "apps", "desktop", "src", "main", "services", "mossInfer.ts");
  if (!existsSync(file)) return { protocolVersion: null, source: null };
  const text = readFileSync(file, "utf8");
  const match = text.match(/protocol_version:\s*(\d+)/);
  return {
    protocolVersion: match ? Number(match[1]) : null,
    source: "apps/desktop/src/main/services/mossInfer.ts",
  };
}

function readEngineRepo() {
  const file = join(vendor, "apps", "desktop", "src", "main", "services", "mossInferDownload.ts");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const match = text.match(/const\s+REPO\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

const catalog = readCatalog();
const protocol = readProtocol();
const data = {
  generatedAt: new Date().toISOString(),
  source: {
    repo: "CloverIris/MossStudio",
    commit: submoduleCommit(),
    commitDate: submoduleDate(),
  },
  protocol,
  engine: {
    repo: readEngineRepo(),
    archivePattern: "mossinfer-<version>-<os>-<cuda>-<arch>[-sm75][-system-cuda].<ext>",
    assetsFrom: "GitHub Release assets + SHA256SUMS",
  },
  catalog: {
    schemaVersion: catalog.schemaVersion,
    updatedAt: catalog.updatedAt,
    models: catalog.models,
  },
};

async function previous() {
  if (!existsSync(target)) return null;
  try {
    const module = await import(`${pathToFileURL(target).href}?t=${Date.now()}`);
    return module.UPSTREAM ?? null;
  } catch {
    return null;
  }
}

const before = await previous();

const banner = `// 由 scripts/sync-upstream.mjs 从 vendor/MossStudio 生成，不要手改。
// 上游提交：${data.source.commit}（${data.source.commitDate ?? "未知时间"}）
`;
writeFileSync(target, `${banner}\nexport const UPSTREAM = ${JSON.stringify(data, null, 2)};\n`, "utf8");

console.log(`写入 ${target}`);
console.log(`上游提交 ${data.source.commit}`);
console.log(`模型 ${data.catalog.models.length} 项，协议 ${data.protocol.protocolVersion ?? "未知"}，引擎仓 ${data.engine.repo ?? "未知"}`);

if (!before) {
  console.log("首次生成，没有可比对的旧快照。");
  process.exit(0);
}

const oldIds = new Set((before.catalog?.models ?? []).map((model) => model.id));
const newIds = new Set(data.catalog.models.map((model) => model.id));
const added = [...newIds].filter((id) => !oldIds.has(id));
const removed = [...oldIds].filter((id) => !newIds.has(id));
if (before.source?.commit !== data.source.commit) {
  console.log(`上游提交变化：${before.source?.commit} → ${data.source.commit}`);
}
if (before.protocol?.protocolVersion !== data.protocol.protocolVersion) {
  console.log(`协议版本变化：${before.protocol?.protocolVersion} → ${data.protocol.protocolVersion}（需要复核 lib/engine.js）`);
}
if (added.length) console.log(`新增模型：${added.join("，")}`);
if (removed.length) console.log(`移除模型：${removed.join("，")}`);
if (!added.length && !removed.length && before.source?.commit === data.source.commit) {
  console.log("与旧快照一致。");
}
