// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * tools/dev/inpaint-probe.mjs — 验证 latent 级局部重绘。
 *
 * 拿一张 256² 图当底图，中间抹一块 64² 的蒙版，跑全步重画，然后看：
 * 区域内该变，区域外该一个像素都不动（外区域 latent 没碰，解码也不该变）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HANA_HOME = process.env.HANA_HOME;
if (!HANA_HOME) {
  console.error("设置 HANA_HOME 指向 Hana 的数据目录（下面有 app-data/hana-moss-studio）");
  process.exit(1);
}
const MOSS_DATA = join(HANA_HOME, "app-data", "hana-moss-studio");
const MODEL_DIR = join(MOSS_DATA, "models", "moss-image-sft");
const MODEL_FILES = join(MOSS_DATA, "models", "files");
const ENGINE_DIR = "mossinfer-2.2.1-windows-cu13-x86_64";
import { tmpdir } from "node:os";
import { encode as encodePng, decode as decodePng } from "fast-png";

import { Engine } from "../../app/lib/engine.js";
import { createSession } from "../../app/lib/session.js";
import { runLatentInpaint } from "../../app/lib/latent.js";

const SOURCE = process.argv[2] ?? join(tmpdir(), "moss-batch-probe", "batch-2.png");
const work = join(tmpdir(), "moss-inpaint-probe");
mkdirSync(work, { recursive: true });
const log = (text) => console.log(`[inpaint] ${text}`);

if (!existsSync(SOURCE)) {
  console.error(`[inpaint] 找不到底图：${SOURCE}`);
  process.exit(1);
}

const settings = {
  serverPath: join(MOSS_DATA, "engine", ENGINE_DIR, "bin", "moss-server.exe"),
  modelPath: MODEL_DIR,
  memoryMode: "min_memory",
  tier: "turbo",
  modelFiles: {
    dit: join(MODEL_FILES, "moss_image_sft_int4_convrot.safetensors"),
    textEncoder: join(MODEL_FILES, "qwen3.5_9b_w4a8_gptq.safetensors"),
    vae: null,
  },
  defaults: { width: 256, height: 256, steps: 6, cfg: 3, sampler: "euler", scheduler: "moss", shift: 5 },
};

const png = decodePng(readFileSync(SOURCE));
const width = png.width;
const height = png.height;
const channels = Number(png.channels ?? 4);

// 蒙版：中间 64² 白，其余黑
const maskChannels = 4;
const maskData = new Uint8Array(width * height * maskChannels);
const box = { x: 96, y: 96, size: 64 };
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const inside = x >= box.x && x < box.x + box.size && y >= box.y && y < box.y + box.size;
    const index = (y * width + x) * maskChannels;
    const value = inside ? 255 : 0;
    maskData[index] = value;
    maskData[index + 1] = value;
    maskData[index + 2] = value;
    maskData[index + 3] = 255;
  }
}
const maskPath = join(work, "mask.png");
writeFileSync(maskPath, encodePng({ width, height, data: maskData, channels: 4, depth: 8 }));
log(`底图 ${SOURCE}（${width}×${height}），蒙版 ${maskPath}`);

const engine = new Engine({
  getSettings: () => settings,
  outputsDir: work,
  cacheDir: work,
  previewDir: work,
  onEvent: (event) => {
    if (event.type === "engine-log") log(event.message);
  },
});
const session = createSession({
  engine,
  exePath: join(process.cwd(), "app", "vendor-bin", "shm-bridge.exe"),
  tmpDir: work,
  onLog: (entry) => log(entry.message),
});

try {
  await engine.start();
  await engine.ensureLoaded({});
  const output = join(work, "inpainted.png");
  const started = Date.now();
  const result = await runLatentInpaint({
    session,
    spec: {
      imagePath: SOURCE,
      maskPath,
      prompt: "a red lantern hanging in the window",
      negativePrompt: "",
      steps: 6,
      strength: 1,
      cfg: 3,
      shift: 5,
      seed: 21,
      output,
    },
    onProgress: (progress) => log(`step ${progress.step}/${progress.total}`),
  });
  log(`完成：${result.stepsRun} 步，区域 ${JSON.stringify(result.region)}，${((Date.now() - started) / 1000).toFixed(1)}s`);

  const after = decodePng(readFileSync(output));
  const before = png;
  let insideSum = 0;
  let insideCount = 0;
  let outsideSum = 0;
  let outsideCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const j = (y * after.width + x) * (after.channels ?? 4);
      const diff = Math.abs(before.data[i] - after.data[j]) + Math.abs(before.data[i + 1] - after.data[j + 1]) + Math.abs(before.data[i + 2] - after.data[j + 2]);
      const inside = x >= box.x && x < box.x + box.size && y >= box.y && y < box.y + box.size;
      if (inside) {
        insideSum += diff;
        insideCount += 3;
      } else {
        outsideSum += diff;
        outsideCount += 3;
      }
    }
  }
  log(`区域内平均差 ${(insideSum / insideCount).toFixed(2)}（应该明显大于 0）`);
  log(`区域外平均差 ${(outsideSum / outsideCount).toFixed(4)}（应该接近 0）`);
  log(`输出：${output}`);
} catch (error) {
  console.error(`[inpaint] 失败：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    await session.close();
  } catch {
    /* 已关 */
  }
  engine.stop();
}
