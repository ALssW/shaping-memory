<#
  tools/device-audit/collect.ps1

  塑忆移动端「设备体检」证据采集器。

  设计要点（已确认的问题，改动前先读）：
    1) 截屏必须两步式：先 `screencap` 落到设备内，再 `adb pull`。
       PowerShell 对 `adb shell screencap -p` 做二进制重定向会损坏 PNG。
    2) tier / 列数由设备上报的物理尺寸与密度「算」出来，而不是猜。
       计算口径与 Web 端 WallView.tsx 的 columnCountFor 完全一致，
       因此两侧在同样逻辑宽度下必须得到同样的列数 —— 不一致就是 bug。
    3) 本脚本只负责「采集当前画面」，不负责导航。
       先手动/adb 把 App 切到目标视图，再调本脚本。

  用法见同目录 README.md
#>
[CmdletBinding()]
param(
  # 目标设备序列号，如 emulator-5554；留空则要求当前只有一台在线设备
  [string]$Serial = '',

  # 该次采集对应的视图名，用于产物目录与 meta 标记
  [ValidateSet('wall', 'list', 'viewer', 'search', 'albums', 'tools', 'admin')]
  [string]$View = 'wall',

  # 状态标签，如 phone-portrait / tablet-landscape；留空则按方向自动推导
  [string]$Label = '',

  # adb 路径；留空则按 ANDROID_HOME → 项目内 SDK 的顺序自动探测
  [string]$Adb = '',

  # 产物根目录；默认 tools/device-audit/out
  [string]$OutRoot = ''
)

$ErrorActionPreference = 'Stop'

# 与 Web 端 WallView.tsx columnCountFor 同一套断点，禁止在此另立数值
$BREAKPOINTS = [ordered]@{ xl = 1440; lg = 1024; md = 769 }

# 列表视图列数：与图墙同源，但手机档要给缩略图留出可点面积，故比图墙多一列
$LIST_COLUMNS_BY_WALL = @{ 2 = 3; 3 = 4; 4 = 5; 5 = 6 }

function Resolve-Adb {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path $Explicit)) { throw "指定的 adb 不存在：$Explicit" }
    return $Explicit
  }
  $candidates = @()
  if ($env:ANDROID_HOME) { $candidates += (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe') }
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  $candidates += (Join-Path $repoRoot '.android-sdk\platform-tools\adb.exe')
  foreach ($path in $candidates) {
    if (Test-Path $path) { return $path }
  }
  throw '未找到 adb.exe，请用 -Adb 显式指定路径'
}

function Invoke-Adb {
  param([string[]]$Arguments)
  $prefix = if ($script:Serial) { @('-s', $script:Serial) } else { @() }
  # adb 把「1 file pulled」这类进度写进 stderr；在 Stop 模式下会被当成终止异常，
  # 所以本地降到 Continue，只看退出码判成败。
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $script:AdbPath @prefix @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($exitCode -ne 0) { throw "adb $($Arguments -join ' ') 失败：$output" }
  return ($output -join "`n")
}

function Get-Prop {
  param([string]$Key)
  return (Invoke-Adb @('shell', 'getprop', $Key)).Trim()
}

# 「1080x2400」→ 数字对。wm size 可能返回 Override 行，取最后一条有效值
function ConvertFrom-WmSize {
  param([string]$Raw)
  $matches = [regex]::Matches($Raw, '(\d+)x(\d+)')
  if ($matches.Count -eq 0) { throw "无法解析 wm size 输出：$Raw" }
  $m = $matches[$matches.Count - 1]
  return @{ Width = [int]$m.Groups[1].Value; Height = [int]$m.Groups[2].Value }
}

# 截图的真实像素尺寸（以 PNG 头为准）。
# 【为什么不能拿 wm size 判方向】wm size 报的是「Physical size」，是屏幕的天然分辨率，
# 不随旋转变化 —— 横屏时它还是竖屏那一组数字，据此算出的逻辑宽与列数会整体错档。
# 而 screencap 出来的位图就是当前方向的，从它头上读宽高是唯一不会自相矛盾的口径。
function Get-PngSize {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 24 -or $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50) {
    throw "不是有效的 PNG：$Path"
  }
  # PNG 头布局：8 字节签名 + 4 字节块长 + 4 字节 'IHDR'，其后 4 字节宽、4 字节高（大端）。
  # BitConverter 按小端读，故先把这 4 个字节倒序再交给它。
  $width = [System.BitConverter]::ToUInt32(($bytes[16..19])[3..0], 0)
  $height = [System.BitConverter]::ToUInt32(($bytes[20..23])[3..0], 0)
  return @{ Width = [int]$width; Height = [int]$height }
}

# 「Physical density: 420」→ 420
function ConvertFrom-WmDensity {
  param([string]$Raw)
  $m = [regex]::Match($Raw, '(\d+)')
  if (-not $m.Success) { throw "无法解析 wm density 输出：$Raw" }
  return [int]$m.Groups[1].Value
}

# 逻辑宽度（dp）= 物理宽 / (密度 / 160)
function Get-LogicalWidth {
  param([int]$WidthPx, [int]$DensityDpi)
  return [math]::Round($WidthPx / ($DensityDpi / 160.0), 1)
}

