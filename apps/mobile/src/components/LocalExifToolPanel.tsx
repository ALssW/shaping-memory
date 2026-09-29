/**
 * apps/mobile/src/components/LocalExifToolPanel.tsx
 *
 * 「工具 · EXIF 编辑」工作台（需求 5）：全屏 Modal。
 *
 * 【纯本地、免登录、断网可用】全程不碰任何 API：相册多选导入（JPEG / PNG / RAW）→ 读字节 →
 * readLocalExifAny 解析 → 批量勾选 → 专用控件编辑 → 二次确认 → writeLocalExif 写新字节 →
 * 存入系统相册。没有一条网络请求，飞行模式下行为与联网时完全一致。
 *
 * 【字段语义沿用批量编辑的三态】批量编辑没有「单张原值」可对照，于是：
 *   · 留空      = 不修改（每张照片保持自己的值）
 *   · 填了值    = 这批照片的该字段统一成它
 *   · 标记清除  = patch[tag] = null（从文件里删掉该 tag）
 * 界面直接复用 ExifFieldsSection + ExifFieldControl（7 组齐全、秒级日期、滑块 + 输入联动、
 * 选项胶囊、多行 / 多值），只把两条本地专有信息作为附加 props 传进去：
 * 「N 张值不一致」与「XMP/IPTC 容器字段置灰」。
 *
 * 【导出的字节即编辑结果】写临时文件走 base64 直写（见 lib/saveToAlbum.ts），
 * 无解码 / 重编码；导出流程里也不再改任何 tag。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ExifFieldsSection } from './ExifFieldsSection';
import { LocalExifImportList } from './LocalExifImportList';
import { Icon } from './primitives';
import {
  buildPatch,
  draftFromSelection,
  exportPatchedToAlbum,
  pickLocalPhotos,
  refreshWithBytes,
  unsupportedFieldReasons,
} from '../lib/localExif';
import type { LocalDraft, LocalExifPhoto } from '../lib/localExif';
import { colors, radius, size, space, text } from '../theme';

const EMPTY_DRAFT: LocalDraft = { values: {}, touched: {}, clears: {} };

interface LocalExifToolPanelProps {
  onClose: () => void;
}

export function LocalExifToolPanel({ onClose }: LocalExifToolPanelProps) {
  const insets = useSafeAreaInsets();

  const [photos, setPhotos] = useState<readonly LocalExifPhoto[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<LocalDraft>(EMPTY_DRAFT);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  /* 容器字段的置灰说明是静态常量，只算一次 */
  const disabledReasons = useMemo(unsupportedFieldReasons, []);

  const editable = photos.filter((photo) => photo.bytes !== null);
  const selectedPhotos = editable.filter((photo) => selected.has(photo.id));
  /* 选中集合的指纹：变了就重算草稿，免得上一次的选择残留把值写到不相干的照片上 */
  const selectionKey = selectedPhotos.map((photo) => photo.id).join('|');

  /* effect 只认指纹，照片本体通过 ref 取最新 —— 否则每次导入 / 导出后（photos 引用变化）
     都会重置草稿，把用户填了一半的值抹掉 */
  const latest = useRef({ photos, selected });
  latest.current = { photos, selected };

  useEffect(() => {
    const chosen = latest.current.photos.filter(
      (photo) => photo.bytes !== null && latest.current.selected.has(photo.id),
    );
    const fresh = draftFromSelection(chosen);
    setDraft(fresh.draft);
    setNotes(fresh.notes);
  }, [selectionKey]);

  /* ---------------------------- 选择 ---------------------------- */

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      // Set.delete 返回是否真的删掉了：一举两得，不必先 has 再判断
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(latest.current.photos.filter((photo) => photo.bytes !== null).map((photo) => photo.id)));
  }, []);

  const selectNone = useCallback(() => setSelected(new Set()), []);

  /* ---------------------------- 导入 ---------------------------- */

  const importPhotos = useCallback(async () => {
    setImporting(true);
    setStatus(null);
    try {
      const picked = await pickLocalPhotos();
      if (picked.length === 0) return; // 用户取消：不做提示
      /* 同一张重复导入不产生重复行：以 id（assetId 优先）去重 —— uri 在 Android 上不稳定。
         seen 边过滤边累加，所以「本次一次选中里重复的路由」也会被收敛掉。 */
      const seen = new Set(latest.current.photos.map((photo) => photo.id));
      const fresh = picked.filter((photo) => {
        if (seen.has(photo.id)) return false;
        seen.add(photo.id);
        return true;
      });
      if (fresh.length === 0) {
        setStatus('这些照片已在列表中');
        return;
      }
      setPhotos((prev) => [...prev, ...fresh]);
      // 新导入的可编辑照片默认勾上：多数时候就是「刚选的这几张一起改」
      setSelected((prev) => new Set([...prev, ...fresh.filter((photo) => photo.bytes).map((photo) => photo.id)]));
      const readonly = fresh.filter((photo) => photo.bytes === null).length;
      setStatus(
        readonly > 0
          ? `已导入 ${fresh.length} 张，其中 ${readonly} 张只读（原因见列表）`
          : `已导入 ${fresh.length} 张，可以开始编辑`,
      );
    } catch (err) {
      Alert.alert('无法导入照片', err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }, []);

  /* ---------------------------- 编辑草稿 ---------------------------- */

  const setField = useCallback((tag: string, value: string) => {
    setDraft((prev) => ({
      values: { ...prev.values, [tag]: value },
      /* 只有动过的字段才进补丁：若把「回填的公共值」也算改动，字段数会被虚报 */
      touched: { ...prev.touched, [tag]: true },
      clears: prev.clears[tag] ? { ...prev.clears, [tag]: false } : prev.clears,
    }));
  }, []);

  const toggleClear = useCallback((tag: string) => {
    setDraft((prev) => ({ ...prev, clears: { ...prev.clears, [tag]: !prev.clears[tag] } }));
  }, []);

  /* ---------------------------- 确认 + 导出 ---------------------------- */

  const runExport = useCallback(async (patch: Record<string, string | null>) => {
    setExporting(true);
    setStatus(null);
    try {
      const targets = latest.current.photos.filter(
        (photo) => photo.bytes !== null && latest.current.selected.has(photo.id),
      );
      const outcomes = await exportPatchedToAlbum(targets, patch);

      /* 成功的那几张换成新字节：同一批再改再导出时叠加在最新结果上，不会丢上一次的改动 */
      const bytesById = new Map(
        outcomes.filter((item) => item.bytes !== undefined).map((item) => [item.photo.id, item.bytes!]),
      );
      if (bytesById.size > 0) {
        setPhotos((prev) =>
          prev.map((photo) => {
            const bytes = bytesById.get(photo.id);
            return bytes === undefined ? photo : refreshWithBytes(photo, bytes);
          }),
        );
      }

      const failures = outcomes.filter((item) => item.failure !== '');
      setStatus(`已把 ${bytesById.size} 张写入系统相册${failures.length > 0 ? `，${failures.length} 张失败` : '（照片保持原始画质）'}`);
      if (failures.length > 0) {
        Alert.alert('部分照片未能导出', failures.map((item) => `${item.photo.name}：${item.failure}`).join('\n'));
      }
    } catch (err) {
      // exif-io 的值校验（「EXIF 写入值不是合法数字」等）与权限文案都落到这里
      Alert.alert('无法导出', err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }, []);

  const confirmExport = useCallback(() => {
    if (selectedPhotos.length === 0) {
      setStatus('尚未勾选照片：请先在列表中勾选需要修改的照片');
      return;
    }
    const patch = buildPatch(draft);
    const fieldCount = Object.keys(patch).length;
    if (fieldCount === 0) {
      setStatus('尚未填写修改内容：请填写一项，或对某项选择「标记清除」');
      return;
    }
    Alert.alert(
      '应用并导出到相册',
      `将修改 ${selectedPhotos.length} 张照片的 ${fieldCount} 项内容。导出的是改好的原图，拍摄信息完整保留，画质不受影响。`,
      [{ text: '取消', style: 'cancel' }, { text: '确认导出', onPress: () => void runExport(patch) }],
    );
  }, [draft, selectedPhotos, runExport]);

  const frozen = exporting || selectedPhotos.length === 0;

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text style={styles.title}>拍摄参数编辑</Text>
            <Text style={styles.sub}>纯本地 · 免登录 · 断网可用</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭拍摄参数编辑"
            hitSlop={8}
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <Icon name="close" size={18} color={colors.text.secondary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <LocalExifImportList
            photos={photos}
            selected={selected}
            importing={importing}
            disabled={exporting}
            onImport={() => void importPhotos()}
            onToggle={toggle}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
          />

          {selectedPhotos.length > 0 ? (
            <View style={styles.fields}>
              <Text style={styles.section}>参数（已选 {selectedPhotos.length} 张）</Text>
              <Text style={styles.hint}>
                留空 = 不修改；如需删除某项内容，请点击其右侧的「标记清除」。仅填写了值或标记了清除的项会写入这批照片。
              </Text>
              <ExifFieldsSection
                values={draft.values}
                onChange={setField}
                onClear={toggleClear}
                mode="batch"
                clears={draft.clears}
                notes={notes}
                disabledReasons={disabledReasons}
                disabled={exporting}
              />
            </View>
          ) : null}
        </ScrollView>

        {status ? <Text style={styles.status}>{status}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="应用并导出到相册"
            disabled={frozen}
            onPress={confirmExport}
            style={({ pressed }) => [styles.action, frozen && styles.disabled, pressed && styles.pressed]}
          >
            {exporting ? (
              <ActivityIndicator color={colors.background} />
            ) : (
              <Text style={styles.actionText}>应用并导出到相册</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s12, paddingHorizontal: space.s16, paddingVertical: space.s12 },
  headText: { flex: 1, gap: space.s2 },
  title: { ...text.title },
  sub: { ...text.meta, color: colors.text.quaternary },
  close: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.material.ultraThin,
  },

  body: { paddingHorizontal: space.s16, paddingBottom: space.s24, gap: space.s24 },
  fields: { gap: space.s12 },
  section: { ...text.caption, color: colors.text.quaternary, textTransform: 'uppercase' },
  hint: { ...text.meta, color: colors.text.tertiary },

  status: { ...text.meta, color: colors.text.secondary, paddingHorizontal: space.s16, paddingBottom: space.s4 },
  actions: { paddingHorizontal: space.s16, paddingBottom: space.s16, paddingTop: space.s4 },
  action: {
    height: size.button.md,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  actionText: { ...text.label, color: colors.background, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
