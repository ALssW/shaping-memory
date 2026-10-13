/**
 * apps/mobile/src/components/OptionSheet.tsx
 *
 * 底部选项弹层：一列可点的候选项 + 标题 + 说明行。
 *
 * 【为什么抽出来】相册分组的两个流程都要「从现有分组里挑一个」：
 * 把相册移到某个分组、以及删除分组前指定组内相册的去处。二者的差别只有标题与说明，
 * 列表本身的交互（滚动、点选、提交中禁用）没有理由写两遍。
 */
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glass, Icon } from './primitives';
import { colors, radius, size, space, text } from '../theme';

export interface SheetOption {
  key: string;
  label: string;
  /** 右侧附注：分组册数、或「当前所在」这类状态说明 */
  meta?: string;
  /** 危险项（删除）：改用语义状态色，与「只是挑一项」区分开 */
  danger?: boolean;
}

interface OptionSheetProps {
  title: string;
  /** 说明行：解释点下去会发生什么 */
  hint?: string;
  options: readonly SheetOption[];
  /** 提交中：整表禁用，避免连点造成重复提交 */
  busy: boolean;
  onCancel: () => void;
  onSelect: (key: string) => void;
}

export function OptionSheet({ title, hint, options, busy, onCancel, onSelect }: OptionSheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
      {/* 点遮罩即取消；内层接管触摸，避免点列表被当成点遮罩 */}
      <Pressable accessibilityRole="button" accessibilityLabel="取消" style={styles.backdrop} onPress={busy ? undefined : onCancel}>
        <View
          onStartShouldSetResponder={() => true}
          style={[styles.sheetWrap, { paddingBottom: insets.bottom + space.s12 }]}
        >
          <Glass corner="xl">
            <View style={styles.head}>
              <Text style={styles.title}>{title}</Text>
              {busy ? <ActivityIndicator color={colors.text.tertiary} /> : null}
            </View>
            {hint ? <Text style={styles.hint}>{hint}</Text> : null}

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
              {options.map((option) => (
                <Pressable
                  key={option.key}
                  accessibilityRole="button"
                  accessibilityLabel={option.meta ? `${option.label}，${option.meta}` : option.label}
                  disabled={busy}
                  onPress={() => onSelect(option.key)}
                  style={({ pressed }) => [styles.option, busy && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={[styles.optionLabel, option.danger && styles.danger]} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {option.meta ? <Text style={styles.optionMeta}>{option.meta}</Text> : null}
                  <Icon name="chevronRight" size={size.icon.compact} color={colors.text.quaternary} />
                </Pressable>
              ))}
            </ScrollView>
          </Glass>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { paddingHorizontal: space.s16 },

  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.s16, paddingBottom: space.s4 },
  title: { ...text.heading },
  hint: { ...text.meta, paddingHorizontal: space.s16, paddingBottom: space.s8 },

  /* 分组可能很多，列表给自己一个上限，超出部分滚动，弹层本身不顶到屏幕顶 */
  list: { maxHeight: 320 },
  listContent: { paddingBottom: space.s8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingHorizontal: space.s16,
    minHeight: size.button.md,
    borderRadius: radius.lg,
  },
  optionLabel: { ...text.body, flex: 1 },
  optionMeta: { ...text.meta },
  danger: { color: colors.danger },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});