/**
 * apps/mobile/src/theme.ts
 *
 * RN 端对设计 token 的适配层。Web 有 CSS 变量与 color-mix()，RN 两者都没有，
 * 因此这里做三件 CSS 帮不上忙的事：
 *   1) 把 '16px' 这类字符串去单位，RN 的尺寸必须是数字；
 *   2) 运行时派生 accent 的透明变体（等价于 CSS 的 color-mix）；
 *   3) 把配方型 elevation 折叠成 RN 能表达的一条阴影。
 * 除此之外不新增任何数值 —— 唯一事实源仍是 packages/design-tokens/tokens.json。
 */
import { tokens } from '@shaping-memory/design-tokens';
import type { TextStyle, ViewStyle } from 'react-native';

/* -------------------------------------------------------------------------- */
/* 单位：token 里带 px 的字符串统一转成数字                                      */
/* -------------------------------------------------------------------------- */

const px = (value: string) => Number.parseFloat(value);

/** 把一个「全字符串值」的 token 组整体转成数字组，键名原样保留 */
function toNumbers<T extends Record<string, string>>(group: T): { [K in keyof T]: number } {
  return Object.fromEntries(Object.entries(group).map(([key, value]) => [key, px(value)])) as {
    [K in keyof T]: number;
  };
}

export const colors = {
  background: tokens.color.background,
  accent: tokens.color.accent,
  accentSecondary: tokens.color.accentSecondary,
  /** 语义状态色：只表「状态」，不参与层级表达（§1.3），与 Web tokens 对齐 */
  danger: tokens.color.danger,
  success: tokens.color.success,
  text: tokens.color.text,
  fill: tokens.color.fill,
  border: tokens.color.border,
  material: tokens.color.material,
};

export const space = toNumbers(tokens.space);
export const radius = toNumbers(tokens.radius);
export const fontSize = toNumbers(tokens.font.size);
export const leading = tokens.font.leading;
export const fontWeight = tokens.font.weight;
export const tracking = tokens.font.tracking;

export const size = {
  iconButton: toNumbers(tokens.size.iconButton),
  icon: toNumbers(tokens.size.icon),
  button: toNumbers(tokens.size.button),
  chip: px(tokens.size.chip),
  header: px(tokens.size.header),
};

/**
 * BlurView 的 intensity 是 0–100，与 CSS 的模糊半径不是同一量纲。
 * 这里按「设计里最重的一档 blur.xxl 对应满强度」线性换算 ——
 * 它是纯换算系数，不引入新的设计数值。
 */
const BLUR_FULL = px(tokens.blur.xxl);
export const blurIntensity = {
  sm: Math.round((px(tokens.blur.sm) / BLUR_FULL) * 100),
  md: Math.round((px(tokens.blur.md) / BLUR_FULL) * 100),
  xxl: 100,
};

/* -------------------------------------------------------------------------- */
/* 透明色：RN 没有 color-mix()，任何「颜色 × 不透明度」都只能运行时算            */
/* -------------------------------------------------------------------------- */

/**
 * 把 token 里的 hex 展开成带透明度的 rgba。
 * 不写死任何一档颜色：accent 会被后端 siteConfig 覆盖、背板色也可能改，
 * 运行时派生才保证换色时不失真。
 */
function rgbaOf(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** 「accent × 不透明度」——对应 Web 端 tokens.css 的 color-mix() */
export function accentRgba(alpha: number): string {
  return rgbaOf(tokens.color.accent, alpha);
}

/** 「背板色 × 不透明度」：选择态的压暗层等中性遮罩 */
export function backgroundRgba(alpha: number): string {
  return rgbaOf(tokens.color.background, alpha);
}

/**
 * 「文字色 × 不透明度」：时间轨上的基线、刻度短横线都用它。
 * Web 端这些值是 color-mix(text-quaternary × N%, transparent)，RN 没有 color-mix，
 * 因此按「text.base 的 alpha」等价换算（text-quaternary 本身就是 base 的 0.3 档）。
 */
export function textRgba(alpha: number): string {
  return rgbaOf(tokens.color.text.base, alpha);
}

/** opacity.accent.* 的语义快捷方式 */
export const accentOpacity = tokens.opacity.accent;

/** 禁用态不透明度：与 Web tokens 的 opacity.disabled 同一档 */
export const disabledOpacity = tokens.opacity.disabled;

/* -------------------------------------------------------------------------- */
/* 玻璃面：材质 + accent 描边 + 中性阴影                                        */
/* -------------------------------------------------------------------------- */

const NEUTRAL_LAYERS = tokens.elevation.neutral;
const OUTER_LAYER = NEUTRAL_LAYERS[0];

/** RN 一条阴影表达不了多层叠加，用「三层不透明度之和 + 最外层的位移与模糊」近似 */
const NEUTRAL_SHADOW_ALPHA = NEUTRAL_LAYERS.reduce((sum, layer) => sum + layer.alpha, 0);

/**
 * 玻璃面的外层阴影。不含材质填充 —— 材质那层要盖在模糊之上，
 * 否则 BlurView 只会模糊到自己那层纯色，等于没模糊。
 * 描边不参与分层（§4.4）。
 */
export const glassShadow: ViewStyle = {
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: px(OUTER_LAYER.offsetY) },
  shadowOpacity: NEUTRAL_SHADOW_ALPHA,
  shadowRadius: px(OUTER_LAYER.blur),
  /** Android 只有一档 elevation，直接沿用最外层阴影的纵向位移 */
  elevation: px(OUTER_LAYER.offsetY),
};

