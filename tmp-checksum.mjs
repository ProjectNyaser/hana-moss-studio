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

const vae = "H:/.hanako/app-data/hana-moss-studio/models/moss-image-base/vae/diffusion_pytorch_model.safetensors";
const mb = (p) => (fs.existsSync(p) ? (fs.statSync(p).size / 1048576).toFixed(1) + " MB" : "不存在");
console.log("开始前 VAE:", mb(vae));

await post("/install/weights", { variant: "base" });
const t0 = Date.now();
let prev = "";
for (let i = 0; i < 200; i += 1) {
  await sleep(2000);
  const s = await get("/state");
  const it = s.install;
  if (!it) break;
  const line = `${((Date.now() - t0) / 1000).toFixed(0)}s ${it.phase} ${(it.files ?? []).join("/")} ${(it.speed / 1048576).toFixed(1)}MB/s ${it.percent}%`;
  if (line.slice(0, 12) !== prev.slice(0, 12) || i % 5 === 0) console.log(line + (it.error ? " | " + it.error.slice(0, 70) : ""));
  prev = line;
  if (it.phase === "done" || it.phase === "error") {
    console.log("结束:", it.phase, "|", it.message, it.error ? "| " + it.error : "");
    break;
  }
}
console.log("结束后 VAE:", mb(vae));
const ledger = fs.existsSync(vae) && fs.existsSync(`${vae}.aria2`);
console.log("残留 .aria2:", ledger ? "有" : "无");
