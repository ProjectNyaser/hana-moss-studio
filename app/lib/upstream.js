// 由 scripts/sync-upstream.mjs 从 vendor/MossStudio 生成，不要手改。
// 上游提交：6aeefab（2026-11-01T17:57:18+08:00）

export const UPSTREAM = {
  "generatedAt": "2026-11-01T11:07:25.883Z",
  "source": {
    "repo": "CloverIris/MossStudio",
    "commit": "6aeefab",
    "commitDate": "2026-11-01T17:57:18+08:00"
  },
  "protocol": {
    "protocolVersion": 2,
    "source": "apps/desktop/src/main/services/mossInfer.ts"
  },
  "engine": {
    "repo": "xycld/owoinfer",
    "archivePattern": "mossinfer-<version>-<os>-<cuda>-<arch>[-sm75][-system-cuda].<ext>",
    "assetsFrom": "GitHub Release assets + SHA256SUMS"
  },
  "catalog": {
    "schemaVersion": 2,
    "updatedAt": "2026-10-19T09:48:26Z",
    "models": [
      {
        "id": "moss-sft-dit",
        "name": "MOSS-Image SFT",
        "repo": "OpenMOSS-Team/MOSS-Image-SFT",
        "revision": "main",
        "role": "dit",
        "precision": "bf16",
        "sizeBytes": 10164704750,
        "files": [
          "transformer/*"
        ],
        "subfolder": "transformer",
        "format": "diffusers",
        "tags": [
          "official",
          "sft"
        ],
        "notes": "官方 SFT 主模型，适合日常生成。"
      },
      {
        "id": "moss-base-dit",
        "name": "MOSS-Image Base",
        "repo": "OpenMOSS-Team/MOSS-Image-Base",
        "revision": "main",
        "role": "dit",
        "precision": "bf16",
        "sizeBytes": 10164704750,
        "files": [
          "transformer/*"
        ],
        "subfolder": "transformer",
        "format": "diffusers",
        "tags": [
          "official",
          "base"
        ],
        "notes": "官方 Base 主模型，适合继续训练与微调。"
      },
      {
        "id": "moss-base-fp16-fixed",
        "name": "MOSS-Image Base FP16-fixed (社区)",
        "repo": "KBlueLeaf/MOSS-Image-FP16-fixed",
        "revision": "main",
        "role": "dit",
        "precision": "fp16",
        "sizeBytes": 10164704750,
        "files": [
          "base/transformer/*"
        ],
        "subfolder": "base/transformer",
        "format": "diffusers",
        "tags": [
          "community",
          "fp16",
          "fixed",
          "base",
          "diffusers",
          "2080ti",
          "v100"
        ],
        "notes": "社区 FP16 修复版主模型；与共享 Qwen、VAE 组合使用，按 FP16 加载。"
      },
      {
        "id": "moss-sft-fp16-fixed",
        "name": "MOSS-Image SFT FP16-fixed (社区)",
        "repo": "KBlueLeaf/MOSS-Image-FP16-fixed",
        "revision": "main",
        "role": "dit",
        "precision": "fp16",
        "sizeBytes": 10164704750,
        "files": [
          "sft/transformer/*"
        ],
        "subfolder": "sft/transformer",
        "format": "diffusers",
        "tags": [
          "community",
          "fp16",
          "fixed",
          "sft",
          "diffusers",
          "2080ti",
          "v100"
        ],
        "notes": "社区 FP16 修复版主模型；与共享 Qwen、VAE 组合使用，按 FP16 加载。"
      },
      {
        "id": "moss-base-fp16-fixed-comfy",
        "name": "MOSS-Image Base FP16-fixed · ComfyUI (社区)",
        "repo": "KBlueLeaf/MOSS-Image-FP16-fixed",
        "revision": "main",
        "role": "dit",
        "precision": "fp16",
        "sizeBytes": 10164655600,
        "files": [
          "comfyui/moss_image_base_fp16_fixed.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "community",
          "fp16",
          "fixed",
          "base",
          "comfyui",
          "2080ti",
          "v100"
        ],
        "notes": "社区 FP16 修复版主模型；供 ComfyUI 使用，不支持绑定到官方 Gradio。"
      },
      {
        "id": "moss-sft-fp16-fixed-comfy",
        "name": "MOSS-Image SFT FP16-fixed · ComfyUI (社区)",
        "repo": "KBlueLeaf/MOSS-Image-FP16-fixed",
        "revision": "main",
        "role": "dit",
        "precision": "fp16",
        "sizeBytes": 10164655600,
        "files": [
          "comfyui/moss_image_sft_fp16_fixed.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "community",
          "fp16",
          "fixed",
          "sft",
          "comfyui",
          "2080ti",
          "v100"
        ],
        "notes": "社区 FP16 修复版主模型；供 ComfyUI 使用，不支持绑定到官方 Gradio。"
      },
      {
        "id": "qwen35-encoder",
        "name": "Qwen3.5 · 文本编码器",
        "repo": "OpenMOSS-Team/MOSS-Image-SFT",
        "revision": "main",
        "role": "text_encoder",
        "precision": "bf16",
        "sizeBytes": 16785543633,
        "files": [
          "text_encoder/*",
          "tokenizer/*"
        ],
        "subfolder": "text_encoder",
        "format": "diffusers",
        "tags": [
          "official",
          "shared"
        ],
        "notes": "含 tokenizer 与配置，Base、SFT 和 FP16-fixed 共用。"
      },
      {
        "id": "flux2-vae-small",
        "name": "FLUX.2 VAE · Small",
        "repo": "OpenMOSS-Team/MOSS-Image-SFT",
        "revision": "main",
        "role": "vae",
        "precision": "fp32",
        "sizeBytes": 249522210,
        "files": [
          "vae/*"
        ],
        "subfolder": "vae",
        "format": "diffusers",
        "tags": [
          "official",
          "shared"
        ],
        "notes": "与官方 MOSS 匹配的 small decoder，运行时使用 FP32。"
      },
      {
        "id": "moss-pipeline",
        "name": "MOSS Pipeline",
        "repo": "OpenMOSS-Team/MOSS-Image-SFT",
        "revision": "main",
        "role": "support",
        "precision": "mixed",
        "sizeBytes": 50000,
        "files": [
          "model_index.json",
          "pipeline_moss_image.py",
          "scheduler/*"
        ],
        "subfolder": "",
        "format": "diffusers",
        "tags": [],
        "notes": "推荐组合所需的 pipeline 与采样器配置。"
      },
      {
        "id": "moss-base-comfy-bf16",
        "name": "MOSS BASE · BF16",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "dit",
        "precision": "bf16",
        "sizeBytes": 10164655808,
        "files": [
          "diffusion_models/moss_image_base_bf16.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI 单文件，仅供下载；不能绑定到官方 Gradio。"
      },
      {
        "id": "moss-base-comfy-int8_convrot",
        "name": "MOSS BASE · INT8_CONVROT",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "dit",
        "precision": "int8",
        "sizeBytes": 5413698958,
        "files": [
          "diffusion_models/moss_image_base_int8_convrot.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI 单文件，仅供下载；不能绑定到官方 Gradio。"
      },
      {
        "id": "moss-sft-comfy-bf16",
        "name": "MOSS SFT · BF16",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "dit",
        "precision": "bf16",
        "sizeBytes": 10164655808,
        "files": [
          "diffusion_models/moss_image_sft_bf16.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI 单文件，仅供下载；不能绑定到官方 Gradio。"
      },
      {
        "id": "moss-sft-comfy-int8_convrot",
        "name": "MOSS SFT · INT8_CONVROT",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "dit",
        "precision": "int8",
        "sizeBytes": 5413698958,
        "files": [
          "diffusion_models/moss_image_sft_int8_convrot.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI 单文件，仅供下载；不能绑定到官方 Gradio。"
      },
      {
        "id": "qwen35-comfy-bf16",
        "name": "Qwen3.5 · BF16",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "text_encoder",
        "precision": "bf16",
        "sizeBytes": 19306312328,
        "files": [
          "text_encoders/qwen3.5_9b_bf16.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI 编码器，量化版本需对应加载器。"
      },
      {
        "id": "qwen35-comfy-int8_convrot",
        "name": "Qwen3.5 · INT8_CONVROT",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "text_encoder",
        "precision": "int8",
        "sizeBytes": 9748121532,
        "files": [
          "text_encoders/qwen3.5_9b_int8_convrot.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI 编码器，量化版本需对应加载器。"
      },
      {
        "id": "qwen35-comfy-w4a8_gptq",
        "name": "Qwen3.5 · W4A8_GPTQ",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "text_encoder",
        "precision": "w4a8",
        "sizeBytes": 7343591088,
        "files": [
          "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI 编码器，量化版本需对应加载器。"
      },
      {
        "id": "flux2-vae-comfy-small",
        "name": "FLUX.2 VAE · Small",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "vae",
        "precision": "fp32",
        "sizeBytes": 249521340,
        "files": [
          "vae/flux2-vae_small.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI VAE 单文件，仅供下载。"
      },
      {
        "id": "flux2-vae-comfy-full",
        "name": "FLUX.2 VAE · Full",
        "repo": "Comfy-Org/MOSS-Image",
        "revision": "main",
        "role": "vae",
        "precision": "fp32",
        "sizeBytes": 336211292,
        "files": [
          "vae/flux2-vae.safetensors"
        ],
        "subfolder": "",
        "format": "comfyui",
        "tags": [
          "comfyui"
        ],
        "notes": "ComfyUI VAE 单文件，仅供下载。"
      }
    ]
  }
};
