---
name: hana-moss-studio
description: 苔室（Hana-Moss-Studio，v2 App）——MOSS-Image 的本机出图工作台：自带 CUDA 引擎进程、串行队列、采样器与加速器、LoRA、图生图与局部重绘、JSON 布局提示（指哪画哪），工具出图在对话里挂实时进度卡。触发场景：用苔室出图、用 MOSS-Image 生图、查看苔室引擎状态、取回生成的图片、启停引擎、释放显存、图生图、局部重绘、蒙版、LoRA、画质调参、采样器与调度器、加速器、JSON 布局、layout 提示、bbox、指哪画哪、框选位置、文字排版控制、高清修正、放大图片、显存不足、arena overflow、模型未加载、引擎路径没配、工作区打不开、面板读不出数据、苔室进度卡不刷新、给这台机器部署苔室引擎、装 moss-server、下载 mossinfer 包、Linux 上装引擎、chmod 执行位、缺 libcublasLt、cuBLASLt 找不到、驱动版本不够装不了、换显卡重新部署、拉 MOSS-Image 权重。不触发：用 ComfyUI 出图（那是 comfyui-hana）、用云端模型生图（那是 media_generate-image）、只要一张图且不关心本机模型（同样走 media_generate-image）。
---

# 苔室（Hana-Moss-Studio）

把本机 **MOSS-Image** 引擎接进 Hana 的出图工作台。一个模型、一条干净流水线：它不加载 SDXL / Flux / Qwen-Image 那些别人的 checkpoint，**只认 MOSS-Image 架构**：bundle 是 `transformer / text_encoder / vae / model_index.json`，单文件 DiT / 文本编码器 / VAE 可以按分量覆盖它。想要一个吃所有模型的界面，走 comfyui-hana。

## 快速上手

先看状态，再出图。三件事都别跳过：

```
moss_status()
moss_estimate(prompt="...", width=1024, height=1024, steps=16)
moss_generate(prompt="...", width=1024, height=1024, steps=16)
```

`moss_generate` **提交即返回**，不阻塞到出图。回合纪律：提交完不要原地等，下面的进度卡会自己刷新，出图后宿主把结果投递回会话。需要当场拿到文件时才轮询。

大图或试新参数组合先 `moss_estimate`：它不加载权重、不写文件，几秒内回「能不能跑、要多久、有没有把加速器打开」。

首次使用若引擎或模型路径未配，`moss_status` 会写明「未配置」。这时先照 `references/platform.md` 把这台机器的引擎与权重装好、把两个路径写回设置；用户已经有引擎时只问路径，不要猜。

## 环境部署

苔室只支持 **Windows x64**。其他平台直接说不可用，不要试变通。

**首选让用户自己点**：左侧面板「引擎与模型」里有「装引擎」与「下权重」两个按钮。App 会自己探测显卡与驱动、选对包、下载、校验 sha256、解压、写设置；权重走同一套下载器，已完整的文件跳过。这条路不需要 Agent 介入，也适合用户不在对话里的场景。

「下载」页除了两个 bundle 仓库，还列了单文件权重与适配器（与 ComfyUI 发布页同源）：DiT INT4 ConvRot（2.83 GB）、DiT INT8 ConvRot（5.04 GB）、文本编码器 INT8（9.08 GB）/ W4A8（6.84 GB）、VAE small、控制适配器 color+depth（0.29 GB）、编辑 LoRA rank 64（0.28 GB）。下载完自动写进设置：适配器进库，权重进 `modelFiles` 并作为 `load` 的 `dit_file` / `text_encoder_file` / `vae_file` 覆盖 bundle 里对应的那一个。

**turbo 档只有配了 INT4 ConvRot 的 DiT 才能跑**。bundle 里的 DiT 是 bf16，直接选 turbo 会被引擎以 `invalid_argument` 拒；先下 `dit-int4` 再选 turbo。

只有按钮走不通（要装到自定义目录、要补 cuBLASLt、包不匹配）时才掀命令行：`references/platform.md`。

装哪个包由驱动与算力决定：

- 驱动主版本 < 580 只能装 `cu12`；compute_cap 7.5 只能装 `-sm75` 且必须 cu13。
- 优先 `bundled` 包；`system-cuda` 要自己补 cuBLASLt。
- 权重 25.4 GiB，放 NVMe。

