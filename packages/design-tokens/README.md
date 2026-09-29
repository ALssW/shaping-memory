# @shaping-memory/design-tokens

塑忆设计语言（Afilmory 风格暗色影展）的 **Token 单一事实源与双端产物**。

规范正文见 [`docs/设计语言-Token规范.md`](../../docs/设计语言-Token规范.md)；
本文件只讲**包级用法、同步规则、校验细节与扩展说明**。

> 核心原则：**照片是唯一光源，其余皆是其前的玻璃。**
> 暗色是唯一方案；强调色是「色调」不是「填充」；深度来自叠加的透明层，不是一道硬阴影。

---

## 1. 文件清单

```
packages/design-tokens/
├── tokens.json                     # 唯一事实源（DTCG 格式，105 个叶子）
├── scripts/
│   └── check-tokens.mjs            # 零依赖一致性校验（Node 原生，无 npm install）
└── web/
    ├── tokens.css                  # Web 变量 + .mat-* / .glass / .t-* 语义工具类
    ├── tokens.ts                   # TS 数值产物（Web 与 React Native 共用）
    ├── theme.css                   # 最小主题基线（reset + body + ::selection）
    └── demo.html                   # 自包含验证页，双击即可打开
```

**两端命名对应关系**（规范 §2.1）：

| DTCG 路径 | CSS 变量 | TS |
| --- | --- | --- |
| `color.text.secondary` | `--color-text-secondary` | `tokens.color.text.secondary` |
| `space.16` | `--space-16` | `tokens.space.s16` |
| `motion.spring.snappy` | *(跳过，见 §4)* | `tokens.motion.spring.snappy` |

数字段统一加 `s` 前缀（`16 → s16`），因为 TS 标识符不能以数字开头。

---

## 2. 两端接入

### 2.1 Web

```html
<link rel="stylesheet" href="packages/design-tokens/web/tokens.css">
```

- `tokens.css` 只声明变量与语义工具类（`.mat-thick`、`.glass`、`.t-text` 等），**不含任何布局**。
- 主题基线（reset + `color-scheme: dark` + `body` 背景）在 `web/theme.css`。
- TS 侧需要数值时（画布、图表、动效参数）从 `web/tokens.ts` 取，**不要去读 CSS 变量**。
- accent 的透明变体用 `accentAt(tokens.opacity.accent.border)` 现算，不要手写 `rgba()`。
- 最小可跑示例：[`web/demo.html`](./web/demo.html)。

### 2.2 React Native（Expo）

```ts
import { tokens, accentAt, accentOpacity } from '@shaping-memory/design-tokens';

// 需要具体数值时（画布、图表、动效参数）直接取常量
const spring = tokens.motion.spring.snappy; // { duration: 0.4, bounce: 0.15 }

// accent 的透明变体必须现算，不要写死 rgba()
const borderColor = accentAt(accentOpacity.border);
```

- React Native 消费 `web/tokens.ts`（即包入口 `@shaping-memory/design-tokens`），**不消费** `tokens.css` / `theme.css`（这两个只服务 Web）。
- **只有一套暗色值，没有亮色分支** —— 暗色是唯一方案。
- `elevation.*` 是配方型 token（见 §5.1），移动端自行把配方 materialize 成 RN 的 `shadowColor` / `shadowOffset` / `shadowRadius` / `shadowOpacity`。
- accent 的透明变体用 `accentAt(tokens.opacity.accent.*)` 现算，不要手写 `rgba()`。

---

## 3. 同步规则（重要）

本包采用 **零依赖手写对齐**：产物是手写的，靠校验脚本拦截偏离。

改动顺序**不可颠倒**：

1. **改 `tokens.json`**（唯一入口，先动它）。
2. 同步改 `web/tokens.css`、`web/tokens.ts` 两份产物，保持与 `tokens.json` 逐一对应。
   - 只需新增/删除对应变量与常量；`theme.css`、`demo.html` 按需跟随。
3. 跑校验：

```bash
node packages/design-tokens/scripts/check-tokens.mjs
```

4. **校验失败不得提交。**

> 产物中**禁止出现 `tokens.json` 之外的新数值**。若确实需要新值，先在 `tokens.json` 里建 token。
>
> 若未来产物规模变大，可考虑改用 Style Dictionary 从 `tokens.json` 生成；
> 届时本校验脚本仍应保留作为守门。

---

## 4. 校验细节

[`scripts/check-tokens.mjs`](./scripts/check-tokens.mjs) 只依赖 Node 内置模块（无 `node_modules`），做四件事：

