import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const info = JSON.parse(fs.readFileSync(path.join(home, "server-info.json"), "utf8"));
const base = `http://127.0.0.1:${info.network?.actualPort ?? info.port}/api/apps/hana-moss-studio/routes/hana-moss-studio`;
const headers = { authorization: `Bearer ${info.token}`, "content-type": "application/json" };
const post = (p, b) => fetch(base + p, { method: "POST", headers, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const get = (p) => fetch(base + p, { headers }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("文件全在，测全量校验要多久");
await post("/install/weights", { variant: "base" });
const t0 = Date.now();
for (let i = 0; i < 400; i += 1) {
  await sleep(4000);
  const s = await get("/state");
  const it = s.install;
  if (!it) break;
  const tasks = it.tasks ?? [];
  const verifying = tasks.filter((t) => t.verifying);
  const done = tasks.filter((t) => t.status === "complete").length;
  console.log(
    `${((Date.now() - t0) / 1000).toFixed(0)}s`,
    it.phase,
    `${done}/${tasks.length}`,
    it.percent + "%",
    "| 校验中",
    verifying.length,
    verifying.length ? `(${verifying.map((t) => (t.verified / 1048576).toFixed(0)).join(",")} MB)` : "",
    it.error ? "| " + it.error.slice(0, 60) : "",
  );
  if (it.phase === "done" || it.phase === "error") {
    console.log("结束:", it.phase, "|", it.message, "| 耗时", ((Date.now() - t0) / 1000).toFixed(0) + "s");
    break;
  }
}
