# 把当前工作树的 build 装进宿主：停用 → 卸载 → 安装 → 启用。
# EPERM 多为瞬时句柄，重试三次。
$info = Get-Content "H:\.hanako\server-info.json" -Raw | ConvertFrom-Json
$port = if ($info.network.actualPort) { $info.network.actualPort } else { $info.port }
$base = "http://127.0.0.1:$port"
$headers = @{ Authorization = "Bearer $($info.token)" }
$app = "$base/api/extensions/app:hana-moss-studio"
$pkg = "E:\Hanako\Workspace\Projects\apps\hana-moss-studio\.hana\worktrees\visual-layout-editor\build\hana-moss-studio"

try { Invoke-RestMethod -Method Put -Uri "$app/enabled" -Headers $headers -ContentType "application/json" -Body '{"enabled":false}' | Out-Null } catch {}
Start-Sleep -Seconds 2
try { Invoke-RestMethod -Method Delete -Uri $app -Headers $headers | Out-Null } catch {}

$installed = $false
for ($i = 1; $i -le 3; $i++) {
  try {
    $body = @{ kind = "app"; source = @{ type = "local"; path = $pkg } } | ConvertTo-Json -Depth 4
    $r = Invoke-RestMethod -Method Post -Uri "$base/api/extensions/install" -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
    Invoke-RestMethod -Method Post -Uri "$base/api/extensions/staged/$($r.staged.stagedId)/confirm" -Headers $headers -ContentType "application/json" -Body '{"options":{}}' | Out-Null
    $installed = $true
    Write-Output "install ok (try $i)"
    break
  } catch {
    Write-Output "try $i failed: $($_.Exception.Message.Split([char]10)[0])"
    Start-Sleep -Seconds 3
  }
}

if (-not $installed) { Write-Output "INSTALL FAILED"; exit 1 }

Invoke-RestMethod -Method Put -Uri "$app/enabled" -Headers $headers -ContentType "application/json" -Body '{"enabled":true}' | Out-Null
Invoke-RestMethod -Method Put -Uri "$app/agents/hanako" -Headers $headers -ContentType "application/json" -Body '{"enabled":true}' | Out-Null
Start-Sleep -Seconds 5
$state = Invoke-RestMethod -Uri "$base/api/apps/hana-moss-studio/routes/hana-moss-studio/state" -Headers $headers
Write-Output "enabled; jobs=$($state.jobs.Count)"
