import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const info = JSON.parse(fs.readFileSync(path.join(home, "server-info.json"), "utf8"));
const base = `http://127.0.0.1:${info.network?.actualPort ?? info.port}/api/apps/hana-moss-studio/routes/hana-moss-studio`;
const headers = { authorization: `Bearer ${info.token}` };
const get = (p) => fetch(base + p, { headers }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
for (let i = 0; i < 300; i += 1) {
  await sleep(5000);
  const s = await get("/state");
  const it = s.install;
  if (!it) break;
  const tasks = it.tasks ?? [];
  const active = tasks.filter((t) => t.status === "active");
  const desc = active
    .map((t) => `${path.basename(t.out)} ${(t.got / 1048576).toFixed(0)}/${(t.size / 1048576).toFixed(0)}MB${t.verifying ? " 校验中" : ""}`)
    .join(" | ");
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`, it.phase, (it.files ?? []).join("/"), it.percent + "%", "|", desc || "-");
  if (it.phase === "done" || it.phase === "error") {
    console.log("结束:", it.phase, "|", it.message, it.error ? "| " + it.error : "");
    break;
  }
}
