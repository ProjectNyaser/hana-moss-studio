// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/unzip.js — 解 zip。
 *
 * 早先调 `tar -xf`（Windows 自带的 bsdtar）。那是外部进程：要赌系统里有它、
 * 要处理退出码、还多一层进程边界。引擎包三百多兆，解压不该依赖一个随时可能
 * 被精简掉的系统工具。
 *
 * 现在走 yauzl：纯 JS、流式、逐条读 entry，内存占用与包大小无关。
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { promisify } from "node:util";

import yauzl from "yauzl";

const openZip = promisify(yauzl.open);

/**
 * 把 zip 解到指定目录。
 *
 * 拒绝越界路径：压缩包里的成员名可以写成 `../../x`，直接 join 会把文件写到目标
 * 目录之外（zip slip）。这里解出绝对路径后确认它仍在 destDir 里。
 *
 * @returns {Promise<number>} 写出的文件数
 */
export async function unzipTo(zipPath, destDir, { onProgress } = {}) {
  const zipfile = await openZip(zipPath, { lazyEntries: true, autoClose: true });
  const root = normalize(destDir).replace(/[\\/]+$/, "") + sep;
  let files = 0;

  await new Promise((resolve, reject) => {
    // 出错时先把 zipfile 关掉：lazyEntries 模式下不再 readEntry，autoClose 不会触发，
    // 句柄就留着了。
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      try {
        zipfile.close();
      } catch {
        /* 已经关了 */
      }
      reject(error);
    };

    zipfile.on("error", fail);
    zipfile.on("end", resolve);
    zipfile.on("entry", (entry) => {
      if (failed) return;
      const target = normalize(join(destDir, entry.fileName));
      if (!target.startsWith(root)) {
        fail(new Error(`压缩包里有越界路径：${entry.fileName}`));
        return;
      }
      if (entry.fileName.endsWith("/")) {
        mkdirSync(target, { recursive: true });
        zipfile.readEntry();
        return;
      }
      mkdirSync(dirname(target), { recursive: true });
      zipfile.openReadStream(entry, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        const out = createWriteStream(target);
        stream.on("error", fail);
        out.on("error", fail);
        out.on("close", () => {
          files += 1;
          onProgress?.(files, entry.fileName);
          if (!failed) zipfile.readEntry();
        });
        stream.pipe(out);
      });
    });
    zipfile.readEntry();
  });

  return files;
}
