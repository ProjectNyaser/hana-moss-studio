# 部署（仅 Windows x64）

苔室只支持 **Windows x64**。其他平台不部署，直接告诉用户这台机器跑不了，不要试着变通。

## 支持面

| 平台 | 状态 |
| --- | --- |
| Windows x64 | 支持，实机验证过（RTX 4050 Laptop 6GB + CUDA 13 + NVMe） |
| Linux x64 | 引擎上游有正式资产，苔室没验证过，不承诺 |
| macOS | 没有任何引擎构建，不可用 |

硬盘、显卡、驱动的门槛照旧：NVIDIA 卡，驱动主版本 ≥ 580 才能用 cu13。

## 先判能不能跑

```powershell
nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader
node -p "process.platform + ' ' + process.arch"
```

| 条件 | 结论 |
| --- | --- |
| 不是 `win32 x64` | **停**。告诉用户只支持 Windows x64 |
| `nvidia-smi` 不存在或报错 | **停**。没有 NVIDIA 卡，或驱动没装 |
| compute_cap < 7.5 | **停**。上游只产出 7.5 与 ≥ 8.0 两档 |
| compute_cap = 7.5 | 只能用 `-sm75` 包，且必须 cu13 |
| 驱动主版本 < 580 | 只能装 `cu12` |
| 驱动主版本 ≥ 580 | 默认 `cu13` |
| 可用空间 < 30 GB | 权重放不下 |

权重约 27 GB，放 NVMe。放 SATA 上文本编码每次重读，30.9 s 对 6.0 s（实测见 `engine.md`）。

## 选包

Windows 只有 zip，包名形状固定：

```
mossinfer-<version>-windows-<cuda>-x86_64[-sm75][-system-cuda].zip
```

| 字段 | 取值 |
| --- | --- |
| `cuda` | `cu12` / `cu13`，看驱动主版本 |
| `sm75` | 只在 compute_cap 7.5 时出现，且只配 cu13 |
| `system-cuda` | 有 = 不自带 CUDA 库；无 = bundled |

发布页：

```
https://github.com/mossimage-cpp/mossimage.cpp/releases
```

同目录有 `SHA256SUMS`，下完必校验。**首选 bundled**：`system-cuda` 只省二十几 MB，代价是自己补 cuBLASLt。

## 落地

目录约定：

```
<HANA_HOME>/app-data/hana-moss-studio/engine/<包名去 .zip>/bin/moss-server.exe
<HANA_HOME>/app-data/hana-moss-studio/models/<任意目录名>/
```

`HANA_HOME` 取环境变量，没设时是 `%USERPROFILE%\.hanako`。

```powershell
$root = "$env:HANA_HOME\app-data\hana-moss-studio\engine"
$pkg  = "mossinfer-<ver>-windows-<cu>-x86_64"     # 按上面的表拼，sm75 与 system-cuda 按需加
$tag  = "v<ver>"
New-Item -ItemType Directory -Force $root | Out-Null
Set-Location $root

$base = "https://github.com/mossimage-cpp/mossimage.cpp/releases/download/$tag"
curl.exe -L -O "$base/$pkg.zip"
curl.exe -L -O "$base/SHA256SUMS"

# 校验 + 解压 + 定位可执行文件
node -e '
const fs=require("fs"),path=require("path"),c=require("crypto"),cp=require("child_process");
const pkg=process.argv[1], file=pkg+".zip";
const want=fs.readFileSync("SHA256SUMS","utf8").split("\n")
  .find(l=>l.includes(file))?.trim().split(/\s+/)[0];
if(!want) throw new Error("SHA256SUMS 里没有 "+file);
const got=c.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if(got!==want.toLowerCase()) throw new Error("sha256 不符："+got);
cp.execFileSync("tar",["-xf",file],{stdio:"inherit"});   // Windows 10+ 的 tar 是 bsdtar，能解 zip
fs.unlinkSync(file);
// 包内是单一顶层目录，里面 bin\moss-server.exe
const tops=fs.readdirSync(".").filter(n=>fs.statSync(n).isDirectory());
if(tops.length!==1) throw new Error("包结构不符：应有单一顶层目录，实际 "+tops.join(","));
const bin=path.join(tops[0],"bin","moss-server.exe");
if(!fs.existsSync(bin)) throw new Error("包里没有 "+bin);
console.log("引擎目录 "+path.resolve(tops[0]));
console.log("就绪    "+path.resolve(bin));
' "$pkg"
```

末尾两行是后面要用的绝对路径：**引擎目录**（补库用）与 **serverPath**（写设置用）。

## 只有 system-cuda 才补库

选的是 `-system-cuda` 包、且引擎报找不到 `cublasLt64_*.dll` 时才做。DLL 从 NVIDIA 的 PyPI wheel 里取，不用 pip、不用 Python：

