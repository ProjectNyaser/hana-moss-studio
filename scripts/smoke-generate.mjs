// 绕开 App 与 UI，直接对 moss-server 跑一次完整链路：
// hello → load → generate → done。用来验证引擎、模型目录与显存档位是否真的能出图。
//
// 用法：
//   node scripts/smoke-generate.mjs --engine <moss-server.exe> --model <diffusers 目录> --out <out.png>
// 可选：--width --height --steps --cfg --seed --tier --mode --prompt

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    prompt: { type: "string", default: "苔石上的一盏白兰花，晨雾，柔光，浅景深" },
    width: { type: "string", default: "768" },
    height: { type: "string", default: "768" },
    steps: { type: "string", default: "8" },
    cfg: { type: "string", default: "3" },
    seed: { type: "string", default: "42" },
    tier: { type: "string", default: "turbo" },
    mode: { type: "string", default: "min_memory" },
  },
});

if (!values.engine || !values.model || !values.out) {
  console.error("需要 --engine、--model、--out");
  process.exit(2);
}
if (!existsSync(values.engine)) throw new Error(`引擎不存在：${values.engine}`);
if (!existsSync(values.model)) throw new Error(`模型目录不存在：${values.model}`);

const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

const child = spawn(values.engine, ["--parent-pid", String(process.pid)], {
  cwd: dirname(values.engine),
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
const lines = () => {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const out = [];
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      out.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    return out;
  };
};
const split = lines();
const splitErr = lines();

let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  try {
    child.kill();
  } catch {
    // 已经退出
  }
  process.exit(code);
};

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function call(id, method, params, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`${method} 超时 ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    send({ id, method, params });
  });
}

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const line of split(chunk)) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log(`stdout: ${line.trim()}`);
      continue;
    }
    if (message.event) {
      const event = message.event;
      if (event === "progress") {
        process.stdout.write(`\r[${((Date.now() - started) / 1000).toFixed(1)}s] ${message.phase} ${message.step}/${message.total_steps}  `);
      } else if (event === "log" || event === "plan") {
        log(`${event}: ${message.message ?? message.explanation ?? ""}`);
      } else if (event === "done") {
        process.stdout.write("\n");
        const status = message.status;
        if (status === "ok") {
          const timings = message.report?.timings_s ?? {};
          log(`出图完成 ${out}`);
          log(`耗时 ${JSON.stringify(timings)}`);
          log(`峰值质量档 ${JSON.stringify(message.report?.quality ?? null)}`);
          log(`总用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
          finish(0);
        } else {
          log(`生成失败 ${status}: ${JSON.stringify(message.error ?? null)}`);
          finish(1);
        }
      }
      continue;
    }
    const entry = pending.get(String(message.id));
    if (!entry) return;
    pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${message.error.code ?? "error"}: ${message.error.message ?? ""}`));
    else entry.resolve(message.result ?? {});
  }
});
child.stderr.on("data", (chunk) => {
  for (const line of splitErr(chunk)) {
    if (line.trim()) console.log(`  stderr: ${line.trim()}`);
  }
});
child.on("error", (error) => {
  console.error(`spawn 失败：${error.message}`);
  finish(2);
});
child.on("close", (code) => {
  if (!finished) {
    console.error(`引擎提前退出 code=${code}`);
    finish(1);
  }
});

log("hello");
const hello = await call("hello-1", "hello", { client: "smoke", protocol_version: 2, devices: true }, 45_000);
const device = (hello.probe?.devices ?? []).find((item) => item.supported);
log(`引擎 ${hello.version} protocol ${hello.protocol_version} / ${device?.name ?? "无可用设备"} / CC ${device?.compute_capability ?? "?"}`);
if (hello.probe?.cublaslt?.error) log(`cuBLASLt 警告：${hello.probe.cublaslt.error}`);
if (!device) {
  console.error("没有受支持的 GPU");
  finish(1);
}

log(`load（${values.mode} / ${values.tier}）`);
await call("load-1", "load", {
  model: resolve(values.model),
  mode: values.mode,
  device: device.index,
  tier: values.tier,
  cache_dir: resolve(dirname(out), "cache"),
}, 900_000);
log("模型已加载");

log("generate");
await call("job-smoke", "generate", {
  output: out,
  prompt: values.prompt,
  negative_prompt: "",
  width: Number(values.width),
  height: Number(values.height),
  steps: Number(values.steps),
  cfg: Number(values.cfg),
  seed: Number(values.seed),
  save_metadata: true,
  include_prompts: true,
}, 3_600_000);
