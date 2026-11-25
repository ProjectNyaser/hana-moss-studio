// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * tools/dev/session-probe.mjs — 在真机上跑通 component session 的最小闭环。
 *
 * 起引擎、加载模型、开组件会话、跑 2 步、把 latent 解码成 PNG。
 * 这一步验证的是「共享内存桥 + 协议方法」这条通路，不涉及界面。
 *
 * 用法：node tools/dev/session-probe.mjs [256]
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
import { encode as encodePng } from "fast-png";

import { Engine } from "../../app/lib/engine.js";
import { createSession, latentSize, SHM_PAYLOAD } from "../../app/lib/session.js";

const SIZE = Number(process.argv[2] ?? 256);

const APP_DATA = "H:/";
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
  defaults: { width: SIZE, height: SIZE, steps: 2, cfg: 3, sampler: "euler", scheduler: "moss", shift: 5 },
};

const work = join(tmpdir(), "moss-session-probe");
mkdirSync(work, { recursive: true });

const log = (text) => console.log(`[probe] ${text}`);

const engine = new Engine({
  getSettings: () => settings,
  outputsDir: work,
  cacheDir: work,
  previewDir: work,
  onEvent: (event) => {
    if (event.type === "engine-log") log(event.message);
    if (event.type === "log" && event.level === "warn") log(`warn: ${event.message}`);
  },
});

const session = createSession({
  engine,
  exePath: join(process.cwd(), "app", "vendor-bin", "shm-bridge.exe"),
  tmpDir: work,
  onLog: (entry) => log(entry.message),
});

function toFloat(buffer) {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return new Float32Array(copy.buffer);
}

try {
  const started = Date.now();
  await engine.start();
  log(`引擎已起（${engine.serverPath()}）`);
  await engine.ensureLoaded({});
  log(`模型已加载（${((Date.now() - started) / 1000).toFixed(1)}s）`);

  await session.open({ maxRows: 2 });
  const conditionings = await session.encodeText(["a red apple on a wooden table", ""]);
  log(`文本编码：${conditionings.map((item) => `id=${item.id} tokens=${item.tokens}`).join(" / ")}`);

  const bytes = latentSize(SIZE, SIZE);
  log(`latent 字节：${bytes}`);
  const noiseShm = await session.alloc(bytes);
  await session.initialNoise({ seed: 7, width: SIZE, height: SIZE, shm: noiseShm.name });
  const noise = await session.bridge.read(noiseShm.name, SHM_PAYLOAD, bytes);
  log(`初始噪声已取回（${noise.length} 字节）`);

  const run = await session.runBegin({
    width: SIZE,
    height: SIZE,
    steps: 2,
    guidance: "moss",
    output: "guided_velocity",
    rows: [
      { conditioning: conditionings[0].id },
      { conditioning: conditionings[1].id, skip_layers: [22] },
    ],
  });
  log(`run 已开：sigmas=${run.sigmas.length} tensors=${JSON.stringify(run.tensors)} info=${JSON.stringify(run.info)}`);

  await session.writeSlot(run.tensors.x, noise);
  let current = toFloat(noise);
  const outSlot = Array.isArray(run.tensors.out) ? run.tensors.out[0] : run.tensors.out;
  for (let index = 0; index < 2; index += 1) {
    const stepStarted = Date.now();
    await session.step(run.sigmas[index]);
    const velocity = toFloat(await session.readSlot(outSlot, bytes));
    const delta = run.sigmas[index + 1] - run.sigmas[index];
    for (let i = 0; i < current.length; i += 1) current[i] += delta * velocity[i];
    log(`step ${index + 1}/2：${((Date.now() - stepStarted) / 1000).toFixed(2)}s，sigma ${run.sigmas[index]} → ${run.sigmas[index + 1]}`);
    if (index < 1) await session.writeSlot(run.tensors.x, Buffer.from(current.buffer, 0, bytes));
  }

  const ended = await session.runEnd();
  log(`run 已结束：${ended?.report ? JSON.stringify({ seed: ended.report.seed_used, steps: ended.report.steps_run }) : "无 report"}`);

  const decoded = await session.vaeDecode({
    latents: Buffer.from(current.buffer, 0, bytes),
    width: SIZE,
    height: SIZE,
  });
  log(`解码完成：${decoded.shape.join("×")}`);

  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0, j = 0; i < decoded.pixels.length; i += 3, j += 4) {
    rgba[j] = decoded.pixels[i];
    rgba[j + 1] = decoded.pixels[i + 1];
    rgba[j + 2] = decoded.pixels[i + 2];
    rgba[j + 3] = 255;
  }
  const png = encodePng({ width: SIZE, height: SIZE, data: rgba, channels: 4, depth: 8 });
  const output = join(work, "session-probe.png");
  writeFileSync(output, png);
  log(`已写出：${output}（${png.length} 字节）`);

  await session.close();
  log(`总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error(`[probe] 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    await session.close();
  } catch {
    /* 已经关了 */
  }
  engine.stop();
}
