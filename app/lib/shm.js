// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/shm.js — moss-server 共享内存区的读写入口。
 *
 * 引擎的 component session 把张量放在 Windows 命名映射里，Node 没有 mmap，
 * 所以经 vendor-bin/shm-bridge.exe 按字节搬运。桥是长驻子进程，命令按到达顺序
 * 一一应答；本文件只做队列、超时与临时文件。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TIMEOUT_MS = 30_000;

export class ShmBridge {
  constructor({ exePath, tmpDir }) {
    this.exePath = exePath;
    this.tmpDir = tmpDir;
    this.child = null;
    this.buffer = "";
    this.queue = [];
    this.stderr = "";
  }

  start() {
    if (this.child) return;
    if (!existsSync(this.exePath)) throw new Error(`共享内存桥不存在：${this.exePath}（构建时生成，见 scripts/vendor/shm-bridge.mjs）`);
    mkdirSync(this.tmpDir, { recursive: true });
    const child = spawn(this.exePath, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const entry = this.queue.shift();
        if (!entry) continue;
        clearTimeout(entry.timer);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          entry.reject(new Error(`共享内存桥回了看不懂的一行：${line.slice(0, 120)}`));
          continue;
        }
        if (message.ok) entry.resolve(message);
        else entry.reject(new Error(message.error ?? "共享内存操作失败"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2000);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      this.failAll(new Error(`共享内存桥已退出${this.stderr ? `：${this.stderr.trim().split("\n").pop()}` : ""}`));
    });
  }

  failAll(error) {
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  command(line) {
    this.start();
    const child = this.child;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error(`共享内存桥超时：${line.split(" ")[0]}`));
      }, TIMEOUT_MS);
      this.queue.push(entry);
      child.stdin.write(`${line}\n`);
    });
  }

  /** 连上区域并读头部（magic / version / bytes / payload 偏移）。 */
  attach(name) {
    return this.command(`probe ${name}`);
  }

  async read(name, offset, length) {
    const file = join(this.tmpDir, "read.bin");
    await this.command(`read ${name} ${offset} ${length} "${file}"`);
    return readFileSync(file);
  }

  async write(name, offset, buffer) {
    const file = join(this.tmpDir, "write.bin");
    writeFileSync(file, buffer);
    await this.command(`write ${name} ${offset} "${file}"`);
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.failAll(new Error("共享内存桥已关闭"));
    try {
      child?.kill();
    } catch {
      /* 进程可能已经不在 */
    }
  }
}
