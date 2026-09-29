/**
 * apps/mobile/src/components/EditDialog.tsx
 *
 * 单张照片编辑（admin 前台专属，RN 版）：元数据 + EXIF。
 * 元数据走 photoApi.update，EXIF 走 exifApi.update（只改数据库）。与 Web 端 EditDialog 同构。
 *
 * 【全量字段】字段清单与分组取 core 的 `EXIF_FIELDS` / `exifFieldsByGroup()`（7 组 41 项），
 * 值转换取 `exifRawToText` / `exifTextToSubmit` / `exifSameText` —— 与后台、Web 前台同一份实现，
 * 不再像旧版那样硬编码 8 个 tag。
 *
 * 【「未填写」与「清除」的区分】单张编辑的草稿在打开时就按文件原值铺满，
 * 于是「有没有改」退化成一次语义比较（`exifSameText`）：
 *   · 用户没动 → 与原值等价 → 该 tag 不进补丁（不修改）；
 *   · 用户按「清除」（草稿置空）→ 与原值不等 → 提交 null（后端删掉该 tag）。
 * 若原值本就是空、用户也没填，同样是「不修改」而非「写入空值」。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CATEGORIES, EXIF_FIELDS, exifRawToText, exifSameText, exifTextToSubmit } from '@shaping-memory/core';
import type { GeoPoint, Photo } from '@shaping-memory/core';
import { exifApi, photoApi } from '@shaping-memory/sdk';
import type { ExifPatch, PhotoExifResult, PhotoPatch } from '@shaping-memory/sdk';

import { Chip, ChipRow, Glass, Icon } from './primitives';
import { ExifFieldsSection } from './ExifFieldsSection';
import { GpsPicker } from './GpsPicker';
import { colors, radius, size, space, text } from '../theme';

const PRIVACY_MARKS: ReadonlyArray<NonNullable<PhotoPatch['privacy']>> = ['inherit', 'visible', 'blur', 'hidden'];
const PRIVACY_LABEL: Record<NonNullable<PhotoPatch['privacy']>, string> = {
  inherit: '跟随默认',
  visible: '公开',
  blur: '模糊',
  hidden: '隐藏',
};

const CATEGORY_OPTIONS = CATEGORIES.filter((name) => name !== '全部');

/** 文件里的原始值 → 表单 canonical 文本（口径见 core exif-values.ts） */
function initialFormText(fields: Record<string, string>): Record<string, string> {
  const text: Record<string, string> = {};
  for (const spec of EXIF_FIELDS) text[spec.tag] = exifRawToText(spec.type, fields[spec.tag]);
  return text;
}

interface EditDialogProps {
  photo: Photo;
  onClose: () => void;
  onChanged: () => void;
}