验收：`moss_status()` 会把引擎拉起来跑一次 `hello`，再拿 512²/8 步出一张，不要用 1024² 试。

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
| `sampler` | 采样器，缺省 `euler`（官方组合）。`ab2` / `dpmpp_2m` 一类换的是数值积分器，构图随之变 |
| `scheduler` | 噪声调度，缺省 `moss`（逐位复现官方流水线）。`karras` / `beta` 更锐，`sgm_uniform` 更稳 |
| `shift` | 噪声偏移，缺省 5。越大越偏整体结构、细节越少 |
| `stepCache` | `off`（缺省）/ `fbcache`。跳过块变化很小的 DiT 前向：更快，但这张图与不加速的不是同一张（lossy） |
| `stepCacheThreshold` | 加速阈值 (0,1]，缺省用模型默认（SFT 0.03）。越大越快、偏得越多 |
| `cfgTruncation` | CFG 截断 [0,1]，缺省 1（关）。小于 1 只在前段跑负向分支，lossy |
| `loras` | LoRA 列表，`["路径"]` 或 `[{path, strength}]`，按顺序叠加，最多 64 个。缺省用设置里勾选的那些 |
| `loraPlacement` | `default` / `merge` / `side_branch`。`merge` 会把权重合进 DiT，换 LoRA 要重载模型 |
| `hiresScale` | 高清修正倍数。`0` 关闭（缺省），`2` 表示先出基础图再放大 2 倍精修 |
| `hiresSteps` | 修正步数，缺省跟主采样一致 |
| `hiresStrength` | 修正重绘强度，缺省 0.45。越小越贴近原图，太大等于重画 |
| `initImage` | 图生图的参考图**绝对路径**（png/jpg）。给了它就按这张图的构图与配色重画 |
| `strength` | 图生图重绘强度 0.05~1，缺省 0.6。0.8 左右会重画背景又保住配色布局 |
| `resize` | 参考图适配：`crop`（居中等比裁，缺省）/ `fit`（留边）/ `stretch`（拉伸） |
| `mask` | 局部重绘蒙版**绝对路径**，与 `initImage` 同尺寸的灰度图：白（≥128）重画、黑保留 |
| `maskEncoding` | `u8`（缺省，按灰度值）/ `binary01`（只认 0 与 1） |
| `controlAdapter` / `controlKind` / `controlImage` | 控制适配器：文件路径、kind（`depth` / `canny` / `pose` 之类，取适配器支持的）、控制图路径 |
| `controlStrength` / `controlLoraStrength` | 控制图强度（0~10，缺省 1）与适配器自带 LoRA 部分的强度 |
| `referenceImages` / `referenceMaxEdge` | 编辑适配器的参考图（最多 4 张，第一张是源图）与长边像素（缺省 512） |
| `uncondSkipLayers` | 负向分支跳过的 DiT 层，缺省 `[22]`（官方）；`[]` 表示不跳 |
| `slgLayers` / `slgScale` / `slgStart` / `slgStop` | 跳过层引导：层号、强度（缺省 0 关）、生效区间。与编辑参考图不能同时开 |
| `maxSequenceLength` | 提示词最大 token，缺省 4096。长布局提示词要够长才不会被截 |
| `flowMultiplier` | flow 采样倍率，缺省 1；`moss` 调度器忽略它 |
| `noiseLayout` / `noiseSource` | 噪声排布（`official` / `batch_stream`）与随机源（`philox` / `philox_device` / `brownian_tree`） |
| `eta` / `sNoise` | 随机采样器的两个系数，缺省 1 |
| `dataspace` | dataspace 采样器的参数文件路径；选了 `dataspace` 就必须给 |
| `distill` | 蒸馏包目录：引擎会追入它的 LoRA，并按它的步数与 CFG 1 跑 |
| `layout` / `layoutPath` | 布局提示（JSON layout）：直接给对象，或给一个 JSON 文件的绝对路径 |
| `boxes` | 指哪画哪的快捷写法：`[{label, caption, text?, box:[x0,y0,x1,y1]}]`，坐标从左上角算、单位像素 |

路径的限制：宿主只允许 App 读写 HANA_HOME 与工作区，桌面上的图直接当 `initImage` 会被权限层拦下。这种图先 `POST .../inputs/upload?kind=init`（或让用户在侧栏选）落到苔室的运行时目录，再拿返回的路径。LoRA 同理，走 `/loras/import` 落在 `app-data/hana-moss-studio/loras/`。

两类适配器要分清：

- **控制适配器**（`controlAdapter`）必须是一个带 `video_embedder` 的完整适配器文件。侧栏可收起的「控制图」里能导入与选图，导入后会先用 `inspect` 问引擎要 kind，不是控制适配器的文件会被当场清掉。HuggingFace 上 `thedeoxen/MOSS-Image-*-controlnet` 那一批只有 LoRA 部分，`moss_inspect` 会把它们判成 `lora`，拿去当 `control` 会被引擎拒（`no video_embedder.weight`）。
- **编辑适配器**（`referenceImages`）是一个 LoRA：先放进 `loras`，再给参考图。`chinoll/Moss-Image-Edit` 这类文件实测能在 `rank 64` 下加载并跑通编辑。

