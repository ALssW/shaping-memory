/**
 * apps/mobile/src/components/DictionaryField.tsx
 *
 * 字典字段：可输入的搜索框 + 实时联想候选（RN 版，不引入任何新依赖）。
 *
 * 【候选从哪来】searchApi.suggest(kind, q) —— 后端按字典内容做前缀/包含匹配；
 *   q 为空时返回最靠前的一屏，因此「聚焦即预加载一批」，用户不必先打字。
 *
 * 【为什么要防抖】逐字母打字会打爆联想接口，也让候选在眼前乱闪；
 *   输入停顿 250ms 才发请求，打字过程本身就安静。
 *
 * 【候选项为什么画在输入框下方而不是浮层】面板本体就是一个 ScrollView，
 *   绝对定位的浮层会被它裁掉；直接内联一段带最大高度的可滚动列表最稳。
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { searchApi } from '@shaping-memory/sdk';
import type { DictionaryEntry } from '@shaping-memory/sdk';
import type { DictionaryKind } from '@shaping-memory/core';

import { colors, radius, space, text } from '../theme';

/** 防抖时长：输入停顿多久之后才发联想请求 */
const DEBOUNCE_MS = 250;
/** 一次取回的候选条数（聚焦预加载与输入联想共用同一个口径） */
const SUGGEST_LIMIT = 20;
/** 失焦延时：点击候选项会先触发输入框 blur，留一点时间让点击先落地 */
const BLUR_CLOSE_MS = 150;

interface DictionaryFieldProps {
  /** 字典类型：决定候选来自哪一类值 */
  kind: DictionaryKind;
  /** 字段标题（用 core 的 fieldLabel，与后端口径一致） */
  label: string;
  placeholder: string;
  /** 当前文本值 */
  value: string;
  onChangeText: (value: string) => void;
}

export function DictionaryField({ kind, label, placeholder, value, onChangeText }: DictionaryFieldProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DictionaryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  /** 请求序号：慢响应回来时若已不是最新一次请求，直接丢弃，避免旧候选盖住新候选 */
  const requestId = useRef(0);
  /** 聚焦时已经立即取过一次候选，用这个标记跳过随之而来的那一次防抖请求 */
  const skipNextDebounce = useRef(false);
  /** 失焦关闭的定时器 */
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 清掉未落地的失焦定时器（组件卸载 / 重新聚焦时用） */
  const clearBlurTimer = () => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  };

  /** 真正发请求：q 为空即「预加载一批最靠前的候选」 */
  const load = (q: string) => {
    const id = (requestId.current += 1);
    setLoading(true);
    searchApi
      .suggest(kind, q, SUGGEST_LIMIT)
      .then((list) => {
        if (id === requestId.current) {
          setItems(list);
          setLoading(false);
        }
      })
      .catch(() => {
        // 联想失败不该挡住搜索本身：清空候选并淡出加载态，用户仍可直接手输
        if (id === requestId.current) {
          setItems([]);
          setLoading(false);
        }
      });
  };

  /* 输入即联想：250ms 防抖；下一次输入或卸载时清掉未触发的定时器 */
  useEffect(() => {
    if (!open) return;
    if (skipNextDebounce.current) {
      skipNextDebounce.current = false;
      return;
    }
    const timer = setTimeout(() => load(value), DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // load 已随 value / kind 一起重建，故不列入依赖
  }, [value, open, kind]);

  // 卸载时清掉尚未落地的定时器，避免对已卸载组件 setState
  useEffect(() => clearBlurTimer, []);

  const handleFocus = () => {
    clearBlurTimer();
    setOpen(true);
    // 聚焦先给一屏候选（q 传空串 = 取最靠前的一批），用户不必先打字
    skipNextDebounce.current = true;
    load('');
  };

  const handleBlur = () => {
    clearBlurTimer();
    blurTimer.current = setTimeout(() => setOpen(false), BLUR_CLOSE_MS);
  };

  /** 点击候选：回填到输入框并收起候选列表 */
  const select = (entry: DictionaryEntry) => {
    clearBlurTimer();
    onChangeText(entry.value);
    setOpen(false);
  };

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        placeholderTextColor={colors.text.quaternary}
        autoCapitalize="none"
        autoCorrect={false}
        underlineColorAndroid="transparent"
        accessibilityLabel={label}
      />

      {open ? (
        <View style={styles.menu}>
          {loading && items.length === 0 ? (
            // 首次加载：还没有任何候选可展示，给一个转圈
            <ActivityIndicator color={colors.accent} style={styles.menuState} />
          ) : items.length === 0 ? (
            // 空结果：字典里没有匹配项，提示可直接手输
            <Text style={styles.menuEmpty}>无匹配候选，可直接输入</Text>
          ) : (
            <ScrollView style={styles.menuList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {items.map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityLabel={entry.label ?? entry.value}
                  onPress={() => select(entry)}
                  style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
                >
                  <Text style={styles.menuItemText} numberOfLines={1}>
                    {entry.label ?? entry.value}
                  </Text>
                  {/* 展示文案与值不同才补一行小字（如「标准档位」这类标注） */}
                  {entry.label && entry.label !== entry.value ? (
                    <Text style={styles.menuItemHint} numberOfLines={1}>
                      {entry.value}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.s6 },
  fieldLabel: { ...text.meta },
  input: {
    ...text.body,
    height: 44,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },

  /** 候选面板：压在输入框下方的卡片，限高后可滚动 */
  menu: {
    borderRadius: radius.lg,
    backgroundColor: colors.material.thick,
    overflow: 'hidden',
  },
  menuList: { maxHeight: 168 },
  menuState: { paddingVertical: space.s12 },
  menuEmpty: { ...text.meta, paddingHorizontal: space.s12, paddingVertical: space.s12 },

  menuItem: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.s8,
    paddingHorizontal: space.s12,
    paddingVertical: space.s8,
  },
  menuItemText: { ...text.label, flexShrink: 1 },
  menuItemHint: { ...text.meta, color: colors.text.quaternary },
  pressed: { opacity: 0.72 },
});