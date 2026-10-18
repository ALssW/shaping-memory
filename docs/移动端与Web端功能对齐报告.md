# 移动端与 Web 端功能对齐报告

> 对象：`apps/mobile`（移动端前台） ↔ `apps/web`（Web 前台）
> 目标：补全移动端相对 Web 端缺失的功能，统一交互逻辑、数据反馈与视觉表现，不改变 Web 端已确认的核心业务逻辑。

---

## 一、对齐范围

本次对齐的范围由以下三项裁定确定：

| 维度 | 裁定 | 说明 |
| --- | --- | --- |
| 对齐范围 | 仅移动端**前台** | 涉及画廊 / 影集 / 地图 / 工具四个模块；移动端后台（`src/admin`）与 Web 后台的差异不在本次范围内 |
| 隐私相关 | 仅纳入**密码解锁** | 时效链接分享页（Web 的 `PrivacyShareScreen`）为 Web 独有链路，本次不做 |
| 数据源差异 | **一并对齐** | 分类列表改为后端动态拉取；页头品牌名与标语接入站点设置 |

---

## 二、功能对齐清单

### 2.1 本次补全的功能

| # | 功能点 | Web 端实现 | 移动端实现 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 隐私照片密码解锁 | `components/UnlockDialog.tsx`；`lib/privacy.ts` 广播；查看器锁面板 | 新建 `components/UnlockDialog.tsx`、`lib/privacy.ts`；查看器锁面板 | 已完成 |
| 2 | 解锁后数据自动重取 | `usePhotos` 依赖 `usePrivacyTick`；`App` 地图档依赖 tick；画廊相册详情依赖 tick | `usePhotos` 接入 `usePrivacyTick`；`App` 地图档接入 tick；画廊 / 地图相册详情接入 tick | 已完成 |
| 3 | 实况照片播放 | 查看器内嵌 `<video>`，播放按钮切换 `liveOn` | 引入 `expo-video`，`LiveVideo` 组件；播放按钮切换 `liveOn` | 已完成 |
| 4 | 分类列表动态拉取 | `categoryApi.list()` 拉取后拼 `['全部', ...names]` | 新建 `hooks/useCategories.ts`，画廊 / 地图 / 编辑对话框 / 批量编辑对话框共用 | 已完成 |
| 5 | 页头品牌名 / 标语 | `settingsApi.all()` 读 `site.title` / `site.slogan`，失败回落缺省值 | 同口径接入 `settingsApi.all()`，保留同一份 `BRAND_FALLBACK` | 已完成 |
| 6 | 卡面「实况」角标 | `.photo-card__live`（右上，图标 + 文案） | `TileBadges`，墙面与列表两种视图共用 | 已完成 |
| 7 | 卡面「隐私」角标 | `.photo-card__lock`（左上，锁图标） | `TileBadges`，墙面与列表两种视图共用 | 已完成 |

### 2.2 交互逻辑与数据反馈一致性

| 项 | 对齐口径 |
| --- | --- |
| 解锁面板文案 | 「这张照片需要授权」/「请输入查看密码」/「尚未配置查看密码，请联系管理员开通授权」/ 失败「密码不正确，请重试」/ 忙碌「验证中…」——与 Web 逐字一致 |
| 解锁密码路径 | 有独立密码走 `POST /privacy/photos/:id/unlock`；否则走全局 `POST /privacy/unlock`——与 Web 判定条件一致 |
| 票据流转 | 解锁成功后写入 SDK，再广播一次解锁事件，各处列表带票据重新拉取——与 Web 同一链路 |
| 解锁入口 | 仅从查看器锁面板进入（锁面板压在服务端下发的模糊图之上） |
| 实况播放按钮显隐 | 仅当 `isLive && liveUrl && !locked` 时显示；锁定时不显示任何原图元素 |
| 实况播放参数 | 静音、循环、`contain`、关闭原生控件、挂载即播 / 卸载即停 |
| 查看器翻页复位 | 换片时 `liveOn` 与 `unlockOpen` 同时复位为 `false` |
| 角标层级 | 选择态角标与实况 / 隐私角标各自独立，同屏可同时出现 |
| 角标视觉 | 材质 ultra-thick；实况角标 height 22、右上 `space-8`、`padding 0 s8 0 s6`、圆角 full、gap `s4`、caption + semibold、图标 11px accent；隐私角标 22×22、左上 `space-8`、图标 12px accent |
| 锁面板视觉 | 铺满舞台、材质 thick、居中、gap `space-12`；图标圆 46px、淡洗底为 accent 12%、字形 accent、图标 22px |

