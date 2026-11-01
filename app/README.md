# 苔室

MOSS-Image 的本机出图工作台。

- 页面：提示词、尺寸、步数、CFG、种子，当前任务进度，画廊
- 工具：`moss_generate`、`moss_status`，可在对话里直接出图
- 引擎：自己管理 `moss-server` 进程，`--parent-pid` 看门狗保证宿主退出后不留孤儿进程

源码与构建方式见仓库根目录的 README。
