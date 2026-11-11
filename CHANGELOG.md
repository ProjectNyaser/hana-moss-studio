# Changelog

## 未发布

把引擎协议里那层生成参数接到界面与工具上。

- 采样面：采样器（九种）、调度器（七种）、`shift` 进入侧栏与 `moss_generate`，缺省是官方组合 `euler` + `moss`
- 加速器：`step_cache`（fbcache）与阈值，lossy，侧栏开关，报告里回实际跳过的调用
- LoRA：导入到 `app-data/loras`、勾选与强度随设置存下来；工具可用 `loras` 与 `loraPlacement`
- 图生图与局部重绘：侧栏选参考图（浏览器里按目标尺寸裁好）、在图上画蒙版；工具可用 `initImage` / `mask` / `maskEncoding`
- 编辑适配器：工作区右键「用这张做编辑参考」，把图作为 `references` 送进下一次生成
- 单文件权重与适配器：「下载」页列 DiT INT4（turbo 必需）/ INT8、文本编码器 INT8 / W4A8、VAE small、控制适配器、编辑 LoRA；下载走 aria2，完成对大小后自动写进设置（适配器进库，权重作为 `dit_file` / `text_encoder_file` / `vae_file` 覆盖 bundle 对应分量）
- 布局：侧栏可收起的「布局」段贴 model-facing JSON layout（`yxyx` + 画布中心坐标），模板按当前尺寸生成；工具面可用 `layout` / `layoutPath` / `boxes`，`boxes` 接左上角像素坐标并自动换算；画廊从 PNG 读回时把布局 prompt 显示成 `summary.caption`
- 控制适配器：侧栏可收起的「控制图」段：导入适配器（`app-data/control`）、向引擎要 kind、控制图按目标尺寸准备；设置里指向已删文件的适配器会自动清掉
- 工具：新增 `moss_estimate`（空跑 `check` 给估算与拒绝理由）、`moss_inspect`（问文件是什么）、`moss_engine`（start / stop / release）
- 显存：侧栏与引擎页加「释放显存」，把显存还给显卡但留住引擎
- 进度卡：元信息行补采样器与 LoRA 个数
- 修正：从 PNG 读回记录时把采样器字段拿错了名字（`shaper`）

## 0.1.0

首个发布版本。

- 工作区：提示词与反向提示词、比例与像素量两条滑条、步数、CFG、种子、高清修正、队列、可收起的画廊
- 流内进度卡：工具提交后挂在对话里，跟四段阶段时间轴、步进、ETA 与耗时，出图后缩略图直接进卡
- 功能面板：唯一一条左侧栏，引擎状态、当前任务、参数、队列、画廊、起停按钮
- 工具：`moss_generate`（出图、图生图、高清修正）与 `moss_status`
- 引擎：托管 `moss-server` 进程，串行队列，`--parent-pid` 看门狗保证宿主退出后不留孤儿
- 数据通路：三处界面共用一条 SSE 事件流，断流后退化轮询；任务落到终态即停止取数
- 主题：全部走宿主注入的变量，明暗与配色跟随宿主
- 尺寸上限按引擎真实限制判定（单边 4096 / 4.2 百万像素），超出时给出具体原因
