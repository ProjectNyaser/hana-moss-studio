// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * tools/dev/crop-probe.mjs — 验证 crop 调用：在大画布的 run 上跑一个更小的 shape。
 *
 * 文档说 crop 调用「等于在 crop 尺寸上单独跑一次」。这里就用同一份 x 各跑一次：
 *   A：256² 的 run，写噪声，跑一步，读 guided velocity；
 *   B：512² 的 run，把同一份噪声写进槽位开头，用 shape=[1,16,16] 跑一步，读回来。
 * 两者逐元素一致，说明槽位布局与 shape 的语义都对上了。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Engine } from "../../app/lib/engine.js";
import { createSession, latentSize, SHM_PAYLOAD } from "../../app/lib/session.js";

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
  defaults: { width: 256, height: 256, steps: 2, cfg: 3, sampler: "euler", scheduler: "moss", shift: 5 },
};

const work = join(tmpdir(), "moss-crop-probe");
mkdirSync(work, { recursive: true });
const log = (text) => console.log(`[crop] ${text}`);

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

function toFloat(buffer) {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return new Float32Array(copy.buffer);
}

async function noiseFor(seed, width, height) {
  const bytes = latentSize(width, height);
  const shm = await session.alloc(bytes);
  try {
    await session.initialNoise({ seed, width, height, shm: shm.name });
    return await session.bridge.read(shm.name, SHM_PAYLOAD, bytes);
  } finally {
    await session.free(shm.name);
  }
}

try {
  await engine.start();
  await engine.ensureLoaded({});
  await session.open({ maxRows: 2, maxLatents: 1 });
  const conds = await session.encodeText(["a red apple on a wooden table", ""]);
  const rows = [
    { conditioning: conds[0].id },
    { conditioning: conds[1].id, skip_layers: [22] },
  ];

  // A：256² 的正常 run
  const small = await session.runBegin({ width: 256, height: 256, steps: 2, guidance: "moss", output: "guided_velocity", rows });
  const smallBytes = latentSize(256, 256);
  const noise = await noiseFor(7, 256, 256);
  await session.writeSlot(small.tensors.x, noise);
  await session.step(small.sigmas[0]);
  const outSmall = toFloat(await session.readSlot(small.tensors.out[0], smallBytes));
  await session.runEnd();
  log(`A：256² 输出 ${outSmall.length} 个数，sigmas=${JSON.stringify(small.sigmas)}`);

  // B：512² 的 run，同一个 shape 的 crop 调用。crop 需要 host guidance，
  // 所以这里自己合 CFG，再与 A 的 guided velocity 对。
  const big = await session.runBegin({ width: 512, height: 512, steps: 2, guidance: "host", output: "rows", cfg: 3, rows });
  const bigBytes = latentSize(512, 512);
  log(`B：512² 的 x 槽位 ${big.tensors.x}，输出槽位 ${JSON.stringify(big.tensors.out)}，staging ${big.info.staging_bytes}`);
  // 把 A 的噪声写进槽位开头：crop 调用的张量就打包在这里
  await session.writeSlot(big.tensors.x, noise);
  log(`sigmas 是否一致：${JSON.stringify(big.sigmas) === JSON.stringify(small.sigmas)}`);
  await session.step(big.sigmas[0], { shape: [1, 16, 16] });
  const condOut = toFloat(await session.readSlot(big.tensors.out[0], smallBytes));
  const uncondOut = toFloat(await session.readSlot(big.tensors.out[1], smallBytes));
  const outBig = new Float32Array(condOut.length);
  for (let i = 0; i < condOut.length; i += 1) outBig[i] = uncondOut[i] + 3 * (condOut[i] - uncondOut[i]);
  await session.runEnd();

  let maxDiff = 0;
  let sum = 0;
  for (let i = 0; i < outSmall.length; i += 1) {
    const diff = Math.abs(outSmall[i] - outBig[i]);
    sum += diff;
    if (diff > maxDiff) maxDiff = diff;
  }
  log(`B 读回 ${outBig.length} 个数`);
  log(`平均差 ${(sum / outSmall.length).toExponential(3)}，最大差 ${maxDiff.toExponential(3)}`);
  log(maxDiff < 1e-3 ? "结论：crop 调用与在 crop 尺寸上单独跑一致" : "结论：不一致，槽位或 shape 的用法要重看");

  writeFileSync(join(work, "crop-A.bin"), Buffer.from(outSmall.buffer));
  writeFileSync(join(work, "crop-B.bin"), Buffer.from(outBig.buffer));
  await session.close();
} catch (error) {
  console.error(`[crop] 失败：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    await session.close();
  } catch {
    /* 已关 */
  }
  engine.stop();
}
