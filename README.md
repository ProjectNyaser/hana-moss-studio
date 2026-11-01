# 苔室（moss-studio）

把 [MossStudio](https://github.com/CloverIris/MossStudio) 的推理链路接进 HanaAgent 的 App。苔室自己管理 `moss-server` 进程，不依赖 Electron 外壳，也不用手抄 token。

## 结构

```
app/                 App 本体，打包后就是安装包内容
  manifest.json      v2 manifest（整页卡片 + 两个工具）
  index.js           路由、串行队列、工具注册
  lib/engine.js      moss-server 生命周期与 JSON-lines 协议
  lib/store.js       设置与任务台账
  lib/upstream.js    生成物，来自 scripts/sync-upstream.mjs
  ui/                工作区页面
scripts/
  sync-upstream.mjs  从 submodule 抽取上游契约
  package.mjs        产出 build/<appId>/
vendor/MossStudio    git submodule，上游源仓
```

## 上游当成 submodule 用

`vendor/MossStudio` 是 upstream 的 git submodule，用来吃它的更新。苔室真正依赖上游的只有三样东西：`release/models.json` 的模型目录、`mossInfer.ts` 里的协议版本、`mossInferDownload.ts` 里的引擎仓。

拉取上游更新：

```bash
git submodule update --remote vendor/MossStudio
node scripts/sync-upstream.mjs
```

同步脚本会把这三样抽到 `app/lib/upstream.js`，并和上一次的快照对比，打印上游提交变化、协议版本变化、模型增删。协议版本一旦变了就必须回去复核 `lib/engine.js`（事件名与参数形状都在那里）。

`build/` 不进版本库，安装包里也不含 `vendor/`。

## 打包与安装

```bash
node scripts/package.mjs
```

产出 `build/moss-studio/`，用 App Manager 从本地目录安装。

App 需要两条能力：`app/tools.expose-to-model`（模型可调 `moss_generate` / `moss_status`）与 `app/process.spawn`（能拉起 `moss-server` 外部进程）。

## 引擎

引擎包来自 `xycld/owoinfer` 的 GitHub Release，命名形如 `mossinfer-<version>-<os>-<cuda>-<arch>[-sm75][-system-cuda]`。

两种包的分界在 cuBLASLt：

- `-system-cuda` 包只有二十几 MB，要求系统里已有 CUDA 13 的 `cublasLt64_13.dll`（≥ 13.6.0）。系统只有 CUDA 11.8 的机器会启动失败，`hello` 的 `probe.cublaslt.error` 会说明缺哪个文件。
- 不带后缀的完整包自带 CUDA 库，体积大但开箱能跑。

解压后指向 `bin/moss-server.exe`。

## 模型

跑起来需要四个组件：DiT、文本编码器、VAE、pipeline，合计约 27 GB，来自 Hugging Face。页面里的「要下什么」按上游目录给出当前推荐组合与体积。

`moss-server` 的 `load` 参数取 diffusers 目录根（含 `transformer/`、`text_encoder/`、`vae/`、`model_index.json`）。

## 已知边界

- 只用协议 2。上游升到 3 之前必须在 `lib/engine.js` 里复核。
- 一次只跑一个任务。单卡小显存下并发只会互相拖慢。
- 权重下载器尚未实现，当前需要手工准备模型目录。
