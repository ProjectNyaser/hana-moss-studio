# 按平台部署

苔室不装引擎，也不打包引擎。部署是「把上游的二进制放到约定位置，再把两个路径写进设置」。本文件是给执行部署的 Agent 看的操作手册：先判定这台机器能不能跑，再按平台走步骤，最后用苔室自己的工具验收。

## 第 0 步：先判能不能跑，再动手

按顺序跑这三条，任何一条不满足就停，把结论告诉用户，不要开始下载。

```bash
# 1. 平台
uname -s            # Windows 上在 Git Bash / WSL 里才有；Windows 直接看下一步的命令能不能跑

# 2. 有没有 NVIDIA 驱动
nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader

# 3. 磁盘（引擎约 1 GB，权重约 27 GB）
```

判据：

| 情况 | 结论 |
| --- | --- |
| macOS（`Darwin`） | **停**。上游没有 darwin 构建，任何路径都跑不起来。改走云端出图 |
| `nvidia-smi` 不存在或报错 | **停**。没有 NVIDIA GPU 或驱动没装 |
| compute_cap < 7.5 | **停**。上游只产出 standard（CC ≥ 8.0）与 sm75（CC 7.5）两档 |
| compute_cap = 7.5 | 只能用 `-sm75` 包，且**只有 Windows + CUDA 13** |
| compute_cap ≥ 8.0 | 走 standard 包 |
| 驱动主版本 < 580 | 只能装 `cu12` 包；装 `cu13` 会在加载时失败 |
| 驱动主版本 ≥ 580 | 默认 `cu13` |

权重约 27 GB，模型目录放在 NVMe 上，放 SATA 上文本编码每次都要重读（30.9 s vs 6.0 s，实测见 `engine.md`）。

## 第 1 步：选包

上游发布的包名是这个形状，只有两处按平台变：

```
mossinfer-<version>-<os>-<cuda>-x86_64[-sm75][-system-cuda]
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `os` | `windows` / `linux` | 没有别的 |
| `cuda` | `cu12` / `cu13` | 看驱动主版本，见上表 |
| `sm75` | 有 / 无 | 只在 CC 7.5 时出现，且仅 Windows cu13 |
| `system-cuda` | 有 / 无 | 有 = 不自带 CUDA 库；无 = bundled，自带 |

归档后缀：Windows `.zip`，Linux `.tar.gz`。同一个 Release 里有 `SHA256SUMS`，下载后校验。

下载用 `gh release download`（已登录时最省事），没装 gh 就直接 `curl -L -O` 这个地址：

```
https://github.com/xycld/owoinfer/releases/download/<tag>/<包名>.<后缀>
```

**首选 bundled**。`system-cuda` 只省二十几 MB，代价是要自己补 cuBLASLt，除非用户已经有 CUDA 13 的库并且明确要用。

## 第 2 步：放到约定目录

```
<HANA_HOME>/app-data/hana-moss-studio/engine/<包名去后缀>/bin/moss-server[.exe]
<HANA_HOME>/app-data/hana-moss-studio/models/<任意目录名>/
```

`HANA_HOME` 取环境变量的值，没设时是 `~/.hanako`（Windows 上 `%USERPROFILE%\.hanako`）。苔室的 App 只能看见自己的目录与 `app-data`，引擎放别处 App 探不到。模型放别的盘时，不要改 App，改用目录联接把它接进 app-data：

```powershell
# Windows
New-Item -ItemType Junction -Path "$env:HANA_HOME\app-data\hana-moss-studio\models\moss-image-sft" -Target "D:\models\moss-image-sft"
```

```bash
# Linux
ln -s /mnt/nvme/models/moss-image-sft "$HANA_HOME/app-data/hana-moss-studio/models/moss-image-sft"
```

## 第 3 步：Windows 落地

```powershell
$root = "$env:HANA_HOME\app-data\hana-moss-studio\engine"
$ver  = "<版本号>"; $pkg = "mossinfer-$ver-windows-cu13-x86_64"   # 按第 1 步的表拼
New-Item -ItemType Directory -Force $root | Out-Null

# 拿 Release 资产列表，挑对包的 url，下载（两个同名资产在同一个 tag 下）
gh release download "<tag>" --repo xycld/owoinfer --pattern "$pkg.zip" --dir $root
gh release download "<tag>" --repo xycld/owoinfer --pattern "SHA256SUMS" --dir $root

