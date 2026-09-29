/**
 * apps/mobile/src/components/SearchPanel.tsx
 *
 * 前台 EXIF 搜索面板（RN 版）：从顶栏搜索图标唤出、挂在页头正下方的玻璃卡片。
 * 与 Web 端 SearchPanel 同构 —— 同样的字段、「只认真关闭按钮」的语义。
 *
 * 【为什么不用 Modal】RN 的 Modal 会另起一个 window，dimezis 模糊只能采样到那个
 * window 自己的内容（拿不到背后的页面），玻璃面会退化成一块纯色。因此改成
 * 「同层绝对定位覆盖层」：卡片直接挂在页头下方，背后就是真实页面，模糊才有东西可糊。
 * 代价是 Modal 自带的 onRequestClose 没了，Android 物理返回键改由 useBackClose 接管。
 *
 * 【为什么没有遮罩】与 Web 一致：Web 的 .search-panel 也没有 scrim。用户会反复调整
 * 筛选条件，面板若「点一下别处就收」会把刚调好的草稿丢光，因此这里只认右上角的关闭按钮。
 *
 * 【尺寸口径】面板宽 min(720, 100vw-32)、字段网格 minmax(200px, 1fr) + 12 间距，
 * 全部照抄 Web 的 .search-panel / .search-panel__grid —— 手机自然落到 1 列、
 * 平板（800dp）落到 3 列，不需要为平板另写一套断点。
 *
 * 【筛选在哪发生】条件经「搜索」交给上层后**走服务端检索**（searchApi.photos）——
 * 器材类字段的候选值来自字典，交给后端匹配才能保证与字典、与 EXIF 口径一致。
 *
 * 【字段从哪来】相机 / 镜头 / 光圈 / 快门 / 感光 这 5 个器材字段直接遍历 core 的
 * DICTIONARY_KINDS：标题用 fieldLabel、占位符用 placeholder，与后端口径同源，
 * 不会出现「前端叫快门、后端叫 speed」这种各写一份的不一致。
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DICTIONARY_KINDS } from '@shaping-memory/core';
import type { DictionaryKind } from '@shaping-memory/core';
import type { PhotoQuery } from '@shaping-memory/sdk';

import { DictionaryField } from './DictionaryField';
import { Glass, Icon } from './primitives';
import { TagFilter } from './TagFilter';
import { useBackClose } from '../hooks/useBackClose';
import { useBreakpoint } from '../layout/useBreakpoint';
import { brandTracking, colors, radius, size, space, text } from '../theme';

/** 面板最大宽度：与 Web 的 min(720px, …) 同数 */
const PANEL_MAX_WIDTH = 720;
/** 字段网格的单列最小宽度：与 Web 的 minmax(200px, 1fr) 同数 */
const FIELD_MIN_WIDTH = 200;
/** 字段网格的间距：与 Web 的 gap: var(--space-12) 同数 */
const FIELD_GAP = space.s12;

/** 空搜索条件：清空草稿用 */
const EMPTY: PhotoQuery = {};

/** 纯文本字段（非字典）：关键词与两个日期 */
const TEXT_FIELDS = [
  ['q', '关键词', '标题 / 分类 / 相机 / 镜头'],
  ['from', '拍摄日期起', 'YYYY-MM-DD'],
  ['to', '拍摄日期止', 'YYYY-MM-DD'],
] as const;

/** 字典类型 → 检索字段名：只有 camera→cam、shutter→speed 两处键名不同，在这里对齐一次 */
const FIELD_OF_KIND: Record<DictionaryKind, 'cam' | 'lens' | 'aperture' | 'speed' | 'iso'> = {
  camera: 'cam',
  lens: 'lens',
  aperture: 'aperture',
  shutter: 'speed',
  iso: 'iso',
};

interface SearchPanelProps {
  /** 提交（点「搜索」）：把草稿作为最终搜索条件交给上层 */
  onApply: (query: PhotoQuery) => void;
  /** 关闭：唯一能让面板消失的通道 */
  onClose: () => void;
}

