// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * tools/dev/batch-probe.mjs — 对拍 host guidance 与 MOSS guidance。
 *
 * 引擎在 MOSS guidance 下只接受一个 latent；多张要走 host 模式自己合 CFG。
 * 这里用同一个种子各跑一次，比较两张图差多少：差得极小说明行序与合并公式对，
 * 差得离谱就是错位了。也用来跑多张看是不是真的各出各的。
 *
 * 用法：
 *   node tools/dev/batch-probe.mjs compare [256] [6]
 *   node tools/dev/batch-probe.mjs batch <2|3|4> [256] [6]
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode as decodePng } from "fast-png";

import { Engine } from "../../app/lib/engine.js";
import { createSession } from "../../app/lib/session.js";
import { runLatentGenerate } from "../../app/lib/latent.js";

const MODE = process.argv[2] ?? "compare";
const SIZE = Number(process.argv[3] ?? 256);
const STEPS = Number(process.argv[4] ?? 6);
const BATCH = MODE === "batch" ? Math.max(2, Math.min(4, Number(process.argv[3] ?? 2))) : 1;
const DIM = MODE === "batch" ? Number(process.argv[4] ?? 256) : SIZE;
const RUN_STEPS = MODE === "batch" ? Number(process.argv[5] ?? 6) : STEPS;

const settings = {
  serverPath: "H:\\.hanako\\app-data\\hana-moss-studio\\engine\\mossinfer-2.2.1-windows-cu13-x86_64\\bin\\moss-server.exe",
  modelPath: "H:\\.hanako\\app-data\\hana-moss-studio\\models\\moss-image-sft",
  memoryMode: "min_memory",
  tier: "turbo",
  modelFiles: {
    dit: "H:\\.hanako\\app-data\\hana-moss-studio\\models\\files\\moss_image_sft_int4_convrot.safetensors",
    textEncoder: "H:\\.hanako\\app-data\\hana-moss-studio\\models\\files\\qwen3.5_9b_w4a8_gptq.safetensors",
    vae: null,
  },
  defaults: { width: DIM, height: DIM, steps: RUN_STEPS, cfg: 3, sampler: "euler", scheduler: "moss", shift: 5 },
};

const work = join(tmpdir(), "moss-batch-probe");
mkdirSync(work, { recursive: true });
const log = (text) => console.log(`[batch] ${text}`);

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

function rgb(path) {
  const png = decodePng(readFileSync(path));
  const channels = Number(png.channels ?? 4);
  const out = [];
  for (let i = 0; i < png.data.length; i += channels) out.push(png.data[i], png.data[i + 1], png.data[i + 2]);
  return { width: png.width, height: png.height, pixels: out };
}

try {
  await engine.start();
  await engine.ensureLoaded({});

  if (MODE === "compare") {
    const runs = [];
    for (const guidance of ["moss", "host"]) {
      const output = join(work, `compare-${guidance}.png`);
      const started = Date.now();
      await runLatentGenerate({
        session,
        spec: {
          id: `probe-${guidance}`,
          prompt: "a red apple on a wooden table",
          width: SIZE,
          height: SIZE,
          steps: STEPS,
          cfg: 3,
          shift: 5,
          seed: 7,
          batch: 1,
          guidance,
          output,
        },
        checkpointDir: join(work, "checkpoints"),
      });
      runs.push({ guidance, output, ms: Date.now() - started });
      log(`${guidance}：${output}（${((Date.now() - started) / 1000).toFixed(1)}s）`);
    }
    const a = rgb(runs[0].output);
    const b = rgb(runs[1].output);
    let diff = 0;
    let maxDiff = 0;
    for (let i = 0; i < a.pixels.length; i += 1) {
      const d = Math.abs(a.pixels[i] - b.pixels[i]);
      diff += d;
      if (d > maxDiff) maxDiff = d;
    }
    const mean = diff / a.pixels.length;
    log(`像素平均绝对差 ${mean.toFixed(3)} / 255，最大 ${maxDiff}`);
    log(mean < 2 ? "结论：两条路基本一致，合并公式可用" : "结论：差得明显，行序或合并公式有问题");
  } else {
    const output = join(work, `batch-${BATCH}.png`);
    const started = Date.now();
    const result = await runLatentGenerate({
      session,
      spec: {
        id: `probe-batch-${BATCH}`,
        prompt: "a lighthouse on a cliff at dusk",
        width: DIM,
        height: DIM,
        steps: RUN_STEPS,
        cfg: 3,
        shift: 5,
        seed: 21,
        batch: BATCH,
        output,
      },
      checkpointDir: join(work, "checkpoints"),
      onProgress: (progress) => {
        if (progress.step % 2 === 0) log(`step ${progress.step}/${progress.total}`);
      },
    });
    log(`跑完 ${result.stepsRun} 步，${result.batch} 张，${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const path of result.outputs) log(`- ${path}`);
    const frames = result.outputs.map(rgb);
    for (let i = 1; i < frames.length; i += 1) {
      let diff = 0;
      for (let k = 0; k < frames[0].pixels.length; k += 1) diff += Math.abs(frames[0].pixels[k] - frames[i].pixels[k]);
      log(`第 1 张与第 ${i + 1} 张的平均差 ${(diff / frames[0].pixels.length).toFixed(2)}（应该明显大于 0）`);
    }
  }
} catch (error) {
  console.error(`[batch] 失败：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    await session.close();
  } catch {
    /* 已关 */
  }
  engine.stop();
}
