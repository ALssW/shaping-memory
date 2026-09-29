/**
 * apps/mobile/src/components/BatchEditDialog.tsx
 *
 * 批量编辑（admin 前台专属，RN 版）：把**同一份补丁**套到选中的每一张照片上。
 * 元数据走 photoApi.updateBatch，EXIF 走 exifApi.updateBatch。与 Web 端 BatchEditDialog 同语义。
 *
 * 【批量语义：未填的字段不下发】批量没有「文件原值」可对照，因此三态由界面直接表达：
 *   · 没填也没标记清除 → 该字段不进补丁（每张照片保持自己的值）；
 *   · 填了值 → 提交该值（这批照片的该字段统一成它）；
 *   · 标记清除 → 提交 null（从每张照片文件里删掉它）。
 *
 * 【字段清单与单张一致】直接复用 ExifFieldsSection（7 组 41 项），不再像旧版那样只支持 3 个字段。
 * 应用前必须二次确认，文案明确「将修改 N 张照片的 M 个字段」。
 */
import { useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CATEGORIES, EXIF_FIELDS, exifTextToSubmit } from '@shaping-memory/core';
import type { GeoPoint, Photo } from '@shaping-memory/core';
import { exifApi, photoApi } from '@shaping-memory/sdk';
import type { ExifPatch, PhotoPatch } from '@shaping-memory/sdk';

import { Chip, ChipRow, Glass, Icon } from './primitives';
import { ExifFieldsSection } from './ExifFieldsSection';
import { GpsPicker } from './GpsPicker';
import { SaveToAlbumButton } from './SaveToAlbumButton';
import { colors, radius, size, space, text } from '../theme';

const PRIVACY_MARKS: ReadonlyArray<NonNullable<PhotoPatch['privacy']>> = ['inherit', 'visible', 'blur', 'hidden'];
const PRIVACY_LABEL: Record<NonNullable<PhotoPatch['privacy']>, string> = {
  inherit: '跟随默认',
  visible: '公开',
  blur: '模糊',
  hidden: '隐藏',
};

const CATEGORY_OPTIONS = CATEGORIES.filter((name) => name !== '全部');

/** 一次批量应用要提交的全部内容 */
interface BatchPlan {
  metaPatch: PhotoPatch;
  exifPatch: ExifPatch;
  /** 本次要改的字段总数（元数据项 + EXIF 项 + 定位），用于二次确认文案 */
  fieldCount: number;
}

interface BatchEditDialogProps {
  /** 本次要改的照片（id 与展示信息都从这里取） */
  photos: readonly Photo[];
  onClose: () => void;
  /** 全部完成（父级清空选中并重拉） */
  onDone: () => void;
}

