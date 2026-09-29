/**
 * packages/sdk/src/theme.ts
 *
 * 主题配置的「客户端实现」：把 core 的配置解析成一份 CSS 覆盖层，套到页面上，
 * 并把缩放后的数值暴露给需要「用 JS 算几何」的地方（查看器、进度轨）。
 *
 * 【为什么放在 sdk 而不是 core】解析需要读 design-tokens 的基准数值（13px 正文、48px 页头…），
 * 而 apps/api 会 import core（校验与落库）却不 import sdk —— 把基准依赖挡在这一层，
 * 后端就不必去解析一份前端设计产物。
 *
 * 【为什么是「注入一份 <style>」而不是改 tokens.css】tokens.css / tokens.ts 是受
 * check-tokens 守门的手写产物（禁止出现 tokens.json 之外的新数值），注入动态值会破坏校验。
 * 运行时覆盖层与产物解耦，二者互不干扰；且它位于 <head> 末尾，同优先级下自然压过 tokens.css。
 *
 * 【为什么缩放写在媒体查询里】缩放只对 PC 生效（窄屏保持现状）。把它包进
 * `@media (min-width: 1024px)`，窄屏解析到的就是 tokens.css 的原值 —— 不需要任何 JS 判断，
 * 也不会出现「JS 说缩放了、CSS 说没缩放」的分叉。
 */
import { tokens } from '@shaping-memory/design-tokens';
import {
  EXIF_SCOPE_CLASS,
  FONT_TIERS,
  THEME_DEFAULTS,
  THEME_SCALE_MIN_WIDTH,
} from '@shaping-memory/core';
import type { FontTier, ThemeConfig } from '@shaping-memory/core';

/** 注入节点 id：重复调用复用同一个节点，避免越套越多 */
const STYLE_ID = 'shaping-theme';

/** EXIF 专区里需要重新定义的档位（该区域实际用到的几档） */
const EXIF_SCOPE_TIERS: readonly FontTier[] = ['caption', 'meta', 'label', 'body', 'heading'];

/** 工具栏高（画廊置顶那一行）：与 app.css 的 --tl-line 公式同源，改一处必须改两处 */
const TOOLBAR_BASE_PX = 56;
/** 查看器 EXIF 卡片基准宽 / 高：与 app.css 的 --exif-w / --exif-h 同源 */
const EXIF_WIDTH_BASE_PX = 256;
const EXIF_HEIGHT_BASE_PX = 128;

const px = (value: string): number => Number.parseFloat(value);
const round2 = (value: number): number => Math.round(value * 100) / 100;
const kebab = (key: string): string => key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

/** 七档字号的基准值（来自 design-tokens，不在这里另写数字） */
const FONT_BASE: Record<FontTier, number> = {
  caption: px(tokens.font.size.caption),
  meta: px(tokens.font.size.meta),
  label: px(tokens.font.size.label),
  body: px(tokens.font.size.body),
  heading: px(tokens.font.size.heading),
  title: px(tokens.font.size.title),
  hero: px(tokens.font.size.hero),
};

/** 间距基准：tokens.space.s12 → --space-12 */
const SPACE_BASE: Record<string, number> = {};
for (const [key, value] of Object.entries(tokens.space)) {
  SPACE_BASE[`--space-${key.slice(1)}`] = px(value);
}

/** 控件尺寸基准：递归拍平成 tokens.css 里的变量名（iconButton.default → --size-icon-button-default） */
const SIZE_BASE: Record<string, number> = {};
function collectSize(prefix: string, node: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(node)) {
    const name = `${prefix}-${kebab(key)}`;
    if (typeof value === 'string') SIZE_BASE[`--size-${name}`] = px(value);
    else if (value && typeof value === 'object') collectSize(name, value as Record<string, unknown>);
  }
}
collectSize('', tokens.size as unknown as Record<string, unknown>);

/**
 * 派生色：只让用户改「核心几个」，其余层级从这里算出来，保证改一处全站跟随。
 * 低层级文字由正文色派生、材质由背景色派生 —— 与 tokens.css 里
 * --elevation-* 引用 accent 是同一个思路，只是这里换成 color-mix。
 */
