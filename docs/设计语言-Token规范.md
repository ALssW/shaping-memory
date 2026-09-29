# 设计语言 · Token 规范（Web / React Native）

> 本规范是塑忆工程端的**设计语言唯一入口**。它把「照片是唯一光源，其余皆是其前的玻璃」这套
> 设计语言，翻译成两端（Web / React Native）可直接消费的 token。
>
> - **唯一事实源**：[`packages/design-tokens/tokens.json`](../packages/design-tokens/tokens.json)（DTCG 格式）
> - **产物**：`packages/design-tokens/web/`（CSS + TS），两端共用同一份产物
> - **校验**：`node packages/design-tokens/scripts/check-tokens.mjs`
>
> 当本规范与产物冲突时，以 `tokens.json` 为准；当 `tokens.json` 与本规范冲突时，视为本规范陈旧，
> 应在同一个改动里同时修正两者。

---

## 1. 设计语言的核心原则

正式工程里所有界面决策都应能回溯到下面五条。它们不是修辞，是约束。

| 原则 | 含义 | 落到 token 上 |
| --- | --- | --- |
| **照片是唯一光源** | 界面外壳永远暗、半透明、退到照片之后；深度来自叠加的透明层，不来自投影 | `color.material.*` + `blur.*` + `elevation.*` 必须成对出现 |
| **控件一律不画描边** | 所有控件——图标按钮、胶囊、chip、preset、输入框、玻璃卡片/面板、状态徽章——一律无描边。交互与层级只靠「材质深浅 + 模糊 + 阴影 + accent 淡洗底」表达，不靠边线。发丝描边仅用于**分隔线**与**树形连接线**两类结构线 | 控件不引用 `color.border.*` / `opacity.accent.border` / `opacity.state.border` |
| **强调色是色调，不是填充** | 除主按钮与激活态外，accent 一律低透明度出现 | `opacity.accent.*`（border 0.2 / wash 0.12 / hover 0.1 / subtle 0.05） |
| **层级靠沿同一族向下走** | 表达层级时在同一颜色族内降低透明度，而不是换一个色相 | `color.text.base → secondary → tertiary → quaternary → quinary`；禁止为此引入灰色阶（唯一例外见 §1.3） |
| **不需要的控件退到零** | 次要操作默认 `opacity: 0`，hover 才出现 | 与 `motion.duration.base` 配合，不用 JS 控制 hover |

### 1.1 暗色是唯一方案

`color.background` 是 `#1c1c1e`（Apple dark `systemBackground`）。**不提供浅色模式、不做主题切换、
不写 `prefers-color-scheme` 分支。** 新组件上写 `dark:` 变体是冗余的——它恒为真。

### 1.2 强调色的两级推导

1. **站点级**：`color.accent` 默认 `#e8a33c`，可由后端 `siteConfig.accentColor` 覆盖。
2. **照片级**：从照片 thumbhash 提取主色，并把它对 `#1c1c1e` 的 WCAG 对比度**钳制到 2.2 – 4.5** 区间内。
   亮到能读，暗到不与照片争光。钳制函数属于实现层（`packages/image` 或 Web 的 `lib/color`），不产出 token。

> 因为 accent 可配置，所有强调色的透明变体都必须**由 `color.accent` 乘以不透明度得到**，
> 不允许把 `#e8a33c` 的 rgba 写死进产物——那会在换 accent 时失真。

### 1.3 语义状态色是唯一允许的换色相

`color.danger`（`#ff453a`）与 `color.success`（`#30d158`）是**状态语义**，不是第三、第四个强调色。

- **取值理由**：`color.background` 取自 Apple dark `systemBackground`，因此状态色同样取 Apple dark 系统色
  （`systemRed` / `systemGreen`），与既有层级体系同源，不引入第二套色彩语言。
- **使用范围**：只允许出现在四处——① 状态徽章（失败 / 已删除 / 上传完成）② 破坏性操作与删除类按钮
  ③ 结果反馈（Toast、提示条）④ 光标合焦态（`--cursor-pointer` 及以后的方框，见 §4.6）。
  **绝不允许**用于装饰、区块强调或与 accent 争夺注意力。
