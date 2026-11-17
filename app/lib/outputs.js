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

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
/** 从 IHDR 读像素尺寸：没写参数的图也至少知道自己是多大。 */
function readPngSize(file) {
  let handle;
  try {
    handle = openSync(file, "r");
    const head = Buffer.alloc(24);
    if (readSync(handle, head, 0, 24, 0) < 24) return null;
    if (head.toString("hex", 0, 8) !== PNG_SIGNATURE) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

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
          } else if (chunk?.keyword === "moss-studio") {
            // 苔室自己写的：底图、蒙版、参考图与父任务。
            try {
              text.studio = JSON.parse(chunk.text);
            } catch {
              /* 坏了就当没有 */
            }
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

/** 苔室自己写的元数据：只留认得的字段，坏了就当没有。 */
function normalizeOrigin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const conv = typeof raw.conv === "string" ? raw.conv : null;
  const base = typeof raw.base === "string" ? raw.base : null;
  const mask = typeof raw.mask === "string" ? raw.mask : null;
  const parent = typeof raw.parent === "string" ? raw.parent : null;
  const refs = Array.isArray(raw.refs) ? raw.refs.filter((item) => typeof item === "string") : [];
  if (!conv && !base && !parent && !refs.length && !mask) return null;
  return { conv, base, mask, parent, refs };
}

/** CRC32 查表，PNG 块尾巴要用。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 往生成的 PNG 里补一个 tEXt 块。
 *
 * 引擎只管它自己的 generation 块；底图、蒙版、参考图属于请求侧输入，得由这里记下来，
 * 否则重启之后这些关系就只剩内存里的那点残留。写不进去不影响出图本身。
 */
export function writePngMeta(file, keyword, value) {
  try {
    const data = readFileSync(file);
    if (data.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) return false;
    // 用 iTXt：中文提示词走 Latin-1 的 tEXt 会坏，UTF-8 才行。
    const body = Buffer.concat([
      Buffer.from(`${keyword}\u0000`, "latin1"),
      Buffer.from([0, 0]),
      Buffer.from("\u0000\u0000", "latin1"),
      Buffer.from(value, "utf8"),
    ]);
    const chunk = Buffer.alloc(12 + body.length);
    chunk.writeUInt32BE(body.length, 0);
    chunk.write("iTXt", 4, "ascii");
    body.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);

    // 同名块先拆掉再插，重复写不会让文件越长越大。
    const parts = [data.subarray(0, 8)];
    let offset = 8;
    let inserted = false;
    while (offset + 8 <= data.length) {
      const size = data.readUInt32BE(offset);
      const type = data.toString("ascii", offset + 4, offset + 8);
      const end = offset + 12 + size;
      if (end > data.length) break;
      const slice = data.subarray(offset, end);
      if (type === "IEND") {
        parts.push(chunk, slice);
        inserted = true;
        offset = end;
        break;
      }
      let drop = false;
      if ((type === "tEXt" || type === "iTXt") && size > 0) {
        const payload = data.subarray(offset + 8, offset + 8 + size);
        const text = type === "iTXt" ? parseITxt(payload) : parseTxt(payload);
        if (text?.keyword === keyword) drop = true;
      }
      if (!drop) parts.push(slice);
      offset = end;
    }
    if (!inserted) return false;
    if (offset < data.length) parts.push(data.subarray(offset));
    // 改元数据不该让这张图看起来是刚生成的：mtime 原样还回去，
    // 否则会话列表会按“刚刚”重新排序。
    const before = statSync(file);
    writeFileSync(file, Buffer.concat(parts));
    try {
      utimesSync(file, before.atime, before.mtime);
    } catch {
      /* 改不动时间不影响图本身 */
    }
    cache.delete(file);
    return true;
  } catch {
    return false;
  }
}

/** 只把苔室自己那一块读出来，改会话归组时要先合再写。 */
export function readStudioMeta(file) {
  const text = readPngText(file);
  if (!text) return null;
  const raw = text.studio ?? null;
  return raw && typeof raw === "object" ? raw : null;
}

/** 扫一遍目录，把每张图还原成一条记录。按生成时间倒序。
 *
 * 引擎写的 generation JSON 里没有高清修正字段（只有 width/height 是最终尺寸）。
 * 所以从盘上恢复的记录不带 hires 信息，不要在这里编一个 0 ��充「未开启」。 */
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
    let createdAt = meta?.created_at ?? null;
    if (!createdAt) {
      try {
        createdAt = statSync(file).mtime.toISOString();
      } catch {
        continue;
      }
    }
    const id = name.replace(/\.png$/i, "");
    // 布局提示的 prompt 是一段 JSON；画廊要的是 caption，不是一整块坐标。
    let prompt = meta?.prompt ?? text?.parameters?.split("\n")[0] ?? "";
    let layoutItems = 0;
    if (typeof prompt === "string" && prompt.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(prompt);
        if (parsed?.summary || Array.isArray(parsed?.items)) {
          layoutItems = Array.isArray(parsed.items) ? parsed.items.length : 0;
          prompt = String(parsed.summary?.caption ?? prompt).trim();
        }
      } catch {
        /* 不像 JSON 就原样留着 */
      }
    }
    const size = meta ? null : readPngSize(file);
    records.push({
      id,
      prompt,
      layoutItems,
      negativePrompt: meta?.negative_prompt ?? "",
      width: meta?.width ?? size?.width ?? null,
      height: meta?.height ?? size?.height ?? null,
      steps: meta?.steps ?? null,
      cfg: meta?.cfg ?? null,
      seed: meta?.seed ?? null,
      tier: meta?.engine?.tier ?? null,
      sampler: meta?.sampler ?? null,
      scheduler: meta?.scheduler ?? null,
      shift: meta?.shift ?? null,
      loras: Array.isArray(meta?.loras) ? meta.loras : [],
      status: "done",
      output: name,
      createdAt,
      fromFile: true,
      origin: normalizeOrigin(text?.studio),
    });
  }
  records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return records;
}
