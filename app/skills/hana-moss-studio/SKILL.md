---
name: hana-moss-studio
description: 苔室（Hana-Moss-Studio，v2 App）——MOSS-Image 的本机出图工作台：自带 CUDA 引擎进程、串行队列、提示词面板与画廊，工具出图在对话里挂实时进度卡。触发场景：用苔室出图、用 MOSS-Image 生图、查看苔室引擎状态、取回生成的图片、启停引擎、图生图、高清修正、放大图片、显存不足、arena overflow、模型未加载、引擎路径没配、工作区打不开、面板读不出数据、苔室进度卡不刷新、给这台机器部署苔室引擎、装 moss-server、下载 mossinfer 包、Linux 上装引擎、chmod 执行位、缺 libcublasLt、cuBLASLt 找不到、驱动版本不够装不了、换显卡重新部署、拉 MOSS-Image 权重。不触发：用 ComfyUI 出图（那是 comfyui-hana）、用云端模型生图（那是 media_generate-image）、只要一张图且不关心本机模型（同样走 media_generate-image）。
---

# 苔室（Hana-Moss-Studio）

把本机 **MOSS-Image** 引擎接进 Hana 的出图工作台。一个模型、一条干净流水线：它不加载 SDXL / Flux / Qwen-Image 那些单文件 checkpoint，**只认 MOSS-Image 那套目录结构**（`transformer / text_encoder / vae / model_index.json`）。想要一个吃所有模型的界面，走 comfyui-hana。

## 快速上手

先看状态，再出图。两件事都别跳过：

```
moss_status()
moss_generate(prompt="...", width=1024, height=1024, steps=16)
```

`moss_generate` **提交即返回**，不阻塞到出图。回合纪律：提交完不要原地等，下面的进度卡会自己刷新，出图后宿主把结果投递回会话。需要当场拿到文件时才轮询。

首次使用若引擎或模型路径未配，`moss_status` 会写明「未配置」。这时先照 `references/platform.md` 把这台机器的引擎与权重装好、把两个路径写回设置；用户已经有引擎时只问路径，不要猜。

## 环境部署

苔室不打包引擎，装哪个包完全由这台机器决定（平台 × 驱动 × 算力）。先判定再动手，不要把 Windows 的经验往别的平台上套。

- **macOS 没有引擎构建**，直接停，不要试翻译或交叉编译。
- 驱动主版本 < 580 只能装 `cu12`；算力 7.5 只有 Windows + cu13 的 `sm75` 包。
- Linux 解压后**必须** `chmod 755`，否则 spawn 直接 `EACCES`。
- 优先 `bundled` 包；`system-cuda` 要自己补 cuBLASLt。
- 权重约 27 GB，放 NVMe。

完整判定树、每步命令、失败对照都在 `references/platform.md`。部署完写回 `settings.json` 并重载 App，用 `moss_status()` 验收，不要拿 1024² 试。

## 工具面

### `moss_generate`

| 参数 | 说明 |
|---|---|
| `prompt` | 正向提示词，必填。中文可用，越具体越好 |
| `negativePrompt` | 反向提示词 |
| `width` / `height` | 缺省取苔室设置。总像素与单边都受引擎硬限（见下） |
| `steps` | 采样步数。缺省取设置值 |
| `cfg` | 缺省 3。MOSS-Image 对高 CFG 敏感，3～4 之间是常态 |
| `seed` | 缺省随机。回执里会给实际用的种子，想复现就拿它 |
| `hiresScale` | 高清修正倍数。`0` 关闭（缺省），`2` 表示先出基础图再放大 2 倍精修 |
| `hiresSteps` | 修正步数，缺省跟主采样一致 |
| `hiresStrength` | 修正重绘强度，缺省 0.45。越小越贴近原图，太大等于重画 |
| `initImage` | 图生图的参考图**绝对路径**（png/jpg）。给了它就按这张图的构图与配色重画 |
| `strength` | 图生图重绘强度 0.05~1，缺省 0.6。0.8 左右会重画背景又保住配色布局 |
| `resize` | 参考图适配：`crop`（居中等比裁，缺省）/ `fit`（留边）/ `stretch`（拉伸） |

### `moss_status`

返回引擎是否在跑、模型是否加载、设备与显存、当前任务阶段与步进、队列长度、最近五条任务结局。调参前、出图失败后、怀疑引擎卡住时都该先看它。

## 三条硬边界

1. **单张上限 4.2 百万像素、单边 4096**。4K（3840×2160 = 8.3MP）**出不了**，引擎直接以 `invalid_params` 拒绝。要更大的图只能走 `hiresScale`，而修正目标同样受这条限制。
2. **`hires` 与基础图共用这条上限**，所以 2048×2048 已经贴着天花板。
3. **MOSS-Image 不是蒸馏模型**，步数太少会明显发糊。8 步是「能看」的底线，16～24 步是常用区间。步数成本很低：每多一步只多约 1 秒级的固定增量，而文本编码每次都要几十秒。