- **档位同形**：状态色同样只作「色调」出现，因此 `opacity.state.*` 与 `opacity.accent.*` 同形
  （border 0.2 / wash 0.12 / hover 0.1）。danger 与 success **共用同一组档位**，保证两侧对称；
  不新增第三组数值。
- **不可配置**：状态色不可被 `siteConfig` 覆盖——语义色一旦随站点变化，「红=失败」的共识就会失效。

> 换色相的禁令针对的是「层级」（层级靠透明度，不靠色相）。状态是另一回事：状态本来就不是层级，
> 它必须一眼可辨，所以它是这条规则的**唯一**例外。

---

## 2. 命名映射规则

`tokens.json` 里的路径是唯一命名来源，两端按固定规则机械派生。**禁止手写第二套命名。**

### 2.1 派生规则

| 目标 | 规则 | 示例 |
| --- | --- | --- |
| **DTCG 路径** | 全小写短横线，按「族 → 语义 → 档位」分组 | `color.text.secondary` |
| **CSS 变量** | `--` + 各级原样拼接（已含短横线，不再变形） | `--color-text-secondary` |
| **TypeScript** | 同级嵌套，每段转 camelCase；**数字段加 `s` 前缀** | `tokens.color.text.secondary`、`tokens.space.s16` |

数字段加前缀的原因：TS 的标识符不能以数字开头，`space.16` 无法直接写成属性名。

### 2.2 特例：非标量与配方型 token

| Token | 产物形态 |
| --- | --- |
| `font.family.*` | CSS 输出为逗号拼接的 font-family 字符串；TS 输出为字符串数组 |
| `elevation.*` | **配方型**，不是标量。CSS 输出为一个完整的 `box-shadow` 字符串；TS 输出为 `{ tint, alpha, offsetY, blur }` 结构数组。详见 §4.4 |
| `motion.spring.*` | CSS 端不直接消费（用 `motion.easing.*` 近似）；TS 端输出为带 `duration` / `bounce` 的对象 |
| `motion.easing.*` | CSS 输出 `cubic-bezier(...)`；TS 输出为字符串 |

### 2.3 顶层族 → CSS 变量前缀

TS 侧所有 token 都挂在同一个 `tokens` 对象下、按同样的层级嵌套，没有按族分装；
下表只用于确定 CSS 变量前缀。

| DTCG 顶层 | CSS 变量前缀 |
| --- | --- |
| `color` | `--color-*` |
| `opacity` | `--opacity-*` |
| `blur` | `--blur-*` |
| `radius` | `--radius-*` |
| `space` | `--space-*` |
| `size` | `--size-*` |
| `font` | `--font-*` |
| `elevation` | `--elevation-*` |
| `motion` | `--motion-*` |
| `z` | `--z-*` |

---

## 3. Token 全表

> 数值以 [`tokens.json`](../packages/design-tokens/tokens.json) 为准，下表用于评审与检索。

### 3.1 颜色 `color.*`

| Token | 值 | 用途 |
| --- | --- | --- |
| `color.background` | `#1c1c1e` | 唯一背景色 |
| `color.accent` | `#e8a33c` | 站点级强调色（可覆盖） |
| `color.accent-secondary` | `#c98a2e` | 渐变末端等「更暗一档」场合 |
| `color.danger` | `#ff453a` | 语义状态色·失败 / 破坏性（§1.3） |
| `color.success` | `#30d158` | 语义状态色·成功反馈（§1.3） |
| `color.text.base` | `#f5f5f7` | 主文字 |
| `color.text.secondary` | `rgba(245,245,247,.62)` | 次级文字、导航默认态 |
| `color.text.tertiary` | `rgba(245,245,247,.44)` | 说明文字、元信息标签 |
| `color.text.quaternary` | `rgba(245,245,247,.3)` | 极弱提示 |
| `color.text.quinary` | `rgba(245,245,247,.2)` | 分隔、占位 |
| `color.fill.base` | `rgba(255,255,255,.075)` | 图标按钮 hover 底 |
| `color.fill.secondary` | `rgba(255,255,255,.06)` | — |
| `color.fill.tertiary` | `rgba(255,255,255,.045)` | — |
| `color.fill.quaternary` | `rgba(255,255,255,.03)` | — |
| `color.border.base` | `rgba(255,255,255,.1)` | 中性发丝描边，**仅用于分隔线与树形连接线**；任何控件都不用（见 §1 / §4.4） |
| `color.border.on-photo` | `rgba(255,255,255,.1)` | 同上；压在照片上的徽章也不用描边，靠 `color.material.ultra-thick` + 模糊保可读性 |
| `color.material.opaque` | `rgba(24,24,26,.92)` | 全遮蔽背板（查看器背景） |
| `color.material.ultra-thick` | `rgba(30,30,32,.86)` | 直接压在照片上的外壳（可读性优先） |
| `color.material.thick` | `rgba(36,36,39,.72)` | 标准悬浮面板 |
| `color.material.medium` | `rgba(40,40,43,.55)` | 标准悬浮面板（更透） |
| `color.material.thin` | `rgba(44,44,47,.35)` | 需要看清下层的淡洗 |
| `color.material.ultra-thin` | `rgba(48,48,51,.18)` | 最淡的洗色 |