/** 盖在模糊之上的材质填充。无描边——深度只由材质 + 模糊 + 外层阴影三层表达（§4.4） */
export const glassTint: ViewStyle = {
  backgroundColor: tokens.color.material.thick,
};

/**
 * 中性阴影的 **CSS 写法**：给 WebView 里那个内联的 Leaflet 页面用
 * （针脚 / 小地图点位需要与站内玻璃面同一档阴影，但页面里没有 CSS 变量可读）。
 * 把 tokens 的三层配方原样展开成一条 box-shadow，数值仍只有 tokens 一处来源。
 */
export const elevationCssShadow = NEUTRAL_LAYERS.map(
  (layer) => `${layer.offsetX} ${layer.offsetY} ${layer.blur} ${layer.spread} ${rgbaOf(layer.tint, layer.alpha)}`,
).join(', ');

/**
 * blur 档位的 CSS 写法（'12px' 这种带单位字符串）：同样是给内联页面用的。
 * RN 自己的模糊走 BlurView + blurIntensity，与这里不是同一量纲，故单列一份。
 */
export const blurCss = tokens.blur;

/** 压在照片上的轻量材质：无描边、无阴影，只做可读性底色 */
export const scrimSurface: ViewStyle = {
  backgroundColor: tokens.color.material.ultraThick,
};

/* -------------------------------------------------------------------------- */
/* 字阶：与 Web 的 font.size.* 一一对应，行高按 leading.normal 折算             */
/* -------------------------------------------------------------------------- */

type SizeKey = keyof typeof fontSize;
type WeightKey = keyof typeof fontWeight;

function textStyle(sizeKey: SizeKey, color: string = tokens.color.text.base, weight: WeightKey = 'regular'): TextStyle {
  const value = fontSize[sizeKey];
  return {
    fontSize: value,
    lineHeight: Math.round(value * leading.normal),
    color,
    fontWeight: String(fontWeight[weight]) as TextStyle['fontWeight'],
  };
}

export const text = {
  caption: textStyle('caption'),
  /** 元信息（EXIF、时间戳、计数）走三级文字色 */
  meta: textStyle('meta', tokens.color.text.tertiary),
  label: textStyle('label'),
  body: textStyle('body'),
  heading: textStyle('heading', tokens.color.text.base, 'semibold'),
  title: textStyle('title', tokens.color.text.base, 'bold'),
  hero: textStyle('hero', tokens.color.text.base, 'bold'),
} satisfies Record<string, TextStyle>;

/* -------------------------------------------------------------------------- */
/* 字体栈                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * token 里的 family 是「给 CSS 拼的数组」（Geist / PingFang SC / … / serif），
 * RN 只认单个 family 名。取各栈末端的**通用族**：那是 Android 与 iOS 都必然
 * 存在的保底项，前面的具体字体名（Noto Serif SC / SF Mono）在移动端不一定装着，
 * 写进 RN 只会静默回落到系统默认，等于未生效。
 *
 * sans 不显式设置 —— RN 默认就是系统无衬线，与 Web 栈末端的 system-ui 同义。
 */
export const fontFamily = {
  /** 衬线：只用于编辑性时刻（年份大标题），对应 Web 的 --font-family-serif */
  serif: tokens.font.family.serif[tokens.font.family.serif.length - 1]!,
  /** 等宽：EXIF 数值与原始数据，对应 Web 的 --font-family-mono */
  mono: tokens.font.family.mono[tokens.font.family.mono.length - 1]!,
};

/** 等宽数字：数值纵列对齐（计数、坐标、EXIF）。字号仍按各自字阶走 */
export const tabularNums: TextStyle = { fontVariant: ['tabular-nums'] };

/**
 * tracking 是 em 值，RN 的 letterSpacing 只认 px：
 * 按字号折算一次即可，字距始终随字号等比缩放。
 */
export function trackingPx(trackingEm: string, sizeKey: SizeKey = 'caption'): number {
  return Number.parseFloat(trackingEm) * fontSize[sizeKey];
}

/** 元信息档字距（页头品牌名与标语用） */
export const metaTracking: TextStyle = { letterSpacing: trackingPx(tracking.meta) };

/** 最宽一档字距：对应 Web 的面板字段标签（.search-field__label） */
export const brandTracking: TextStyle = { letterSpacing: trackingPx(tracking.brand) };