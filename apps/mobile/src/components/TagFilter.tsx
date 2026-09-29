/**
 * apps/mobile/src/components/TagFilter.tsx
 *
 * 标签筛选器（RN 版）：挂在 SearchPanel 的第一行，支持多选。
 * 与 Web 端 TagFilter 同构 —— 同一个 SDK 数据源、同一套 AND 语义。
 *
 * 【为什么内联展开而不是 Modal】面板本身已经占用了 Android 返回键（useBackClose），
 * 再叠一层 Modal 会让返回键的语义变得含混（先关谁？）；展开/收起只是把候选区放长，
 * 外层 ScrollView 本来就能滚，因此内联是更直接也更符合直觉的做法。
 *
 * 【触控尺寸】候选与已选标签的高度都取 44 —— 与面板里的输入框同高，
 * 既是 Apple HIG 的最小触控高度，视觉上也不会比输入框矮一截。
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { loadTagCatalog } from '@shaping-memory/sdk';
import type { TagOption } from '@shaping-memory/sdk';

import { Icon } from './primitives';
import { accentOpacity, accentRgba, colors, radius, space, text } from '../theme';

/** 收起时最多铺开几枚（已选的另有展示区，因此这里少列几枚也不会导致找不到） */
const COLLAPSED_LIMIT = 12;
/** 展开后的候选区最高多少：超过就在区内滚，面板不会被拉成一条长条 */
const EXPANDED_MAX_HEIGHT = 240;

interface TagFilterProps {
  /** 已选标签名；空数组即「不按标签筛」 */
  value: string[];
  onChange: (names: string[]) => void;
}

export function TagFilter({ value, onChange }: TagFilterProps) {
  const [options, setOptions] = useState<readonly TagOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTagCatalog()
      .then((list) => {
        if (cancelled) return;
        setOptions(list);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // 面板会被反复开合：卸载后的 setState 要拦掉
    return () => {
      cancelled = true;
    };
  }, []);

  /** 按关键词本地过滤候选（候选已在内存里，逐字过滤比发请求跟手得多） */
  const matched = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((tag) => tag.name.toLowerCase().includes(q));
  }, [options, keyword]);

  const visible = expanded ? matched : matched.slice(0, COLLAPSED_LIMIT);

  /** 点一枚标签 = 选中 / 取消 */
  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>标签</Text>

      {/* 已选区：点整块即取消，× 仅提示「整块可点击取消」，无需额外的迷你命中区 */}
      {value.length > 0 && (
        <View style={styles.selected}>
          {value.map((name) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={`取消标签 ${name}`}
              onPress={() => toggle(name)}
              style={({ pressed }) => [styles.chip, styles.chipOn, pressed && styles.pressed]}
            >
              <Text style={[text.label, styles.chipLabelOn]}>{name}</Text>
              <Icon name="close" size={12} color={colors.accent} />
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.head}>
        <TextInput
          style={styles.input}
          value={keyword}
          onChangeText={setKeyword}
          placeholder={loading ? '标签加载中…' : '搜索标签'}
          placeholderTextColor={colors.text.quaternary}
          autoCapitalize="none"
          autoCorrect={false}
          underlineColorAndroid="transparent"
          accessibilityLabel="搜索标签"
        />
        {/* 候选多过一屏才给展开入口，避免固定占一个没用的按钮 */}
        {matched.length > COLLAPSED_LIMIT && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? '收起标签候选' : '展开更多标签'}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((prev) => !prev)}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            <Icon name={expanded ? 'arrowUp' : 'arrowDown'} size={16} color={colors.text.tertiary} />
            <Text style={[text.label, styles.moreText]}>{expanded ? '收起' : `更多 ${matched.length}`}</Text>
          </Pressable>
        )}
      </View>

      {/* 候选区：展开后可滚（外层面板也在滚，故显式开 nestedScrollEnabled） */}
      <ScrollView
        style={expanded ? styles.optionsExpanded : undefined}
        contentContainerStyle={styles.options}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {visible.map((tag) => {
          const on = value.includes(tag.name);
          return (
            <Pressable
              key={tag.id}
              accessibilityRole="button"
              accessibilityLabel={tag.name}
              accessibilityState={{ selected: on }}
              onPress={() => toggle(tag.name)}
              style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
            >
              {on && <Icon name="check" size={12} color={colors.accent} />}
              <Text style={[text.label, on ? styles.chipLabelOn : styles.chipLabelOff]}>{tag.name}</Text>
              <Text style={[text.caption, styles.count]}>{tag.count}</Text>
            </Pressable>
          );
        })}
        {!loading && matched.length === 0 && (
          <Text style={[text.label, styles.empty]}>{failed ? '标签加载失败，请稍后重试' : '未找到匹配的标签'}</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  /* 撑满整行：外层字段网格是 row + wrap，不给 100% 会被挤到与某个字段并排 */
  wrap: { width: '100%', gap: space.s8 },
  label: {
    ...text.caption,
    color: colors.text.quaternary,
    textTransform: 'uppercase',
  },

  selected: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  input: {
    ...text.body,
    flex: 1,
    height: 44,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  more: { flexDirection: 'row', alignItems: 'center', gap: space.s4, height: 44 },
  moreText: { color: colors.text.tertiary },

  optionsExpanded: { maxHeight: EXPANDED_MAX_HEIGHT },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 },

  /* 候选与已选共用：44 高、胶囊底，选中时换 accent 淡洗底 + accent 文字 */
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    height: 44,
    paddingHorizontal: space.s16,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  chipOn: { backgroundColor: accentRgba(accentOpacity.wash) },
  chipLabelOn: { color: colors.accent, fontWeight: '600' },
  chipLabelOff: { color: colors.text.secondary },
  count: { color: colors.text.quaternary },
  empty: { color: colors.text.quaternary },

  pressed: { opacity: 0.72 },
});