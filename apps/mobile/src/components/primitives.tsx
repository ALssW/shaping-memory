/**
 * apps/mobile/src/components/primitives.tsx
 *
 * RN 端的交互基元：图标 / 圆形图标按钮 / 胶囊分段 / chip / 玻璃面。
 * 与 Web 端 apps/web/src/components/controls.tsx 一一对应，
 * 尺寸与配色全部从 src/theme.ts 取，不直接写入字面数值。
 *
 * 交互统一用 Pressable：它是 RN 官方推荐替代 TouchableOpacity 的组件，
 * 按下态靠 style 回调拿到，不需要自己维护一份 pressed state。
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, ReactNode } from 'react';
import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';

import { accentOpacity, accentRgba, blurIntensity, colors, glassShadow, glassTint, radius, size, space, text } from '../theme';

/* -------------------------------------------------------------------------- */
/* 图标                                                                        */
/* -------------------------------------------------------------------------- */

export type IconName =
  | 'grid'
  | 'album'
  | 'map'
  | 'wrench'
  | 'camera'
  | 'aperture'
  | 'close'
  | 'download'
  | 'heart'
  | 'heartFilled'
  | 'arrowLeft'
  | 'arrowRight'
  | 'info'
  | 'chevron'
  | 'chevronRight'
  | 'search'
  | 'edit'
  | 'user'
  | 'logout'
  | 'check'
  | 'list'
  | 'arrowUp'
  | 'arrowDown'
  | 'save'
  | 'sliders'
  | 'pin';

type FeatherName = ComponentProps<typeof Feather>['name'];

/**
 * 图标集换成 @expo/vector-icons 的字形（随 expo 一起提供，不必再引 svg 运行时）。
 * 只有实心爱心需要换一个字形族 —— Feather 全是线性图标。
 */
const GLYPHS: Record<Exclude<IconName, 'heartFilled'>, FeatherName> = {
  grid: 'grid',
  album: 'image',
  map: 'map',
  wrench: 'tool',
  camera: 'camera',
  aperture: 'aperture',
  close: 'x',
  download: 'download',
  heart: 'heart',
  arrowLeft: 'chevron-left',
  arrowRight: 'chevron-right',
  info: 'info',
  chevron: 'chevron-down',
  chevronRight: 'chevron-right',
  search: 'search',
  edit: 'edit-2',
  user: 'user',
  logout: 'log-out',
  check: 'check',
  list: 'list',
  /* 排序的两枚图标在 Web 上就是「上下尖括号」（见 Icon.tsx 的 arrowUp/arrowDown 路径），
     不是带杆的箭头 —— 排序控件因此与 Web 同形，不会读成两个不同的东西 */
  arrowUp: 'chevron-up',
  arrowDown: 'chevron-down',
  save: 'save',
  /* 面板型工具（EXIF 编辑）的图标：与 PanelToolDef.icon 同名，两端各自按名实现 */
  sliders: 'sliders',
  /* 拍摄地点：与 Web 的 Icon name="pin" 同一枚（地图针脚），地点字段两端同形 */
  pin: 'map-pin',
};

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

export function Icon({ name, size: glyphSize = size.icon.default, color = colors.text.base }: IconProps) {
  if (name === 'heartFilled') return <Ionicons name="heart" size={glyphSize} color={color} />;
  return <Feather name={GLYPHS[name]} size={glyphSize} color={color} />;
}

/* -------------------------------------------------------------------------- */
/* 圆形图标按钮：只有 default(32) / compact(28) 两档                            */
/* -------------------------------------------------------------------------- */

interface IconButtonProps {
  name: IconName;
  label: string;
  size?: 'default' | 'compact';
  active?: boolean;
  glass?: boolean;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}

export const IconButton = memo(function IconButton({ name, label, size: tier = 'default', active = false, glass = false, style, onPress }: IconButtonProps) {
  const glyphSize = tier === 'compact' ? size.icon.compact : size.icon.default;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        tier === 'compact' && styles.iconButtonCompact,
        glass && styles.iconButtonGlass,
        active && styles.iconButtonActive,
        pressed && styles.pressed,
        style,
      ]}
    >
      <Icon name={name} size={glyphSize} color={active ? colors.accent : colors.text.base} />
    </Pressable>
  );
});

/* -------------------------------------------------------------------------- */
/* 胶囊分段控件（主导航 / 墙面-列表 / 倒序-正序 共用）                          */
/* -------------------------------------------------------------------------- */

export interface PillOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

interface PillBarProps<T extends string> {
  options: readonly PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** 只渲染图标、隐藏文字：文字保留为无障碍标签。用于顶栏导航 / 视图 / 排序等 */
  iconOnly?: boolean;
}

