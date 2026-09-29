/**
 * apps/mobile/src/components/AccountPanel.tsx
 *
 * 前台账号面板：未登录是登录表单，登录后是当前账号 + 退出。
 * 从顶栏的账号图标唤出，挂在页头下方靠右，只认右上角关闭按钮收口
 * （与搜索面板同一套「玻璃卡片 + 同层覆盖层」的做法，理由见 SearchPanel）。
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { authApi } from '@shaping-memory/sdk';

import type { FrontSession } from '../front/session';
import { saveSession } from '../front/session';
import { Glass, Icon } from './primitives';
import { useBackClose } from '../hooks/useBackClose';
import { useBreakpoint } from '../layout/useBreakpoint';
import { brandTracking, colors, radius, size, space, text } from '../theme';

/** 面板宽度：与 Web 的 .account-panel 同数（窄屏则退到左右各留 16） */
const PANEL_WIDTH = 320;
/** 屏幕右缘留白：页头自己已有 s12 内边距，这里补到 s16 */
const PANEL_GUTTER = space.s16 - space.s12;

interface AccountPanelProps {
  session: FrontSession | null;
  onLogin: (session: FrontSession) => void;
  onLogout: () => void;
  onClose: () => void;
}

export function AccountPanel({ session, onLogin, onLogout, onClose }: AccountPanelProps) {
  const { width } = useBreakpoint();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBackClose(onClose);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await authApi.login(username.trim(), password);
      const next = { token: result.token, username: result.username, role: result.role };
      saveSession(next);
      /* 登录成功后清掉表单里的明文口令，退出登录再打开时不会看到上一次的残留 */
      setUsername('');
      setPassword('');
      onLogin(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Glass corner="xl" style={[styles.panel, { width: Math.min(PANEL_WIDTH, width - space.s16 * 2) }]}>
      {session ? (
        <View style={styles.signed}>
          <View style={styles.who}>
            <View style={styles.avatar}>
              <Icon name="user" size={size.icon.default} color={colors.accent} />
            </View>
            {/* 名字与角色贴在一起：2px 的小间距让它们成为一组，而不是两条独立信息 */}
            <View style={styles.meta}>
              <Text style={styles.name} numberOfLines={1}>
                {session.username}
              </Text>
              <Text style={styles.role} numberOfLines={1}>
                {session.role === 'admin' ? '管理员 · 已开放前台编辑' : session.role}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="退出登录"
            onPress={onLogout}
            style={({ pressed }) => [styles.logout, pressed && styles.pressed]}
          >
            <Icon name="logout" size={size.icon.compact} color={colors.text.secondary} />
            <Text style={styles.logoutText}>退出登录</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.form}>
          <View style={styles.field}>
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
          </View>
          <View style={styles.field}>
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
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="登录"
            onPress={() => void handleSubmit()}
            disabled={!canSubmit}
            style={({ pressed }) => [styles.submit, !canSubmit && styles.submitDisabled, pressed && styles.pressed]}
          >
            {submitting ? (
              <ActivityIndicator color={colors.background} />
            ) : (
              <Text style={styles.submitText}>登录</Text>
            )}
          </Pressable>
        </View>
      )}

      {/* 关闭固定在右上角：唯一收口，与搜索面板同一个位置、同一个命中尺寸 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭账号面板"
        onPress={onClose}
        hitSlop={8}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
      >
        <Icon name="close" size={size.icon.compact} color={colors.text.tertiary} />
      </Pressable>
    </Glass>
  );
}

const styles = StyleSheet.create({
  /* 挂载点把卡片贴在页头下方靠右：top/right 都由页头容器决定（见 SearchPanel 的同款说明） */
  panel: {
    position: 'absolute',
    top: '100%',
    right: PANEL_GUTTER,
    padding: space.s16,
  },

  signed: { gap: space.s12 },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.s12 },
  avatar: {
    width: size.button.md,
    height: size.button.md,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.material.thin,
  },
  meta: { gap: space.s2, flexShrink: 1 },
  name: { ...text.label },
  role: { ...text.caption, color: colors.text.quaternary },
  /* 退出按钮：胶囊、随内容宽，与 Web 的 .account-panel__logout 同形 */
  logout: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    gap: space.s6,
    height: size.button.sm,
    paddingHorizontal: space.s16,
    borderRadius: radius.full,
    backgroundColor: colors.material.thin,
  },
  logoutText: { ...text.label, color: colors.text.secondary },

  form: { gap: space.s12 },
  field: { gap: space.s6 },
  /* 与 Web 的 .search-field__label 同款（与搜索面板共用同一口径） */
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
  error: { ...text.caption, color: colors.danger },
  /* 提交按钮：与搜索面板的主按钮同形（胶囊 + accent 实心） */
  submit: {
    alignItems: 'center',
    justifyContent: 'center',
    height: size.button.sm,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { ...text.label, color: colors.background, fontWeight: '600' },

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