### 3.2 不透明度 `opacity.*`

| Token | 值 | 用途 |
| --- | --- | --- |
| `opacity.accent.border` | `0.2` | accent 细描边。**正式工程已不使用**（控件一律无描边），保留待用 |
| `opacity.accent.wash` | `0.12` | 激活态背景 / 淡洗 |
| `opacity.accent.hover` | `0.1` | 文字按钮 hover |
| `opacity.accent.subtle` | `0.05` | 极淡强调 |
| `opacity.accent.selection` | `0.3` | 文本选区高亮（`::selection`） |
| `opacity.state.border` | `0.2` | 状态描边。正式工程已不使用，保留待用（状态徽章改靠 wash 底 + 状态色文字区分） |
| `opacity.state.wash` | `0.12` | 状态徽章背景 / 破坏性按钮淡底 |
| `opacity.state.hover` | `0.1` | 破坏性文字按钮 hover 背景 |
| `opacity.disabled` | `0.4` | 禁用态 |

### 3.3 模糊 `blur.*`

**按角色选，只有三档，禁止引入第四档。**

| Token | 值 | 角色 |
| --- | --- | --- |
| `blur.sm` | `6px` | 模态背后的遮罩 / scrim |
| `blur.md` | `14px` | 压在照片上的二级控件 |
| `blur.xxl` | `38px` | 悬浮面板、菜单、浮层、Toast、查看器外壳 |

> 内容需要在固定边缘下**渐隐**而不是撞上硬边界时，用渐进模糊（8 层 `backdrop-filter` 叠加
> `linear-gradient` 遮罩，即 Afilmory 的 `LinearBlur`），它不是这三档的替代品。

### 3.4 圆角 `radius.*`

核心规律：**容器比它内部的条目圆一档。**

| Token | 值 | 用途 |
| --- | --- | --- |
| `radius.xxl` | `20px` | 对话框、hover 卡、Toast、Hero 块 |
| `radius.xl` | `16px` | 菜单、气泡、中等卡片、照片项 |
| `radius.lg` | `12px` | 分段控件、输入框、头部按钮 |
| `radius.md` | `9px` | 分段项、列表行、EXIF 行 |
| `radius.sm` | `7px` | 最小内部条目 |
| `radius.full` | `999px` | 圆形图标按钮、胶囊徽章、chip |

### 3.5 间距 `space.*`

4px 基准栅格，命名即像素值：`2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 64`。
其中 `space.64` 专门用于模块顶部留白，以避开 48px 悬浮导航。

### 3.6 尺寸 `size.*`

| Token | 值 | 用途 |
| --- | --- | --- |
| `size.icon-button.default` / `.compact` | `32 / 28px` | 图标按钮容器 |
| `size.icon.default` / `.compact` | `18 / 16px` | 图标字形尺寸，与上面两档一一配套 |
| `size.button.xs / sm / md / lg / xl` | `24 / 32 / 40 / 44 / 48px` | 文字按钮档位，默认 `sm` |
| `size.chip` | `26px` | 筛选 chip |
| `size.header` | `48px` | 悬浮页头 |
| `size.timeline-track` | `16px` | 时间线进度轨命中区（视觉细线 3px） |

