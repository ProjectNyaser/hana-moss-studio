# 苔室（hana-moss-studio）

把 [MossStudio](https://github.com/CloverIris/MossStudio) 的推理链路接进 HanaAgent 的 App：自带 CUDA 引擎进程、串行队列、提示词面板与画廊，工具出图在对话里挂实时进度卡。

苔室自己管理 `moss-server` 进程，不依赖 Electron 外壳，也不用手抄 token。

## 结构

```
app/                    App 本体，打包后就是安装包内容
  manifest.json         v2 manifest（整页卡片 + 功能面板 + 两个工具）
  index.js              路由、串行队列、宿主任务桥、工具注册
  lib/engine.js         moss-server 生命周期与 JSON-lines 协议
  lib/store.js          设置与任务台账
  lib/upstream.js       生成物，来自 scripts/sync-upstream.mjs
  assets/icon.png       应用图标（MOSS-Image 画的）
  skills/hana-moss-studio/
                        SKILL.md 与 references/，装了 App 就有这个技能
  sdk/                  @hana/app-sdk 的展开副本，派生物，不入库
  ui/                   工作区 studio.html / 流内进度卡 task.html / 功能面板 panel.html
    assets/             hana-theme.css（主题 token）、cover.png（卡面）、各页脚本；
                        sdk.js 与 app-ui.* 也是派生物
scripts/
  vendor/sdk.mjs        从本机宿主同步 vendor/hana-app-sdk 的快照
  derive.mjs            从依赖树展开 app/sdk、ui 侧副本与 manifest#minAppVersion
  sync-upstream.mjs     从 submodule 抽取上游契约
  package.mjs           产出 build/<appId>/
  pack.mjs              出安装包与市场投稿条目
  fetch-weights.ps1     按清单续传拉权重
  smoke-generate.mjs    绕开 UI 直跑引擎
vendor/MossStudio       git submodule，上游源仓
vendor/hana-app-sdk     App SDK 快照（tgz + source-manifest.json），见该目录的 README
```

## 三个界面

| 界面 | 位置 | 数据 |
| --- | --- | --- |
| 工作区 `studio.html` | 整页卡（常驻全站导航） | 订阅 `GET /hana-moss-studio/events`（SSE），断流后退化轮询 |
| 流内进度卡 `task.html` | 工具提交后挂在对话里 | 订阅同一条事件流，只在自己这张卡状态变化时取一次 `/task` |
| 功能面板 `panel.html` | 左侧栏，跟工作区走 | 同一事件流的第二个客户端 |

三个页面共用一条 SSE 通道：连上先给一帧快照，之后只在状态真变时推（进度合并到 180 ms 一次），心跳 15 秒。`/state` 只作为首帧与兜底。

界面配色不做自有色板，全部走宿主注入到 `:root` 的 `--bg` / `--bg-card` / `--sidebar-bg` / `--text*` / `--border` / `--accent*` / `--green` / `--danger` / `--overlay-*`，`--fb-*` 只在非宿主预览里兜底。宿主把主题当成一份 CSS 通过 URL 参数交给页面（`hana-css` / `hana-theme-appearance`），所以 `theme-boot.js` 在 `<head>` 里同步把它插进来。

流内进度卡靠工具回执里的 `details.card` 落地（卡页路由静态，身份经宿主 surface 上下文的 `cardInstanceId` 反查），同时按 `app/tasks.manage` + `app/session.start-turn` 建宿主任务：完成后结果自动投递回会话。缺这两条能力时降级成「只跟踪、不投递」，回执里写明。

## 上游当成 submodule 用

`vendor/MossStudio` 是 upstream 的 git submodule，用来吃它的更新。苔室真正依赖上游的只有三样：`release/models.json` 的模型目录、`mossInfer.ts` 里的协议版本、`mossInferDownload.ts` 里的引擎仓。

```bash
git submodule update --remote vendor/MossStudio
node scripts/sync-upstream.mjs
```

同步脚本把这三样抽到 `app/lib/upstream.js`，并与上次快照对比，打印上游提交变化、协议版本变化、模型增删。协议版本一旦变了必须回去复核 `lib/engine.js`（事件名与参数形状都在那里）。

## SDK 与派生

苔室服务端只用 `defineApp` 一个入口（`@hana/app-sdk/server`），浏览器侧只用 `ui` 那份 bundle。App 装上去是自包含的，宿主不替它解析 `node_modules`，所以 SDK 必须以 App 自己的文件形态躺在包里。但那份副本不签入仓库：它是 `vendor/hana-app-sdk` 里 tgz 的派生，入库等于把「哪来的、哪个版本」全丢掉。

```bash
pnpm install          # 把 vendor 里的 tgz 展到 node_modules
pnpm run derive       # 展开 app/sdk 与 ui 侧副本，写 manifest#minAppVersion
pnpm run check        # 只校验派生文件跟不跟得上，有漂移 exit 1
```

宿主升级后换快照：

```bash
pnpm run sync:sdk                      # 从 <HANA_HOME> 的 hana-app-creator 资产同步 tgz
pnpm update @hana/app-sdk && pnpm install
pnpm run build                         # 先跑一遍界面：ui bundle 和 minAppVersion 都会跟着抬
```

`app/sdk/` 与 `app/ui/assets/` 里的 `sdk.js` / `app-ui.*` 都是派生物，手改下次 derive 就盖掉；要改就改在上游。

## 打包与发版

```bash
pnpm run pack
```

产出三样：

```
build/<id>/                                 安装目录（本地安装用）
dist-extensions/<id>-v<version>.zip         安装包
dist-extensions/app-<id>-<version>.entry.json   市场投稿条目
```

包内容由这个 App 需要什么决定，不走官方通用打包器：它按自己的目录约定收文件，失败信息也是通用的。ZIP 内时间戳与权限固定，同输入连打两次 SHA256 相同。

条目是对 ZIP 的派生：字节数与 `sha256` 都对包现算，不经中间小票，所以不存在「小票与包对不上」这条失败路径。`archive.url` 保留 `{{BASE_URL}}/` 占位符是协议要求，市场同步器按这个前缀取出资产名。

推 tag 后 `.github/workflows/release.yml` 会出包、校验 tag 与 manifest 版本一致、建**正式** Release（市场不接受 draft 与 prerelease）并把 ZIP 与 entry.json 一起挂上去，发完再回头核对。

投稿时在市场的 `registry.json` 追加 `{kind, id, repository, publisher}`，在 `approvals.json` 追加 `{kind, id, tag, sha256, readme}`。`sha256` 抄 entry.json 里的值，不要自行计算。

## 引擎

引擎包来自 `xycld/owoinfer` 的 GitHub Release，命名形如 `mossinfer-<version>-<os>-<cuda>-<arch>[-sm75][-system-cuda]`。

两种包的分界在 cuBLASLt：

- `-system-cuda` 包只有二十几 MB，要求系统里已有 CUDA 13 的 `cublasLt64_13.dll`（≥ 13.6.0）。只有 CUDA 11.8 的机器会启动失败，`hello` 的 `probe.cublaslt.error` 会说明缺哪个文件。
- 不带后缀的完整包自带 CUDA 库，体积大但开箱能跑。

解压后指向 `bin/moss-server.exe`。

引擎接受 `vram_reserve_bytes`（CLI 上是 `--vram-reserve MiB`），但苔室目前不传，用引擎自己的默认规划。

## 模型

跑起来需要四个组件：DiT、文本编码器、VAE、pipeline，合计约 27 GB。

```powershell
pwsh -File scripts/fetch-weights.ps1 -Root H:\.hanako\app-data\hana-moss-studio\models\moss-image-sft
```

不走 `huggingface_hub` 是因为它在部分网络下会走 Xet 的 CAS 通道，连接建起来但读不动，反复 `The read operation timed out`。同一个镜像用 curl 单连接能到 8–11 MB/s。脚本按大小校验完整性，中断重跑会接着下。

`moss-server` 的 `load` 参数取 diffusers 目录根（含 `transformer/`、`text_encoder/`、`vae/`、`model_index.json`）。

**模型放 NVMe 上**。文本编码器 15.6 GB，SATA 上读一次 30.9 秒，NVMe 上 6 秒，这是这台机器收益最大的一次优化。

## 验证

绕开 App 与 UI，直接对引擎跑完整链路：

```powershell
node scripts/smoke-generate.mjs --engine <moss-server.exe> --model <diffusers 目录> --out out.png
```

它打印 hello 里的设备与 cuBLASLt 状态、load 耗时、逐阶段进度、`timings_s` 与最终文件位置。UI 出问题时先用它分辨「引擎坏了」还是「界面坏了」。

## 已知边界

- 单张上限 4.2 百万像素、单边 4096。4K 出不了，要更大的图只能走 `hiresScale`，而修正目标同样受这条限制。
- 只吃 MOSS-Image 那套目录结构，不吃单文件 checkpoint，不吃 LoRA。
- 一次只跑一个任务。单卡小显存下并发只会互相拖慢。
- 6 GB 卡上 `balanced` 策略在 1024² 及以上会 arena overflow，大图必须切 `min_memory`。
