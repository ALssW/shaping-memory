# tools/device-audit · 设备体检采集器

给塑忆移动端做「四态 × 多视图」证据采集用：一张截图 + 一份 UI 树 + 一份设备元数据，
三者同目录落盘，事后可交叉验证「元素到底有没有渲染出来」。

## 前置

```powershell
$env:ANDROID_HOME      = "D:\dev\env\android-sdk"
$env:ANDROID_USER_HOME = "D:\dev\env\android-data\.android"
$env:ANDROID_AVD_HOME  = "D:\dev\env\android-data\.android\avd"
$env:JAVA_HOME         = "D:\dev\software\Andriod Studio\jbr"   # JDK 25，用于 cmdline-tools
```

启动模拟器（漏掉 `-no-snapshot-load` 会读到上一轮的脏状态）：

```powershell
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd Phone_35_6 -no-snapshot-load
```

让模拟器访问本机后端：

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" -s emulator-5556 reverse tcp:3000 tcp:3000
```

## 采集

先手动（或用 `adb shell input tap`）把 App 切到目标视图，再调脚本：

```powershell
cd tools\device-audit
powershell -ExecutionPolicy Bypass -File .\collect.ps1 -Serial emulator-5556 -View wall -Label sm-portrait
```

用脚本 `-Wait` 起来的话，PowerShell 默认禁止运行脚本，务必带 `-ExecutionPolicy Bypass`。

### 参数

| 参数 | 说明 |
| --- | --- |
| `-Serial` | 设备序列号。留空时要求恰好一台在线设备 |
| `-View` | `wall` / `list` / `viewer` / `search` / `albums` / `tools` / `admin` |
| `-Label` | 状态标签，如 `phone-portrait` / `tablet-landscape`；留空按 tier + 方向自动生成 |
| `-Adb` | adb 路径；默认按 `ANDROID_HOME` → 项目内 `.android-sdk` 顺序探测 |
| `-OutRoot` | 产物根目录，默认本目录下的 `out/` |

### 产物

```
out/<avd 名>/<label>/{shot.png, ui.xml, meta.json}
```

`meta.json` 里有一行关键读数：

```
逻辑尺寸 ${logicalWidth}x${logicalHeight}dp | tier | 墙面 N 列 | 列表 N 列
```

`tier` 与列数是**算出来的**，计算口径与 Web 端 `apps/web/src/components/WallView.tsx`
的 `columnCountFor` 完全一致（`>=1440 → 5` / `>=1024 → 4` / `>=769 → 3` / 否则 `2`）。
两端在同样逻辑宽度下必须得出同样列数 —— 不一致就是 bug，不是配置差异。

## 加一台设备

```powershell
$AVD = "$env:ANDROID_HOME\cmdline-tools\latest-2\bin\avdmanager.bat"
& $AVD list device          # 先确认设备定义 id 存在
& $AVD create avd -n Phone_35_6 -k "system-images;android-35;google_apis_playstore_tablet;x86_64" -d pixel_6 --force
```

### 本机镜像现状（2026-09-25）

| 镜像 | 状态 |
| --- | --- |
| `android-35;google_apis_playstore_tablet;x86_64` | **唯一完整可用** |
| `android-36.1;google_apis_playstore;x86_64` | 空占位目录（只有 `.installer`），不可用 |
| `android-37.2;google_apis_playstore_ps16k;x86_64` | 空占位目录，不可用 |

因此手机 AVD 复用平板镜像 + 手机设备档（`-d pixel_6` / `-d small_phone`）。
该镜像的 `build.prop` 既无 `ro.build.characteristics` 也无 `ro.sf.lcd_density`，
屏幕形态完全由 AVD 的 `hw.lcd.*` 决定，故资源限定符（`sw600dp` 等）按手机视口正确解析。

`cmdline-tools;12.0` 读不了新版 package.xml（XML v3 vs v4），已另装
`cmdline-tools\latest-2`（23.0）；`latest-2` 需 JDK 21+，用 Android Studio 自带 jbr 即可，
用 zulu17 会直接崩溃（`STATUS_STACK_BUFFER_OVERRUN`）。

## 采集后怎么用

1. **目视**：`shot.png` 直接看渲染结果与可读性
2. **存在性**：`ui.xml` 里 grep 节点，占布局但不进 a11y 树 = 未挂载或被移出可视区
3. **可点性**：比对 `bounds` 是否落在屏内，是否有 0 宽/0 高节点
4. **横向对比**：Web 端用 Chrome DevTools 设备模拟设成 `meta.json` 里的
   `logicalWidth × logicalHeight`，产物放 `out/web/<w>x<h>-<view>/`，与移动端同 label 并排看