### `moss_estimate`

与 `moss_generate` 同参数（`prompt` 必填，其余按需）。空跑一次 `check`：不加载权重、不写文件，返回能不能跑、拒绝理由、总耗时与分阶段估算。`plan.estimate.rates` 是 `measured` 时才算的是这台机器的实测系数，`default` 只是引擎内置经验值。

### `moss_inspect`

`{path}` → 文件是什么：`dit` / `text_encoder` / `lora` / `control_adapter` / `unknown`，能不能加载，可用 tier，控制适配器支持哪些 kind，LoRA 的 rank 与适配器数。不加载模型、不占显存。给 LoRA 之前先问一句，比出图失败再排查便宜。

### `moss_latent`

可续画的生成，与 `moss_generate` 走同一条队列，但底下是引擎的 component session：采样循环在苔室这边，每一步的 latent 都落盘到 `app-data/hana-moss-studio/checkpoints/`。

| 参数 | 说明 |
|---|---|
| `action` | `run` 新开一次；`resume` 从断点接着跑；`list` 列断点；`encode` PNG → latent；`decode` latent → PNG |
| `batch` | 一次出 1~4 张（缺省 1）。2 张以上走 host guidance，种子逐张 +1；断点里的张数要与这次一致才能续 |
| `imagePath` + `maskPath` | `action=inpaint` 用：底图与蒙版（白处重画），两张同尺寸且是 16 的倍数 |
| `strength` | inpaint 的重画幅度（缺省 0.6，1 = 这块从噪声重画） |
| `prompt` / `negativePrompt` / `width` / `height` / `steps` / `cfg` / `shift` / `seed` | 同 `moss_generate`。`resume` 时用断点里的值 |
| `checkpointId` | `resume` 用：断点 id（就是任务 id）或 meta 文件绝对路径 |
| `imagePath` | `encode` 用：PNG 路径，尺寸要是 16 的倍数 |
| `latentPath` / `width` / `height` | `decode` 用：latent 文件与它的尺寸（文件本身不含形状） |

限制：只做**纯文生图**，采样器固定 `euler`（MOSS 官方组合），不搭底图/蒙版/控制图/编辑参考图。layout 提示词照样能用（它只是提示词的写法）。

续画的边界：断点里存了 `sigmas`。`resume` 时步数与 `shift` 必须与断点一致，否则调度表对不上会直接报错——这是故意的，换了调度还接着跑只会得到一张安静的错图。

latent 是模型空间的 F32 `[128, h/16, w/16]`，与 ComfyUI 的 Flux2 `LATENT` 同构，拿去 ComfyUI 不用转换。

### `moss_engine`

`{action: "start" | "stop" | "release" | "preload"}`。`release` 把显存还给显卡但留住引擎（`keepHostCopy` 缺省 true，权重留在内存里，下次出图直接传）；6 GB 卡上跑完一批要给别的工作腾卡时用它。`preload` 按当前设置预热一次（`width` / `height` / `steps` 可覆盖），之后同样形状的生成不付加载代价。

### `moss_status`

返回引擎是否在跑、模型是否加载、设备与显存、当前任务阶段与步进、队列长度、最近五条任务结局。调参前、出图失败后、怀疑引擎卡住时都该先看它。

## 未包装的引擎能力

- **conditioning 导入**（`conditioning_import`）：把外部算好的文本条件直接灌进去。苔室的文本编码一直在引擎里，没有需要复用的外部条件；`encode_text` 本身也很快（17 token 毫秒级）。

## latent 级局部重绘

`runLatentInpaint`，走 `POST /latent/inpaint` 或工具 `moss_latent` 的 `action=inpaint`。

做法：底图先 `vae_encode` 成全图 latent，蒙版按 16 像素网格取包围盒，然后每一步只把这块裁成 `[128, ch, cw]` 写进槽位、用 `shape` 声明尺寸跑，输出去 CFG 合完再积分贴回。

两条硬约束：

- crop 调用必须用 `guidance: "host"`，MOSS guidance 下引擎直接报 `invalid_argument`。
- 尺寸要是 16 的倍数，蒙版与底图同尺寸。

保真度：区域内外不是像素级严格封口。实测 256² + 中心 64² 蒙版，区域内平均差 14.2，区域外 1.96（VAE 解码的全局注意力会扩散一点）。换来的是区域**不经过 VAE 往返**，与像素级 inpainting 是两条路。

## 三条硬边界

1. **单张上限 4.2 百万像素、单边 4096**。4K（3840×2160 = 8.3MP）**出不了**，引擎直接以 `invalid_params` 拒绝。这个上限对基础图和高清修正目标**一视同仁**，所以高清修正不能把图做大，它只做两段式采样（小图定构图、放大后补细节）。
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