export function SearchPanel({ onApply, onClose }: SearchPanelProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useBreakpoint();
  const [draft, setDraft] = useState<PhotoQuery>(EMPTY);
  useBackClose(onClose);

  /* 字段网格按宽度定列数：等价于 CSS 的 repeat(auto-fill, minmax(200px, 1fr)) */
  const panelWidth = Math.min(PANEL_MAX_WIDTH, width - space.s16 * 2);
  const innerWidth = panelWidth - space.s16 * 2;
  const columns = Math.max(1, Math.floor((innerWidth + FIELD_GAP) / (FIELD_MIN_WIDTH + FIELD_GAP)));
  const fieldWidth = (innerWidth - (columns - 1) * FIELD_GAP) / columns;

  /* 手机竖屏下 9 个字段会高过屏幕，字段区自己滚；提交行钉在底部（与 Web 同结构）。
     space.s64 让出的正是页头 + 底部留白，卡片不会顶到屏幕外。 */
  const bodyMaxHeight = height - insets.top - space.s64;

  /** 写一个字段：空值即删除该键，避免把「没填」当成有效条件发给后端 */
  const patch = (key: keyof PhotoQuery, value: string | number | boolean | undefined) =>
    setDraft((prev) => {
      const next = { ...prev };
      if (value === '' || value === undefined) delete next[key];
      else next[key] = value as never;
      return next;
    });

  /** 取某个字典字段的文本值（只有感光度是数字，其余是字符串） */
  const valueOfKind = (kind: DictionaryKind): string => {
    const raw = draft[FIELD_OF_KIND[kind]];
    return typeof raw === 'number' ? String(raw) : raw ?? '';
  };

  /** 字典字段回填：感光度是数字维度，解析不出有限数就视为「未填」 */
  const setKindValue = (kind: DictionaryKind, input: string) => {
    const key = FIELD_OF_KIND[kind];
    if (key !== 'iso') {
      patch(key, input);
      return;
    }
    const parsed = Number(input.trim());
    patch('iso', input.trim() !== '' && Number.isFinite(parsed) ? parsed : undefined);
  };

  const hasGpsValue = draft.hasGps === undefined ? '' : draft.hasGps ? '1' : '0';

  /**
   * 标签是唯一的**数组**维度，不能走 patch —— patch 按标量 key 逐个赋值，
   * 塞数组进去会破坏其余九个字段的类型约束。空数组即删除该维度，与别处「空即不限」一致。
   */
  const setTags = (names: string[]) =>
    setDraft((prev) => {
      const next = { ...prev };
      if (names.length === 0) delete next.tags;
      else next.tags = names;
      return next;
    });

  return (
    <Glass corner="xl" style={[styles.panel, { width: panelWidth }]}>
      <ScrollView style={{ maxHeight: bodyMaxHeight }} contentContainerStyle={styles.grid} keyboardShouldPersistTaps="handled">
        {/* 标签在第一行：它是「先圈大范围、再用 EXIF 抠细节」里的第一步 */}
        <TagFilter value={draft.tags ?? []} onChange={setTags} />

        {TEXT_FIELDS.map(([key, label, placeholder]) => (
          <View style={[styles.field, { width: fieldWidth }]} key={key}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              style={styles.input}
              value={draft[key] ?? ''}
              onChangeText={(value) => patch(key, value)}
              placeholder={placeholder}
              placeholderTextColor={colors.text.quaternary}
              autoCapitalize="none"
              autoCorrect={false}
              underlineColorAndroid="transparent"
              accessibilityLabel={label}
            />
          </View>
        ))}

        {/* 5 个器材字段：字典下拉 + 实时联想。包一层定宽壳，让它们与文本字段同宽 */}
        {DICTIONARY_KINDS.map((meta) => (
          <View key={meta.kind} style={{ width: fieldWidth }}>
            <DictionaryField
              kind={meta.kind}
              label={meta.fieldLabel}
              placeholder={meta.placeholder}
              value={valueOfKind(meta.kind)}
              onChangeText={(input) => setKindValue(meta.kind, input)}
            />
          </View>
        ))}

        <View style={[styles.field, { width: fieldWidth }]}>
          <Text style={styles.fieldLabel}>定位状态</Text>
          <View style={styles.seg}>
            {(
              [
                ['', '不限'],
                ['1', '有定位'],
                ['0', '无定位'],
              ] as const
            ).map(([value, label]) => {
              const on = hasGpsValue === value;
              return (
                <Pressable
                  key={value || 'any'}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: on }}
                  onPress={() => patch('hasGps', value === '' ? undefined : value === '1')}
                  style={[styles.segItem, on && styles.segOn]}
                >
                  <Text style={[text.label, on ? styles.segLabelOn : styles.segLabelOff]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {/* 提交行：一条发丝线把「填条件」与「提交」分成两段，按钮不再浮在字段里显得零散 */}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="清空搜索条件"
          onPress={() => setDraft(EMPTY)}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Icon name="close" size={14} color={colors.text.tertiary} />
          <Text style={styles.actionText}>清空</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="搜索"
          onPress={() => onApply(draft)}
          style={({ pressed }) => [styles.action, styles.primary, pressed && styles.pressed]}
        >
          <Icon name="search" size={14} color={colors.background} />
          <Text style={styles.primaryText}>搜索</Text>
        </Pressable>
      </View>

      {/* 关闭固定在右上角：唯一且显眼的收口 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭搜索"
        onPress={onClose}
        hitSlop={8}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
      >
        <Icon name="close" size={16} color={colors.text.tertiary} />
      </Pressable>
    </Glass>
  );
}

const styles = StyleSheet.create({
  /* 挂载点把卡片贴在页头正下方：top:'100%' 由挂载它的页头容器决定，页头高度变了也不用改这里。
     水平取 alignSelf:'center' —— 挂载容器左右对称，居中即屏幕居中（与 Web 的 left:50% 同效）。 */
  panel: {
    position: 'absolute',
    top: '100%',
    alignSelf: 'center',
    paddingHorizontal: space.s16,
    paddingTop: space.s16,
    paddingBottom: space.s12,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: FIELD_GAP, rowGap: FIELD_GAP },

  field: { gap: space.s6 },
  /* 与 Web 的 .search-field__label 同款：caption 档 + 最宽字距 + 全大写 + 四级文字色 */
  fieldLabel: {
    ...text.caption,
    ...brandTracking,
    color: colors.text.quaternary,
    textTransform: 'uppercase',
  },
  input: {
    ...text.body,
    height: 44,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },

  seg: { flexDirection: 'row', gap: space.s6 },
  segItem: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.material.thin,
  },
  segOn: { backgroundColor: colors.accent },
  segLabelOn: { color: colors.background, fontWeight: '600' },
  segLabelOff: { color: colors.text.secondary },

  /* 与 Web 的 .search-panel__actions 同款：右对齐 + 上发丝线，按钮是胶囊而非大色块 */
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.s8,
    marginTop: space.s16,
    paddingTop: space.s12,
    borderTopWidth: 1,
    borderTopColor: colors.border.base,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    height: size.button.sm,
    paddingHorizontal: space.s16,
    borderRadius: radius.full,
  },
  actionText: { ...text.label, color: colors.text.tertiary },
  primary: { backgroundColor: colors.accent },
  primaryText: { ...text.label, color: colors.background, fontWeight: '600' },

  close: {
    position: 'absolute',
    top: space.s8,
    right: space.s8,
    alignItems: 'center',
    justifyContent: 'center',
    width: size.iconButton.default,
    height: size.iconButton.default,
    borderRadius: radius.full,
  },

  pressed: { opacity: 0.72 },
});
