// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/image.js — 图片降采样与 WebP 编码。
 *
 * 两处用到：画廊的缩略图（一屏几十张，不能铺原图），采样预览（全尺寸 PNG 一张
 * 十兆，界面只要看清形状）。
 *
 * PNG 解码用 fast-png（2560×1440 约 30 ms，pngjs 是 74 ms，体积也更小），
 * WebP 编码用 @jsquash/webp 的 libwebp WASM，缩放自己写（面积平均）。
 *
 * 不用 sharp：它是 native 模块，要按平台带二进制，装进宿主还得赌 require 能解析
 * 到 .node。WASM 版本没有这些事。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { decode as decodePng } from "fast-png";
import { initEmscriptenModule } from "@jsquash/webp/utils.js";
import webpEncoder from "@jsquash/webp/codec/enc/webp_enc_simd.js";
import { defaultOptions } from "@jsquash/webp/meta.js";

/** 小于这个体积的图片不值得处理：小图本来就不大。 */
const WORTH_RESIZING = 300 * 1024;
/** 缩略图质量。78 在 320 宽下约 10 KB，肉眼与无损没差别。 */
const WEBP_QUALITY = 78;

let encoder = null;

/** 懒加载 libwebp 编码器。首次要编译 wasm，之后复用同一个实例。 */
async function getEncoder() {
  if (encoder) return encoder;
  const wasmUrl = new URL(
    "../node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm",
    import.meta.url,
  );
  const wasm = await WebAssembly.compile(readFileSync(wasmUrl));
  const module = await initEmscriptenModule(webpEncoder, wasm);
  encoder = { module, defaultOptions };
  return encoder;
}

/**
 * 等比缩小到不超过 maxWidth，输出 RGBA。
 *
 * 直接按源图的通道数取样再写 RGBA，省掉先把整张转成 RGBA 的那一趟遍历。
 * 面积平均：目标像素取源图对应矩形内所有像素的平均值。
 */
function downscale(source, maxWidth) {
  const { width, height, data } = source;
  const channels = source.channels ?? 4;
  if (width <= maxWidth) return null;
  const ratio = maxWidth / width;
  const outWidth = Math.max(1, Math.round(width * ratio));
  const outHeight = Math.max(1, Math.round(height * ratio));
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const xRatio = width / outWidth;
  const yRatio = height / outHeight;
  const opaque = channels < 4;
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * width + sx) * channels;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          if (!opaque) a += data[i + 3];
          count += 1;
        }
      }
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = opaque ? 255 : Math.round(a / count);
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

/** 通道数不是四时补齐成 RGBA，编码器只认 RGBA。 */
function toRgba(source) {
  const { width, height, data } = source;
  const channels = source.channels ?? 4;
  if (channels === 4) return { width, height, data };
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i += 1, j += channels) {
    out[i * 4] = data[j];
    out[i * 4 + 1] = data[j + 1];
    out[i * 4 + 2] = data[j + 2];
    out[i * 4 + 3] = 255;
  }
  return { width, height, data: out };
}

/**
 * 等比缩小并写成一个 WebP。
 *
 * `force` 为真时即使原图不够宽也只转格式不缩放：采样预览常常是 512 宽的 PNG，
 * 缩不了但能压小一个量级，每帧刷新少读几百 KB。
 *
 * 返回写出的尺寸；源图不满足条件或读不动时返回 null，调用方据此保持原样。
 */
export async function shrinkToWebp(src, dst, maxWidth, { force = false } = {}) {
  if (!existsSync(src)) return null;
  const input = readFileSync(src);
  // 小图默认不处理（本来就不大），但 force 时还是要转：缩略图路由需要这个文件
  // 存在，不然每次请求都要重新解一遍 PNG。
  if (!force && input.length < WORTH_RESIZING) return null;
  let image;
  try {
    image = decodePng(input);
  } catch {
    // 读不动的格式交给调用方处理，这里不抛。
    return null;
  }
  // 16 位深无法直接当 8 位用，交给调用方退回原图。
  if (image.depth !== 8) return null;
  const small = downscale(image, maxWidth) ?? (force ? toRgba(image) : null);
  if (!small) return null;
  const { module, defaultOptions } = await getEncoder();
  const encoded = module.encode(small.data, small.width, small.height, {
    ...defaultOptions,
    quality: WEBP_QUALITY,
  });
  if (!encoded) return null;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, Buffer.from(encoded));
  return { width: small.width, height: small.height };
}