**圆形图标按钮只有两档**，不得自创第三档。

### 3.7 字体 `font.*`

家族：

| Token | 用途 |
| --- | --- |
| `font.family.sans` | 默认：`Geist` → CJK 回退栈 |
| `font.family.serif` | 编辑性时刻（年份大标题），CJK 优先 |
| `font.family.mono` | EXIF 数值与原始数据 |

字号：刻意偏密，`body` 与 `meta` 覆盖 UI 中绝大多数文字。

| Token | 值 | 用途 |
| --- | --- | --- |
| `font.size.caption` | `10px` | 徽章、角标 |
| `font.size.meta` | `11px` | EXIF、时间戳、计数 |
| `font.size.label` | `12px` | 导航项、chip、次级正文 |
| `font.size.body` | `13px` | 正文默认档 |
| `font.size.heading` | `15px` | 区块标题、日期大号数字 |
| `font.size.title` | `19px` | 年份大标题（衬线） |
| `font.size.hero` | `30px` | 空态 / Hero |

字重 `400 / 500 / 600 / 700`；字距 `tight -0.01em` · `normal 0` · `wide 0.01em` · `meta 0.02em` · `brand 0.14em`；
行高（无单位倍数）`tight 1.2` · `snug 1.35` · `normal 1.5` · `relaxed 1.7`。

> **字距约束**：`tracking.brand` 这类宽字距只用于全大写拉丁字母或数字标签，**中文不加字距**。
> **归一约定**：原型中散落的 `10.5 / 11.5 / 12.5 / 13.5` 一律归一到上表整数档。

### 3.8 阴影 `elevation.*`

配方型 token，每层由 `tint` + `alpha` + 位移/模糊描述：

| Token | 组成 |
| --- | --- |
| `elevation.context` | accent 8% @ y8 blur32 · accent 6% @ y4 blur16 · 黑 10% @ y2 blur8 |
| `elevation.neutral` | 黑 6.7% ×3 层（y6/blur24 · y3/blur10 · y1/blur4） |

一道硬阴影是错的。任何玻璃面优先用 `elevation.neutral`，而不是 Tailwind 的 `shadow-md` / `shadow-lg`。

### 3.9 动效 `motion.*`

**按「什么在动」分两套系统。**

| 情况 | 用哪套 |
| --- | --- |
| 改变**位置或尺寸**（布局、进出场、手势、共享元素） | `motion.spring.*`，Web 端用 `motion.easing.*` 作近似 |
| 只改 **opacity / color** 等非空间状态 | `motion.duration.*` + CSS transition |

| Token | 值 | 用途 |
| --- | --- | --- |
| `motion.duration.fast` | `150ms` | 按下态即时反馈 |
| `motion.duration.base` | `200ms` | hover / focus / active 默认档 |
| `motion.duration.slow` | `300ms` | 较慢淡入与揭示 |
| `motion.spring.smooth` | duration `0.4` bounce `0` | 默认 |
| `motion.spring.snappy` | duration `0.4` bounce `0.15` | 控件与开关 |
| `motion.spring.bouncy` | duration `0.4` bounce `0.3` | 回弹档：回弹幅度最大，克制使用 |
| `motion.easing.smooth` | `cubic-bezier(.22,.61,.36,1)` | Web 侧 smooth 近似 |
| `motion.easing.snappy` | `cubic-bezier(.34,1.3,.5,1)` | Web 侧 snappy 近似 |
| `motion.easing.in-out` | `cubic-bezier(.45,0,.55,1)` | 对称 ease-in-out：**起止两端都该慢下来**的位移（进度轨刻度标签的左右换边） |

> **禁止**手写 `cubic-bezier` 或仅给 `duration` 的 tween 来表达空间运动。

> `smooth` / `snappy` 都是「快起慢收」，适合一次性到位（进场、抬起、翻页）；
> `in-out` 是唯一**对称**的一条，专给「同一个元素还会滑回原位」的往复位移用 ——
> 起点与终点都慢，去与回才读成同一件事的两半。目前只有进度轨的刻度标签用它
> （见《Motion-动效规范》§4.4）。

