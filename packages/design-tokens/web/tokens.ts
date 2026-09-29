/**
 * packages/design-tokens/web/tokens.ts
 *
 * 塑忆设计语言 —— Web 端 Token 产物（TypeScript）
 *
 * 【唯一事实源】packages/design-tokens/tokens.json（DTCG 格式）
 * 本文件由人手工对齐，不是自动生成的。改 token 必须：
 *   1) 先改 tokens.json  2) 同步改本文件与 tokens.css  3) 跑校验脚本
 *      node packages/design-tokens/scripts/check-tokens.mjs
 * 产物中禁止出现 tokens.json 之外的新数值。
 *
 * 【命名规则】规范 §2.1：同级嵌套 + 每段转 camelCase；
 * 数字段加 `s` 前缀（TS 标识符不能以数字开头）：space.16 -> tokens.space.s16。
 *
 * 【什么时候用它】规范 §5.1：JS / TS 侧需要数值时（画布、图表、动效参数等）
 * 从这里取，而不是去读 CSS 变量。
 */

export const tokens = {
  color: {
    /** 唯一背景色，也是 accent 对比度校验的基准底色 */
    background: '#1c1c1e',
    /** 站点级强调色，可被后端 siteConfig 覆盖；不是品牌色，而是当前照片推导出的光 */
    accent: '#e8a33c',
    /** 强调色的压低版本，仅用于渐变末端等需要「更暗一档」的场合 */
    accentSecondary: '#c98a2e',

    /** 语义状态色：只表「状态」，不参与层级表达（规范 §1.3） */
    danger: '#ff453a',
    success: '#30d158',

    /** 文字层级：沿同一族向下走，不换色相 */
    text: {
      base: '#f5f5f7',
      secondary: 'rgba(245, 245, 247, 0.62)',
      tertiary: 'rgba(245, 245, 247, 0.44)',
      quaternary: 'rgba(245, 245, 247, 0.3)',
      quinary: 'rgba(245, 245, 247, 0.2)',
    },

    /** 不透明感控件填充，只有 4 档；第 5 档是 border */
    fill: {
      base: 'rgba(255, 255, 255, 0.075)',
      secondary: 'rgba(255, 255, 255, 0.06)',
      tertiary: 'rgba(255, 255, 255, 0.045)',
      quaternary: 'rgba(255, 255, 255, 0.03)',
    },

    border: {
      /** 中性发丝描边（fill 族的第 5 档） */
      base: 'rgba(255, 255, 255, 0.1)',
      /** 直接压在照片上的描边：照片底色不可知，因此只用白/黑透明度 */
      onPhoto: 'rgba(255, 255, 255, 0.1)',
    },

    /** 半透明材质填充，共 6 档；必须与 blur 成对使用 */
    material: {
      opaque: 'rgba(24, 24, 26, 0.92)',
      ultraThick: 'rgba(30, 30, 32, 0.86)',
      thick: 'rgba(36, 36, 39, 0.72)',
      medium: 'rgba(40, 40, 43, 0.55)',
      thin: 'rgba(44, 44, 47, 0.35)',
      ultraThin: 'rgba(48, 48, 51, 0.18)',
    },
  },

  /**
   * 色调色（accent 与语义状态色）一律低透明度：除主按钮与激活态外不写死 rgba。
   * 使用方式：accentAt(tokens.opacity.accent.border)，不要自己写 rgba。
   */
  opacity: {
    accent: {
      /** 玻璃面描边 */
      border: 0.2,
      /** 玻璃面淡洗 / 激活态背景 */
      wash: 0.12,
      /** 文字按钮 hover 背景 */
      hover: 0.1,
      /** 极淡的强调色倾向 */
      subtle: 0.05,
      /** 文本选区高亮（::selection） */
      selection: 0.3,
    },
    /** 语义状态色（danger / success）的档位，与 accent 同形，两侧对称 */
    state: {
      /** 状态徽章 / 提示条描边 */
      border: 0.2,
      /** 状态徽章背景 / 破坏性按钮淡底 */
      wash: 0.12,
      /** 破坏性文字按钮 hover 背景 */
      hover: 0.1,
    },
    /** 禁用态 */
    disabled: 0.4,
  },

  /** 模糊按「角色」选，只有三档，禁止引入第四档 */
  blur: {
    /** 模态背后的遮罩 / scrim */
    sm: '6px',
    /** 压在照片上的二级控件 */
    md: '14px',
    /** 悬浮面板、菜单、浮层、Toast、查看器外壳 */
    xxl: '38px',
  },

  /** 圆角映射容器尺寸；核心规律：容器比它内部的条目圆一档 */
  radius: {
    xxl: '20px',
    xl: '16px',
    lg: '12px',
    md: '9px',
    sm: '7px',
    full: '999px',
  },

  /** 4px 基准栅格；数字段加 s 前缀 */
  space: {
    s2: '2px',
    s4: '4px',
    s6: '6px',
    s8: '8px',
    s12: '12px',
    s16: '16px',
    s20: '20px',
    s24: '24px',
    s32: '32px',
    s40: '40px',
    /** 模块顶部留白，用于避开 48px 悬浮导航 */
    s64: '64px',
  },

  /** 控件尺寸；圆形图标按钮只有两档，不得自创第三档 */
  size: {
    iconButton: {
      default: '32px',
      compact: '28px',
    },
    /** 图标字形尺寸，与上面的按钮尺寸配对使用 */
    icon: {
      default: '18px',
      compact: '16px',
    },
    button: {
      xs: '24px',
      /** 文字按钮默认档 */
      sm: '32px',
      md: '40px',
      lg: '44px',
      xl: '48px',
    },
    chip: '26px',
    /** 悬浮页头高度（fixed） */
    header: '48px',
    /** 时间线进度轨可拖拽命中区宽度；视觉细线为 3px */
    timelineTrack: '16px',
  },

  font: {
    /**
     * 家族保持数组原样，便于拼接 font-family 或作字体回退栈。
     * 注意 color.accent 是可配置的，但字体名不是数值，这里不需要派生。
     */
    family: {
      sans: [
        'Geist',
        'PingFang SC',
        'Hiragino Sans GB',
        'Microsoft YaHei',
        'ui-sans-serif',
        'system-ui',
        'sans-serif',
      ],
      /** CJK 优先的衬线栈，只用于编辑性时刻（年份大标题等） */
      serif: ['Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'serif'],
      /** EXIF 数值与原始数据专用 */
      mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
    },
    /** 刻意偏密的正文字号 */
    size: {
      caption: '10px',
      meta: '11px',
      label: '12px',
      body: '13px',
      heading: '15px',
      title: '19px',
      hero: '30px',
    },
    weight: {
      regular: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    /** 宽字距只用于全大写拉丁 / 数字标签，中文不加字距 */
    tracking: {
      tight: '-0.01em',
      normal: '0em',
      wide: '0.01em',
      meta: '0.02em',
      brand: '0.14em',
    },
    leading: {
      tight: 1.2,
      snug: 1.35,
      normal: 1.5,
      relaxed: 1.7,
    },
  },

  /**
   * 配方型 token（规范 §2.2）：这里保留 tint + alpha + 位移的原始配方，
   * 由调用端自行 materialize。CSS 侧已在 tokens.css 里 materialize 成 box-shadow 字符串，
   * React Native 侧 materialize 成 shadow* 系列属性。
   * 深度来自叠加的透明层，不是一道硬阴影。
   */
  elevation: {
    /** 强调色着色版：用于带 accent 描边的玻璃面 */
    context: [
      { tint: '{color.accent}', alpha: 0.08, offsetX: '0px', offsetY: '8px', blur: '32px', spread: '0px' },
      { tint: '{color.accent}', alpha: 0.06, offsetX: '0px', offsetY: '4px', blur: '16px', spread: '0px' },
      { tint: '#000000', alpha: 0.1, offsetX: '0px', offsetY: '2px', blur: '8px', spread: '0px' },
    ],
    /** 中性版：三层 6.7% 黑。任何玻璃面优先用它 */
    neutral: [
      { tint: '#000000', alpha: 0.067, offsetX: '0px', offsetY: '6px', blur: '24px', spread: '0px' },
      { tint: '#000000', alpha: 0.067, offsetX: '0px', offsetY: '3px', blur: '10px', spread: '0px' },
      { tint: '#000000', alpha: 0.067, offsetX: '0px', offsetY: '1px', blur: '4px', spread: '0px' },
    ],
  },

  motion: {
    /** 仅用于 opacity / color 这类「非空间」状态变化 */
    duration: {
      fast: '150ms',
      base: '200ms',
      slow: '300ms',
    },
    /** Web 端对 spring 的 CSS 近似；TS 侧拿到的是四段贝塞尔控制点 */
    easing: {
      smooth: [0.22, 0.61, 0.36, 1],
      snappy: [0.34, 1.3, 0.5, 1],
      /** 对称 ease-in-out：起止都慢的位移（如刻度标签换边） */
      inOut: [0.45, 0, 0.55, 1],
    },
    /** 空间运动唯一允许的模型：duration（秒）+ bounce（0–1） */
    spring: {
      smooth: { duration: 0.4, bounce: 0 },
      snappy: { duration: 0.4, bounce: 0.15 },
      bouncy: { duration: 0.4, bounce: 0.3 },
    },
  },

  /** z-index 只作用于最近的定位祖先，因此是两套体系 */
  z: {
    /** Surface 层：fixed 根节点与 portal */
    surface: {
      chrome: 30,
      scrim: 40,
      modal: 50,
      popover: 60,
      toast: 70,
    },
    /** Intra-surface 层：卡片 / 模态面内部 */
    inset: {
      hairline: 1,
      decoration: 10,
      badge: 20,
      chrome: 30,
    },
  },
} as const;

/**
 * 由 accent 现算一个带透明度的强调色，例如玻璃描边、激活态淡洗。
 *
 * 为什么不直接写 `rgba(232, 163, 60, 0.2)`：
 * accent 是可配置的 —— 后端 siteConfig.accentColor 会覆盖默认的 #e8a33c，
 * 照片级还会按 thumbhash 主色再推导一次（规范 §1.2）。一旦把某个具体 accent
 * 的 rgba 写死，换 accent 时这些透明变体会整体失真。
 * 所以「accent × 不透明度」这一步必须留在运行时，与 tokens.css 里
 * elevation 的 materialize 方式（规范 §4.4 用 color-mix）保持一致。
 *
 * @param alpha 0–1 的不透明度，传 tokens.opacity.accent.* 中的值
 */
export function accentAt(alpha: number): string {
  // color-mix 的百分比参数支持 calc 表达式，这里把 0–1 的 alpha 换算成百分比
  return `color-mix(in srgb, ${tokens.color.accent} ${alpha * 100}%, transparent)`;
}

/**
 * opacity.accent.* 的语义快捷方式，配合 accentAt 使用：
 *   accentAt(accentOpacity.border) // 玻璃面描边
 *   accentAt(accentOpacity.wash)   // 激活态背景
 */
export const accentOpacity = {
  /** 玻璃面描边 0.2 */
  border: tokens.opacity.accent.border,
  /** 玻璃面淡洗 / 激活态背景 0.12 */
  wash: tokens.opacity.accent.wash,
  /** 文字按钮 hover 背景 0.1 */
  hover: tokens.opacity.accent.hover,
  /** 极淡的强调色倾向 0.05 */
  subtle: tokens.opacity.accent.subtle,
  /** 文本选区高亮 0.3 */
  selection: tokens.opacity.accent.selection,
} as const;