# 校验，再解压
$want = (Select-String -Path "$root\SHA256SUMS" -Pattern "$pkg\.zip").Line.Split(" ")[0]
if ((Get-FileHash "$root\$pkg.zip" -Algorithm SHA256).Hash -ne $want.ToUpper()) { throw "sha256 不符" }
Expand-Archive "$root\$pkg.zip" -DestinationPath $root -Force
Remove-Item "$root\$pkg.zip"
```

产物是 `<root>\<pkg>\bin\moss-server.exe`。`bin\` 里还会有 CUDA 的 DLL（bundled 包），引擎靠 exe 同目录找到它们。

## 第 4 步：Linux 落地

```bash
root="$HANA_HOME/app-data/hana-moss-studio/engine"
ver="<版本号>"; pkg="mossinfer-$ver-linux-cu13-x86_64"          # 按第 1 步的表拼
mkdir -p "$root"

gh release download "<tag>" --repo xycld/owoinfer --pattern "$pkg.tar.gz" --dir "$root"
gh release download "<tag>" --repo xycld/owoinfer --pattern "SHA256SUMS" --dir "$root"

want=$(grep "$pkg.tar.gz" "$root/SHA256SUMS" | cut -d' ' -f1)
echo "$want  $root/$pkg.tar.gz" | sha256sum -c -
tar -xzf "$root/$pkg.tar.gz" -C "$root"
rm "$root/$pkg.tar.gz"

# 必须做：归档里的执行位不一定保留，没有它 spawn 直接 EACCES
chmod 755 "$root/$pkg/bin/moss-server"
```

产物是 `$root/$pkg/bin/moss-server`，**没有扩展名**。`.so` 在同级 `lib/` 下，二进制靠 `RUNPATH=$ORIGIN/../lib` 找它们。

## 第 5 步：system-cuda 缺库才补

只有在选了 `-system-cuda` 包、且 `moss-server` 起不来并报 `libcublasLt.so.N: cannot open shared object file` / 找不到 `cublasLt64_*.dll` 时才做这一步。

库从 NVIDIA 的 PyPI wheel 里取，不用 pip、不用 Python：

| CUDA | 包名 |
| --- | --- |
| cu13 | `nvidia-cublas`、`nvidia-cuda-runtime` |
| cu12 | `nvidia-cublas-cu12`、`nvidia-cuda-runtime-cu12` |

取 wheel 里的 `*.so*` / `*.dll`，放进引擎自己的目录：Windows 放 `bin/`，Linux 放 `lib/`。这样不做任何系统级改动，也不需要 root。

```bash
# 例：Linux + cu13，把 cuBLASLt 补进包内 lib/
pkgdir="$HANA_HOME/app-data/hana-moss-studio/engine/mossinfer-<ver>-linux-cu13-x86_64"
tmp=$(mktemp -d)
for name in nvidia-cublas nvidia-cuda-runtime; do
  url=$(curl -s "https://pypi.org/pypi/$name/json" \
    | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const j=JSON.parse(s);const f=(j.urls||[]).find(u=>/manylinux.*x86_64\.whl$/.test(u.filename));console.log(f?f.url:'')})")
  [ -n "$url" ] || { echo "PyPI 没有 $name 的 Linux wheel"; exit 1; }
  curl -sL "$url" -o "$tmp/$name.whl"
  unzip -oj "$tmp/$name.whl" '*.so*' -d "$pkgdir/lib" >/dev/null
done
ls "$pkgdir/lib" | grep -i cublasLt || { echo "补完仍然没有 cuBLASLt"; exit 1; }
rm -rf "$tmp"
```

`unzip` 缺失时用 `python3 -m zipfile -e` 替代，只取 `*.so*` 条目。

## 第 6 步：拉权重

仓库 `OpenMOSS-Team/MOSS-Image-SFT`，约 27 GB，六个部分：`model_index.json`、`scheduler/`、`transformer/`、`vae/`、`tokenizer/`、`text_encoder/`。

Windows 用仓库里的脚本：

```powershell
pwsh -File scripts/fetch-weights.ps1 -Root "$env:HANA_HOME\app-data\hana-moss-studio\models\moss-image-sft"
```

Linux / macOS 上没有 PowerShell 版本，用这段（同样走 curl 续传，按大小判完整）：

```bash
root="$HANA_HOME/app-data/hana-moss-studio/models/moss-image-sft"
repo=OpenMOSS-Team/MOSS-Image-SFT; ep=https://hf-mirror.com
mkdir -p "$root"