### 3.10 层级 `z.*`

z-index 只作用于最近的定位祖先，因此是**两套**体系。禁止取用这两张表以外的数值——
如果某个元素需要盖住 Toast，那是层叠结构错了，不是数值小了。

Surface 层（`fixed` 根节点与 portal）：`chrome 30` · `scrim 40` · `modal 50` · `popover 60` · `toast 70`
Intra-surface 层（卡片 / 模态面内部）：`hairline 1` · `decoration 10` · `badge 20` · `chrome 30`

---

## 4. 布局骨架约定

这些是**结构约束**，不产出 token，但必须与 token 一起遵守。

### 4.1 内容优先，外壳悬浮

没有 header / sidebar / content 三栏外壳。**瀑布流本身就是页面**，所有控件都是浮在它之上的覆盖层。

- 页头 `fixed`，高 `size.header`（48px），用渐进模糊渐隐带替代不透明横条。
- 次要操作收在悬浮操作簇里，不做工具栏。
- 桌面端专属操作（查看器左右箭头）默认 `opacity: 0`，`group-hover` 才出现。
- 元信息（EXIF）在查看器里是**常驻卡片**：挂在照片右侧、高度随照片自适应，与照片作为一个整体居中
  （`fitRect` 先把卡片的位置扣掉，照片才不会被卡片压住）；窄屏时改挂照片下方、压成一条横向列表。
  它不再有「可折叠面板 / 开关按钮」这一层 —— 照片一放大，卡片同步从照片右缘后方滑出，收起时原路收回。
  **照片左上角不再叠标题**：画框里只留照片本身，标题归到右侧卡片的第一行，照片是唯一的主角。
- **定位四件套（左轨 / 分类 chip / 视图切换 / 排序胶囊）都 `sticky` 且零位移**：
  吸附点与静态位置严格相等（见《Motion-动效规范》§4.4 的表），滚动时不动，
  且因仍在文档流内而自动占位 —— 它们因此不会遮挡下方的照片。
- 页面滚动条是**半透明的主色细条**（8px，`color.mix(accent 40%)`）；
  查看器打开时只把滑块画成透明（零重排），滚动由查看器拦输入，见《Motion-动效规范》§6.4。

### 4.2 网格

瀑布流按 `aspectRatio` **计算**条目高度，绝不测量，因此图片加载完成时网格不会重排。

列不交给 CSS `columns`（它是列优先填充，横向一排的日期会跨好几个月）：`WallView` 先按当前
时间刻度把有序列表**切成段**（每段 = 一条横贯整行的发丝分隔线 + 分组标题，与列表的分组头同款），
段内再把照片按「第 i 张进第 i % N 列」轮转到 N 条等宽纵列 ——
**横向从左往右读过去就是时间推进的方向**，段与段之间由那根整行线切开。
列数由 JS 给到 `--masonry-cols`，与分配方式同源（1440 / 1024 / 769 → 5 / 4 / 3 / 2 列）。

### 4.3 图片渐进

`thumbhash 占位 → 低清 → 全分辨率`。能用 thumbhash 的地方，绝不用 loading spinner。

### 4.4 阴影的 materialize 方式

**玻璃配方 = 材质 `color.material.*` + 模糊 `blur.*` + 阴影 `elevation.*`，三件套齐备，且没有第四件（描边）。**
图标按钮（`.icon-btn--glass`）、胶囊（`.pillbar` / 查看器底部胶囊）、chip、preset、输入框、玻璃卡片与玻璃面板一律遵守。

发丝描边在正式工程里只允许出现在两类**结构线**上，它们不参与控件的分层，也不属于任何 pill / button：

1. **分隔线**：sticky 头部的 `border-bottom`、年份块标题下的 `border-bottom`、EXIF 行的 `border-top`、月份 / 日期之间的 1px 分隔条；
2. **树形连接线**：时间线左轴月份节点的 `border-left: 1px dotted`。

除此之外，任何控件上再出现边线（无论白描边还是 accent 描边）都视为违规。

