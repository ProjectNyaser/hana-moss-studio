# 苔室（moss-studio）

把 [MossStudio](https://github.com/CloverIris/MossStudio) 的推理链路接进 HanaAgent 的 App。苔室自己管理 `moss-server` 进程，不依赖 Electron 外壳，也不用手抄 token。

## 结构

```
app/                 App 本体，打包后就是安装包内容
  manifest.json      v2 manifest（整页卡片 + 功能面板 + 两个工具）
  index.js           路由、串行队列、宿主任务桥、工具注册
  lib/engine.js      moss-server 生命周期与 JSON-lines 协议
  lib/store.js       设置与任务台账
  lib/upstream.js    生成物，来自 scripts/sync-upstream.mjs
  ui/                工作区页面 studio.html / 流内进度卡 task.html / 功能面板 panel.html
    assets/          hana-theme.css（主题 token 与公共控件）、各页脚本、宿主桥 sdk.js
scripts/
  sync-upstream.mjs  从 submodule 抽取上游契约
  package.mjs        产出 build/<appId>/
vendor/MossStudio    git submodule，上游源仓
```

## 三个界面

| 界面 | 位置 | 数据 |
| --- | --- | --- |
| 工作区 `studio.html` | 整页卡（常驻全站导航） | `GET /moss-studio/state`，1.5 s 轮询 |
| 流内进度卡 `task.html` | 工具提交后挂在对话里 | `GET /moss-studio/task?cardId=`，1.2 s 轮询，终态后放慢 |
| 功能面板 `panel.html` | 左侧栏，跟工作区走 | `GET /moss-studio/panel`，2 s 轮询 |

版式沿用上游 MossStudio 的 `studio-workbench`（左「生成设置」、中间画布、右「运行信息」、底部进度带），配色改成宿主主题：`hana-theme.css` 把 `--hana-*` → 旧主题名 → 本地兜底三级映射成页面语义 token，宿主换主题、切明暗都跟着走。

流内进度卡靠工具回执里的 `details.card` 落地（卡页 route 静态，身份经宿主 surface 上下文的 `cardInstanceId` 反查到任务），同时按 `app/tasks.manage` + `app/session.start-turn` 建宿主任务：任务完成时结果自动投递回会话。这两个能力缺失时自动降级成「只跟踪、不投递」，回执里会写清楚。


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

App 需要四条能力：`app/tools.expose-to-model`（模型可调 `moss_generate` / `moss_status`）、`app/process.spawn`（能拉起 `moss-server` 外部进程）、`app/tasks.manage` 与 `app/session.start-turn`（宿主任务与结果投递）。

## 引擎

引擎包来自 `xycld/owoinfer` 的 GitHub Release，命名形如 `mossinfer-<version>-<os>-<cuda>-<arch>[-sm75][-system-cuda]`。

两种包的分界在 cuBLASLt：

- `-system-cuda` 包只有二十几 MB，要求系统里已有 CUDA 13 的 `cublasLt64_13.dll`（≥ 13.6.0）。系统只有 CUDA 11.8 的机器会启动失败，`hello` 的 `probe.cublaslt.error` 会说明缺哪个文件。
- 不带后缀的完整包自带 CUDA 库，体积大但开箱能跑。

解压后指向 `bin/moss-server.exe`。

## 模型

跑起来需要四个组件：DiT、文本编码器、VAE、pipeline，合计约 27 GB，来自 Hugging Face。页面里的「要下什么」按上游目录给出当前推荐组合与体积。

拉权重用仓库自带的脚本，它按文件清单走 curl 分段续传：

```powershell
pwsh -File scripts/fetch-weights.ps1 -Root H:\.hanako\app-data\moss-studio\models\moss-image-sft
```

不走 `huggingface_hub` 的原因是它在部分网络下会走 Xet 的 CAS 通道，连接建起来但读不动，反复 `The read operation timed out`。同一个镜像用 curl 单连接能到 8–11 MB/s。脚本按大小校验完整性，中断重跑会接着下。

`moss-server` 的 `load` 参数取 diffusers 目录根（含 `transformer/`、`text_encoder/`、`vae/`、`model_index.json`）。

## 验证

绕开 App 与 UI，直接对引擎跑完整链路：

```powershell
node scripts/smoke-generate.mjs --engine <moss-server.exe> --model <diffusers 目录> --out out.png
```

它会打印 hello 里的设备与 cuBLASLt 状态、load 耗时、逐阶段进度、`timings_s` 与最终文件位置。UI 出问题时先用它分辨「引擎坏了」还是「界面坏了」。

## 已知边界

- 只用协议 2。上游升到 3 之前必须在 `lib/engine.js` 里复核。
- 一次只跑一个任务。单卡小显存下并发只会互相拖慢。
- 权重下载器尚未实现，当前需要手工准备模型目录。
