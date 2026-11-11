// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

/**
 * app/lib/mossimage.js — 苔室直接对话的那个引擎，以及它要吃的那套模型文件。
 *
 * 苔室不经过任何中间项目：它 spawn `moss-server`，用 stdio JSON-lines 说话，
 * 协议本体以 vendor/mossimage.cpp 的 docs/server-protocol.md 为准。这里的常量是
 * 运行时唯一的事实来源，改版本时把 vendor/mossimage.cpp 的 submodule 指针一起动。
 */

export const MOSSIMAGE = {
  repo: "mossimage-cpp/mossimage.cpp",
  version: "2.1.2",
  protocolVersion: 2,
  abiVersion: 1,
  /** 可执行文件在发布包里的位置，按平台。 */
  server: { windows: "bin/moss-server.exe", linux: "bin/moss-server" },
  model: {
    id: "moss-image-sft",
    name: "MOSS-Image SFT",
    repo: "OpenMOSS-Team/MOSS-Image-SFT",
    revision: "main",
    license: "Apache-2.0",
  },
  /** 一套 diffusers 目录由这四个组件组成，与 scripts/fetch-weights.mjs 的默认清单一致。 */
  components: [
    {
      "role": "dit",
      "id": "moss-image-sft-dit",
      "name": "DiT（SFT）",
      "files": [
        "transformer/*"
      ],
      "sizeBytes": 10164729814,
      "fileCount": 6
    },
    {
      "role": "text_encoder",
      "id": "qwen35-encoder",
      "name": "文本编码器（Qwen3.5）",
      "files": [
        "text_encoder/*",
        "tokenizer/*"
      ],
      "sizeBytes": 16805544650,
      "fileCount": 9
    },
    {
      "role": "vae",
      "id": "flux2-vae-small",
      "name": "VAE（FLUX.2 small）",
      "files": [
        "vae/*"
      ],
      "sizeBytes": 249522210,
      "fileCount": 2
    },
    {
      "role": "support",
      "id": "moss-pipeline",
      "name": "pipeline 与调度配置",
      "files": [
        "model_index.json",
        "scheduler/*"
      ],
      "sizeBytes": 25966,
      "fileCount": 3
    }
  ],
  /**
   * 单文件权重与控制/编辑适配器。ComfyUI 发布页把它们按用途分好了，
   * 苔室只负责拉下来并填进 load 的 dit_file / text_encoder_file / vae_file。
   * role 决定落盘目录与怎么被引用：control → 控制适配器，lora → LoRA 库，其它 → 单文件权重。
   */
  files: [
    {
      id: "control-color-depth",
      role: "control",
      name: "控制适配器（color + depth）",
      note: "配控制图用",
      repo: "Comfy-Org/MOSS-Image",
      path: "loras/moss_image_color_depth_control.safetensors",
      bytes: 313063368,
    },
    {
      id: "lora-edit",
      role: "lora",
      name: "编辑适配器 Moss-Image-Edit（rank 64）",
      note: "配 references 用来改图",
      repo: "Comfy-Org/MOSS-Image",
      path: "loras/moss_image_edit_lora_rank_64_bf16.safetensors",
      bytes: 297382216,
    },
    {
      id: "dit-int4",
      role: "dit",
      name: "DiT INT4 ConvRot（turbo 档）",
      note: "turbo 档只能用它",
      repo: "toxicdog/MOSS-Image-SFT-INT4-ConvRot-ComfyUI",
      path: "diffusion_models/moss_image_sft_int4_convrot.safetensors",
      bytes: 3035537312,
    },
    {
      id: "dit-int8-sft",
      role: "dit",
      name: "DiT INT8 ConvRot（SFT · high 档）",
      note: "high 档的 INT8 权重",
      repo: "Comfy-Org/MOSS-Image",
      path: "diffusion_models/moss_image_sft_int8_convrot.safetensors",
      bytes: 5413698958,
    },
    {
      id: "dit-int8-base",
      role: "dit",
      name: "DiT INT8 ConvRot（Base · high 档）",
      note: "high 档的 INT8 权重",
      repo: "Comfy-Org/MOSS-Image",
      path: "diffusion_models/moss_image_base_int8_convrot.safetensors",
      bytes: 5413698958,
    },
    {
      id: "te-int8",
      role: "text_encoder",
      name: "文本编码器 INT8 ConvRot",
      note: "比 bundle 里的 bf16 省一半内存",
      repo: "Comfy-Org/MOSS-Image",
      path: "text_encoders/qwen3.5_9b_int8_convrot.safetensors",
      bytes: 9748121532,
    },
    {
      id: "te-w4a8",
      role: "text_encoder",
      name: "文本编码器 W4A8（GPTQ）",
      note: "最省内存的文本编码器",
      repo: "Comfy-Org/MOSS-Image",
      path: "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors",
      bytes: 7343591088,
    },
    {
      id: "vae-small",
      role: "vae",
      name: "VAE（FLUX.2 small）",
      note: "单文件方案用",
      repo: "Comfy-Org/MOSS-Image",
      path: "vae/flux2-vae_small.safetensors",
      bytes: 249521340,
    },
  ],
};

/** 整套权重的字节数，用于下载前估空间。 */
export const MODEL_BYTES = MOSSIMAGE.components.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
