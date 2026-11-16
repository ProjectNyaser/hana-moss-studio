// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/session.js — moss-server 的 component session。
 *
 * 普通生成是 `generate` 一口气跑完，中间状态拿不到。component session 把
 * 采样循环交给调用方：文本编码、DiT 前向、VAE 编解码都还在引擎里，但每一步的
 * latent 由这边写进共享内存、读出来，于是可以存盘、可以中断、可以从任意一步接着跑。
 *
 * 张量布局（协议文档 component session / shared memory）：
 *   - latent：F32 [128, h/16, w/16]，模型空间，与 ComfyUI 的 Flux2 LATENT 同构；
 *   - 图像：RGB8 [height][width][3]；
 *   - 区域：64 字节头 + 4096 起是载荷；scratch 的张量从载荷开始，run 的槽位看 tensors 偏移。
 */

import { ShmBridge } from "./shm.js";

const LATENT_CHANNELS = 128;
const HEADER = 64;
const PAYLOAD = 4096;

export class ComponentSession {
  constructor({ engine, bridge, onLog }) {
    this.engine = engine;
    this.bridge = bridge;
    this.onLog = onLog ?? (() => {});
    this.opened = false;
    /** 当前 run：{ shm, tensors, sigmas, info, bytes }。 */
    this.run = null;
    this.conditionings = [];
  }

  get available() {
    return Boolean(this.engine?.snapshot?.().running);
  }

  async open(options) {
    const settings = options ?? {};
    const maxRows = Number.isFinite(settings.maxRows) ? settings.maxRows : 2;
    const maxLatents = Number.isFinite(settings.maxLatents) ? settings.maxLatents : 1;
    const controlAdapter = settings.controlAdapter ?? null;
    const planRequest = settings.planRequest ?? null;
    const params = { max_rows: maxRows, max_latents: maxLatents };
    if (controlAdapter) params.control_adapter = controlAdapter;
    if (planRequest) params.plan_request = planRequest;
    const result = await this.engine.call("session_open", params, 900_000);
    this.opened = true;
    this.onLog({ level: "info", message: `组件会话已开启（max_rows ${result.max_rows}）` });
    return result;
  }

  async close() {
    if (!this.opened) return;
    this.opened = false;
    this.run = null;
    try {
      await this.engine.call("session_close", {}, 120_000);
    } catch {
      /* 会话可能已随引擎一起没了 */
    }
  }

  async alloc(bytes) {
    const result = await this.engine.call("shm_alloc", { bytes }, 60_000);
    return result.shm;
  }

  async free(name) {
    try {
      await this.engine.call("shm_free", { name }, 30_000);
    } catch {
      /* 区域可能已被回收 */
    }
  }

  /** 文本编码：返回 conditioning 数组（含 id 与 token 统计）。 */
  async encodeText(prompts, maxSequenceLength) {
    const seqLength = Number.isFinite(maxSequenceLength) ? maxSequenceLength : 4096;
    const result = await this.engine.call("encode_text", {
      prompts,
      max_sequence_length: seqLength,
    }, 900_000);
    this.conditionings = result.conditionings ?? [];
    return this.conditionings;
  }

  /** 初始噪声：引擎按 seed 生成到 scratch 区，读出来就是 x 的起点。 */
  async initialNoise({ seed, width, height, shm }) {
    await this.engine.call("initial_noise", {
      seed,
      width,
      height,
      noise_layout: "official",
      shm,
    }, 300_000);
    return {};
  }

  /** 开一次 run：给行（prompt 与负向）、形状、步数，拿回 sigmas 与张量偏移。 */
  async runBegin(params) {
    const result = await this.engine.call("run_begin", params, 1_800_000);
    this.run = {
      shm: result.shm,
      tensors: result.tensors,
      sigmas: result.sigmas ?? [],
      info: result.info ?? {},
      adopted: result.adopted,
    };
    return this.run;
  }

  /** 跑一步：调用方先把 x 写进 tensors.x。 */
  async step(sigma, extra) {
    if (!this.run) throw new Error("没有打开的 run");
    return this.engine.call("denoise_step", { sigma, ...(extra ?? {}) }, 1_800_000);
  }

  async runEnd() {
    if (!this.run) return null;
    const run = this.run;
    this.run = null;
    return this.engine.call("run_end", {}, 120_000);
  }

  /** 把图像（RGB8）编码成 latent：返回 latent 字节与它的形状。 */
  async vaeEncode({ imageBuffer, width, height }) {
    const latentBytes = latentSize(width, height);
    const inShm = await this.alloc(width * height * 3);
    const outShm = await this.alloc(latentBytes);
    try {
      await this.bridge.write(inShm.name, PAYLOAD, imageBuffer);
      const result = await this.engine.call("vae_encode", {
        shm: inShm.name,
        width,
        height,
        out_shm: outShm.name,
      }, 900_000);
      const latents = await this.bridge.read(outShm.name, PAYLOAD, latentBytes);
      return { latents, shape: result.shape ?? [LATENT_CHANNELS, height / 16, width / 16] };
    } finally {
      await this.free(inShm.name);
      await this.free(outShm.name);
    }
  }

  /** latent → RGB8。 */
  async vaeDecode({ latents, width, height }) {
    const latentBytes = latentSize(width, height);
    if (latents.length !== latentBytes) {
      throw new Error(`latent 长度不对：${latents.length}，期望 ${latentBytes}`);
    }
    const inShm = await this.alloc(latentBytes);
    const outShm = await this.alloc(width * height * 3);
    try {
      await this.bridge.write(inShm.name, PAYLOAD, latents);
      const result = await this.engine.call("vae_decode", {
        shm: inShm.name,
        width,
        height,
        out_shm: outShm.name,
      }, 900_000);
      const pixels = await this.bridge.read(outShm.name, PAYLOAD, width * height * 3);
      return { pixels, shape: result.shape ?? [height, width, 3] };
    } finally {
      await this.free(inShm.name);
      await this.free(outShm.name);
    }
  }

  /** run 区里某个槽位的字节数：一个 latent。 */
  latentBytes() {
    const info = this.run?.info ?? {};
    const height = info.latent_height;
    const width = info.latent_width;
    if (!height || !width) throw new Error("run 还没开始，拿不到 latent 形状");
    return latentSize(width * 16, height * 16);
  }

  readSlot(offset, bytes) {
    if (!this.run) throw new Error("没有打开的 run");
    return this.bridge.read(this.run.shm.name, offset, bytes);
  }

  writeSlot(offset, buffer) {
    if (!this.run) throw new Error("没有打开的 run");
    return this.bridge.write(this.run.shm.name, offset, buffer);
  }
}

/** latent 字节数：128 通道 × (h/16) × (w/16) × 4 字节。 */
export function latentSize(width, height) {
  const h = Math.max(1, Math.round(height / 16));
  const w = Math.max(1, Math.round(width / 16));
  return LATENT_CHANNELS * h * w * 4;
}

/** 每个函数的导出常量，测试与调用方都用同一份。 */
export const SHM_HEADER = HEADER;
export const SHM_PAYLOAD = PAYLOAD;

export function createSession({ engine, exePath, tmpDir, onLog }) {
  const bridge = new ShmBridge({ exePath, tmpDir });
  return new ComponentSession({ engine, bridge, onLog });
}
