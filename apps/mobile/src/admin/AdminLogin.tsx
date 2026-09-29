/**
 * apps/mobile/src/admin/AdminLogin.tsx
 *
 * 移动端后台登录页：账号密码 → authApi.login → saveSession。
 * 仅 admin / editor 可进（web 后台的 LoginPage 同款逻辑，只是换 RN 控件）。
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { authApi } from '@shaping-memory/sdk';

import { Glass } from '../components/primitives';
import { colors, radius, size, space, text } from '../theme';
import { saveSession } from './session';
import type { AdminSession } from './session';

interface AdminLoginProps {
  onLoggedIn: (session: AdminSession) => void;
}

export function AdminLogin({ onLoggedIn }: AdminLoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await authApi.login(username.trim(), password);
      const session = { token: result.token, username: result.username, role: result.role };
      saveSession(session);
      onLoggedIn(session);
    } catch (err) {
      // sdk 对登录失败只抛「账号或密码错误」，不区分「用户不存在」以免泄露账号是否存在
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Glass corner="xl" style={styles.card}>
        <Text style={styles.title}>塑忆 · 后台</Text>
        <Text style={styles.sub}>仅管理员 / 编辑可登录；修改拍摄参数只更新数据库记录，照片文件保持原样</Text>

        <Text style={styles.fieldLabel}>账号</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoComplete="username"
          placeholder="admin"
          placeholderTextColor={colors.text.quaternary}
          underlineColorAndroid="transparent"
          accessibilityLabel="账号"
        />

        <Text style={styles.fieldLabel}>密码</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          placeholder="请输入密码"
          placeholderTextColor={colors.text.quaternary}
          underlineColorAndroid="transparent"
          accessibilityLabel="密码"
          onSubmitEditing={() => void handleSubmit()}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="登录"
          onPress={() => void handleSubmit()}
          disabled={!canSubmit}
          style={({ pressed }) => [styles.button, !canSubmit && styles.buttonDisabled, pressed && styles.pressed]}
        >
          {submitting ? (
            <ActivityIndicator color={colors.background} />
          ) : (
            <Text style={styles.buttonText}>登录</Text>
          )}
        </Pressable>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: space.s24 },
  card: { padding: space.s20, gap: space.s8 },

  title: { ...text.title },
  sub: { ...text.meta, marginBottom: space.s8 },

  fieldLabel: { ...text.caption, color: colors.text.tertiary, marginTop: space.s8 },
  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },

  error: { ...text.meta, color: colors.danger, marginTop: space.s4 },

  button: {
    marginTop: space.s16,
    height: size.button.md,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { ...text.label, color: colors.background, fontWeight: '600' },
  pressed: { opacity: 0.8 },
});