| CUDA | 包名 |
| --- | --- |
| cu13 | `nvidia-cublas`、`nvidia-cuda-runtime` |
| cu12 | `nvidia-cublas-cu12`、`nvidia-cuda-runtime-cu12` |

```powershell
node -e '
const fs=require("fs"),path=require("path"),cp=require("child_process"),os=require("os");
const dir=process.argv[1], flavour=process.argv[2];
const pkgs=flavour==="cu13"?["nvidia-cublas","nvidia-cuda-runtime"]:["nvidia-cublas-cu12","nvidia-cuda-runtime-cu12"];
const dest=path.join(dir,"bin");          // Windows 上引擎从 exe 同目录找 DLL
fs.mkdirSync(dest,{recursive:true});
(async()=>{
  for(const name of pkgs){
    const meta=await (await fetch("https://pypi.org/pypi/"+name+"/json")).json();
    const file=(meta.urls||[]).find(u=>/win_amd64\.whl$/i.test(u.filename));
    if(!file) throw new Error("PyPI 没有 "+name+" 的 Windows wheel");
    const buf=Buffer.from(await (await fetch(file.url)).arrayBuffer());
    const tmp=path.join(os.tmpdir(),file.filename);
    fs.writeFileSync(tmp,buf);
    cp.execFileSync("tar",["-xf",tmp,"-C",dest],{stdio:"inherit"});
    fs.unlinkSync(tmp);
  }
  if(!fs.readdirSync(dest).some(n=>/cublasLt/i.test(n))) throw new Error("补完仍然没有 cuBLASLt");
  console.log("已补进 "+dest);
})().catch(e=>{console.error(e.message);process.exit(1)});
' "<引擎目录>" "<cu12|cu13>"
```

wheel 是 zip，`tar -xf` 能解；解完把非 DLL 的文件删掉即可，留在 `bin\` 里不影响引擎。

## 拉权重

仓库 `OpenMOSS-Team/MOSS-Image-SFT`，六个部分：`model_index.json`、`scheduler/`、`transformer/`、`vae/`、`tokenizer/`、`text_encoder/`。

```powershell
node scripts/fetch-weights.mjs
```

默认落到 `<HANA_HOME>/app-data/hana-moss-studio/models/moss-image-sft`，`--root` 改目录，`--endpoint` 换镜像。单连接按字节范围续传，按大小判完整，中断重跑接着下。

不要用 `huggingface_hub`：它在部分网络下会切到 Xet 的 CAS 通道，连接建起来但读不动，反复超时。

## 写回设置与验收

苔室启动时读一次 `settings.json`：

```powershell
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const dir=path.join(process.env.HANA_HOME||path.join(os.homedir(),".hanako"),"app-data","hana-moss-studio");
fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,"settings.json");
const cur=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
cur.serverPath=process.argv[1]; cur.modelPath=process.argv[2];
fs.writeFileSync(file,JSON.stringify(cur,null,2)+"\n");
console.log("写入 "+file);
' "<serverPath>" "<模型目录>"
```

写完必须重载 App，否则内存里还是旧值：`extension_manager`，`kind=app`、`id=hana-moss-studio`、`action=reload`。用户也可以自己在扩展详情里点重载，或在工作区「引擎」里手填这两个路径。

验收用苔室自己的工具，不要拿 1024² 试：

```
moss_status()
moss_generate(prompt="一只白猫坐在窗台上，午后阳光", width=512, height=512, steps=8)
```

`moss_status()` 会把引擎拉起来跑一次 `hello`，报设备、显存与 cuBLASLt 状态。出图成功才算部署完成。

## 失败对照

| 现象 | 原因 | 下一步 |
| --- | --- | --- |
| 工具回「只支持 Windows x64」 | 平台不对 | 没有替补方案，说清即可 |
| `ENOENT` / `没有找到 moss-server` | `serverPath` 指错，或指到了目录 | 指向 `bin\moss-server.exe` |
| 找不到 `cublasLt64_*.dll` | 装的是 system-cuda，库里没有 | 补库，或换 bundled 包 |
| `引擎协议不兼容（protocol 3）` | 装了 3.x 引擎，苔室要 protocol 2 | 换回 2.x |
| `hello` 超时 | 驱动加载不了该 CUDA 版本 | 换 `cu12`，或升级驱动到 R580+ |
| 引擎起来但模型加载失败 | `modelPath` 不是 diffusers 根 | 指到含 `transformer/`、`vae/`、`text_encoder/` 的那层 |
| `arena overflow` | 显存策略与分辨率不匹配，不是部署问题 | 切 `min_memory`，见 `engine.md` |
