/**
 * apps/mobile/src/components/PromptDialog.tsx
 *
 * 单行文本输入弹窗：相册分组的「新建」与「重命名」共用一条实现。
 *
 * 【为什么抽出来】两个流程的差别只有标题、初始值与提交动作；各自复制一份
 * 输入框 + 校验 + 错误行，迟早会在其中一处漏掉禁用态或失败提示。
 * 【草稿为什么由调用方给 key】初值只在挂载时取一次（重命名要带出原名）；
 * 换个对象重开时由调用方换 key 重挂载，比在内部监听 props 变化再同步更不容易出错。
 */
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Glass } from './primitives';
import { colors, radius, size, space, text } from '../theme';

interface PromptDialogProps {
  title: string;
  placeholder: string;
  /** 初始文本：新建为空串，重命名带入原名 */
  initialValue: string;
  /** 正在提交：输入与两个按钮一并禁用，避免重复提交出同名分组 */
  busy: boolean;
  /** 服务端给出的失败原因（如「已有同名分组」） */
  error: string | null;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

export function PromptDialog({ title, placeholder, initialValue, busy, error, onCancel, onSubmit }: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      {/* 遮罩铺满整屏：点空白处等同取消，与 Web 弹层点背板关闭同一口径 */}
      <Pressable accessibilityRole="button" accessibilityLabel="取消" style={styles.backdrop} onPress={busy ? undefined : onCancel}>
        {/* 内层接管触摸：点输入框与按钮不应被当成点遮罩 */}
        <View onStartShouldSetResponder={() => true} style={styles.cardWrap}>
          <Glass corner="xl" style={styles.card}>
            <Text style={styles.title}>{title}</Text>
            <TextInput
              value={value}
              onChangeText={setValue}
              placeholder={placeholder}
              placeholderTextColor={colors.text.quaternary}
              editable={!busy}
              autoFocus
              // 分组名只做导航，20 字足够表达且不会挤破导航条
              maxLength={20}
              underlineColorAndroid="transparent"
              accessibilityLabel={title}
              onSubmitEditing={() => canSubmit && onSubmit(trimmed)}
              style={styles.input}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="取消"
                onPress={onCancel}
                disabled={busy}
                style={({ pressed }) => [styles.button, styles.ghost, pressed && styles.pressed]}
              >
                <Text style={styles.ghostText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="确定"
                onPress={() => onSubmit(trimmed)}
                disabled={!canSubmit}
                style={({ pressed }) => [styles.button, styles.primary, !canSubmit && styles.disabled, pressed && styles.pressed]}
              >
                {busy ? <ActivityIndicator color={colors.background} /> : <Text style={styles.primaryText}>确定</Text>}
              </Pressable>
            </View>
          </Glass>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', paddingHorizontal: space.s24 },
  cardWrap: { width: '100%' },
  card: { padding: space.s20, gap: space.s12 },

  title: { ...text.heading },
  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  error: { ...text.meta, color: colors.danger },

  actions: { flexDirection: 'row', gap: space.s8, marginTop: space.s4 },
  button: { flex: 1, height: size.button.md, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.accent },
  primaryText: { ...text.label, color: colors.background, fontWeight: '600' },
  ghost: { backgroundColor: colors.material.thin },
  ghostText: { ...text.label, color: colors.text.secondary },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});