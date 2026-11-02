// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/outputs.js — 从 PNG 里读出生成记录。
 *
 * 出图文件就是记录的真相源：引擎在 iTXt 块里写了完整参数，删掉文件记录随之消失。
 * 所以这里不做数据库，只把目录扫成记录列表。
 *
 * 按块头逐条跳读，只把文本块读进内存。整张 10 MB 的图从头读到尾没有必要，
 * 而且固定读前 N KB 会在文本块跨越边界时把它截断。
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";

/** 单个文本块的上限。坏文件里 length 字段可能是任意值，按它分配内存会炸。 */
const MAX_TEXT_CHUNK = 4 * 1024 * 1024;
const PNG_SIGNATURE = "89504e470d0a1a0a";

const cache = new Map();

/**
 * 解析 iTXt：keyword\0 flag method language\0 translated\0 text。
 * 返回 null 表示这个块不合法。
 */
function parseITxt(body) {
  const keywordEnd = body.indexOf(0);
  if (keywordEnd < 0 || keywordEnd + 3 > body.length) return null;
  const keyword = body.toString("utf8", 0, keywordEnd);
  const compressed = body[keywordEnd + 1] === 1;
  const method = body[keywordEnd + 2];
  let cursor = keywordEnd + 3;
  const languageEnd = body.indexOf(0, cursor);
  if (languageEnd < 0) return null;
  cursor = languageEnd + 1;
  const translatedEnd = body.indexOf(0, cursor);
  if (translatedEnd < 0) return null;
  cursor = translatedEnd + 1;
  const payload = body.subarray(cursor);
  if (!compressed) return { keyword, text: payload.toString("utf8") };
  if (method !== 0) return null;
  try {
    return { keyword, text: inflateSync(payload).toString("utf8") };
  } catch {
    return null;
  }
}

/** tEXt 是 keyword\0 text，没有压缩。 */
function parseTxt(body) {
  const keywordEnd = body.indexOf(0);
  if (keywordEnd < 0) return null;
  return { keyword: body.toString("utf8", 0, keywordEnd), text: body.toString("utf8", keywordEnd + 1) };
}

/** 从一个 PNG 里取出文本块，返回 { generation, parameters }，读不到就是 null。 */
export function readPngText(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text;

  let handle;
  const text = {};
  try {
    handle = openSync(file, "r");
    const signature = Buffer.alloc(8);
    if (readSync(handle, signature, 0, 8, 0) < 8) return null;
    if (signature.toString("hex") !== PNG_SIGNATURE) return null;

    let offset = 8;
    const head = Buffer.alloc(8);
    for (;;) {
      if (readSync(handle, head, 0, 8, offset) < 8) break;
      const size = head.readUInt32BE(0);
      const type = head.toString("ascii", 4, 8);
      if (type === "IEND") break;
      if ((type === "iTXt" || type === "tEXt") && size > 0 && size <= MAX_TEXT_CHUNK) {
        const body = Buffer.alloc(size);
        if (readSync(handle, body, 0, size, offset + 8) === size) {
          const chunk = type === "iTXt" ? parseITxt(body) : parseTxt(body);
          if (chunk?.keyword === "generation") {
            try {
              text.generation = JSON.parse(chunk.text);
            } catch {
              // 元数据坏了就当没有，不影响这张图本身。
            }
          } else if (chunk?.keyword === "parameters") {
            text.parameters = chunk.text;
          }
        }
      }
      // 块 = 4 size + 4 type + size 数据 + 4 CRC
      offset += 12 + size;
      if (offset <= 8 || offset > stat.size) break;
    }
  } catch {
    return null;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }

  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

/** 扫一遍目录，把每张图还原成一条记录。按生成时间倒序。 */
export function scanOutputs(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const file = join(dir, name);
    const text = readPngText(file);
    const meta = text?.generation ?? null;
    let createdAt = null;
    try {
      createdAt = statSync(file).mtime.toISOString();
    } catch {
      continue;
    }
    const id = name.replace(/\.png$/i, "");
    records.push({
      id,
      prompt: meta?.prompt ?? text?.parameters?.split("\n")[0] ?? "",
      negativePrompt: meta?.negative_prompt ?? "",
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      steps: meta?.steps ?? null,
      cfg: meta?.cfg ?? null,
      seed: meta?.seed ?? null,
      tier: meta?.engine?.tier ?? null,
      shaper: meta?.sampler ?? null,
      scheduler: meta?.scheduler ?? null,
      hiresScale: meta?.hires?.width ? 1 : 0,
      hiresWidth: meta?.hires?.width ?? null,
      hiresHeight: meta?.hires?.height ?? null,
      status: "done",
      output: name,
      createdAt,
      fromFile: true,
    });
  }
  records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return records;
}