const DERIVED_TEXT_COLORS: [string, number][] = [
  ['--color-text-tertiary', 44],
  ['--color-text-quaternary', 30],
  ['--color-text-quinary', 20],
];
const DERIVED_FILL_COLORS: [string, number][] = [
  ['--color-fill-base', 7.5],
  ['--color-fill-secondary', 6],
  ['--color-fill-tertiary', 4.5],
  ['--color-fill-quaternary', 3],
];
const DERIVED_MATERIAL_COLORS: [string, number][] = [
  ['--color-material-opaque', 92],
  ['--color-material-ultra-thick', 86],
  ['--color-material-thick', 72],
  ['--color-material-medium', 55],
  ['--color-material-thin', 35],
  ['--color-material-ultra-thin', 18],
];

export interface ResolvedTheme {
  config: ThemeConfig;
  /** 直接写进 <style> 的 CSS 文本 */
  css: string;
  /** 全局缩放倍率 */
  scale: number;
  /** EXIF 专区倍率（替代全局，不叠加） */
  exifScale: number;
  /**
   * 七档字号的最终 px（已含逐档覆盖与倍率）。
   * 后台的 AntD token 是 JS 算的，拿不到 CSS 变量，只能从这里读。
   */
  fontPx: Record<FontTier, number>;
}

/** 某一档在这一份配置下的字号：显式覆盖优先，否则按倍率算 */
function fontPxOf(tier: FontTier, config: ThemeConfig, scale: number): number {
  return round2(config.fontOverrides[tier] ?? FONT_BASE[tier] * scale);
}

/**
 * 配置 → CSS 覆盖层。纯函数（不碰 DOM），因此后台可以在「保存前」反复调用它做实时预览。
 * 只有颜色是**永远发出**的（改了就立刻生效）；缩放类仅在确实不等于 1 时才发出，
 * 出厂状态下注入的 CSS 因此只有颜色那一小段。
 */
export function resolveTheme(config: ThemeConfig): ResolvedTheme {
  const { colors, fontScale, exifScale } = config;
  const parts: string[] = [];

  /* ---- 第一段：颜色（全端生效，不分断点） ---- */
  const base: string[] = [
    `--color-accent:${colors.accent}`,
    `--color-accent-secondary:${colors.accentSecondary}`,
    `--color-background:${colors.background}`,
    `--color-text-base:${colors.textBase}`,
    `--color-text-secondary:${colors.textSecondary}`,
    `--color-border-base:${colors.borderBase}`,
    `--color-success:${colors.success}`,
    `--color-danger:${colors.danger}`,
    // 缩放变量的保底值：窄屏不缩放，此处恒为 1（PC 媒体查询中再覆盖）
    '--theme-scale:1',
    '--theme-exif-scale:1',
  ];
  for (const [name, percent] of DERIVED_TEXT_COLORS) {
    base.push(`${name}:color-mix(in srgb,var(--color-text-base) ${percent}%,transparent)`);
  }
  for (const [name, percent] of DERIVED_FILL_COLORS) {
    base.push(`${name}:color-mix(in srgb,var(--color-text-base) ${percent}%,transparent)`);
  }
  for (const [name, percent] of DERIVED_MATERIAL_COLORS) {
    base.push(`${name}:color-mix(in srgb,var(--color-background) ${percent}%,transparent)`);
  }
  parts.push(`:root{${base.join(';')}}`);

  /* ---- 第二段：缩放（仅 PC），以及 EXIF 专区的独立字号 ---- */
  const hasOverride = Object.keys(config.fontOverrides).length > 0;
  if (fontScale !== 1 || exifScale !== 1 || hasOverride) {
    const root: string[] = [`--theme-scale:${fontScale}`, `--theme-exif-scale:${exifScale}`];
    for (const tier of FONT_TIERS) root.push(`--font-size-${tier}:${fontPxOf(tier, config, fontScale)}px`);
    for (const [name, value] of Object.entries(SPACE_BASE)) root.push(`${name}:${round2(value * fontScale)}px`);
    for (const [name, value] of Object.entries(SIZE_BASE)) root.push(`${name}:${round2(value * fontScale)}px`);

    // EXIF 专区：档位基准（含逐档覆盖）再乘自己的倍率 —— 与全局的关系是「替代」而非「叠加」
    const exif: string[] = EXIF_SCOPE_TIERS.map(
      (tier) => `--font-size-${tier}:${fontPxOf(tier, config, exifScale)}px`,
    );

    parts.push(
      `@media (min-width:${THEME_SCALE_MIN_WIDTH}px){:root{${root.join(';')}}.${EXIF_SCOPE_CLASS}{${exif.join(';')}}}`,
    );
  }

  const fontPx = {} as Record<FontTier, number>;
  for (const tier of FONT_TIERS) fontPx[tier] = fontPxOf(tier, config, fontScale);

  return { config, css: parts.join(''), scale: fontScale, exifScale, fontPx };
}