### 2.3 平台合理差异（不视为功能缺失）

以下差异是移动端设备特性的必然选择，交互语义与 Web 等价，核心业务逻辑未变：

| Web 端 | 移动端 | 说明 |
| --- | --- | --- |
| 原片下载 | 「查看原图」就地预览 | 触屏无文件下载语义，改为就地切原图 |
| EXIF 右侧卡片 / 侧栏 | 底部抽屉（`MetaSheet`） | 窄屏空间约束 |
| 鼠标悬停蒙版 | 长按浮层（`TilePeek`） | 触屏无 hover，长按为对等手势 |
| 左侧进度轨 | 底部时间线横轨 / 不渲染 | 手机上拖拽与页面滚动冲突，Web 窄屏分支同样处理 |
| 自定义光标 / 键盘快捷键 | 不适用 | 无对应输入设备 |
| 墙面列式瀑布流 | 按批渲染（非 FlatList 虚拟化） | 列内连续堆叠的结构要求 |

### 2.4 移动端超出 Web 端的部分（保留，不回退）

影集分组管理、画廊全选 / 取消全选、保存到相册、顶栏多一个「后台」导航项。

### 2.5 明确不在本次范围

- 移动端后台（`src/admin`）相对 Web 后台缺失的管理页；
- 隐私时效链接分享页（`PrivacyShareScreen`）。

---

## 三、变更文件

### 新建

| 文件 | 用途 |
| --- | --- |
| `apps/mobile/src/lib/privacy.ts` | 解锁广播通道（RN 无 `window` / `EventTarget`，改用订阅表）+ `usePrivacyTick` |
| `apps/mobile/src/components/UnlockDialog.tsx` | 隐私照片密码解锁面板 |
| `apps/mobile/src/hooks/useCategories.ts` | 分类候选列表（后端动态拉取，失败静默降级为仅「全部」） |

### 修改

| 文件 | 变更 |
| --- | --- |
| `apps/mobile/src/hooks/usePhotos.ts` | 依赖接入 `usePrivacyTick`，解锁后自动重取 |
| `apps/mobile/src/components/primitives.tsx` | 新增 `lock` / `play` / `pause` / `live` 图标（`live` 走 MDI 同心圆字形） |
| `apps/mobile/src/screens/Viewer.tsx` | 实况视频层 + 播放按钮 + 锁定面板 + 解锁弹窗挂载 + 翻页复位 |
| `apps/mobile/src/screens/GalleryScreen.tsx` | 分类动态拉取、隐私 tick、`TileBadges` 接入墙面与列表 |
| `apps/mobile/src/screens/MapScreen.tsx` | 分类动态拉取、隐私 tick |
| `apps/mobile/src/components/EditDialog.tsx` | 分类改为 `useCategories` |
| `apps/mobile/src/components/BatchEditDialog.tsx` | 分类改为 `useCategories` |
| `apps/mobile/src/components/TopNav.tsx` | 品牌名 / 标语接入 `settingsApi.all()` |
| `apps/mobile/App.tsx` | 地图档依赖接入 `usePrivacyTick` |
| `apps/mobile/app.json` | plugins 新增 `expo-video` |
| `apps/mobile/package.json` | 新增依赖 `expo-video: ~2.0.6` |

---

## 四、测试报告