## 分辨率与时间

**决定等待时间的是像素量，不是比例**。实测每步耗时几乎严格正比于百万像素：

| 尺寸 | 像素量 | 每步 | 说明 |
|---|---|---|---|
| 1024×768 | 0.79 MP | 3.3 s | 试构图最快 |
| 1024×1024 | 1.05 MP | 4.1 s | 常用 |
| 1536×1024 | 1.57 MP | 6.4 s | |
| 2048×1152 | 2.36 MP | 9.3 s | 2K 级别，解码开始分块 |
| 2560×1440 | 3.69 MP | 15.3 s | 接近上限 |

约 **4.2 秒每百万像素每步**（RTX 4050 Laptop 6GB、`min_memory` 策略、模型在 NVMe 上）。换卡、换策略、换盘这个系数全变，**不要把它当预算报给用户**。要给时间就给引擎自己报的 ETA，或者同一尺寸上次的实测值。

## 显存策略

`min_memory`（省显存）与 `balanced`（预算内最快）的差别不是「快慢」，是「装得下装不下」：

- 6 GB 卡上引擎启动后能支配的 arena 约 **4.58 GiB**，而 DiT 全常驻要 9.81 GiB。
- `balanced` 的策略是塞满为止，高水位能到 4.53 / 4.58 GiB，留给激活值的余量只有几十 MiB。640²、768² 挤得进，**1024² 及以上会 arena overflow**。
- `min_memory` 一个块都不常驻，1024² 全流程 arena 高水位约 1.6 GiB，一路顺畅，代价是每步慢数倍。

所以：**小图用 balanced，大图必须 min_memory**。这不是可调的性能开关，是硬边界。

## 写提示词

模型对「数量」和「谁身上有什么」的服从度有限，几条实测有用的做法：

- **数量写死并加反向词**：写「两杯茶」它可能给你三杯。想要几个就写几个，同时在反向词里排除「多余的 X」「第三个人」「重复的角色」。
- **多人图用互斥描述**：两个角色时，除了写「她有猫耳」，还要写「她没有兰花」。否则模型会把两条描述的配饰混到一个人身上（属性泄漏），人越多越容易。
- **位置写具体**：「人物在画面左侧三分之一，右侧大片留白」比「构图偏左」有效得多。
- **别写「雾」「朦胧」又怪它灰**：低饱和、薄雾、莫兰迪这些词会真的把画面压灰。
- **手容易糊**：贴身小物件、握持动作、手指细节是弱项，16 步也救不回来。要么减少手部戏份，要么换姿势。

## 产物在哪

生成的 PNG 落在 `<HANA_HOME>/app-data/hana-moss-studio/generated/`（宿主的媒体目录，预建好的），同时进苔室画廊。工具的 `details.moss.output` 给文件名；要在聊天里交付，用 `stage_files` 把这个绝对路径交出去。

## 排障

先 `moss_status`，再按症状对：

| 症状 | 大概率原因 |
|---|---|
| `arena overflow: need X MiB, have Y MiB` | 显存策略太省余量。切 `min_memory`，或降低像素量 |
| 出图很糊、像没画完 | 步数太少。8 步是底线，抬到 16～24 |
| 每次都要等三十多秒才动 | 文本编码器在从盘上重读（`te_weight_load`）。模型放 NVMe 会快五倍 |
| `invalid_params: the size must be at most 4096 / 4.2 megapixels` | 撞硬限。降像素或改走 `hiresScale` |
| 引擎未启动 / 模型未加载 | 在苔室工作区或左侧面板点「启动引擎」；路径未配就去填 |
| 引擎起不来，报 `EACCES` | Linux 上解压丢了执行位 | `chmod 755 <serverPath>`，部署全流程见 `references/platform.md` |
| 报找不到 `libcublasLt.so.N` / `cublasLt64_*.dll` | 装的是 `system-cuda` 包，库不在包里 | 补库或换 `bundled` 包，见 `references/platform.md` |
| 换了台机器或换了显卡就起不来 | 包与平台的组合不对（驱动版本、算力） | 按 `references/platform.md` 重新选包 |
| 进度卡停在「正在读取任务状态」 | 本机回环偶发 `ENOBUFS`，卡片会保留已画内容并重试。持续不恢复就刷新页面 |
| 面板数据不更新 | 事件流 `/events` 断开会退化成轮询，刷新页面重连 |

更细的引擎与显存实测数字见 `references/engine.md`，按平台部署见 `references/platform.md`。