/* ==========================================================================
 * 运行时状态：一份当前生效的主题 + 订阅
 * ========================================================================== */

/**
 * 启动初值：出厂颜色 + **不缩放**。
 * 这里刻意不用 THEME_DEFAULTS.fontScale（1.15）—— 真正生效的倍率由接口在渲染前套用，
 * 初值只是「接口还没回来」时的安全垫，保持原样最不容易出错。
 */
let current: ResolvedTheme = resolveTheme({ ...THEME_DEFAULTS, fontScale: 1, exifScale: 1 });

const listeners = new Set<() => void>();

export function getResolvedTheme(): ResolvedTheme {
  return current;
}

/** 订阅主题变化（后台实时预览靠它把改动推给订阅者） */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 把 CSS 写进 <head> 末尾的唯一那个 <style> 节点 */
function writeStyle(css: string): void {
  if (typeof document === 'undefined') return;
  let node = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!node) {
    node = document.createElement('style');
    node.id = STYLE_ID;
    document.head.appendChild(node);
  }
  node.textContent = css;
}

/**
 * 套用一份配置：解析 → 写样式 → 通知订阅者。
 * 后台的「实时预览」就是拿草稿反复调它；点保存前的撤销则是拿基线再调一次。
 */
export function setActiveTheme(config: ThemeConfig): ResolvedTheme {
  current = resolveTheme(config);
  writeStyle(current.css);
  for (const listener of listeners) listener();
  return current;
}

/* ==========================================================================
 * 给「用 JS 算几何」的地方用的缩放读数
 *
 * 这些量在 CSS 里是 calc，在 JS 里必须读出**同一个结果**：
 * 一旦两边不一致，查看器预留的 EXIF 卡片宽度、进度轨的判定线就会错位。
 * ========================================================================== */

/** 当前视口是否处于「缩放生效」的档位（与生成的媒体查询同一个断点） */
export function isScaleActive(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(`(min-width: ${THEME_SCALE_MIN_WIDTH}px)`).matches;
}

/** 全局缩放倍率（窄屏恒为 1） */
export function themeScale(): number {
  return isScaleActive() ? current.scale : 1;
}

/** EXIF 专区倍率（窄屏恒为 1） */
export function themeExifScale(): number {
  return isScaleActive() ? current.exifScale : 1;
}

/** 把间距基准值换算成当前生效的 px（`themeSpace(40)` = --space-40 的实际值） */
export function themeSpace(base: number): number {
  return base * themeScale();
}

/** 进度轨判定线：48px 页头 + 56px 工具栏（与 app.css 的 --tl-line 同式） */
export function themeTlLine(): number {
  return (px(tokens.size.header) + TOOLBAR_BASE_PX) * themeScale();
}

/** 查看器 EXIF 卡片宽 / 高。两者都只随**专区倍率**（不叠加全局）——
    与 app.css 的 --exif-w / --exif-h 用同一组基准数与同一个变量，两边必须一致，
    否则 fitRect 预留的空间会与卡片实际尺寸对不上（照片被压或被叠）。 */
export function themeExifWidth(): number {
  return EXIF_WIDTH_BASE_PX * themeExifScale();
}

export function themeExifHeight(): number {
  return EXIF_HEIGHT_BASE_PX * themeExifScale();
}