### 4.1 已执行的验证

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 类型检查（四端） | `npm run typecheck`（api / web / admin / mobile，`tsc --noEmit`） | 全部通过，无错误 |
| 依赖安装 | `npx.cmd expo install expo-video` | 成功，`~2.0.6` 与 Expo SDK 52 兼容 |
| 静态对照 | 逐项比对 Web 端组件 / 样式与移动端实现（文案、参数、层级、色值、尺寸） | 一致（详见第二节） |
| 接线核查 | 全局检索 `useCategories` / `usePrivacyTick` / `settingsApi` 引用点 | 画廊、地图、两个编辑对话框、页头、`usePhotos`、`App` 均已接入 |

### 4.2 静态对照结论

- 隐私解锁：移动端与 Web 端的密码路径判定、票据流转、广播重取、文案与色值完全一致；
- 实况播放：播放参数、按钮显隐条件、翻页复位与 Web 一致；
- 角标：墙面与列表两种视图共用同一组件，实况（右上）/ 隐私（左上）的位置与尺寸与 Web 一致；
- 分类列表：两端均为「先拉列表、再拼『全部』」，编辑对话框同样收到含「全部」的列表；
- 品牌名 / 标语：两端均读站点设置、失败回落同一份缺省值。

### 4.3 运行期对照测试清单（需在真机 / 模拟器执行）

以下为端到端运行时验证项，需在装有 Expo 客户端的设备或模拟器上逐项确认：

| # | 测试项 | 步骤 | 预期 |
| --- | --- | --- | --- |
| R1 | 隐私照片解锁 | 打开锁定的照片 → 点「输入密码解锁」→ 输入正确密码 | 面板关闭，模糊图转为清晰原图 |
| R2 | 密码错误反馈 | 解锁面板输入错误密码 | 显示「密码不正确，请重试」，面板不关闭 |
| R3 | 无可用密码提示 | 全局未配置密码时打开解锁面板 | 显示「尚未配置查看密码，请联系管理员开通授权」，输入框禁用 |
| R4 | 解锁后全局重取 | 解锁后返回画廊 / 地图 | 受保护照片同步转为可见，无需手动刷新 |
| R5 | 实况播放 | 打开实况照片 → 点播放按钮 | 视频在照片上播放；再点按钮停播 |
| R6 | 锁定时不显实况控件 | 打开锁定中的实况照片 | 不出现播放按钮，仅显示锁面板 |
| R7 | 翻页复位 | 播放实况 / 打开解锁面板后翻到下一张 | 视频停止，解锁面板关闭 |
| R8 | 角标显示 | 浏览墙面与列表视图 | 实况照片右上角标、隐私照片左上角标常驻显示 |
| R9 | 角标并存 | 浏览一张既实况又受保护的照片 | 两个角标分别在右上、左上同时显示 |
| R10 | 分类动态拉取 | 后台新增分类后重开画廊 / 地图 | 筛选 chip 出现新分类；编辑对话框分类项同步 |
| R11 | 品牌名 / 标语 | 后台修改站点标题与标语后重开应用 | 页头文案随设置变化；接口不可用时回落缺省值 |
| R12 | 分类接口失败降级 | 断网 / 接口异常时打开画廊 | 筛选条仅保留「全部」，页面不报错 |

### 4.4 已知限制与前置条件

1. `expo-video` 为原生模块，接入后需重新执行 `expo prebuild` 并重打包应用（Expo Go 客户端自带的模块版本可能与项目声明版本不一致，需以预构建产物为准）；
2. `expo-video` 的安装若失败并提示 `EPERM ... C:\Users\<用户>\.expo`，属沙箱对缓存目录的写入限制，需在非受限环境下重试；
3. 运行期对照测试（第 4.3 节）依赖真机 / 模拟器，本次未在本流程内执行，需按清单人工确认；
4. 移动端后台与 Web 后台的功能差异、隐私时效链接分享页，均不在本次范围内。

---

## 五、结论

移动端前台相对 Web 端前台的功能缺失已按 Web 端的功能逻辑、交互规范与视觉标准补全并适配，两端在操作流程、数据反馈与异常处理上保持一致；四端类型检查通过，静态对照无偏差。剩余运行期对照测试需按第 4.3 节清单在真机上确认。
