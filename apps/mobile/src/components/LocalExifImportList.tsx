/**
 * apps/mobile/src/components/LocalExifImportList.tsx
 *
 * 本地 EXIF 工作台的导入区：导入按钮 + 「已选 N / 共 M」+ 全选 / 取消全选 + 照片行。
 *
 * 【不可编辑的照片也列出来】认不出的格式（HEIC / WebP）与解析失败的照片仍然占一行，
 * 勾选框禁用并写明原因。「列出但不可编辑」比「静默不出现」更明确：用户能够知道自己所选照片的去向。
 *
 * 【缩略图优先用 photo.thumbUri】RAW（NEF / DNG）本体 RN 解不了，数据层会把内嵌 JPEG 预览
 * 落成缓存文件给这里用；JPEG / PNG 的 thumbUri 就是系统给的 uri，不额外落盘。
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { containerLabel } from '@shaping-memory/core';

import { Icon } from './primitives';
import type { LocalExifPhoto } from '../lib/localExif';
import { accentRgba, accentOpacity, colors, radius, size, space, text } from '../theme';

interface LocalExifImportListProps {
  photos: readonly LocalExifPhoto[];
  selected: ReadonlySet<string>;
  /** 正在导入：按钮转圈 */
  importing: boolean;
  /** 正在导出：整段交互冻结，避免边写边改 */
  disabled: boolean;
  onImport: () => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}

export function LocalExifImportList({
  photos,
  selected,
  importing,
  disabled,
  onImport,
  onToggle,
  onSelectAll,
  onSelectNone,
}: LocalExifImportListProps) {
  const editable = photos.filter((photo) => photo.bytes !== null);
  const selectedCount = editable.filter((photo) => selected.has(photo.id)).length;
  const frozen = importing || disabled;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.section}>照片</Text>
        {photos.length > 0 ? (
          <Text style={styles.count}>
            已选 {selectedCount} / 共 {photos.length}
            {editable.length < photos.length ? `（${photos.length - editable.length} 张只读）` : ''}
          </Text>
        ) : null}
      </View>

      {photos.length === 0 ? (
        <Text style={styles.empty}>
          点「导入照片」从系统相册选择照片（JPEG / PNG / RAW，可多选）。全程在本机完成，不上传、不需要登录；导入后勾选照片，改完导出即存回系统相册。
        </Text>
      ) : (
        <>
          <View style={styles.tools}>
            <SmallAction
              label="全选"
              disabled={frozen || editable.length === 0 || selectedCount === editable.length}
              onPress={onSelectAll}
            />
            <SmallAction label="取消全选" disabled={frozen || selectedCount === 0} onPress={onSelectNone} />
          </View>
          {photos.map((photo) => (
            <PhotoRow
              key={photo.id}
              photo={photo}
              checked={selected.has(photo.id)}
              disabled={frozen}
              onToggle={onToggle}
            />
          ))}
        </>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="导入照片"
        disabled={frozen}
        onPress={onImport}
        style={({ pressed }) => [styles.import, frozen && styles.disabled, pressed && styles.pressed]}
      >
        {importing ? (
          <ActivityIndicator color={colors.text.base} size="small" />
        ) : (
          <>
            <Icon name="album" size={size.icon.compact} color={colors.text.base} />
            <Text style={styles.importText}>{photos.length === 0 ? '导入照片' : '继续导入'}</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

/* -------------------------------------------------------------------------- */

function SmallAction({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.small, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={styles.smallText}>{label}</Text>
    </Pressable>
  );
}

interface PhotoRowProps {
  photo: LocalExifPhoto;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}

function PhotoRow({ photo, checked, disabled, onToggle }: PhotoRowProps) {
  const readOnly = photo.bytes === null;
  const parsed = Object.keys(photo.values).length;

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={photo.name}
      accessibilityState={{ checked, disabled: disabled || readOnly }}
      disabled={disabled || readOnly}
      onPress={() => onToggle(photo.id)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Image source={{ uri: photo.thumbUri }} style={styles.thumb} contentFit="cover" />
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {photo.name}
        </Text>
        {/* 只读原因本身就是可读文案，直接当副标题用；可编辑的则报「格式 + 解析出多少字段」 */}
        <Text style={readOnly ? styles.reason : styles.meta} numberOfLines={2}>
          {readOnly
            ? photo.reason
            : `${containerLabel(photo.container)} · 已读取 ${parsed} 项拍摄信息${
                photo.unknownCount > 0 ? ` · 另有 ${photo.unknownCount} 项无法识别的内容将原样保留` : ''
              }`}
        </Text>
      </View>
      <View style={[styles.check, checked && styles.checkOn, readOnly && styles.checkOff]}>
        {checked ? <Icon name="check" size={size.icon.compact} color={colors.background} /> : null}
      </View>
    </Pressable>
  );
}

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  wrap: { gap: space.s12 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.s8 },
  section: { ...text.caption, color: colors.text.quaternary, textTransform: 'uppercase' },
  count: { ...text.meta, color: colors.text.tertiary },
  empty: { ...text.body, color: colors.text.tertiary },
  tools: { flexDirection: 'row', gap: space.s8 },

  small: {
    height: size.chip,
    justifyContent: 'center',
    paddingHorizontal: space.s12,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  smallText: { ...text.caption, color: colors.text.secondary },

  import: {
    height: size.button.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.s8,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  importText: { ...text.label, color: colors.text.base, fontWeight: '600' },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.s12, paddingVertical: space.s4 },
  thumb: {
    width: size.iconButton.default * 2,
    height: size.iconButton.default * 2,
    borderRadius: radius.md,
    backgroundColor: colors.material.ultraThin,
  },
  rowText: { flex: 1, gap: space.s2 },
  name: { ...text.body, color: colors.text.base },
  meta: { ...text.meta, color: colors.text.quaternary },
  reason: { ...text.meta, color: colors.danger },

  check: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.material.thin,
  },
  checkOn: { backgroundColor: accentRgba(accentOpacity.wash), borderWidth: 1, borderColor: colors.accent },
  checkOff: { opacity: 0.4 },

  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