export function PillBar<T extends string>({ options, value, onChange, label, iconOnly = false }: PillBarProps<T>) {
  return (
    <Glass corner="full" style={styles.pillBar}>
      {/* 内层容器只为把整组暴露给读屏（role=tablist + 组名），样式仍由 Glass 承担 */}
      <View accessibilityRole="tablist" accessibilityLabel={label} style={styles.pillGroup}>
        {options.map((option) => {
          const isOn = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: isOn }}
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [styles.pillItem, iconOnly && styles.pillItemIcon, isOn && styles.pillItemOn, pressed && styles.pressed]}
            >
              {option.icon ? (
                <Icon name={option.icon} size={14} color={isOn ? colors.background : colors.text.secondary} />
              ) : null}
              {iconOnly ? null : (
                <Text style={[text.label, isOn ? styles.pillLabelOn : styles.pillLabelOff]} numberOfLines={1}>
                  {option.label}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </Glass>
  );
}

/* -------------------------------------------------------------------------- */
/* 分类 chip                                                                   */
/* -------------------------------------------------------------------------- */

interface ChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

export const Chip = memo(function Chip({ label, active, onPress }: ChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipOn, pressed && styles.pressed]}
    >
      <Text style={[text.label, active ? styles.chipLabelOn : styles.chipLabelOff]}>{label}</Text>
    </Pressable>
  );
});

/* -------------------------------------------------------------------------- */
/* 玻璃面：模糊层 + 材质层必须成对，缺一个就退化成半透明色块                      */
/* -------------------------------------------------------------------------- */

interface GlassProps {
  children?: ReactNode;
  /** 模糊档位：按角色选，只有三档 */
  blur?: keyof typeof blurIntensity;
  corner?: keyof typeof radius;
  style?: StyleProp<ViewStyle>;
}

export function Glass({ children, blur = 'md', corner = 'xl', style }: GlassProps) {
  const cornerRadius = radius[corner];
  return (
    <View style={[{ borderRadius: cornerRadius }, glassShadow, style]}>
      {/* Android 需要显式打开 dimezis 实现，否则只有 iOS 有真实模糊 */}
      <BlurView
        intensity={blurIntensity[blur]}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={[StyleSheet.absoluteFill, { borderRadius: cornerRadius, overflow: 'hidden' }]}
      />
      <View style={[StyleSheet.absoluteFill, { borderRadius: cornerRadius }, glassTint]} />
      {children}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  pressed: { opacity: 0.72 },

  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    width: size.iconButton.default,
    height: size.iconButton.default,
    borderRadius: radius.full,
  },
  iconButtonCompact: { width: size.iconButton.compact, height: size.iconButton.compact },
  /** 激活态：accent 文字 + 12% 淡洗底，不填实心 accent */
  iconButtonActive: { backgroundColor: accentRgba(accentOpacity.wash) },
  /** 压在照片上：只给一层材质底，无描边 */
  iconButtonGlass: {
    backgroundColor: colors.material.ultraThick,
  },

  pillBar: {
    alignSelf: 'flex-start',
    padding: space.s4,
  },
  /** 组内条目行：间距放这里，外层只留内边距 */
  pillGroup: { flexDirection: 'row', alignItems: 'center', gap: space.s2 },
  pillItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    height: 28,
    paddingHorizontal: space.s12,
    borderRadius: radius.full,
  },
  /** 纯图标项：收窄左右内边距，去掉文字后的间距 */
  pillItemIcon: { paddingHorizontal: space.s8, gap: 0 },
  /** 激活态实心 accent：唯一允许「填充 accent」的两种场合之一 */
  pillItemOn: { backgroundColor: colors.accent },
  pillLabelOn: { color: colors.background, fontWeight: '600' },
  pillLabelOff: { color: colors.text.secondary },

  chip: {
    height: size.chip,
    justifyContent: 'center',
    paddingHorizontal: space.s12,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  /** 激活态：accent 淡洗底 + accent 文字。无描边 */
  chipOn: { backgroundColor: accentRgba(accentOpacity.wash) },
  chipLabelOn: { color: colors.accent, fontWeight: '600' },
  chipLabelOff: { color: colors.text.secondary },
});

/** chip 行 / 图标按钮行共用：横向排布且允许换行 */
export const rowStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: space.s8,
};

/** 横向可滚动的 chip 行：分类多了也不会把标签挤到看不见 */
export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={rowStyle}>
      {children}
    </ScrollView>
  );
}

/** 分区小标题：全大写、宽字距、四级文字色 */
export function SectionLabel({ children }: { children: string }) {
  return <Text style={[labelStyle]}>{children}</Text>;
}

const labelStyle: TextStyle = {
  ...text.meta,
  color: colors.text.quaternary,
  textTransform: 'uppercase',
  marginBottom: space.s8,
};