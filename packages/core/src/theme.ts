/**
 * packages/core/src/theme.ts
 *
 * 主题配置的「契约 + 出厂默认值 + 安全校验」——纯逻辑，不含任何 DOM 与基准数值。
 *
 * 【为什么要单独一层】主题配置要同时被后端（校验、落库）与前端（解析、套用）使用，
 * 两端必须对「什么算合法配置」给出同一个答案。因此契约与校验放在 core，
 * 基准数值（13px 正文、48px 页头…）留在 design-tokens，由前端那层负责把两者拼起来。
 *
 * 【为什么校验这么严】配置最终会被写进页面的 <style> 里。若不校验，
 * 一个 `red;} body{display:none` 这样的「颜色」就能改掉整站样式 —— 托管方是管理员，
 * 但这仍是一道必须守住的注入边界（与 settings 只认白名单键是同一思路）。
 *
 * 【为什么读取端也要再校验一遍】数据库里的值可能被人工改为非法值、也可能来自旧版本。
 * 读接口返回的永远是 normalize 之后的结果，非法字段静默回落出厂默认，避免整站样式失效。
 */

/** 可调字号档位：与 design-tokens 的 font.size.* 一一对应 */
export const FONT_TIERS = ['caption', 'meta', 'label', 'body', 'heading', 'title', 'hero'] as const;
export type FontTier = (typeof FONT_TIERS)[number];

/** 档位的中文名（后台表单与文档共用一处，避免两处各写一遍） */
export const FONT_TIER_LABELS: Record<FontTier, string> = {
  caption: '角标 / 极次要说明',
  meta: '元信息（EXIF、时间戳、计数）',
  label: '导航项 / 次级正文',
  body: '正文',
  heading: '区块标题',
  title: '大标题（年份等）',
  hero: '空态 / Hero 标题',
};

/** 可改的颜色：核心语义令牌。其余层级（材质 / 填充 / 低层级文字）由这几个派生 */
export const THEME_COLOR_KEYS = [
  'accent',
  'accentSecondary',
  'background',
  'textBase',
  'textSecondary',
  'borderBase',
  'success',
  'danger',
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/** 颜色字段的中文名（后台表单用） */
export const THEME_COLOR_LABELS: Record<ThemeColorKey, string> = {
  accent: '主题主色调',
  accentSecondary: '辅助色（渐变末端）',
  background: '页面背景色',
  textBase: '正文颜色',
  textSecondary: '次要文字颜色',
  borderBase: '边框颜色',
  success: '成功态颜色',
  danger: '危险态颜色',
};

export interface ThemeColors {
  accent: string;
  accentSecondary: string;
  background: string;
  textBase: string;
  textSecondary: string;
  borderBase: string;
  success: string;
  danger: string;
}

export interface ThemeConfig {
  colors: ThemeColors;
  /** 全局字号 / 间距 / 控件尺寸倍率（仅 PC 生效） */
  fontScale: number;
  /** 逐档微调：留空表示走倍率。键为档位名，值为 px */
  fontOverrides: Partial<Record<FontTier, number>>;
  /** EXIF 专区倍率：**替代**全局倍率（不叠加） */
  exifScale: number;
}

/** 取值范围与出厂默认值（后台滑杆与校验共用，禁止在两处各写一份数字） */
export const THEME_LIMITS = {
  fontScale: { min: 1, max: 1.5, step: 0.01, default: 1.15 },
  exifScale: { min: 1, max: 2, step: 0.01, default: 1.15 },
  overrideFontPx: { min: 8, max: 48 },
} as const;

/**
 * 缩放生效的最小视口宽：与 core 的 VIEWPORT_BREAKPOINTS.lg 同值。
 * JS 侧判定与生成 CSS 的媒体查询必须共用这一个数 —— 两处各写一遍迟早会分叉，
 * 而一旦分叉，Viewer 预留的卡片宽度就会和实际卡片宽度对不上。
 */
export const THEME_SCALE_MIN_WIDTH = 1024;

/** EXIF 专区的作用域类名：挂在 EXIF 相关容器上，字号在类内被重新定义 */
export const EXIF_SCOPE_CLASS = 'exif-scope';

/** 主题配置在 settings 表里的键 */
export const THEME_CONFIG_KEY = 'theme.config';

export const THEME_DEFAULTS: ThemeConfig = {
  colors: {
    accent: '#e8a33c',
    accentSecondary: '#c98a2e',
    background: '#1c1c1e',
    textBase: '#f5f5f7',
    textSecondary: 'rgba(245, 245, 247, 0.62)',
    borderBase: 'rgba(255, 255, 255, 0.1)',
    success: '#30d158',
    danger: '#ff453a',
  },
  fontScale: THEME_LIMITS.fontScale.default,
  fontOverrides: {},
  exifScale: THEME_LIMITS.exifScale.default,
};

/* ==========================================================================
 * 安全校验
 * ========================================================================== */

/** 十六进制颜色：#rgb / #rrggbb / #rrggbbaa */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/**
 * 函数式颜色的**安全子集**：括号内只允许数字、字母、百分号、逗号、点、斜杠、
 * 空白与正负号。这样 `url(...)`、`var(...)` 这类带嵌套括号的写法天然写不进来，
 * `;` `}` `"` `'` 也不在允许集里 —— 颜色值因此不可能越出这条声明。
 */
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla)\([0-9a-z%.,/\s+-]*\)$/i;

/** 值能不能安全地写进 <style>：只认上面的两种颜色写法 */
export function isSafeCssColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length === 0 || text.length > 64) return false;
  return HEX_COLOR.test(text) || FUNC_COLOR.test(text);
}

/** 把数字夹进区间；非有限数一律回落默认值（NaN / Infinity / 字符串都走这条） */
function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(range.max, Math.max(range.min, num));
  // 保留两位小数：滑杆是 0.01 步进，避免浮点误差堆出 1.1500000000000001
  return Math.round(clamped * 100) / 100;
}

/**
 * 归一化：任何来源（HTTP 请求体 / 数据库 JSON / localStorage 缓存）都必须先过这里。
 * 规则是「宽进严出」——不认识的键直接丢，非法值回落默认，永远返回一个完整的合法对象。
 */
export function normalizeThemeConfig(raw: unknown): ThemeConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<ThemeConfig>;

  const colors: ThemeColors = { ...THEME_DEFAULTS.colors };
  const rawColors = (source.colors && typeof source.colors === 'object' ? source.colors : {}) as Record<
    string,
    unknown
  >;
  for (const key of THEME_COLOR_KEYS) {
    // 只有通过安全校验的颜色才被采纳；非法值保持出厂默认，不报错也不清空
    if (isSafeCssColor(rawColors[key])) colors[key] = (rawColors[key] as string).trim();
  }

  const fontOverrides: Partial<Record<FontTier, number>> = {};
  const rawOverrides = (source.fontOverrides && typeof source.fontOverrides === 'object'
    ? source.fontOverrides
    : {}) as Record<string, unknown>;
  for (const tier of FONT_TIERS) {
    const value = rawOverrides[tier];
    // 逐档覆盖的语义是「这一档就按这个 px 来」，因此只认显式给出的数字
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const range = THEME_LIMITS.overrideFontPx;
    if (value < range.min || value > range.max) continue;
    fontOverrides[tier] = Math.round(value * 10) / 10;
  }

  return {
    colors,
    fontScale: clampNumber(source.fontScale, THEME_LIMITS.fontScale, THEME_DEFAULTS.fontScale),
    fontOverrides,
    exifScale: clampNumber(source.exifScale, THEME_LIMITS.exifScale, THEME_DEFAULTS.exifScale),
  };
}