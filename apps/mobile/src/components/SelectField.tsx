/**
 * apps/mobile/src/components/SelectField.tsx
 *
 * 点选式字段（RN 版）：点一下展开候选、选中即收起。
 * 用于省份 / 城市这类「取值必须来自固定清单」的维度 —— 与 DictionaryField 的
 * 自由输入不同，这里不接受手输，保证交出去的条件一定能被后端等值匹配命中。
 *
 * 【为什么候选项内联展开而不是浮层】与 DictionaryField 同理：面板本体是
 * ScrollView，绝对定位的浮层会被它裁掉，内联一段限高可滚动的列表最稳。
 *
 * 【为什么无可选项时整项置灰】城市候选跟随所选省，未选省时无从谈起 ——
 * 置灰并显示提示文案，比展开一个空列表更能说明「先选省份」。
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from './primitives';
import { colors, radius, space, text } from '../theme';

/** 单个候选：值交给检索条件，标签给人看 */
export interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps {
  /** 字段标题 */
  label: string;
  /** 候选项（含「不限」项）；空数组即无可选项，整项置灰 */
  options: readonly SelectOption[];
  /** 当前值；空串即「不限」 */
  value: string;
  /** 选中回调（空串代表「不限」） */
  onChange: (value: string) => void;
  /** 无可选项时的灰字提示 */
  placeholder: string;
}

export function SelectField({ label, options, value, onChange, placeholder }: SelectFieldProps) {
  const [open, setOpen] = useState(false);

  // 与 Web 的 SelectMenu 同口径：值必须精确命中候选，不回落到第一项冒充「已设置」
  const current = options.find((option) => option.value === value);
  const disabled = options.length === 0;
  const isEmpty = !current && value === '';

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen((prev) => !prev)}
        style={({ pressed }) => [
          styles.trigger,
          disabled && styles.triggerDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.triggerText, isEmpty && styles.triggerPlaceholder]} numberOfLines={1}>
          {isEmpty ? placeholder : (current?.label ?? value)}
        </Text>
        <Icon name="chevron" size={14} color={colors.text.quaternary} />
      </Pressable>

      {open && !disabled ? (
        <View style={styles.menu}>
          <ScrollView style={styles.menuList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {options.map((option) => {
              const on = option.value === value;
              return (
                <Pressable
                  key={option.value || 'any'}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  style={({ pressed }) => [styles.menuItem, on && styles.menuItemOn, pressed && styles.pressed]}
                >
                  <Text style={[styles.menuItemText, on && styles.menuItemTextOn]} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {on ? <Icon name="check" size={14} color={colors.accent} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.s6 },
  /* 与 DictionaryField 的字段标题同款 */
  fieldLabel: { ...text.meta },

  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.s8,
    height: 44,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  triggerDisabled: { opacity: 0.5 },
  triggerText: { ...text.body, flexShrink: 1 },
  triggerPlaceholder: { color: colors.text.quaternary },

  /** 候选面板：压在字段下方的卡片，限高后可滚动（与 DictionaryField 同结构） */
  menu: {
    borderRadius: radius.lg,
    backgroundColor: colors.material.thick,
    overflow: 'hidden',
  },
  menuList: { maxHeight: 168 },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.s8,
    paddingHorizontal: space.s12,
    paddingVertical: space.s8,
  },
  menuItemOn: { backgroundColor: colors.material.thin },
  menuItemText: { ...text.label, flexShrink: 1 },
  menuItemTextOn: { color: colors.accent, fontWeight: '600' },

  pressed: { opacity: 0.72 },
});
