// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/** tools/dev/vae-probe.mjs — 验证 VAE 编解码通路：PNG → latent → PNG。 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode as decodePng } from "fast-png";

import { Engine } from "../../app/lib/engine.js";
import { createSession } from "../../app/lib/session.js";
import { writePng } from "../../app/lib/latent.js";

const SOURCE = process.argv[2];
if (!SOURCE) {
  console.error("用法：node tools/dev/vae-probe.mjs <png>");
  process.exit(1);
}

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

const work = join(tmpdir(), "moss-vae-probe");
mkdirSync(work, { recursive: true });

const engine = new Engine({
  getSettings: () => settings,
  outputsDir: work,
  cacheDir: work,
  previewDir: work,
  onEvent: (event) => {
    if (event.type === "engine-log") console.log(`[vae] ${event.message}`);
  },
});
const session = createSession({
  engine,
  exePath: join(process.cwd(), "app", "vendor-bin", "shm-bridge.exe"),
  tmpDir: work,
});

try {
  const png = decodePng(readFileSync(SOURCE));
  const width = png.width;
  const height = png.height;
  const channels = Number(png.channels ?? 4);
  console.log(`[vae] 源图 ${width}×${height}，${channels} 通道`);
  const rgb = new Uint8Array(width * height * 3);
  let j = 0;
  for (let i = 0; i < png.data.length; i += channels) {
    rgb[j] = png.data[i];
    rgb[j + 1] = png.data[i + 1];
    rgb[j + 2] = png.data[i + 2];
    j += 3;
  }

  await engine.start();
  await engine.ensureLoaded({});
  await session.open({ maxRows: 1 });

  const encoded = await session.vaeEncode({ imageBuffer: Buffer.from(rgb), width, height });
  console.log(`[vae] latent ${encoded.latents.length} 字节，形状 ${encoded.shape.join("×")}`);
  const latentPath = join(work, "probe.latent");
  writeFileSync(latentPath, encoded.latents);

  const decoded = await session.vaeDecode({ latents: encoded.latents, width, height });
  console.log(`[vae] 解码 ${decoded.shape.join("×")}`);
  const outPath = join(work, "probe-roundtrip.png");
  writePng(outPath, decoded.pixels, width, height);
  console.log(`[vae] 往返图：${outPath}（${readFileSync(outPath).length} 字节）`);
  await session.close();
} catch (error) {
  console.error(`[vae] 失败：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    await session.close();
  } catch {
    /* 已关 */
  }
  engine.stop();
}