# 与 Web 端 columnCountFor 逐条对齐：>=1440 → 5，>=1024 → 4，>=769 → 3，否则 2
function Get-WallColumns {
  param([double]$LogicalWidth)
  if ($LogicalWidth -ge $BREAKPOINTS.xl) { return 5 }
  if ($LogicalWidth -ge $BREAKPOINTS.lg) { return 4 }
  if ($LogicalWidth -ge $BREAKPOINTS.md) { return 3 }
  return 2
}

function Get-Tier {
  param([double]$LogicalWidth)
  if ($LogicalWidth -ge $BREAKPOINTS.xl) { return 'xl' }
  if ($LogicalWidth -ge $BREAKPOINTS.lg) { return 'lg' }
  if ($LogicalWidth -ge $BREAKPOINTS.md) { return 'md' }
  return 'sm'
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

$script:AdbPath = Resolve-Adb -Explicit $Adb

# 未指定序列号时，要求恰好一台在线设备，避免误采到别的模拟器
if (-not $Serial) {
  $devices = (& $script:AdbPath devices) | Select-String -Pattern '\tdevice$'
  if ($devices.Count -ne 1) {
    throw "在线设备数为 $($devices.Count)，请用 -Serial 明确指定目标设备"
  }
  $script:Serial = ($devices[0] -split '\s+')[0]
}

$physicalSizeRaw = Invoke-Adb @('shell', 'wm', 'size')
$densityRaw = Invoke-Adb @('shell', 'wm', 'density')
$physicalSize = ConvertFrom-WmSize -Raw $physicalSizeRaw
$density = ConvertFrom-WmDensity -Raw $densityRaw

# AVD 名只对模拟器有意义，真机上取不到就留空
$avdName = ''
try { $avdName = (Invoke-Adb @('emu', 'avd', 'name')).Trim().Split("`n")[0].Trim() } catch { }
$deviceFolder = if ($avdName) { $avdName } else { $script:Serial.Replace(':', '-') }
if (-not $OutRoot) { $OutRoot = Join-Path $PSScriptRoot 'out' }

# 先把截图落到产物根目录下的临时位，读到真实像素尺寸后才能定 Label 与目录。
# 截屏必须两步式：先 screencap 落到设备内，再 adb pull；绝不走管道。
$tempShot = Join-Path $OutRoot '_pending.png'
New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
Invoke-Adb @('shell', 'screencap', '-p', '/sdcard/_audit_cap.png') | Out-Null
Invoke-Adb @('pull', '/sdcard/_audit_cap.png', $tempShot) | Out-Null

# 以下全部由截图的真实像素尺寸推导，方向一定与画面自洽
$size = Get-PngSize -Path $tempShot
$logicalWidth = Get-LogicalWidth -WidthPx $size.Width -DensityDpi $density
$logicalHeight = Get-LogicalWidth -WidthPx $size.Height -DensityDpi $density
$wallColumns = Get-WallColumns -LogicalWidth $logicalWidth
$tier = Get-Tier -LogicalWidth $logicalWidth
$listColumns = $LIST_COLUMNS_BY_WALL[$wallColumns]
$orientation = if ($size.Width -gt $size.Height) { 'landscape' } else { 'portrait' }

if (-not $Label) { $Label = "$tier-$orientation" }
$targetDir = Join-Path $OutRoot (Join-Path $deviceFolder $Label)
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Move-Item -Force -Path $tempShot -Destination (Join-Path $targetDir 'shot.png')

# UI 树：同样是设备内落盘再 pull，便于事后 grep 节点 bounds
Invoke-Adb @('shell', 'uiautomator', 'dump', '/sdcard/_audit_ui.xml') | Out-Null
Invoke-Adb @('pull', '/sdcard/_audit_ui.xml', (Join-Path $targetDir 'ui.xml')) | Out-Null

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$commit = ''
try { $commit = (& git -C $repoRoot rev-parse --short HEAD 2>&1).Trim() } catch { }

$meta = [ordered]@{
  serial         = $script:Serial
  avd            = $avdName
  model          = Get-Prop 'ro.product.model'
  apiLevel       = Get-Prop 'ro.build.version.sdk'
  release        = Get-Prop 'ro.build.version.release'
  screenshotWidth  = $size.Width
  screenshotHeight = $size.Height
  wmSize           = "$($physicalSize.Width)x$($physicalSize.Height)"
  densityDpi       = $density
  logicalWidth   = $logicalWidth
  logicalHeight  = $logicalHeight
  orientation    = $orientation
  tier           = $tier
  wallColumns    = $wallColumns
  listColumns    = $listColumns
  view           = $View
  label          = $Label
  appPackage     = 'cn.alsw.shapingmemory'
  commit         = $commit
  capturedAt     = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}

$meta | ConvertTo-Json -Depth 3 | Set-Content -Path (Join-Path $targetDir 'meta.json') -Encoding UTF8

# 设备内的临时文件随手清掉，别在截图目录里留垃圾
Invoke-Adb @('shell', 'rm', '-f', '/sdcard/_audit_cap.png', '/sdcard/_audit_ui.xml') | Out-Null

Write-Host "已采集 $deviceFolder/$Label/$View → $targetDir" -ForegroundColor Green
Write-Host "  逻辑尺寸 ${logicalWidth}x${logicalHeight}dp | tier=$tier | 墙面 $wallColumns 列 | 列表 $listColumns 列"
