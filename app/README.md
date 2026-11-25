# 苔室

MOSS-Image 的本机出图工作台。

- 工作区：提示词与反向提示词、比例与像素量滑条、步数、CFG、种子、高清修正、队列与画廊
- 流内进度卡：对话里提交后自动挂上，显示阶段时间轴、步进、预计剩余与成品缩略图
- 功能面板：左侧栏常驻引擎状态、当前任务、参数、队列与起停按钮
- 工具：`moss_generate`、`moss_status`、`moss_estimate`、`moss_inspect`、`moss_engine`、`moss_latent`，可在对话里直接出图、试参数、查引擎、续画
- 引擎：自己管理 `moss-server` 进程，`--parent-pid` 看门狗保证宿主退出后不留孤儿进程
- 技能：`skills/hana-moss-studio/`，装了 App 就带上工具用法与引擎边界

界面配色全部走宿主主题变量，明暗与配色跟随宿主。源码、打包与发版方式见仓库根目录的 README。
