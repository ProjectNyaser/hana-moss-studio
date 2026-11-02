// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/image.js — 预览图的体积压缩。
 *
 * 引擎写的采样预览是全尺寸 PNG，2560×1440 一张 10.5 MB。中间过程本来就糊，
 * 无损存它没有意义，而界面每次更新都要重新读一遍、解码一遍。
 * 转成 JPEG q70 同样画面约 250 KB，小了四十倍，肉眼差别在这个阶段看不出来。
 *
 * 用的是系统自带的 System.Drawing（.NET），不引第三方依赖。
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 小于这个体积的 PNG 不值得转：小图 PNG 也就几百 KB。 */
const WORTH_CONVERTING = 800 * 1024;

/** PowerShell 单引号字符串里只需要把单引号翻倍。 */
function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * 把 PNG 转成 JPEG。源文件不存在或转不动时抛错，调用方自己决定回退。
 */
export async function pngToJpeg(src, dst, quality = 70) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    `$src = ${psQuote(src)}`,
    `$dst = ${psQuote(dst)}`,
    "$img = [System.Drawing.Image]::FromFile($src)",
    "try {",
    "  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    "  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)",
    `  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${Math.round(quality)})`,
    "  $img.Save($dst, $codec, $params)",
    "} finally { $img.Dispose() }",
  ].join("; ");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 20_000,
  });
}

/** 值不值得转：源文件得存在，而且确实够大。 */
export function worthConverting(src) {
  try {
    return existsSync(src) && statSync(src).size > WORTH_CONVERTING;
  } catch {
    return false;
  }
}
