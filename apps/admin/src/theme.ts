/**
 * apps/admin/src/theme.ts
 *
 * AntD v5 主题：把项目设计语言的 token **与后台可配置的主题**一起注入 AntD 的 token 体系。
 *
 * 【为什么不直接写颜色】packages/design-tokens 是唯一事实源（docs/设计语言-Token规范.md §5.1），
 * 后台必须与前台同一套底色 / 强调色 / 圆角 / 字号，否则两个界面像两个产品。
 * AntD 的组件内部配色由它自己的 token 计算，因此这里做一次「token → AntD token」的映射，
 * 而不是在 CSS 里逐个覆盖 .ant-* 类名。
 *
 * 【为什么是个工厂而不是常量】主题配置现在由后台自己维护（theme.config），
 * 改动要能实时预览 —— 常量无法满足，每次渲染按当前配置计算一份才能随之变化。
 */
import { theme as antdTheme } from 'antd';
import type { ThemeConfig as AntdThemeConfig } from 'antd';
import { tokens } from '@shaping-memory/design-tokens';
import type { ThemeConfig } from '@shaping-memory/core';

/** 后台控制的基准高：与 tokens 无关，是 AntD 的默认档，随倍率一起放大 */
const CONTROL_HEIGHT_BASE = 32;

/**
 * 将背景色向白色方向提升一档，作为「容器底色」的实色近似。
 *
 * 【为什么不用现成的材质色】tokens 里的 material.* 是半透明色（配 backdrop-filter 用），
 * 而 AntD 的 colorBgContainer 是不透明容器底 —— 直接使用半透明色会让表格行透出页头。
 * 这里按「背景色叠加少量白色」计算实色，更换背景色时容器随之变化。
 */
function elevateBackground(background: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(background.trim());
  if (!match) return background; // 非 6 位十六进制（如 rgba()）不做推测，交由 AntD 自行计算
  const value = Number.parseInt(match[1], 16);
  const lift = (channel: number): number => Math.round(channel + (255 - channel) * amount);
  const r = lift((value >> 16) & 0xff);
  const g = lift((value >> 8) & 0xff);
  const b = lift(value & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * 按当前主题配置算一份 AntD 主题。
 * @param config 当前**草稿**配置（实时预览就是把它传进来）
 * @param scale  字号/控件尺寸倍率。窄屏传 1 —— AntD 的 token 由 JS 计算，
 *               无法像 CSS 那样交给媒体查询，因此由调用方先判好断点再传进来。
 */
export function buildAdminTheme(config: ThemeConfig, scale: number): AntdThemeConfig {
  const { colors } = config;
  const container = elevateBackground(colors.background, 0.06);
  // 正文字号：有逐档覆盖则优先，否则基准 × 倍率
  const baseBody = Number.parseFloat(tokens.font.size.body);
  const bodyPx = Math.round(config.fontOverrides.body ?? baseBody * scale);

  return {
    algorithm: antdTheme.darkAlgorithm,
    token: {
      // 强调色与状态色：跟随后台配置
      colorPrimary: colors.accent,
      colorInfo: colors.accent,
      colorError: colors.danger,
      colorSuccess: colors.success,

      // 底色与层级：容器比背景亮一档，靠明度表达，不换色相
      colorBgBase: colors.background,
      colorBgContainer: container,
      colorBgElevated: container,
      colorBorder: colors.borderBase,
      colorBorderSecondary: colors.borderBase,
      colorText: colors.textBase,
      colorTextSecondary: colors.textSecondary,

      // 圆角映射容器尺寸；后台信息密度高，整体取中档
      borderRadius: 9,
      borderRadiusLG: 12,
      borderRadiusSM: 7,

      // 字号与控件高随倍率放大（后台只在宽屏使用，窄屏由调用方传 1）
      fontSize: bodyPx,
      fontFamily: tokens.font.family.sans.join(', '),
      controlHeight: Math.round(CONTROL_HEIGHT_BASE * scale),
    },
    components: {
      Layout: {
        headerBg: container,
        bodyBg: colors.background,
        headerHeight: Math.round(52 * scale),
      },
      Table: {
        headerBg: tokens.color.fill.tertiary,
        rowHoverBg: tokens.color.fill.quaternary,
        borderColor: colors.borderBase,
        cellPaddingBlockSM: 6,
      },
      Drawer: {
        colorBgElevated: container,
      },
      Card: {
        colorBgContainer: tokens.color.material.thin,
      },
    },
  };
}