/**
 * apps/mobile/src/admin/AdminPhotoDetail.tsx
 *
 * 移动端后台 · 照片详情编辑：基础信息（标题/分类）+ 全量 EXIF 分组编辑。
 * 复用 packages/core 的 EXIF_FIELDS 作为字段单一事实源，按 type 挑选控件；
 * 保存时分两条链路：基础信息走 photoApi.update，EXIF 走 exifApi.update（只改数据库）。
 *
 * 【GPS 经纬度】移动端不做地图选点（需地图库，留待后续），海拔/朝向等 GPS 字段仍可编辑。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { exifApi, photoApi } from '@shaping-memory/sdk';
import { CATEGORIES, EXIF_FIELDS, exifFieldsByGroup } from '@shaping-memory/core';
import type { ExifField } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';

import { Chip, ChipRow, Glass, Icon } from '../components/primitives';
import { colors, radius, size, space, text } from '../theme';

interface AdminPhotoDetailProps {
  photoId: string;
  onClose: () => void;
  onSaved: () => void;
}

/** 单字段控件：select 用 chip，其余用文本/数字输入框 */
function FieldControl({ field, value, onChange }: { field: ExifField; value: string; onChange: (next: string) => void }) {
  if (field.type === 'select') {
    return (
      <View style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>{field.label}</Text>
        <View style={styles.optionRow}>
          {(field.options ?? []).map((option) => {
            const on = option.value === value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => onChange(option.value)}
                style={[styles.option, on && styles.optionOn]}
              >
                <Text style={[text.caption, on ? styles.optionLabelOn : styles.optionLabelOff]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  const isNumber = field.type === 'number';
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>
        {field.label}
        {field.unit ? ` · ${field.unit}` : ''}
      </Text>
      <TextInput
        style={[styles.input, field.type === 'textarea' && styles.textarea]}
        value={value}
        onChangeText={onChange}
        keyboardType={isNumber ? 'decimal-pad' : 'default'}
        multiline={field.type === 'textarea'}
        placeholder={field.placeholder}
        placeholderTextColor={colors.text.quaternary}
        underlineColorAndroid="transparent"
        accessibilityLabel={field.label}
      />
      {field.hint ? <Text style={styles.hint}>{field.hint}</Text> : null}
    </View>
  );
}

export function AdminPhotoDetail({ photoId, onClose, onSaved }: AdminPhotoDetailProps) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('纪实');
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([photoApi.detail(photoId), exifApi.get(photoId)])
      .then(([photoRow, exif]) => {
        if (cancelled) return;
        setPhoto(photoRow);
        setTitle(photoRow.title);
        setDescription(photoRow.description);
        setCategory(photoRow.cat);
        setFields(exif.fields);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '详情加载失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [photoId]);

  const patchField = useCallback((tag: string, next: string) => {
    setFields((prev) => (prev ? { ...prev, [tag]: next } : prev));
  }, []);

  const handleSave = useCallback(async () => {
    if (!fields) return;
    setSaving(true);
    setError(null);
    try {
      // 两条链路各自落：基础信息与 EXIF 独立，任一失败都要让用户知道
      // 描述与标题同一步提交（都是展示字段，且描述为空串即清除）
      await photoApi.update(photoId, { title, description, category });
      // EXIF 字段里 select 未选中的空 tag 不落写（避免把未填写字段清空）
      const patch: Record<string, string> = {};
      for (const field of EXIF_FIELDS) {
        const raw = fields[field.tag];
        if (raw !== undefined && raw !== '') patch[field.tag] = raw;
      }
      if (Object.keys(patch).length > 0) {
        await exifApi.update(photoId, { fields: patch });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [fields, title, description, category, photoId, onSaved, onClose]);

  const groups = exifFieldsByGroup();

  return (
    <View style={styles.overlay}>
      <View style={styles.scrim} />
      <Glass corner="xxl" style={styles.sheet}>
        <View style={styles.head}>
          <Text style={styles.headTitle}>编辑照片</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={styles.closeBtn}>
            <Icon name="close" size={size.icon.default} />
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : error && !fields ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : photo && fields ? (
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {photo.cardUrl || photo.url ? (
              <Image source={{ uri: photo.cardUrl ?? photo.url }} style={styles.hero} contentFit="cover" cachePolicy="memory-disk" />
            ) : null}

            <Text style={styles.sectionLabel}>基础信息</Text>
            <Text style={styles.fieldLabel}>标题</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="照片标题"
              placeholderTextColor={colors.text.quaternary}
              underlineColorAndroid="transparent"
              accessibilityLabel="标题"
            />
            <Text style={styles.fieldLabel}>描述</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              value={description}
              onChangeText={setDescription}
              multiline
              textAlignVertical="top"
              placeholder="想为这张照片留一段话…"
              placeholderTextColor={colors.text.quaternary}
              underlineColorAndroid="transparent"
              accessibilityLabel="描述"
            />
            <Text style={styles.fieldLabel}>分类</Text>
            <ChipRow>
              {CATEGORIES.filter((c) => c !== '全部').map((c) => (
                <Chip key={c} label={c} active={category === c} onPress={() => setCategory(c)} />
              ))}
            </ChipRow>

            {groups.map(([group, groupFields]) => (
              <View key={group}>
                <Text style={styles.sectionLabel}>{group}</Text>
                {groupFields.map((field) => (
                  <FieldControl key={field.tag} field={field} value={fields[field.tag] ?? ''} onChange={(next) => patchField(field.tag, next)} />
                ))}
              </View>
            ))}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="保存"
              onPress={() => void handleSave()}
              disabled={saving}
              style={({ pressed }) => [styles.saveBtn, saving && styles.disabled, pressed && styles.pressed]}
            >
              {saving ? <ActivityIndicator color={colors.background} /> : <Text style={styles.saveText}>保存</Text>}
            </Pressable>
            <Text style={styles.footnote}>保存只更新数据库记录，照片文件保持原样</Text>
          </ScrollView>
        ) : null}
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.material.opaque },
  sheet: { flex: 1, margin: space.s16 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s16,
    paddingVertical: space.s12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.base,
  },
  headTitle: { ...text.heading },
  closeBtn: { width: size.iconButton.default, height: size.iconButton.default, alignItems: 'center', justifyContent: 'center' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.s8 },
  error: { ...text.meta, color: colors.danger },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },

  body: { padding: space.s16, paddingBottom: space.s40, gap: space.s4 },
  hero: { width: '100%', aspectRatio: 16 / 10, borderRadius: radius.xl, backgroundColor: colors.material.ultraThin },

  sectionLabel: { ...text.meta, textTransform: 'uppercase', marginTop: space.s16, marginBottom: space.s4 },
  fieldLabel: { ...text.caption, color: colors.text.tertiary },
  fieldBlock: { marginTop: space.s8 },
  hint: { ...text.caption, color: colors.text.tertiary },
  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  textarea: { height: 72, paddingVertical: space.s8 },

  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s8, marginTop: space.s6 },
  option: {
    minHeight: size.chip,
    justifyContent: 'center',
    paddingHorizontal: space.s12,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  optionOn: { backgroundColor: colors.accent },
  optionLabelOn: { color: colors.background, fontWeight: '600' },
  optionLabelOff: { color: colors.text.secondary },

  saveBtn: {
    marginTop: space.s24,
    height: size.button.md,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  saveText: { ...text.label, color: colors.background, fontWeight: '600' },
  footnote: { ...text.meta, textAlign: 'center', marginTop: space.s8 },
});