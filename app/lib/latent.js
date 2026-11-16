// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/latent.js — 可续画的生成：走 component session，把每一步的 latent 落盘。
 *
 * 与 `generate` 的区别只有一处：中间状态在自己手里。于是取消、关 App、换机器之后
 * 都能从断点接着跑，也能把 latent 交给 ComfyUI（同构的 Flux2 LATENT）。
 *
 * 采样只做 euler：MOSS 官方组合（euler + moss + shift 5）。别的采样器公式不同，
 * 乱用会得到一张安静的错图，所以这里直接拒绝。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encode as encodePng } from "fast-png";

import { latentSize, SHM_PAYLOAD } from "./session.js";

export const RESUME_SAMPLER = "euler";

export function checkpointPaths(dir, id) {
  return { latents: join(dir, `${id}.latent`), meta: join(dir, `${id}.json`) };
}

/** 读一份断点：latent 字节 + 参数（sigmas、步号、提示词、形状）。 */
export function readCheckpoint(dir, id) {
  const paths = checkpointPaths(dir, id);
  if (!existsSync(paths.meta) || !existsSync(paths.latents)) return null;
  let meta;
  try {
    meta = JSON.parse(readFileSync(paths.meta, "utf8"));
  } catch {
    return null;
  }
  return { ...meta, latents: readFileSync(paths.latents) };
}

function toFloat(buffer) {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return new Float32Array(copy.buffer);
}

function toBuffer(floatView, bytes) {
  return Buffer.from(floatView.buffer, floatView.byteOffset, bytes);
}

export function writePng(path, pixels, width, height) {
  const rgba = new Uint8Array(width * height * 4);
  let j = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
    j += 4;
  }
  writeFileSync(path, encodePng({ width, height, data: rgba, channels: 4, depth: 8 }));
}

/**
 * 跑一次可续画的生成。
 *
 * spec: { prompt, negativePrompt, width, height, steps, cfg, shift, seed, output, from }
 *   `from` 是 readCheckpoint 的结果：给了就从它的步号接着跑，不再重新加噪。
 */
export async function runLatentGenerate(options) {
  const { session, spec, checkpointDir } = options;
  const onProgress = options.onProgress ?? (() => {});
  const shouldStop = options.shouldStop ?? (() => false);
  if (spec.sampler && spec.sampler !== RESUME_SAMPLER) {
    throw new Error(`可续画模式只支持 euler（MOSS 官方组合），当前是 ${spec.sampler}`);
  }
  const width = Math.round(spec.width / 16) * 16;
  const height = Math.round(spec.height / 16) * 16;
  const steps = Math.max(1, Math.round(spec.steps));
  const bytes = latentSize(width, height);
  mkdirSync(checkpointDir, { recursive: true });

  const from = spec.from ?? null;
  if (from && (from.width !== width || from.height !== height)) {
    throw new Error(`断点是 ${from.width}×${from.height}，这次是 ${width}×${height}：形状不一致没法接着跑`);
  }

  await session.open({ maxRows: 2 });
  try {
    const conditionings = await session.encodeText([spec.prompt, spec.negativePrompt ?? ""]);
    const run = await session.runBegin({
      width,
      height,
      steps,
      guidance: "moss",
      output: "guided_velocity",
      cfg: Number.isFinite(spec.cfg) ? spec.cfg : 3,
      shift: Number.isFinite(spec.shift) ? spec.shift : 5,
      rows: [
        { conditioning: conditionings[0].id },
        { conditioning: conditionings[1].id, skip_layers: [22] },
      ],
    });

    const sigmas = run.sigmas ?? [];
    if (sigmas.length < steps + 1) throw new Error(`引擎给的 sigmas 不够：${sigmas.length} 个，要 ${steps + 1} 个`);
    if (from && Array.isArray(from.sigmas) && from.sigmas.length === sigmas.length) {
      const mismatch = sigmas.findIndex((value, index) => Math.abs(value - from.sigmas[index]) > 1e-9);
      if (mismatch >= 0) {
        throw new Error("断点的调度表与这次不同（步数或 shift 变了）：没法续跑，重新生成一张");
      }
    }

    let latents;
    let startStep = 0;
    if (from) {
      if (from.latents.length !== bytes) throw new Error(`断点的 latent 长度不对：${from.latents.length}，期望 ${bytes}`);
      latents = from.latents;
      startStep = Math.max(0, Math.min(steps, Math.round(from.stepIndex ?? 0)));
    } else {
      const noiseShm = await session.alloc(bytes);
      try {
        await session.initialNoise({ seed: spec.seed ?? 42, width, height, shm: noiseShm.name });
        latents = await session.bridge.read(noiseShm.name, SHM_PAYLOAD, bytes);
      } finally {
        await session.free(noiseShm.name);
      }
    }

    const meta = {
      id: spec.id ?? null,
      prompt: spec.prompt,
      negativePrompt: spec.negativePrompt ?? "",
      width,
      height,
      steps,
      cfg: spec.cfg ?? 3,
      shift: spec.shift ?? 5,
      seed: spec.seed ?? 42,
      sampler: RESUME_SAMPLER,
      sigmas,
      stepIndex: startStep,
      updatedAt: new Date().toISOString(),
    };
    const paths = checkpointPaths(checkpointDir, spec.id ?? "session");
    writeFileSync(paths.latents, latents);
    writeFileSync(paths.meta, JSON.stringify(meta, null, 2), "utf8");

    const outSlot = Array.isArray(run.tensors.out) ? run.tensors.out[0] : run.tensors.out;
    if (typeof outSlot !== "number") throw new Error("引擎没有给输出槽位");

    const current = toFloat(latents);
    await session.writeSlot(run.tensors.x, toBuffer(current, bytes));
    let done = startStep;
    for (let index = startStep; index < steps; index += 1) {
      if (shouldStop()) {
        throw Object.assign(new Error("已取消"), { cancelled: true });
      }
      await session.step(sigmas[index]);
      const velocity = toFloat(await session.readSlot(outSlot, bytes));
      const delta = sigmas[index + 1] - sigmas[index];
      for (let i = 0; i < current.length; i += 1) current[i] += delta * velocity[i];
      done = index + 1;
      // 每步落盘：这一步之后的状态就是下一台机器上的起点。
      writeFileSync(paths.latents, toBuffer(current, bytes));
      meta.stepIndex = done;
      meta.updatedAt = new Date().toISOString();
      writeFileSync(paths.meta, JSON.stringify(meta, null, 2), "utf8");
      onProgress({ step: done, total: steps, sigmas: sigmas[index + 1] });
      if (done < steps) await session.writeSlot(run.tensors.x, toBuffer(current, bytes));
    }

    await session.runEnd();
    if (spec.output) {
      const decoded = await session.vaeDecode({ latents: toBuffer(current, bytes), width, height });
      writePng(spec.output, decoded.pixels, width, height);
    }
    return { output: spec.output ?? null, stepsRun: done - startStep, totalSteps: steps, checkpoint: paths.meta, latents: paths.latents };
  } finally {
    await session.close();
  }
}
