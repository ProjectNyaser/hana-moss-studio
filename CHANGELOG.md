# Changelog

## 0.1.0

首个公开版本。

### 工作区与界面

- 提示词与反向提示词、比例与像素量两条滑条、步数、CFG、种子、高清修正、队列、可收起的画廊
- 采样面：采样器（九种）、调度器（七种）、`shift` 进入侧栏与 `moss_generate`，缺省是官方组合 `euler` + `moss`
- 加速器：`step_cache`（fbcache）与阈值，lossy，侧栏开关，报告里回实际跳过的调用
- LoRA：导入到 `app-data/loras`，勾选与强度随设置存下来；工具可用 `loras` 与 `loraPlacement`
- 图生图与局部重绘：侧栏选参考图（浏览器里按目标尺寸裁好）、在图上画蒙版；工具可用 `initImage` / `mask` / `maskEncoding`
- 编辑适配器：工作区右键「用这张做编辑参考」，把图作为 `references` 送进下一次生成
- 控制适配器：侧栏可收起的「控制图」段：导入适配器（`app-data/control`）、向引擎要 kind、控制图按目标尺寸准备；设置里指向已删文件的适配器会自动清掉
- 布局：框选搬到工作区画布上。空画布可直接「导入底图框选布局」，也可把图拖进来；在图上拖框、拖四角改大小、选中后在底部写 label / caption / text，画幅按底图比例自动对齐；完成后框交给侧栏，侧栏「布局」段只显示框数并负责导入 / 清空 JSON。工具面可用 `layout` / `layoutPath` / `boxes`，`boxes` 接左上角像素坐标并自动换算；画廊从 PNG 读回时把布局 prompt 显示成 `summary.caption`
- 底图与参考图落到 `app-data`，只记文件名，路径搬家后仍能取到，不随重启清空

### 模型与下载

- 「下载」页列 DiT INT4（turbo 必需）/ INT8、文本编码器 INT8 / W4A8、VAE small、控制适配器、编辑 LoRA；下载走 aria2，完成对大小后自动写进设置（适配器进库，权重作为 `dit_file` / `text_encoder_file` / `vae_file` 覆盖 bundle 对应分量）
- 引擎与权重的安装、卸载与校验都在版本页与侧栏完成；轻量配置包（配置 + 分词器 + VAE）配单文件权重可跑

### 工具

- `moss_generate`：出图、图生图、局部重绘、高清修正
- `moss_latent`：可续画的生成，每步 latent 落盘到 `checkpoints/`，`run` / `resume` / `list` / `encode` / `decode` / `inpaint`；latent 与 ComfyUI 的 Flux2 `LATENT` 同构，拿去不用转换
- `moss_status`（引擎状态与自检）、`moss_estimate`（空跑 `check` 给估算与拒绝理由）、`moss_inspect`（问引擎一个文件是什么）、`moss_engine`（start / stop / release）

### 引擎与数据通路

- 托管 `moss-server` 进程，串行队列，`--parent-pid` 看门狗保证宿主退出后不留孤儿
- 共享内存桥（`tools/shm-bridge`）承接 component session 的命名共享内存
- 三处界面共用一条 SSE 事件流，断流后退化轮询；任务落到终态即停止取数
- 任务归属在提交那一刻定下，进行中的也按会话过滤
- 侧栏与引擎页的「释放显存」把显存还给显卡但留住引擎
- 主题全部走宿主注入的变量，明暗与配色跟随宿主
- 尺寸上限按引擎真实限制判定（单边 4096 / 4.2 百万像素），超出时给出具体原因
- 流内进度卡跟四段阶段时间轴、步进、ETA 与耗时，出图后缩略图直接进卡；元信息行补采样器与 LoRA 个数

### 修正

- 从 PNG 读回记录时把采样器字段拿错了名字（`shaper`）
- 重复点「装引擎」会撑上正在运行的引擎对自身 DLL 的锁（`EBUSY on cublasLt64_13.dll`）；同版本已经解好时直接认它，不再重下一遍
- 取消下载只停了 aria2，按整包预分配的 zip 留在磁盘上；现在连同 `.aria2` 一起清掉
