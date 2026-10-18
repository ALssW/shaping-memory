/**
 * apps/mobile/src/components/UnlockDialog.tsx
 *
 * 隐私照片的密码解锁面板（从查看器唤起），与 Web 端 apps/web/src/components/UnlockDialog.tsx 同语义。
 *
 * 【密码走哪条路】看这张照片自己有没有独立密码：
 *   - 有（hasOwnPassword）→ 走 POST /privacy/photos/:id/unlock，只解开这一张；
 *   - 没有 → 走全局的 POST /privacy/unlock，解开「按全局策略被打糊」的全部照片。
 * 两者成功都返回同一形态的票据，写进 SDK 后由调用方广播一次解锁事件。
 *
 * 【为什么自己拉一次策略】「有没有全局密码」只有后端知道，且返回的是布尔量
 * （policy.hasPassword）而非哈希 —— 前端无法、也不该自己推断，因此挂载时读一次公开策略。
 */
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { privacyApi } from '@shaping-memory/sdk';
import type { PrivacyPolicy } from '@shaping-memory/sdk';
import type { Photo } from '@shaping-memory/core';

import { Glass, Icon } from './primitives';
import { notifyPrivacyUnlocked } from '../lib/privacy';
import { colors, radius, size, space, text } from '../theme';

interface UnlockDialogProps {
  photo: Photo;
  onClose: () => void;
}

export function UnlockDialog({ photo, onClose }: UnlockDialogProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** null = 策略还没读到：此时不下「没有可用密码」的结论，避免闪一下误导文案 */
  const [policy, setPolicy] = useState<PrivacyPolicy | null>(null);

  useEffect(() => {
    let cancelled = false;
    privacyApi
      .policy()
      .then((value) => {
        if (!cancelled) setPolicy(value);
      })
      .catch(() => {
        if (!cancelled) setPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 这张有独立密码时优先用它；否则回落到全局密码 */
  const own = photo.privacy?.hasOwnPassword ?? false;
  const usable = own || (policy?.hasPassword ?? false);
  const canSubmit = password.length > 0 && usable && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (own) await privacyApi.unlockPhoto(photo.id, password);
      else await privacyApi.unlock(password);
      // 票据已进 SDK：广播出去，各处的照片列表会带着它重新拉一次
      notifyPrivacyUnlocked();
      onClose();
    } catch {
      setError('密码不正确，请重试');
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={busy ? undefined : onClose}>
      {/* 遮罩铺满整屏：点空白处等同关闭（与 Web 面板点背板关闭同一口径） */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭解锁面板"
        style={styles.backdrop}
        onPress={busy ? undefined : onClose}
      >
        {/* 内层接管触摸：点输入框与按钮不应被当成点遮罩 */}
        <View onStartShouldSetResponder={() => true} style={styles.cardWrap}>
          <Glass corner="xl" style={styles.card}>
            <View style={styles.iconWrap}>
              <Icon name="lock" size={size.icon.default} color={colors.accent} />
            </View>
            <Text style={styles.title}>这张照片需要授权</Text>
            <Text style={styles.hint}>
              {own ? '请输入这张照片的独立查看密码' : '请输入查看密码'}
              {photo.title ? ` · ${photo.title}` : ''}
            </Text>

            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="查看密码"
              placeholderTextColor={colors.text.quaternary}
              /* 密码是隐私字段：输入掩码，且未确认有可用密码前不允许输入 */
              secureTextEntry
              editable={usable && !busy}
              autoFocus
              underlineColorAndroid="transparent"
              accessibilityLabel="查看密码"
              onSubmitEditing={() => void submit()}
              style={styles.input}
            />

            {policy && !usable ? (
              <Text style={styles.error}>尚未配置查看密码，请联系管理员开通授权</Text>
            ) : error ? (
              <Text style={styles.error}>{error}</Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="取消"
                onPress={onClose}
                disabled={busy}
                style={({ pressed }) => [styles.button, styles.ghost, pressed && styles.pressed]}
              >
                <Text style={styles.ghostText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="解锁"
                onPress={() => void submit()}
                disabled={!canSubmit}
                style={({ pressed }) => [styles.button, styles.primary, !canSubmit && styles.disabled, pressed && styles.pressed]}
              >
                {busy ? <Text style={styles.primaryText}>验证中…</Text> : <Text style={styles.primaryText}>解锁</Text>}
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

  iconWrap: { alignItems: 'center' },
  title: { ...text.heading, textAlign: 'center' },
  hint: { ...text.meta, textAlign: 'center', color: colors.text.secondary },

  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  error: { ...text.meta, color: colors.danger, textAlign: 'center' },

  actions: { flexDirection: 'row', gap: space.s8, marginTop: space.s4 },
  button: { flex: 1, height: size.button.md, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.accent },
  primaryText: { ...text.label, color: colors.background, fontWeight: '600' },
  ghost: { backgroundColor: colors.material.thin },
  ghostText: { ...text.label, color: colors.text.secondary },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
