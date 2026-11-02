import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

/** 出图文件是记录的真相源：PNG 自带生成参数，删除文件即删除记录。
 *
 *  引擎把元数据写在两张 iTXt 块里：
 *    generation  完整 JSON（prompt / steps / cfg / seed / 尺寸 / tier …）
 *    parameters  给 ComfyUI 那一套看的纯文本
 *  这里只读文件头，不把整个 PNG 载入内存。 */

const HEADER_BYTES = 128 * 1024;
const cache = new Map();

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
  let text = null;
  try {
    handle = openSync(file, "r");
    const length = Math.min(stat.size, HEADER_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, 0);
    if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
    text = {};
    let offset = 8;
    while (offset + 8 <= length) {
      const size = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      if (type === "IEND") break;
      if (type === "iTXt" || type === "tEXt" || type === "zTXt") {
        const body = buffer.subarray(offset + 8, offset + 8 + Math.min(size, length - offset - 8));
        const keyword = body.toString("utf8", 0, Math.min(body.length, 32)).split("\u0000")[0];
        const raw = body.toString("utf8");
        if (keyword === "generation") {
          const json = raw.slice(raw.indexOf("{"));
          try {
            text.generation = JSON.parse(json.replace(/\u0000+$/, ""));
          } catch {
            /* 元数据坏了就当没有 */
          }
        } else if (keyword === "parameters") {
          text.parameters = raw.slice(keyword.length).replace(/^[\u0000\s]+/, "");
        }
      }
      offset += 12 + size;
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
