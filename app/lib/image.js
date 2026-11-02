// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/image.js — 图片降采样。
 *
 * 两处用到：画廊的缩略图（一屏几十张，不能铺原图），采样预览（全尺寸 PNG 一张
 * 十兆，界面只要看清形状）。
 *
 * PNG 的编解码交给 pngjs（派生在 app/node_modules 里，见 scripts/derive.mjs）；
 * 缩放是自己写的面积平均，比最近邻干净，也不用为它拖一整个图像套件进来。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { PNG } from "pngjs";

/** 小于这个体积的 PNG 不值得处理：小图本来就不大。 */
const WORTH_RESIZING = 300 * 1024;

/**
 * 等比缩小到不超过 maxWidth。只缩不放。
 * 面积平均：目标像素取源图对应矩形内所有像素的平均值。
 */
function downscale(source, maxWidth) {
  const { width, height, data } = source;
  if (width <= maxWidth) return null;
  const ratio = maxWidth / width;
  const outWidth = Math.max(1, Math.round(width * ratio));
  const outHeight = Math.max(1, Math.round(height * ratio));
  const out = new PNG({ width: outWidth, height: outHeight });
  const xRatio = width / outWidth;
  const yRatio = height / outHeight;
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
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          count += 1;
        }
      }
      const o = (y * outWidth + x) * 4;
      out.data[o] = Math.round(r / count);
      out.data[o + 1] = Math.round(g / count);
      out.data[o + 2] = Math.round(b / count);
      out.data[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

/**
 * 等比缩小并写成一个新的 PNG。
 *
 * 返回实际写出的尺寸；源图比目标宽度小、或者读不动时返回 null，调用方据此保持原样。
 */
export function shrinkPng(src, dst, maxWidth) {
  if (!existsSync(src)) return null;
  const input = readFileSync(src);
  if (input.length < WORTH_RESIZING) return null;
  let image;
  try {
    image = PNG.sync.read(input);
  } catch {
    // 读不动的格式交给调用方处理，这里不抛。
    return null;
  }
  const small = downscale(image, maxWidth);
  if (!small) return null;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, PNG.sync.write(small, { colorType: 6, deflateLevel: 6 }));
  return { width: small.width, height: small.height };
}