`elevation.*` 是配方，两端各自落地：

```css
/* Web：用 color-mix 保住 accent 可配置性 */
box-shadow:
  0 8px 32px color-mix(in srgb, var(--color-accent) 8%, transparent),
  0 4px 16px color-mix(in srgb, var(--color-accent) 6%, transparent),
  0 2px 8px rgba(0, 0, 0, 0.1);
```

RN 侧没有 `box-shadow` 字符串，`elevation.neutral` 的三层要折叠成一条阴影：三层 alpha 求和、
取最外层的位移与模糊，落到 RN 的 `shadowOffset / shadowOpacity / shadowRadius`。
实现见 `apps/mobile/src/theme.ts` 的 `glassShadow`。

### 4.5 hover 用 CSS，不用 JS

优先用 `[data-highlighted]` 与 `group-hover` 变体，而不是 `onMouseEnter` 处理器：

```
opacity:0 duration-200 group-hover:opacity-100
```

### 4.6 光标：四态一套自定义图案

前台（`apps/web`）全站使用自定义鼠标图案，定义在 `apps/web/src/styles/app.css` 的 `:root`
（**不进 `tokens.json`**：它是 data URI 图片，不是可跨端共享的标量，RN 端也没有光标概念）。

图案取自**尼康相机对焦点（AF point）**的语义，四态一一对应四种交互：

| 变量 | 相机语义 | 交互语义 | 图形 | 热点 |
| --- | --- | --- | --- | --- |
| `--cursor-default` | 单点 AF | 正常 | `#F5F5F7` 方框 + 深色双层衬底 | `16 16`（几何中心） |
| `--cursor-pointer` | 单点 AF · 合焦 | 悬停可点 | 同形同位，面层转 `#30D158` | `16 16` |
| `--cursor-active` | 微点 AF | 按下 | 绿框中心再收一枚小框（内:外 = 1:2） | `16 16` |
| `--cursor-drag` | 动态区域 AF | 拖拽中 | 绿框外环绕 8 枚小点（正方形 4 角 + 4 边中点，各带 1px 深色衬底） | `16 16` |

> **尺寸口径**：整套图形是初版的 **50%**（可视包络 10px，初版 20px），
> 面层方框 8px、线宽 1px。拖拽态因点距被刻意拉大、且点带衬底，总占地为初版的 80%。
> 详见 [`光标图标规范.md`](./光标图标规范.md) §3.1 与 §8。

约定：

- **一律不描边，用「双层实心」代替**。光标会落在纯白照片与近黑背景两种极端上，
  单层纯白方框在浅色照片上会糊。做法是每个方框画两遍：下层深色实心矩形比上层向内外各多露
  1px（32px 挂载尺寸下），用 `fill-rule="evenodd"` 把「外矩形 + 内矩形」两个子路径挖成方环 ——
  视觉上等价于描边，但全程零 `stroke`（与 §1.3「控件一律不画描边」同源）。
- **data URI 里只能写实色**。SVG 是独立文档，拿不到宿主页面的 CSS 变量，因此白色 / 深色 / 绿色
  都写死；改主色时这几个变量必须一起改（这是本规范里唯一允许硬编码颜色的地方）。
  绿色复用 `color.success`（`#30D158`）的等效实色，理由见 [`光标图标规范.md`](./光标图标规范.md) §4。
- **热点取几何中心**（`16 16`）。对焦框是「瞄准」语义，中心即目标点；四态热点完全一致，
  状态切换时点击位置不会跳动。
- **浏览器只吃 ≤128×128 的 `cursor: url()`**，超限整条声明被静默丢弃、退回系统箭头。
  因此母版是 256×256（可缩放的 SVG），CSS 挂载一律 32×32（`viewBox 0 0 128 128`，
  缩放 0.25，所有坐标取 4 的倍数 → 边线落在整数像素上，无锯齿）。
- **挂载靠全局保底**，不逐组件改：`html` 挂 `--cursor-default`（可继承），
  `:where(a, button, [role='button'], [role='tab'], summary, label[for])` 给绿框，
  再叠一条 `:active` 给微点框。组件只在语义更强时覆盖（拖拽区的 `--cursor-drag`）。
