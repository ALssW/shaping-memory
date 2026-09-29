/**
 * apps/mobile/src/components/SaveToAlbumButton.tsx
 *
 * 「保存到相册」按钮：查看器顶栏用图标形态，批量编辑结果区用带文字的胶囊形态。
 * 两种形态共用同一段落盘逻辑（lib/saveToAlbum.ts），因此隐私拦截与权限提示只写一处。
 *
 * 【为什么失败一定要弹 Alert】权限被拒 / 下载失败都发生在异步链路里，
 * 只更新一行小字用户很容易看不到；这里用系统弹窗保底，保证「可读提示」不被忽略。
 */
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Photo } from '@shaping-memory/core';

import { IconButton } from './primitives';
import { canExportOriginal, savePhotoToAlbum } from '../lib/saveToAlbum';
import { colors, radius, space, text } from '../theme';

interface SaveToAlbumButtonProps {
  photo: Photo;
  /** icon = 顶栏图标按钮；inline = 结果区带文字的胶囊 */
  variant?: 'icon' | 'inline';
  disabled?: boolean;
}

export function SaveToAlbumButton({ photo, variant = 'inline', disabled = false }: SaveToAlbumButtonProps) {
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await savePhotoToAlbum(photo);
      Alert.alert('保存到相册', '已把修改后的照片存入系统相册，拍摄信息完整、画质不受影响。');
    } catch (err) {
      Alert.alert('无法保存到相册', err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  /* 不可导出的照片直接不给入口，避免用户点了才知道存不了 */
  const gate = canExportOriginal(photo);
  if (!gate.ok) {
    if (variant === 'icon') return null;
    return <Text style={styles.blocked}>{gate.reason}</Text>;
  }

  if (variant === 'icon') {
    return (
      <IconButton name="save" label={busy ? '正在保存到相册' : '保存到相册'} onPress={() => void run()} />
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`把《${photo.title}》保存到相册`}
      disabled={disabled || busy}
      onPress={() => void run()}
      style={({ pressed }) => [styles.button, (disabled || busy) && styles.disabled, pressed && styles.pressed]}
    >
      {busy ? (
        <ActivityIndicator color={colors.background} size="small" />
      ) : (
        <View style={styles.buttonInner}>
          <Text style={styles.buttonText}>保存到相册</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  blocked: { ...text.meta, color: colors.text.quaternary },
  button: {
    height: 32,
    paddingHorizontal: space.s16,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: space.s6 },
  buttonText: { ...text.caption, color: colors.background, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
