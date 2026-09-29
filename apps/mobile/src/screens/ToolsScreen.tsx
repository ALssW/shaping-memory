/**
 * apps/mobile/src/screens/ToolsScreen.tsx
 *
 * 工具模块：遍历 @shaping-memory/core 的 TOOL_REGISTRY，按字段 schema 动态渲染表单，
 * 数值交给纯函数 compute 得到结果 —— 与 Web 端 apps/web/src/screens/ToolsScreen.tsx
 * 共用同一份计算逻辑，因此两端算出的结果逐位一致。
 *
 * 【两类工具】计算器（TOOL_REGISTRY）就地渲染「填数看结果」；面板型工具
 * （PANEL_TOOL_REGISTRY，如 EXIF 编辑）点开进入各自端实现的全屏工作台 ——
 * 它们要选文件、改字节、导出，无法用 compute 的形态表达（见「工具」模块设计）。
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { PANEL_TOOL_REGISTRY, TOOL_REGISTRY } from '@shaping-memory/core';
import type { PanelToolDef, ToolDef, ToolField } from '@shaping-memory/core';

import { Glass, Icon, rowStyle } from '../components/primitives';
import type { IconName } from '../components/primitives';
import { LocalExifToolPanel } from '../components/LocalExifToolPanel';
import { accentOpacity, accentRgba, colors, fontFamily, radius, size, space, tabularNums, text } from '../theme';

/** 工具图标映射：清单是数据，图标是表现，两边不互相污染 */
const TOOL_ICONS: Record<string, IconName> = {
  nd: 'aperture',
  ev: 'wrench',
  dof: 'camera',
  fov: 'grid',
  color_temp: 'aperture',
};

/** 面板工具的图标：注册表给的是名字，本端的 Icon 组件按名实现（名字对不上就退回默认图标） */
const PANEL_ICONS: Record<string, IconName> = { sliders: 'sliders' };

/** 由字段默认值搭出初始 state（全部字段默认都是 number） */
function defaultsOf(tool: ToolDef): Record<string, number> {
  const values: Record<string, number> = {};
  for (const field of tool.fields) values[field.key] = field.default;
  return values;
}