curl -sL --max-time 60 --retry 5 "$ep/api/models/$repo/tree/main?recursive=true" \
  | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{for(const e of JSON.parse(s)){if(e.type!=='file')continue;if(/^(model_index\.json|scheduler\/|transformer\/|vae\/|tokenizer\/|text_encoder\/)/.test(e.path))console.log(e.path.replace(/\t/g,' ')+'\t'+e.size)}})" \
  > /tmp/moss-files.tsv

while IFS=$'\t' read -r p sz; do
  mkdir -p "$root/$(dirname "$p")"
  [ -f "$root/$p" ] && [ "$(stat -c%s "$root/$p")" = "$sz" ] && continue
  echo "→ $p ($sz)"
  curl -L --fail --continue-at - --retry 20 --retry-all-errors --retry-delay 5 \
    --connect-timeout 20 --speed-time 60 --speed-limit 10240 \
    --output "$root/$p" "$ep/$repo/resolve/main/$p" || { echo "失败：$p"; exit 1; }
done < /tmp/moss-files.tsv
```

不要用 `huggingface_hub`：它在部分网络下会切到 Xet 的 CAS 通道，连接建起来但读不动，反复超时。用镜像 + curl 单连接能到 8–11 MB/s。

## 第 7 步：写回设置

苔室从 `settings.json` 读两个路径，启动时读一次：

```
<HANA_HOME>/app-data/hana-moss-studio/settings.json
```

```bash
node -e '
const fs=require("fs"),path=require("path");
const dir=path.join(process.env.HANA_HOME||path.join(require("os").homedir(),".hanako"),"app-data","hana-moss-studio");
const file=path.join(dir,"settings.json");
const cur=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
cur.serverPath=process.argv[1]; cur.modelPath=process.argv[2];
fs.writeFileSync(file,JSON.stringify(cur,null,2)+"\n");
console.log("写入",file);
' "<serverPath 绝对路径>" "<模型目录绝对路径>"
```

写完之后必须重载 App，否则内存里还是旧值。重载用扩展管理（`extension_manager`，`kind=app`、`id=hana-moss-studio`、`action=reload`）。用户也可以自己在扩展详情里点重载，或者在工作区「引擎」里手填这两个路径。

## 第 8 步：验收

不要拿 1024² 验收。用最小的那次：

```
moss_status()
```

它会把引擎拉起来、跑一次 `hello`，报告设备、显存与 cuBLASLt 状态。看到 `running: true` 且没有 `probe.cublaslt.error`，再出图：

```
moss_generate(prompt="一只白猫坐在窗台上，午后阳光", width=512, height=512, steps=8)
```

出图成功才算部署完成。失败时按下面的表往下查。

## 失败对照

| 现象 | 原因 | 下一步 |
| --- | --- | --- |
| `ENOENT` / `没有找到 moss-server` | `serverPath` 指错，或指到了目录而不是可执行文件 | 确认指向 `bin/moss-server[.exe]` |
| `EACCES`（Linux/macOS） | 归档没保留执行位 | `chmod 755 <serverPath>` |
| `libcublasLt.so.N: cannot open shared object file` | system-cuda 包缺库 | 走第 5 步补库，或换 bundled 包 |
| `找不到 cublasLt64_*.dll` | 同上，Windows | 走第 5 步，DLL 放 `bin/` |
| `引擎协议不兼容（protocol 3）` | 装了 3.x 引擎，苔室要 protocol 2 | 换回 2.x 引擎 |
| `arena overflow` | 显存策略与分辨率不匹配，不是部署问题 | 切 `min_memory`，见 `engine.md` |
| `hello` 超时 | 驱动版本不够加载该 CUDA 版本 | 换 `cu12` 包，或升级驱动到 R580+ |
| 引擎起来了但模型加载失败 | `modelPath` 不是 diffusers 根（缺 `model_index.json`） | 指到含 `transformer/`、`vae/`、`text_encoder/` 的那一层 |
