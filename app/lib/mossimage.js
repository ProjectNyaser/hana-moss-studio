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
};

/** 整套权重的字节数，用于下载前估空间。 */
export const MODEL_BYTES = MOSSIMAGE.components.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