export function EditDialog({ photo, onClose, onChanged }: EditDialogProps) {
  const insets = useSafeAreaInsets();

  // 元数据草稿
  const [title, setTitle] = useState(photo.title);
  const [description, setDescription] = useState(photo.description);
  const [category, setCategory] = useState<string>(photo.cat);
  const [likes, setLikes] = useState(String(photo.likes));
  // 标签编辑只认名字：来源与审核态由后端维护
  const [tags, setTags] = useState(photo.tags.map((tag) => tag.name).join(', '));
  const [privacy, setPrivacy] = useState<NonNullable<PhotoPatch['privacy']>>(photo.privacy?.mode ?? 'visible');

  // EXIF 草稿（canonical 文本）
  const [exif, setExif] = useState<PhotoExifResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [gpsCleared, setGpsCleared] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    exifApi
      .get(photo.id)
      .then((result) => {
        if (cancelled) return;
        setExif(result);
        setValues(initialFormText(result.fields));
        setPoint(result.gps ? { lat: result.gps.lat, lon: result.gps.lon } : null);
        setGpsCleared(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'EXIF 读取失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [photo.id]);

  const setField = useCallback((tag: string, value: string) => {
    setValues((prev) => ({ ...prev, [tag]: value }));
  }, []);

  /** 单张的「清除」= 草稿置空；提交时归一成 null，后端会删掉这个 tag */
  const clearField = useCallback((tag: string, label: string) => {
    setValues((prev) => ({ ...prev, [tag]: '' }));
    setNotice(`已清空「${label}」，保存后将从这张照片中移除`);
  }, []);

  /** 选点变化一律解除「已清除」：用户刚点了地图，意图显然是「要一个定位」 */
  const handlePointChange = useCallback((next: GeoPoint) => {
    setPoint(next);
    setGpsCleared(false);
  }, []);

  const handleSave = async (): Promise<void> => {
    if (!exif) return;
    setError(null);
    setNotice(null);

    // 前置校验：数值范围 / 时间格式 —— 与 Web、后台同一套规则，先拦一道再发请求
    for (const spec of EXIF_FIELDS) {
      const value = (values[spec.tag] ?? '').trim();
      if (value === '') continue;
      if (spec.type === 'number') {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          setError(`「${spec.label}」需要填写一个数字`);
          return;
        }
        if ((spec.min != null && num < spec.min) || (spec.max != null && num > spec.max)) {
          setError(`「${spec.label}」需在 ${spec.min} ~ ${spec.max} 之间`);
          return;
        }
      }
      if (spec.type === 'datetime' && exifTextToSubmit('datetime', value) === null) {
        setError(`「${spec.label}」时间格式不正确，请补齐年月日`);
        return;
      }
    }

    const metaPatch: PhotoPatch = {
      title: title.trim(),
      description: description.trim(),
      category,
      likes: Math.max(0, Number(likes) || 0),
      tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      privacy,
    };
    const metaDirty =
      metaPatch.title !== photo.title ||
      metaPatch.description !== photo.description ||
      metaPatch.category !== photo.cat ||
      metaPatch.likes !== photo.likes ||
      metaPatch.privacy !== (photo.privacy?.mode ?? 'visible') ||
      metaPatch.tags!.join(',') !== photo.tags.map((tag) => tag.name).join(',');

    // 逐字段语义比对：只提交真正改动的 tag
    const fieldPatch: Record<string, string | string[] | null> = {};
    for (const spec of EXIF_FIELDS) {
      const value = values[spec.tag] ?? '';
      if (exifSameText(spec.type, value, exifRawToText(spec.type, exif.fields[spec.tag]))) continue;
      fieldPatch[spec.tag] = exifTextToSubmit(spec.type, value);
    }

    /* 定位：与文件里的原值比过才提交 —— 否则打开即保存会白写一次同样的坐标 */
    const saved = exif.gps;
    const pointDiffers =
      point != null &&
      (saved == null || Math.abs(point.lat - saved.lat) > 1e-9 || Math.abs(point.lon - saved.lon) > 1e-9);

    const patch: ExifPatch = {};
    if (Object.keys(fieldPatch).length > 0) patch.fields = fieldPatch;
    if (gpsCleared) patch.gps = null;
    else if (point && pointDiffers) patch.gps = { lat: point.lat, lon: point.lon };

    const exifDirty = patch.fields !== undefined || patch.gps !== undefined;
    if (!exifDirty && !metaDirty) {
      setNotice('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      if (metaDirty) await photoApi.update(photo.id, metaPatch);
      if (exifDirty) await exifApi.update(photo.id, patch);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.backdrop, { paddingTop: insets.top + space.s16, paddingBottom: insets.bottom + space.s16 }]}>
        <Glass corner="xl" style={styles.card}>
          <View style={styles.head}>
            <Text style={styles.title}>编辑照片</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭编辑" onPress={onClose} hitSlop={8} style={styles.close}>
              <Icon name="close" size={18} color={colors.text.secondary} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.section}>照片信息</Text>
            <Field label="标题">
              <TextInput style={styles.input} value={title} onChangeText={setTitle} underlineColorAndroid="transparent" />
            </Field>
            {/* 描述是多行正文：高度放开、文字顶对齐，换行原样保留（前台查看器整段展示） */}
            <Field label="描述">
              <TextInput
                style={[styles.input, styles.multiline]}
                value={description}
                onChangeText={setDescription}
                placeholder="想为这张照片留一段话…"
                placeholderTextColor={colors.text.quaternary}
                multiline
                textAlignVertical="top"
                underlineColorAndroid="transparent"
              />
            </Field>
            <Field label="分类">
              <ChipRow>
                {CATEGORY_OPTIONS.map((name) => (
                  <Chip key={name} label={name} active={name === category} onPress={() => setCategory(name)} />
                ))}
              </ChipRow>
            </Field>
            <Field label="点赞数">
              <TextInput style={styles.input} value={likes} onChangeText={setLikes} keyboardType="number-pad" underlineColorAndroid="transparent" />
            </Field>
            <Field label="标签（逗号分隔）">
              <TextInput style={styles.input} value={tags} onChangeText={setTags} placeholder="如 上海, 街头" placeholderTextColor={colors.text.quaternary} underlineColorAndroid="transparent" />
            </Field>
            <Field label="隐私标记">
              <ChipRow>
                {PRIVACY_MARKS.map((value) => (
                  <Chip key={value} label={PRIVACY_LABEL[value]} active={value === privacy} onPress={() => setPrivacy(value)} />
                ))}
              </ChipRow>
            </Field>

            <Text style={styles.section}>拍摄参数</Text>
            {loading ? (
              <ActivityIndicator color={colors.accent} style={styles.loading} />
            ) : (
              <>
                <ExifFieldsSection values={values} onChange={setField} onClear={clearField} disabled={saving} />

                <Text style={styles.subsection}>定位（经纬度）</Text>
                <GpsPicker
                  point={point}
                  savedGps={exif?.gps ? { lat: exif.gps.lat, lon: exif.gps.lon } : null}
                  cleared={gpsCleared}
                  disabled={saving}
                  onPointChange={handlePointChange}
                  onClear={() => setGpsCleared(true)}
                  onCancelClear={() => setGpsCleared(false)}
                />
              </>
            )}

            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Text style={styles.hint}>保存只更新数据库中的 EXIF 记录，照片文件保持原样；下载时会把最新 EXIF 写入下载的图片。把某项内容清空再保存，即可移除该项。</Text>
          </ScrollView>

          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onClose} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <Text style={styles.actionText}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="保存"
              onPress={() => void handleSave()}
              disabled={saving || loading}
              style={({ pressed }) => [styles.action, styles.primary, (saving || loading) && styles.disabled, pressed && styles.pressed]}
            >
              {saving ? <ActivityIndicator color={colors.background} /> : <Text style={styles.primaryText}>保存</Text>}
            </Pressable>
          </View>
        </Glass>
      </View>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={fieldStyles.field}>
      <Text style={fieldStyles.label}>{label}</Text>
      {children}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  field: { gap: space.s6 },
  label: { ...text.caption, color: colors.text.tertiary },
});

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
  section: { ...text.caption, color: colors.text.quaternary, textTransform: 'uppercase', marginTop: space.s4 },
  subsection: { ...text.caption, color: colors.text.tertiary, marginTop: space.s8 },
  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  /* 多行输入：盖掉单行输入写死的行高，改成随内容长高（上限交给弹窗自身的滚动） */
  multiline: { height: undefined, minHeight: 96, paddingTop: space.s12, paddingBottom: space.s12 },
  loading: { alignSelf: 'center', marginVertical: space.s12 },
  notice: { ...text.meta, color: colors.accent },
  error: { ...text.meta, color: colors.danger },
  hint: { ...text.meta, color: colors.text.quaternary },
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