## 布局提示（指哪画哪）

MOSS-Image 支持把整张图的排布写成一段 JSON，**这段 JSON 就是提示词**，引擎不需要额外参数。官方格式（实验性，Base 与 SFT 实测都跟）：

```json
{
  "summary": { "canvas": "single", "caption": "整张图的描述" },
  "items": [
    { "label": "text", "text": "EXPLORE", "caption": "顶部居中的大标题", "bbox": [-240, -200, -120, 200] },
    { "label": "object", "caption": "下方的蓝山", "bbox": [0, -180, 200, 180] }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

两个坐标语义最容易搞错：

- `bbox_format: "yxyx"`：顺序是 `[y_min, x_min, y_max, x_max]`，不是 xyxy。
- `bbox_coord_space: "abs_centralized"`：以**画布中心**为原点、单位像素，上负下正、左负右正。512×512 的画布范围是 ±256。从左上角坐标转换就是 `x - W/2`、`y - H/2`。

写起来麻烦的是坐标。苔室给了两个省事的入口：

- 工具面用 `boxes`：从左上角算的 `[x0, y0, x1, y1]`，苔室按 `width × height` 换算成模型要的中心坐标，再拼成 layout JSON。给了 `boxes` 就以它为准。
- 侧栏的「布局」段：点「去画布框选」把工作区切到框选模式；空画布上点「导入底图框选布局」，或者直接把图拖进画布。在图上拖出框、拖四角改大小，底部写每块的提示词（label / caption / text）。框按比例存着，换画幅时跟着缩；完成后框自动交给侧栏，点「开始生成」就带上。
- 底图只用来对齐，不进生成流程：它不上传、不写进任务；比例和画幅不同时自动把画幅调成和它一样。侧栏的「参考图」是另一件事，那张会作为 `initImage` 参与生成。

几条实测经验：

- **手写坐标要重算**。bbox 是像素而不是比例，换个画幅原来的框就偏了；侧栏框选出来的布局不受这条限制。
- 文字要渲染就写成 `label: "text"` 并把内容放在 `text`，`caption` 描述样式（颜色、大小、位置）。
- 模型对框的服从是「大致就位」而不是像素级：单张图里 2～4 个元素最稳，再多会互相挤。

## 产物在哪

生成的 PNG 落在 `<HANA_HOME>/app-data/hana-moss-studio/generated/`（宿主的媒体目录，预建好的），同时进苔室画廊。工具的 `details.moss.output` 给文件名；要在聊天里交付，用 `stage_files` 把这个绝对路径交出去。

## 排障

先 `moss_status`，再按症状对：

| 症状 | 大概率原因 |
|---|---|
| `arena overflow: need X MiB, have Y MiB` | 显存策略太省余量。切 `min_memory`，或降低像素量 |
| 出图很糊、像没画完 | 步数太少。8 步是底线，抬到 16～24 |
| 每次都要等三十多秒才动 | 文本编码器在从盘上重读（`te_weight_load`）。模型放 NVMe 会快五倍 |
| `invalid_params: the size must be at most 4096 / 4.2 megapixels` | 撞硬限。降像素；改走 `hiresScale` 也绕不过去 |
| `loras[0].path: file not found` | 路径不在宿主可读范围，或文件被移走。用 `/loras/import` 导进 app-data 再指过去 |
| LoRA 没效果 | 先 `moss_inspect`：`loadable` 为假，或 `base_model` 不是 MOSS；也可以把强度抬到 1.2 试一次 |
| `An inpainting mask needs an init image` | 只给了 `mask`。局部重绘必须先给 `initImage`，两张同尺寸 |
| 开了 `fbcache` 后和之前不一样 | 这是加速器的定义：它是 lossy 的。要对比就关掉重跑同一个种子 |
| 引擎未启动 / 模型未加载 | 在苔室工作区或左侧面板点「启动引擎」；路径未配就先装或去填 |
| 报找不到 `cublasLt64_*.dll` | 装的是 `system-cuda` 包，库里没有；补库或换 `bundled` 包（`references/platform.md`） |
| 换了机器或换了显卡就起不来 | 包与平台的组合不对（驱动、算力），重新选包（`references/platform.md`） |
| 点「装引擎」一直停在下载 | GitHub 的 release 资产链路差，不是本机问题。用 `references/platform.md` 的本地包接口，把已拿到的 zip 交给 App |
| 进度卡停在「正在读取任务状态」 | 本机回环偶发 `ENOBUFS`，卡片会保留已画内容并重试。持续不恢复就刷新页面 |
| 面板数据不更新 | 事件流 `/events` 断开会退化成轮询，刷新页面重连 |

更细的引擎与显存实测数字见 `references/engine.md`，按平台部署见 `references/platform.md`。