- **`:where()` 的权重是 0**，所以全局规则压不过任何组件级 `cursor`；
  `:active` 那条靠书写顺序（文件末尾）压过同为 `(0,1,0)` 的组件规则。
- 文本类 `input / textarea / [contenteditable]` 显式留回 `text`；
  禁用态（`:disabled` / `[aria-disabled='true']`）留回 `not-allowed`。
- **几何 / 配色 / 导出格式的完整规范见 [`光标图标规范.md`](./光标图标规范.md)**；
  改图案改 `packages/design-tokens/cursors/src/*.svg`，跑 `npm run build:cursors`
  重新生成四态产物，脚本会自动比对 `app.css` 里的回填值是否出现偏移。

---

## 5. 两端接入

### 5.1 Web

```html
<link rel="stylesheet" href="packages/design-tokens/web/tokens.css">
```

`tokens.css` 只声明变量与语义工具类，不含任何布局。主题基线（reset + body）在 `web/theme.css`。
JS / TS 侧需要数值时（例如画布、图表、动效参数）从 `web/tokens.ts` 取值，而不是去读 CSS 变量。

最小可跑示例见 `packages/design-tokens/web/demo.html`。

### 5.2 React Native（Expo）

```ts
import { tokens } from '@shaping-memory/design-tokens';

const headerHeight = Number.parseFloat(tokens.size.header);
```

RN 没有 CSS 变量，也没有 `color-mix()`，因此 `apps/mobile/src/theme.ts` 承担三件 CSS 帮不上忙的事：
把 `'48px'` 这类字符串去单位成数字、运行时派生 accent 的透明变体（等价于 `color-mix()`）、
把配方型的 `elevation.neutral` 折叠成一条 RN 阴影。它不新增任何数值，事实源仍是 `tokens.json`。

---

## 6. 变更流程

1. 改 `tokens.json`（唯一入口）。
2. 同步改两端产物，保持与 `tokens.json` 逐一对应。
3. 跑校验：

```bash
node packages/design-tokens/scripts/check-tokens.mjs
```

4. 校验会做四件事：JSON 可解析、DTCG 叶子格式合法、**两端 token 名称集合完全一致**、
   关键数值（背景色 / accent / 三档模糊 / 六档圆角）逐个比对。
5. 校验失败不得提交。

> 本仓库当前为**零依赖手写对齐**：产物是手写的，靠校验脚本拦截偏离。若后续产物规模变大，
> 再考虑用 Style Dictionary 从 `tokens.json` 生成，届时校验脚本仍应保留作为守门。

---

## 7. 与其它文档的关系

| 文档 | 关系 |
| --- | --- |
| [`packages/design-tokens/tokens.json`](../packages/design-tokens/tokens.json) | 唯一事实源 |
| [`packages/design-tokens/README.md`](../packages/design-tokens/README.md) | 包级用法、扩展说明、校验细节 |
| [`prototypes/shaping-memory-ui/`](../prototypes/shaping-memory-ui/) | 本设计语言的高保真原型，token 取值的来源之一；原型允许存在下文所述偏差 |
| [`Motion-动效规范.md`](./Motion-动效规范.md) | 动效实现规范：职责边界、基线层、动效清单、性能与无障碍约定 |
| [`塑忆产品设计方案.md`](./塑忆产品设计方案.md) | 产品与技术架构决策 |

### 7.1 已知偏差

原型（`afilmory`）早于本规范，存在以下偏差，**正式工程不得照抄**：

| 偏差 | 原型写法 | 规范写法 |
| --- | --- | --- |
| 变量命名不统一 | `--text-text`、`--mat-thick`、`--overlay-blur-md` | `--color-text-base`、`--color-material-thick`、`--blur-md` |
| 字号出现小数 | `10.5px`、`11.5px`、`12.5px` | 归一到 `10 / 11 / 12px` |
| 阴影只有一份 | 单一 accent 着色 `--shadow-ctx` | `elevation.context` 与 `elevation.neutral` 分开 |
| z-index 随手取值 | `z-index: 18 / 20 / 30` | 只允许 §3.10 两张表内的数值 |