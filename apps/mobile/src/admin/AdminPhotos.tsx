/**
 * apps/mobile/src/admin/AdminPhotos.tsx
 *
 * 移动端后台 · 照片管理列表：分类筛选 + 刷新 + 软删除（单张 + 多选批量）。
 * 与 Web 后台 PhotoManager 同源（photoApi），只是换成 RN 控件。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { photoApi } from '@shaping-memory/sdk';
import { CATEGORIES } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';

import { Chip, ChipRow, Icon } from '../components/primitives';
import { colors, radius, size, space, text } from '../theme';
import { AdminPhotoDetail } from './AdminPhotoDetail';
import { useUpload } from './useUpload';

/** 选中标记：空心圈 → 实心 accent 圈，用纯样式表达，不引图标 */
function RowCheck({ selected }: { selected: boolean }) {
  return <View style={[styles.check, selected && styles.checkOn]} />;
}

export function AdminPhotos() {
  const [photos, setPhotos] = useState<readonly Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('全部');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const list = await photoApi.list({ category, sort: 'desc' });
      setPhotos(list);
      // 已被删掉的行不该继续留在选中集里
      const ids = new Set(list.map((p) => p.id));
      setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
    } catch {
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  // 上传成功后刷新列表，新照片进档案
  const { uploading, error: uploadError, pickAndUpload, resetError } = useUpload(useCallback(() => void load(), [load]));

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const removeOne = useCallback(
    (photo: Photo) => {
      Alert.alert('删除照片', `确认删除「${photo.title || photo.id}」？照片会从相册中移除，原文件仍会保留。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void photoApi.remove(photo.id).then(() => load());
          },
        },
      ]);
    },
    [load],
  );

  const removeSelected = useCallback(() => {
    const ids = [...selected];
    if (ids.length === 0) return;
    Alert.alert('批量删除', `确认删除选中的 ${ids.length} 张照片？原文件仍会保留。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void photoApi.removeBatch(ids).then(() => {
            setSelected(new Set());
            void load();
          });
        },
      },
    ]);
  }, [selected, load]);

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <ChipRow>
          {CATEGORIES.map((item) => (
            <Chip key={item} label={item} active={category === item} onPress={() => setCategory(item)} />
          ))}
        </ChipRow>
        <View style={styles.toolRow}>
          <Text style={styles.count}>
            共 {photos.length} 张 · 已选 {selected.size}
          </Text>
          <View style={styles.toolActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="上传照片" onPress={() => void pickAndUpload()} style={styles.uploadBtn}>
              {uploading ? <ActivityIndicator color={colors.background} size="small" /> : <Text style={styles.uploadText}>上传</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="刷新" onPress={() => void load()} style={styles.iconBtn}>
              <Icon name="download" size={size.icon.compact} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="批量软删除"
              onPress={removeSelected}
              disabled={selected.size === 0}
              style={[styles.batchBtn, selected.size === 0 && styles.disabled]}
            >
              <Text style={styles.batchText}>删除所选</Text>
            </Pressable>
          </View>
        </View>
        {uploadError ? (
          <Text style={styles.uploadError} onPress={resetError}>
            {uploadError} · 点此关闭
          </Text>
        ) : null}
      </View>

      {loading ? (
        <Text style={styles.empty}>加载中…</Text>
      ) : photos.length === 0 ? (
        <Text style={styles.empty}>该分类暂无照片</Text>
      ) : (
        <FlatList
          data={photos}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`编辑《${item.title}》`}
              onPress={() => setDetailId(item.id)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={selected.has(item.id) ? '取消选中' : '选中'}
                onPress={() => toggleSelect(item.id)}
                style={styles.checkWrap}
              >
                <RowCheck selected={selected.has(item.id)} />
              </Pressable>
              {item.cardUrl || item.url ? (
                <Image source={{ uri: item.cardUrl ?? item.url }} style={styles.thumb} contentFit="cover" cachePolicy="memory-disk" />
              ) : (
                <View style={styles.thumbPlaceholder} />
              )}
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title || '（无标题）'}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {item.cat} · {item.date || '—'}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`删除《${item.title}》`}
                onPress={() => removeOne(item)}
                style={styles.deleteBtn}
              >
                <Icon name="close" size={size.icon.compact} color={colors.danger} />
              </Pressable>
            </Pressable>
          )}
        />
      )}

      {detailId ? <AdminPhotoDetail photoId={detailId} onClose={() => setDetailId(null)} onSaved={() => void load()} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  toolbar: { paddingHorizontal: space.s16, paddingBottom: space.s8, gap: space.s8 },
  toolRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toolActions: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  count: { ...text.meta },
  uploadBtn: {
    height: size.button.sm,
    minWidth: 48,
    paddingHorizontal: space.s12,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  uploadText: { ...text.caption, color: colors.background, fontWeight: '600' },
  uploadError: { ...text.meta, color: colors.danger },
  iconBtn: {
    width: size.button.sm,
    height: size.button.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.material.thin,
  },
  batchBtn: {
    height: size.button.sm,
    paddingHorizontal: space.s12,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.danger,
  },
  batchText: { ...text.caption, color: colors.background, fontWeight: '600' },
  disabled: { opacity: 0.4 },

  empty: { ...text.body, color: colors.text.tertiary, textAlign: 'center', marginTop: space.s40 },

  list: { paddingHorizontal: space.s16, paddingBottom: space.s40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s12,
    marginTop: space.s8,
    padding: space.s8,
    borderRadius: radius.lg,
    backgroundColor: colors.material.ultraThin,
  },
  pressed: { opacity: 0.8 },
  checkWrap: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  check: {
    width: 18,
    height: 18,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.border.base,
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  thumb: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: colors.material.thin },
  thumbPlaceholder: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: colors.material.ultraThin },
  rowBody: { flex: 1, gap: space.s2 },
  rowTitle: { ...text.label, fontWeight: '600' },
  rowMeta: { ...text.meta },
  deleteBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});