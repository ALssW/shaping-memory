/**
 * apps/mobile/src/admin/AdminScreen.tsx
 *
 * 移动端后台外壳：登录门禁 + 页头 + 照片管理工作区。
 * 与 Web 后台 App.tsx 同款门禁策略：未登录只渲染登录页，登录后进管理。
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, text } from '../theme';
import { AdminLogin } from './AdminLogin';
import { AdminPhotos } from './AdminPhotos';
import { clearSession, currentSession } from './session';
import type { AdminSession } from './session';

export function AdminScreen() {
  // 登录态放 state：登录/退出时触发重渲染决定渲染哪棵树
  const [session, setSession] = useState<AdminSession | null>(() => currentSession());

  const handleLoggedIn = (next: AdminSession): void => setSession(next);
  const handleLogout = (): void => {
    clearSession();
    setSession(null);
  };

  if (!session) return <AdminLogin onLoggedIn={handleLoggedIn} />;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>塑忆 · 后台</Text>
          <Text style={styles.slogan}>shape of my memory</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.user}>{session.username}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="退出登录" onPress={handleLogout} style={styles.logoutBtn}>
            <Text style={styles.logoutText}>退出</Text>
          </Pressable>
        </View>
      </View>
      <AdminPhotos />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s16,
    paddingVertical: space.s12,
    gap: space.s12,
  },
  brand: { ...text.heading },
  slogan: { ...text.meta },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.s12 },
  user: { ...text.label, color: colors.text.secondary },
  logoutBtn: {
    paddingHorizontal: space.s12,
    paddingVertical: space.s6,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  logoutText: { ...text.caption, color: colors.text.secondary },
});