export function BatchEditDialog({ photos, onClose, onDone }: BatchEditDialogProps) {
  const insets = useSafeAreaInsets();

  // 元数据：空 = 不修改
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState<NonNullable<PhotoPatch['privacy']> | ''>('');
  const [likes, setLikes] = useState('');

  // EXIF：值 + 标记清除
  const [values, setValues] = useState<Record<string, string>>({});
  const [clears, setClears] = useState<Record<string, boolean>>({});

  // 定位：统一设置 / 统一清除 / 不动
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [gpsCleared, setGpsCleared] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 应用成功后的结果区：列出这批照片，逐个提供「保存到相册」 */
  const [applied, setApplied] = useState(false);

  const setField = (tag: string, value: string) => {
    setValues((prev) => ({ ...prev, [tag]: value }));
    setClears((prev) => (prev[tag] ? { ...prev, [tag]: false } : prev));
  };

  const clearField = (tag: string) => {
    setClears((prev) => ({ ...prev, [tag]: !prev[tag] }));
  };

  /** 组装补丁；填写不合法时置错误并返回 null */
  const buildPlan = (): BatchPlan | null => {
    const metaPatch: PhotoPatch = {};
    if (category) metaPatch.category = category;
    if (tags.trim() !== '') metaPatch.tags = tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (privacy) metaPatch.privacy = privacy;
    if (likes !== '') metaPatch.likes = Math.max(0, Number(likes) || 0);

    const fieldPatch: Record<string, string | string[] | null> = {};
    for (const spec of EXIF_FIELDS) {
      if (clears[spec.tag]) {
        fieldPatch[spec.tag] = null;
        continue;
      }
      const value = (values[spec.tag] ?? '').trim();
      if (value === '') continue; // 未填 → 不进补丁（每张照片保持自己的值）
      const normalized = exifTextToSubmit(spec.type, value);
      if (normalized === null) {
        setError(`「${spec.label}」的值不合法，请检查后重试`);
        return null;
      }
      fieldPatch[spec.tag] = normalized;
    }

    const exifPatch: ExifPatch = {};
    if (Object.keys(fieldPatch).length > 0) exifPatch.fields = fieldPatch;
    if (gpsCleared) exifPatch.gps = null;
    else if (point) exifPatch.gps = { lat: point.lat, lon: point.lon };

    const fieldCount =
      Object.keys(metaPatch).length + Object.keys(fieldPatch).length + (exifPatch.gps !== undefined ? 1 : 0);
    if (fieldCount === 0) {
      setError('未填写要统一修改的项');
      return null;
    }
    return { metaPatch, exifPatch, fieldCount };
  };

  const apply = async (plan: BatchPlan): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const ids = photos.map((photo) => photo.id);
      if (Object.keys(plan.metaPatch).length > 0) await photoApi.updateBatch(ids, plan.metaPatch);
      if (plan.exifPatch.fields || plan.exifPatch.gps !== undefined) await exifApi.updateBatch(ids, plan.exifPatch);
      setApplied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量修改失败');
    } finally {
      setSaving(false);
    }
  };

  const confirm = (): void => {
    setError(null);
    const plan = buildPlan();
    if (!plan) return;
    Alert.alert(
      '批量修改确认',
      `将修改 ${photos.length} 张照片的 ${plan.fieldCount} 项内容。拍摄参数只更新数据库记录，照片文件保持原样，是否继续？`,
      [
        { text: '取消', style: 'cancel' },
        { text: '确认修改', onPress: () => void apply(plan) },
      ],
    );
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.backdrop, { paddingTop: insets.top + space.s16, paddingBottom: insets.bottom + space.s16 }]}>
        <Glass corner="xl" style={styles.card}>
          <View style={styles.head}>
            <Text style={styles.title}>批量编辑（已选 {photos.length} 张）</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭批量编辑" onPress={onClose} hitSlop={8} style={styles.close}>
              <Icon name="close" size={18} color={colors.text.secondary} />
            </Pressable>
          </View>

          {applied ? (
            <ResultPanel photos={photos} onDone={onDone} />
          ) : (
            <>
              <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                <Text style={styles.hint}>只修改填写过的项，留空的内容保持原样。拍摄参数只更新数据库记录，照片文件保持原样。</Text>

                <Text style={styles.section}>照片信息（统一设置）</Text>
                <Text style={styles.fieldLabel}>分类</Text>
                <ChipRow>
                  {CATEGORY_OPTIONS.map((name) => (
                    <Chip key={name} label={name} active={name === category} onPress={() => setCategory(name === category ? '' : name)} />
                  ))}
                </ChipRow>
                <Text style={styles.fieldLabel}>标签（逗号分隔）</Text>
                <TextInput style={styles.input} value={tags} onChangeText={setTags} placeholder="留空则不修改这批标签" placeholderTextColor={colors.text.quaternary} underlineColorAndroid="transparent" />
                <Text style={styles.fieldLabel}>隐私标记</Text>
                <ChipRow>
                  {PRIVACY_MARKS.map((value) => (
                    <Chip key={value} label={PRIVACY_LABEL[value]} active={value === privacy} onPress={() => setPrivacy(value === privacy ? '' : value)} />
                  ))}
                </ChipRow>
                <Text style={styles.fieldLabel}>点赞数</Text>
                <TextInput style={styles.input} value={likes} onChangeText={setLikes} keyboardType="number-pad" placeholder="留空则不修改点赞数" placeholderTextColor={colors.text.quaternary} underlineColorAndroid="transparent" />

                <Text style={styles.section}>拍摄参数（统一更新记录）</Text>
                <ExifFieldsSection
                  values={values}
                  onChange={setField}
                  onClear={clearField}
                  mode="batch"
                  clears={clears}
                  disabled={saving}
                />

                <Text style={styles.subsection}>定位（统一设置）</Text>
                <GpsPicker
                  point={point}
                  savedGps={null}
                  cleared={gpsCleared}
                  disabled={saving}
                  onPointChange={(next) => {
                    setPoint(next);
                    setGpsCleared(false);
                  }}
                  onClear={() => {
                    setPoint(null);
                    setGpsCleared(true);
                  }}
                  onCancelClear={() => setGpsCleared(false)}
                />

                {error ? <Text style={styles.error}>{error}</Text> : null}
              </ScrollView>

              <View style={styles.actions}>
                <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onClose} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
                  <Text style={styles.actionText}>取消</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="应用到选中的照片" onPress={confirm} disabled={saving} style={({ pressed }) => [styles.action, styles.primary, saving && styles.disabled, pressed && styles.pressed]}>
                  {saving ? <ActivityIndicator color={colors.background} /> : <Text style={styles.primaryText}>应用到选中的照片</Text>}
                </Pressable>
              </View>
            </>
          )}
        </Glass>
      </View>
    </Modal>
  );
}

/** 应用成功后的结果区：把写回后的原图逐张存入系统相册（隐私照片不导出） */
function ResultPanel({ photos, onDone }: { photos: readonly Photo[]; onDone: () => void }) {
  return (
    <>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.hint}>已更新 {photos.length} 张照片。可以把改好的原图存入系统相册（照片保持原始画质）。</Text>
        {photos.map((photo) => (
          <View key={photo.id} style={styles.resultRow}>
            <Text style={styles.resultTitle} numberOfLines={1}>
              {photo.title || photo.id}
            </Text>
            <SaveToAlbumButton photo={photo} />
          </View>
        ))}
      </ScrollView>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="完成" onPress={onDone} style={({ pressed }) => [styles.action, styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryText}>完成</Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.material.opaque, paddingHorizontal: space.s16, justifyContent: 'center' },
  card: { maxHeight: '92%' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s16,
    paddingVertical: space.s12,
  },
  title: { ...text.title },
  close: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.material.ultraThin,
  },
  body: { paddingHorizontal: space.s16, paddingBottom: space.s16, gap: space.s12 },
  hint: { ...text.meta },
  section: { ...text.caption, color: colors.text.quaternary, textTransform: 'uppercase', marginTop: space.s4 },
  subsection: { ...text.caption, color: colors.text.tertiary, marginTop: space.s8 },
  fieldLabel: { ...text.caption, color: colors.text.tertiary },
  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  error: { ...text.meta, color: colors.danger },

  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.s12,
    paddingVertical: space.s4,
  },
  resultTitle: { ...text.body, flexShrink: 1 },

  actions: {
    flexDirection: 'row',
    gap: space.s8,
    paddingHorizontal: space.s16,
    paddingBottom: space.s16,
    paddingTop: space.s8,
  },
  action: {
    flex: 1,
    height: size.button.md,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.material.thin,
  },
  actionText: { ...text.label, color: colors.text.secondary },
  primary: { backgroundColor: colors.accent },
  primaryText: { ...text.label, color: colors.background, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
