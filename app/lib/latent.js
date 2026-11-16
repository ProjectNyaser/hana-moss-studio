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
 *
 * 两张以上走 `guidance: "host"`：引擎在 MOSS guidance 下只接受一个 latent
 * （文档写明 `L = 1`），要并行就得自己把 cond / uncond 两行按 CFG 合起来。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encode as encodePng } from "fast-png";

import { latentSize, SHM_PAYLOAD } from "./session.js";

export const RESUME_SAMPLER = "euler";
/** 一份任务里最多几张：MOSS 行限制 8 行，每张要 2 行。 */
export const MAX_BATCH = 4;

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

/** 第 index 张的产物路径：单张就是 output，多张在名字后面加 -2、-3。 */
export function outputForIndex(output, index) {
  if (index === 0) return output;
  return output.replace(/\.png$/i, `-${index + 1}.png`);
}

/**
 * 跑一次可续画的生成。
 *
 * spec: { prompt, negativePrompt, width, height, steps, cfg, shift, seed, batch,
 *         output, from }
 *   `batch` 1~4；`from` 是 readCheckpoint 的结果：给了就从它的步号接着跑。
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
  const batch = Math.max(1, Math.min(MAX_BATCH, Math.round(spec.batch ?? from?.batch ?? 1)));
  if (from && (from.width !== width || from.height !== height)) {
    throw new Error(`断点是 ${from.width}×${from.height}，这次是 ${width}×${height}：形状不一致没法接着跑`);
  }
  if (from && Number(from.batch ?? 1) !== batch) {
    throw new Error(`断点里有 ${from.batch ?? 1} 张，这次是 ${batch} 张：张数不一致没法接着跑`);
  }
  const hostGuidance = spec.guidance ? spec.guidance === "host" : batch > 1;

  await session.open({ maxRows: hostGuidance ? batch * 2 : 2, maxLatents: batch });
  try {
    const conditionings = await session.encodeText([spec.prompt, spec.negativePrompt ?? ""]);
    const condId = conditionings[0].id;
    const uncondId = conditionings[1].id;
    const rows = [];
    for (let index = 0; index < batch; index += 1) {
      rows.push({ conditioning: condId, latent: index });
      rows.push({ conditioning: uncondId, latent: index, skip_layers: [22] });
    }
    const run = await session.runBegin({
      width,
      height,
      steps,
      guidance: hostGuidance ? "host" : "moss",
      output: hostGuidance ? "rows" : "guided_velocity",
      cfg: Number.isFinite(spec.cfg) ? spec.cfg : 3,
      shift: Number.isFinite(spec.shift) ? spec.shift : 5,
      rows: hostGuidance ? rows : rows.slice(0, 2),
    });

    const sigmas = run.sigmas ?? [];
    if (sigmas.length < steps + 1) throw new Error(`引擎给的 sigmas 不够：${sigmas.length} 个，要 ${steps + 1} 个`);
    if (from && Array.isArray(from.sigmas) && from.sigmas.length === sigmas.length) {
      const mismatch = sigmas.findIndex((value, index) => Math.abs(value - from.sigmas[index]) > 1e-9);
      if (mismatch >= 0) {
        throw new Error("断点的调度表与这次不同（步数或 shift 变了）：没法续跑，重新生成一张");
      }
    }

    const totalBytes = bytes * batch;
    let latents;
    let startStep = 0;
    if (from) {
      if (from.latents.length !== totalBytes) {
        throw new Error(`断点的 latent 长度不对：${from.latents.length}，期望 ${totalBytes}`);
      }
      latents = from.latents;
      startStep = Math.max(0, Math.min(steps, Math.round(from.stepIndex ?? 0)));
    } else {
      latents = Buffer.alloc(totalBytes);
      for (let index = 0; index < batch; index += 1) {
        const noiseShm = await session.alloc(bytes);
        try {
          const seed = (spec.seed ?? 42) + index;
          await session.initialNoise({ seed, width, height, shm: noiseShm.name });
          const noise = await session.bridge.read(noiseShm.name, SHM_PAYLOAD, bytes);
          noise.copy(latents, index * bytes);
        } finally {
          await session.free(noiseShm.name);
        }
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
      batch,
      sampler: RESUME_SAMPLER,
      sigmas,
      stepIndex: startStep,
      updatedAt: new Date().toISOString(),
    };
    const paths = checkpointPaths(checkpointDir, spec.id ?? "session");
    writeFileSync(paths.latents, latents);
    writeFileSync(paths.meta, JSON.stringify(meta, null, 2), "utf8");

    const outSlots = Array.isArray(run.tensors.out) ? run.tensors.out : [run.tensors.out];
    if (outSlots.some((offset) => typeof offset !== "number")) throw new Error("引擎没有给齐输出槽位");
    if (hostGuidance && outSlots.length < batch * 2) {
      throw new Error(`rows 模式给了 ${outSlots.length} 个输出，需要 ${batch * 2} 个`);
    }

    const xBase = run.tensors.x;
    const writeX = async () => {
      if (batch === 1) {
        await session.writeSlot(xBase, latents);
        return;
      }
      // 多张：x 是一段连续的 [L, 128, h, w]，一次写整块。
      await session.writeSlot(xBase, latents);
    };

    await writeX();
    const current = toFloat(latents);
    let done = startStep;
    for (let index = startStep; index < steps; index += 1) {
      if (shouldStop()) {
        throw Object.assign(new Error("已取消"), { cancelled: true });
      }
      await session.step(sigmas[index]);
      const delta = sigmas[index + 1] - sigmas[index];
      if (hostGuidance) {
        const cfg = Number.isFinite(spec.cfg) ? spec.cfg : 3;
        for (let item = 0; item < batch; item += 1) {
          const base = item * bytes;
          const cond = toFloat(await session.readSlot(outSlots[item * 2], bytes));
          const uncond = toFloat(await session.readSlot(outSlots[item * 2 + 1], bytes));
          const float32 = new Float32Array(current.buffer, current.byteOffset + base, bytes / 4);
          for (let i = 0; i < float32.length; i += 1) {
            const velocity = uncond[i] + cfg * (cond[i] - uncond[i]);
            float32[i] += delta * velocity;
          }
        }
      } else {
        const velocity = toFloat(await session.readSlot(outSlots[0], bytes));
        for (let i = 0; i < current.length; i += 1) current[i] += delta * velocity[i];
      }
      done = index + 1;
      // 每步落盘：这一步之后的状态就是下一台机器上的起点。
      const snapshot = toBuffer(current, totalBytes);
      latents = snapshot;
      writeFileSync(paths.latents, snapshot);
      meta.stepIndex = done;
      meta.updatedAt = new Date().toISOString();
      writeFileSync(paths.meta, JSON.stringify(meta, null, 2), "utf8");
      onProgress({ step: done, total: steps, sigmas: sigmas[index + 1] });
      if (done < steps) await writeX();
    }

    await session.runEnd();
    const outputs = [];
    if (spec.output) {
      for (let index = 0; index < batch; index += 1) {
        const slice = toBuffer(current, totalBytes).subarray(index * bytes, (index + 1) * bytes);
        const decoded = await session.vaeDecode({ latents: Buffer.from(slice), width, height });
        const path = outputForIndex(spec.output, index);
        writePng(path, decoded.pixels, width, height);
        outputs.push(path);
      }
    }
    return {
      outputs,
      output: outputs[0] ?? null,
      stepsRun: done - startStep,
      totalSteps: steps,
      batch,
      checkpoint: paths.meta,
      latents: paths.latents,
    };
  } finally {
    await session.close();
  }
}