1. `tokens.json` 可解析，且 DTCG 叶子（含 `$type` 继承）格式合法；
2. 按规范 §2.1 的反推规则，从 token 路径推导出两端应有的名称；
3. **两端名称集合逐一比对** —— 缺、多、重复都会失败；
4. 标量值逐个比对（背景色 / accent / 模糊 / 圆角 / 间距 / 字号等）。

### 已知跳过项（有意为之，不是遗漏）

| 跳过对象 | 位置 | 原因 |
| --- | --- | --- |
| `elevation.*` | 两端 | 配方型 token（见 §5.1），不是标量，无法逐值比对 |
| `font.family` | 两端 | 值类型是数组，两端表达形式（CSS 变量 / 数组常量）不同 |
| `motion.spring.*` | 两端 | 值对象（见 §5.2），整体为一个 token，数值比对交由人工评审 |
| `motion.easing` | 两端 | 四段贝塞尔控制点数组，CSS 侧不产出同名变量 |
| CSS 侧 `motion.spring.*` | CSS | Web 用四段贝塞尔（`motion.easing`）近似弹簧，不导出 `--spring-*` 变量 |

因此校验输出里 CSS 的期望数是 **102**（= 105 − 3 个 spring），而 TS 是 **105**。

---

## 5. 扩展说明（本仓库对 DTCG 的扩展用法）

本包遵循 [DTCG](https://tr.designtokens.org/format/) 格式，但有两处是其**规范之外**的扩展。
写在这里，是为了让后来者不必从产物反推设计意图。

### 5.1 配方型 token：`elevation.*`

DTCG 的 `$value` 通常是一个标量（颜色 / 尺寸 / 数字）。而 `elevation.context` 的 `$value`
是一个**数组**，每个元素是 `{ tint, alpha, offsetX, offsetY, blur, spread }` 这样的**配方**，
而不是最终的 `box-shadow` 字符串。

**为什么不直接写死 `box-shadow`**：`tint` 指向 `{color.accent}`，而 accent 是**可配置**的
—— 后端 `siteConfig.accentColor` 会覆盖默认值，照片级还会按 thumbhash 主色再推导一次
（规范 §1.2）。如果把 accent 参与的那层阴影固化成 `rgba(232, 163, 60, 0.08)`，
换 accent 时这层阴影就会与其余部分脱节。

**materialize 交给各端**（规范 §4.4）：

- Web：`tokens.css` 里用 `color-mix(in srgb, var(--color-accent) 8%, transparent)` 拼出 `box-shadow`；
- React Native：`web/tokens.ts` 里保留原始配方（`tint` 仍是 `{color.accent}` 引用），由移动端在运行时换算成 RN 的 `shadow*` 属性。

> 这也是 `elevation.context/neutral` 在产物侧保留原始配方、不预先 materialize 的原因：
> 一旦把 accent 固化成具体颜色，就**冻结**了 accent，违反 §1.2 的「accent 可配置」前提。
> 这是有意取舍，不是笔误。

### 5.2 值对象：`motion.spring.*`

`motion.spring.smooth` 的 `$value` 是一个**对象**：`{ duration: 0.4, bounce: 0 }`。
它整体是**一个** token（「一个弹簧预设」），不是 `duration` / `bounce` 两个独立 token。

原因：`spring(duration:bounce:)` 是 Apple 的**唯一**空间运动模型，两者必须成对使用才成立
（规范 §3.9）。拆成两个 token 会让调用方有「只写 duration 不写 bounce」的可能。

因此在 `web/tokens.ts` 里它是一个嵌套对象（值对象），而不是被拆成两个独立叶子：

```ts
tokens.motion.spring.smooth  // { duration: 0.4, bounce: 0 }
```

> 校验脚本用 `valueObjectKeys` 集合识别这类叶子：下探到该 key 时**停止下探并整体记录**，
> 否则会被误拆成 `motionSpringSmoothDuration` 等子叶子。

---

## 6. 相关文档

| 文档 | 内容 |
| --- | --- |
| [`docs/设计语言-Token规范.md`](../../docs/设计语言-Token规范.md) | 规范正文：核心原则、命名规则、Token 全表、布局约定、变更流程、已知偏差 |
| [`docs/Motion-动效规范.md`](../../docs/Motion-动效规范.md) | 动效实现规范：`motion.*` token 怎么落到 Motion 的过渡对象、职责边界与注意事项记录 |
| [`tokens.json`](./tokens.json) | 唯一事实源 |
| [`docs/塑忆产品设计方案.md`](../../docs/塑忆产品设计方案.md) | 产品与技术架构决策 |
| [`prototypes/shaping-memory-ui/`](../../prototypes/shaping-memory-ui/) | 本设计语言的高保真原型（早于本规范，存在规范 §7.1 列举的偏差，正式工程不得照抄） |