/** 单输入控件：number 渲染数值框，select 渲染 chip 按钮组 */
function ToolFieldControl({ field, value, onChange }: { field: ToolField; value: number; onChange: (next: number) => void }) {
  if (field.type === 'select') {
    return (
      <View>
        <Text style={styles.fieldLabel}>{field.label}</Text>
        <View style={rowStyle}>
          {(field.options ?? []).map((option) => {
            const isOn = option.value === value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityState={{ selected: isOn }}
                onPress={() => onChange(option.value)}
                style={({ pressed }) => [styles.preset, isOn && styles.presetOn, pressed && styles.pressed]}
              >
                <Text style={[text.caption, isOn ? styles.presetTextOn : styles.presetTextOff]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.fieldLabel}>
        {field.label}
        {field.label && field.unit ? ` · ${field.unit}` : ''}
      </Text>
      <TextInput
        style={styles.input}
        value={Number.isFinite(value) ? String(value) : ''}
        onChangeText={(raw) => onChange(Number(raw))}
        keyboardType="decimal-pad"
        inputMode="decimal"
        placeholderTextColor={colors.text.quaternary}
        /* Android 默认会在输入框下画一条下划线，也是一道白边，显式关掉 */
        underlineColorAndroid="transparent"
        accessibilityLabel={field.label}
      />
    </View>
  );
}

/** 一张可交互的计算卡：头部 + 字段 + 结果 */
function ToolCard({ tool }: { tool: ToolDef }) {
  const [values, setValues] = useState(() => defaultsOf(tool));

  const setField = (key: string, next: number): void => {
    setValues((prev) => ({ ...prev, [key]: next }));
  };

  // 字段少（≤4）且函数纯，但结果带 toFixed 分支，切字段时才算即可
  const result = useMemo(() => tool.compute(values), [tool, values]);

  return (
    <Glass corner="xl" style={styles.toolCard}>
      <View style={styles.toolHead}>
        <View style={styles.toolIcon}>
          <Icon name={TOOL_ICONS[tool.key] ?? 'wrench'} />
        </View>
        <View style={styles.toolHeadText}>
          <Text style={styles.toolName}>{tool.name}</Text>
          <Text style={styles.toolDesc}>{tool.desc}</Text>
        </View>
      </View>

      <View style={styles.fields}>
        {tool.fields.map((field) => (
          <ToolFieldControl key={field.key} field={field} value={values[field.key]} onChange={(next) => setField(field.key, next)} />
        ))}
      </View>

      <View style={styles.result}>
        <Text style={styles.resultLabel}>{result.primarySub ?? tool.name}</Text>
        <View style={styles.resultText}>
          <Text style={styles.resultValue}>{result.primary}</Text>
          {result.rows.length > 0 ? (
            <View style={styles.resultRows}>
              {result.rows.map((row) => (
                <View key={row.label} style={styles.resultRow}>
                  <Text style={styles.resultRowLabel}>{row.label}</Text>
                  <Text style={styles.resultRowValue}>{row.value}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Glass>
  );
}

export function ToolsScreen() {
  /* 面板型工具打开的是全屏工作台（目前只有 EXIF 编辑）：存 key，关掉即卸载 */
  const [panel, setPanel] = useState<string | null>(null);

  return (
    <>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>工具</Text>
        <Text style={styles.sub}>拍摄现场用得上的换算，全在本地即时计算</Text>

        <View style={styles.list}>
          {/* 面板型工具排在计算器之前：打开一个工作台与填数看结果不是同一类操作 */}
          {PANEL_TOOL_REGISTRY.map((tool) => (
            <PanelToolCard key={tool.key} tool={tool} onOpen={() => setPanel(tool.key)} />
          ))}
          {TOOL_REGISTRY.map((tool) => (
            <ToolCard key={tool.key} tool={tool} />
          ))}
        </View>
      </ScrollView>

      {/* 按 key 挂载：注册表将来变长时，在这里加一条分发即可 */}
      {panel === 'exif-edit' ? <LocalExifToolPanel onClose={() => setPanel(null)} /> : null}
    </>
  );
}

/** 面板型工具卡：不自带表单与结果，点开进入全屏工作台 */
function PanelToolCard({ tool, onOpen }: { tool: PanelToolDef; onOpen: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开${tool.name}`}
      onPress={onOpen}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      <Glass corner="xl" style={styles.toolCard}>
        <View style={styles.toolHead}>
          <View style={styles.toolIcon}>
            <Icon name={PANEL_ICONS[tool.icon] ?? 'wrench'} />
          </View>
          <View style={styles.toolHeadText}>
            <View style={styles.panelTitleRow}>
              <Text style={styles.toolName}>{tool.name}</Text>
              {/* 「本地 · 免登录」是面板型工具的特点，挂在标题旁边最省地方 */}
              {tool.local ? <Text style={styles.localTag}>本地 · 免登录</Text> : null}
            </View>
            <Text style={styles.toolDesc}>{tool.desc}</Text>
          </View>
          <Icon name="chevronRight" size={size.icon.compact} color={colors.text.quaternary} />
        </View>
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: space.s16, paddingBottom: space.s40, gap: space.s4 },
  title: { ...text.title },
  sub: { ...text.meta },
  list: { gap: space.s12, marginTop: space.s12 },

  toolCard: { padding: space.s16, gap: space.s8 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: space.s12 },
  toolHeadText: { flex: 1, gap: space.s2 },
  panelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  /** 免登录标记：accent 淡洗底的小胶囊，与 chip 的激活态同一套口径 */
  localTag: {
    ...text.meta,
    color: colors.accent,
    paddingHorizontal: space.s8,
    paddingVertical: space.s2,
    borderRadius: radius.full,
    backgroundColor: accentRgba(accentOpacity.wash),
    overflow: 'hidden',
  },
  toolIcon: {
    width: size.iconButton.default,
    height: size.iconButton.default,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: accentRgba(accentOpacity.wash),
  },
  toolName: { ...text.heading, fontWeight: '700' },
  toolDesc: { ...text.meta },

  fields: { gap: space.s8, marginTop: space.s4 },
  fieldLabel: { ...text.caption, color: colors.text.tertiary },
  input: {
    ...text.body,
    height: size.button.sm,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },

  preset: {
    height: size.chip,
    justifyContent: 'center',
    paddingHorizontal: space.s12,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  presetOn: { backgroundColor: accentRgba(accentOpacity.wash) },
  presetTextOn: { color: colors.accent, fontWeight: '600' },
  presetTextOff: { color: colors.text.secondary },
  pressed: { opacity: 0.75 },

  result: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.s12,
    marginTop: space.s4,
    padding: space.s12,
    borderRadius: radius.lg,
    backgroundColor: accentRgba(accentOpacity.wash),
  },
  resultLabel: { ...text.caption, color: colors.accent, fontWeight: '600', width: 104, flexShrink: 0 },
  resultText: { flex: 1, alignItems: 'flex-end', gap: space.s2 },
  resultValue: { ...text.title, fontWeight: '700', color: colors.accent },
  resultRows: { width: '100%', gap: space.s6, marginTop: space.s4 },
  resultRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.s16 },
  resultRowLabel: { ...text.caption, color: colors.text.tertiary },
  /* 工具输出是数值类信息：与 Web 的 .tool-result__row-value 同款等宽，逐位比对不错行 */
  resultRowValue: { ...text.body, color: colors.text.base, fontFamily: fontFamily.mono, ...tabularNums },
});