# 拉取 MOSS-Image 权重。
# 用 curl 分段续传，绕开 huggingface_hub 的 Xet 路径在部分网络下读超时的问题。
# 已存在的文件按大小判断是否完整，不完整就 --continue-at - 续传。

param(
  [string]$Root = "H:\.hanako\app-data\hana-moss-studio\models\moss-image-sft",
  [string]$Repo = "OpenMOSS-Team/MOSS-Image-SFT",
  [string]$Endpoint = "https://hf-mirror.com",
  [string[]]$Includes = @("model_index.json", "scheduler/*", "transformer/*", "vae/*", "tokenizer/*", "text_encoder/*")
)

$ErrorActionPreference = "Stop"
$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curl) { throw "需要 curl.exe" }

New-Item -ItemType Directory -Force $Root | Out-Null

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -Path (Join-Path $Root "download.log") -Value $line
}

Log "读取文件清单 $Endpoint/api/models/$Repo"
$api = "$Endpoint/api/models/$Repo/tree/main?recursive=true"
$raw = & $curl -sL --max-time 60 --retry 5 $api
if (-not $raw) { throw "取不到文件清单" }
$entries = $raw | ConvertFrom-Json

$wanted = $entries | Where-Object {
  if ($_.type -ne "file") { return $false }
  foreach ($pattern in $Includes) {
    if ($pattern -like "*/*") {
      $prefix = $pattern.Substring(0, $pattern.Length - 2)
      if ($_.path -like "$prefix/*") { return $true }
    } elseif ($_.path -eq $pattern) {
      return $true
    }
  }
  return $false
}

$totalBytes = ($wanted | Measure-Object -Property size -Sum).Sum
Log ("需要 {0} 个文件，合计 {1:N2} GB" -f $wanted.Count, ($totalBytes / 1GB))

$index = 0
foreach ($entry in $wanted) {
  $index++
  $target = Join-Path $Root ($entry.path -replace "/", "\")
  $dir = Split-Path -Parent $target
  New-Item -ItemType Directory -Force $dir | Out-Null

  if (Test-Path $target) {
    $have = (Get-Item $target).Length
    if ($have -eq $entry.size) {
      Log ("[{0}/{1}] 跳过（已完整）{2}" -f $index, $wanted.Count, $entry.path)
      continue
    }
    if ($have -gt $entry.size) {
      Remove-Item $target -Force
    }
  }

  $url = "$Endpoint/$Repo/resolve/main/$($entry.path)"
  $start = Get-Date
  Log ("[{0}/{1}] 开始 {2} ({3:N1} MB)" -f $index, $wanted.Count, $entry.path, ($entry.size / 1MB))
  & $curl -L --fail --continue-at - --retry 20 --retry-all-errors --retry-delay 5 `
    --connect-timeout 20 --speed-time 60 --speed-limit 10240 `
    --output $target $url
  if ($LASTEXITCODE -ne 0) {
    Log ("[{0}/{1}] 失败 exit={2} {3}" -f $index, $wanted.Count, $LASTEXITCODE, $entry.path)
    throw "下载中断：$($entry.path)"
  }
  $got = (Get-Item $target).Length
  if ($got -ne $entry.size) {
    Log ("[{0}/{1}] 大小不符 期望 {2} 实际 {3}" -f $index, $wanted.Count, $entry.size, $got)
    throw "大小校验失败：$($entry.path)"
  }
  $secs = [math]::Max(((Get-Date) - $start).TotalSeconds, 0.1)
  Log ("[{0}/{1}] 完成 {2} 用时 {3:N0}s {4:N2} MB/s" -f $index, $wanted.Count, $entry.path, $secs, ($entry.size / 1MB / $secs))
}

Log "全部完成"
