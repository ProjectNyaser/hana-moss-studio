# 苔室（hana-moss-studio）

把 [MossInfer](https://github.com/mossimage-cpp/mossimage.cpp) 的本机推理引擎接进 HanaAgent 的 App：自带 CUDA 引擎进程、串行队列、提示词面板与画廊，工具出图在对话里挂实时进度卡。苔室自己管理 `moss-server` 进程，不依赖 Electron 外壳，也不用手抄 token。

苔室自己管理 `moss-server` 进程，不依赖 Electron 外壳，也不用手抄 token。

## 结构

```
app/                    App 本体，打包后就是安装包内容
  manifest.json         v2 manifest（整页卡片 + 功能面板 + 两个工具）
  index.js              路由、串行队列、宿主任务桥、工具注册
  lib/engine.js         moss-server 生命周期与 JSON-lines 协议
  lib/installer.js      引擎与权重的下载安装（面板上的两个按钮）
  lib/store.js          设置与任务台账
  lib/mossimage.js      引擎版本、协议号与模型组件清单（手写常量，不派生）
  vendor-bin/           aria2c.exe，构建时按 vendor/aria2-bin.json 取，不入库
  assets/icon.png       应用图标（MOSS-Image 画的）
  skills/hana-moss-studio/
                        SKILL.md 与 references/，装了 App 就有这个技能
  sdk/                  @hana/app-sdk 的展开副本，派生物，不入库
  ui/                   工作区 studio.html / 流内进度卡 task.html / 功能面板 panel.html
    assets/             hana-theme.css（主题 token）、cover.png（卡面）、各页脚本；
                        sdk.js 与 app-ui.* 也是派生物
scripts/
  vendor/sdk.mjs        从本机宿主同步 vendor/hana-app-sdk 的快照
  vendor/aria2.mjs      按 vendor/aria2-bin.json 把 aria2c.exe 取进 app/vendor-bin/
  derive.mjs            从依赖树展开 app/sdk、ui 侧副本与 manifest#minAppVersion
  package.mjs           产出 build/<appId>/
  pack.mjs              出安装包与市场投稿条目
  fetch-weights.mjs     按清单拉权重（aria2c 优先，缺了就 Node fetch）
  smoke-generate.mjs    绕开 UI 直跑引擎
vendor/mossimage.cpp    引擎源与权威文档（git submodule，shallow）
vendor/aria2            下载器源（git submodule，shallow，GPLv2）
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

## 只依赖引擎，不依赖任何客户端项目

苔室直接对 `moss-server` 说话（stdio JSON-lines），中间没有别的项目。仓库里挂两份源码快照，都是 shallow：

| submodule | 用途 |
| --- | --- |
| `vendor/mossimage.cpp` | 引擎本体。`docs/server-protocol.md` 是协议的权威原文，`docs/integration.md` 是支持矩阵与集成面。二进制从它的 Release 取，不在这里编译 |
| `vendor/aria2` | 下载器。GPLv2，源码在手即满足对应源码可得性；运行时用官方 Windows 预编译 |

[MossStudio](https://github.com/CloverIris/MossStudio) 是同一引擎的另一个客户端（Electron 壳），只能当参考读，苔室不继承它的代码也不跟它的版本。

```bash
git submodule update --init --depth 1
```

引擎版本、协议号与模型组件清单写在 `app/lib/mossimage.js`，手写常量，不派生。改引擎版本时两件事一起做：动这个文件，动 `vendor/mossimage.cpp` 的指针。

协议号变了必须回去复核 `lib/engine.js`：请求名、参数形状与事件类型都在那里，`hello` 返回的 `protocol_version` 对不上会直接拒。

## 生成参数面

侧栏的「采样」与「LoRA」两段对应引擎协议里的可调项，工具面同名：

| 参数 | 缺省 | 说明 |
|---|---|---|
| `sampler` | `euler` | 九个采样器（`ab2` / `dpmpp_2m` / `res_multistep` 等），换的是数值积分器 |
| `scheduler` | `moss` | 七个调度器；`moss` + `euler` 是官方组合，逐位一致 |
| `shift` | `5` | 噪声偏移，越大越偏整体结构 |
| `stepCache` | `off` | `fbcache` 跳过快稳定的 DiT 块，lossy，能明显加快 |
| `stepCacheThreshold` | 模型默认 | 加速阈值 (0,1]，SFT 上默认 0.03 |
| `cfgTruncation` | `1`（关） | 只在前段跑负向分支，lossy |
| `loras` | 空 | `[{path, strength}]`，按序叠加，最多 64 个 |
| `loraPlacement` | `default` | `merge` 会把 LoRA 合进权重（换 LoRA 要重载） |
| `mask` | — | 局部重绘蒙版，和 `initImage` 同尺寸的灰度图 |
| `controlAdapter` / `controlKind` | 空 | 控制适配器（需带 `video_embedder` 的完整文件）+ 图类型 |
| `referenceImages` | 空 | 编辑适配器的参考图，最多 4 张，第一张是源图 |

侧栏的「参考图」除了图生图与蒙版，还承接编辑参考图：工作区里右键一张图选「用这张做编辑参考」，它就会作为 `references` 的第一张送进下一次生成（需要 LoRA 列表里有编辑适配器）。控制适配器目前只在工具面开放。

侧栏里 LoRA 是「库」：导入的 safetensors 落在 `app-data/hana-moss-studio/loras/`，勾选与强度跟着设置存下来。参考图在浏览器里按目标尺寸裁好（crop / fit / stretch）再上传，蒙版就在这张裁好的图上画，所以引擎拿到的 `init_image` 与蒙版天然同尺寸。

工具面另有三件：`moss_estimate`（空跑 `check`，给「能不能跑、要多久」）、`moss_inspect`（问引擎一个文件是什么）、`moss_engine`（start / stop / release，`release` 把显存还回去但留住引擎）。

## 装引擎与权重

用户不需要命令行。左侧面板「引擎与模型」里两个按钮：

- **装引擎**：读 `nvidia-smi` 拿驱动与算力 → 定 cuda 版本与 sm75 → 在 Release 里挑 bundled 包 → aria2c 下载（不通就换 curl）→ 对 `SHA256SUMS` 校 sha256 → `tar` 解压 → 把 `bin\moss-server.exe` 写进设置。
- **下权重**：列 HF 镜像的文件树 → 过滤出六个部分 → 已完整的跳过 → aria2c 批量下 → 逐个对大小。已有可用模型时直接装在原处，不另开一份 25 GiB 的副本。
- **用本地包**：网络不行时 `POST .../install/engine` 带 `{"zipPath": "..."}`，跳过下载，只校验与解压。

两个都能中途取消。进度不解析 aria2 输出（那是无换行的动态行），而是定期扫目标目录的体积。

命令行版本（装到自定义目录、补 cuBLASLt）在 `app/skills/hana-moss-studio/references/platform.md`。

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

引擎包来自 `mossimage-cpp/mossimage.cpp` 的 GitHub Release（原 `xycld/owoinfer`），命名形如 `mossinfer-<version>-<os>-<cuda>-<arch>[-sm75][-system-cuda]`。苔室只取 `windows` 包。

两种包的分界在 cuBLASLt：

- `-system-cuda` 包只有二十几 MB，要求系统里已有 CUDA 13 的 `cublasLt64_13.dll`（≥ 13.6.0）。只有 CUDA 11.8 的机器会启动失败，`hello` 的 `probe.cublaslt.error` 会说明缺哪个文件。
- 不带后缀的完整包自带 CUDA 库，体积大但开箱能跑。

解压后指向 `bin\moss-server.exe`。

引擎接受 `vram_reserve_bytes`（CLI 上是 `--vram-reserve MiB`），但苔室目前不传，用引擎自己的默认规划。

## 模型

跑起来需要四个组件：DiT、文本编码器、VAE、pipeline，合计约 27 GB。

```bash
node scripts/fetch-weights.mjs
```

默认落到 `<HANA_HOME>/app-data/hana-moss-studio/models/moss-image-sft`，`--root` 改目录，`--endpoint` 换镜像。

下载器优先用 aria2c（`--aria2 <path>` > `<app-data>/tools/aria2c.exe` > PATH），多连接 + 自带重连；都没有就走 Node fetch 单连接，慢但能跑。`--bootstrap-aria2` 会从官方 Release 取一份 2.4 MB 的包放到 `tools/`。已完整的文件跳过，中断重跑接着下。

不走 `huggingface_hub` 是因为它在部分网络下会走 Xet 的 CAS 通道，连接建起来但读不动，反复 `The read operation timed out`。

`moss-server` 的 `load` 参数取 diffusers 目录根（含 `transformer/`、`text_encoder/`、`vae/`、`model_index.json`）。

**模型放 NVMe 上**。文本编码器 15.6 GB，SATA 上读一次 30.9 秒，NVMe 上 6 秒，这是这台机器收益最大的一次优化。

## 验证

绕开 App 与 UI，直接对引擎跑完整链路：

```powershell
node scripts/smoke-generate.mjs --engine <moss-server 路径> --model <diffusers 目录> --out out.png
```

它打印 hello 里的设备与 cuBLASLt 状态、load 耗时、逐阶段进度、`timings_s` 与最终文件位置。UI 出问题时先用它分辨「引擎坏了」还是「界面坏了」。

## 已知边界

- **只支持 Windows x64**。引擎上游也有 Linux x64 资产，但苔室只在这个平台验证过；macOS 没有任何引擎构建。非 Windows 平台上启动引擎会直接报平台不支持。
- 单张上限 4.2 百万像素、单边 4096。4K 出不了；`hiresScale` 受同一个上限，只做两段式细化，不能把图做大。
- 只吃 MOSS-Image 那套目录结构，不吃单文件 checkpoint。单文件 DiT / 文本编码器在协议里有（`dit_file` / `text_encoder_file`），苔室还没接。
- 控制适配器只认带 `video_embedder` 的完整文件：HuggingFace 上 `thedeoxen/MOSS-Image-*-controlnet` 那批只有 LoRA，`moss_inspect` 会判成 `lora`，当 `control` 用会被引擎拒。
- 加速器（`step_cache` / `cfg_truncation`）与 LoRA 合并都是 lossy 的：开了之后与同一随机种子的未加速结果不是同一张图。
- 一次只跑一个任务。单卡小显存下并发只会互相拖慢。
- 6 GB 卡上 `balanced` 策略在 1024² 及以上会 arena overflow，大图必须切 `min_memory`。
