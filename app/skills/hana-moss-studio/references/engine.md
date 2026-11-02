# 引擎与显存

苔室不实现推理，它只管理一个外部进程 `moss-server`（同目录的 `mossinfer` 发行版）。所有关于速度与显存的结论都来自这个进程自己的报告，不是苔室算的。

## 进程与接口

- 可执行：`<HANA_HOME>/app-data/hana-moss-studio/engine/mossinfer-<ver>-<os>-<cuda>-x86_64/bin/moss-server`（Windows 带 `.exe`；包名与平台、驱动的对应关系见 `platform.md`）
- 通信：本机 stdio 上的 JSON 消息（`load` / `generate` / `cancel` / 进度事件 / 结束报告）
- `load` 只收一个模型目录路径，没有架构或类型参数：它按 MOSS-Image 的结构读 `transformer / text_encoder / vae / model_index.json`
- 不吃 LoRA（报告里 `lora: none`），不吃单文件 checkpoint

模型目录可以指向盘上任意位置，但**引擎进程不在 App 的 fs 沙箱里**：App 自己 `existsSync` 检查路径时受宿主 `--allow-fs-read` 限制，只能看见自己的目录与 app-data。把模型放别的盘时，用目录联接（Windows junction / Linux 符号链接）把它接到 app-data 下，具体命令见 `platform.md`。App 看到的是字面合法路径，真正的数据流走引擎。

## arena 与两种显存策略

启动日志里会打印一行规划：

```
Arena cap 4.58 GiB (free 4.95 GiB - reserve 0.38 GiB)
```

- 卡标称 6.0 GiB，但进程一启动，CUDA 上下文加上 cuBLASLt 这类库先占掉约 1 GiB，所以能用的只剩 4.95 GiB
- 再扣 0.38 GiB 预留（给 cuBLASLt workspace、驱动内部这类不走 arena 的分配），剩 4.58 GiB 是可以自由支配的池子

DiT 全常驻需要 **9.81 GiB**，接近池子的两倍。所以策略的差别在：

| 策略 | 行为 | 高水位 | 1024² 能跑吗 |
|---|---|---|---|
| `balanced` | 权重尽可能塞进显存，放不下的流式读 | 4.53 / 4.58 GiB（640² 实测） | **不能**，`need 32 MiB, have 26 MiB` |
| `min_memory` | 一个块都不常驻，全部按需读 | 1.6 GiB（1024² 实测） | 能，每步慢数倍 |

`balanced` 的自我描述是「预算内最快」，它从来不是「权重全在显存」，是「塞满为止」。塞满之后留给激活值的余量只剩几十 MiB，640²、768² 的激活值挤得进，1024² 挤不进。

**结论：小图 balanced，大图 min_memory。这是硬边界，不是调优。**

## 磁盘是真正的瓶颈

在 SATA 上跑时，一张 768×1024 的图 102 秒里，文本编码占 30.9 秒，其中 `te_weight_load` 占 30.9 秒，真正的计算只有 2.2 秒。文本编码器 4 个分片共 15.6 GB，15.6 ÷ 30.9 ≈ **505 MB/s**，正好是 SATA 顺序读的上限。

同一套参数换到 NVMe：

| | SATA / VHDX | NVMe |
|---|---|---|
| 文本编码器加载 | 30.9 s | **6.0 s** |
| 去噪（16 步） | 69.6 s | 55.0 s |
| 总计 | 102 s | **63 s** |

15.6 GB ÷ 5.98 s ≈ 2.6 GB/s，就是 NVMe 的顺序读速度。**把模型目录放在 NVMe 上是这台机器上收益最大的一次优化**，比调显存策略值钱。

## 时间构成（2560×1440、16 步、min_memory 实测）

```
total 256.7 s
  load（DiT）    0.5 s
  encode         6.6 s   其中 te_weight_load 6.3 s、真正计算 0.5 s
  denoise      243.3 s   16 步 × 15.2 s
  decode         6.1 s
```

- 去噪占 95%，每步耗时严格正比于像素量
- 文本编码那 6 秒里，5.7 秒是在等权重从盘上读进来（`te_weight_wait`）
- 解码在超过单块容量时自动分块，代价约 1.9 倍解码时间，但那是唯一能出 2K 的方式

## 冷热之别

同一提示词连续出图时，引擎会命中嵌入缓存，`te_weight_load` 与 `te_compute` 都会接近 0，编码只花几毫秒。这种「全热运行」的数字不能拿来和冷启动比。要测真实代价，必须换一个从没出现过的提示词，或者重启引擎。

同理，操作系统的文件缓存能让刚读过的权重几秒内读完。真冷启动（重启过机器）的数字会比这更差。
