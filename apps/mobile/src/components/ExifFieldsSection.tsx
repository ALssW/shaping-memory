/**
 * apps/mobile/src/components/ExifFieldsSection.tsx
 *
 * 全量 EXIF 字段的分区表单：按 core `exifFieldsByGroup()` 的 7 组渲染，每组一个可折叠面板。
 * 单张编辑（EditDialog）、批量编辑（BatchEditDialog）与本地工作台（LocalExifToolPanel）共用这一份 ——
 * 字段清单与控件分派只写一次，三处不会因为「某一处改了字段、另一处忘记同步」而出现不一致（与 Web 端两边共用
 * ExifFieldControl 是同一个动机）。本地工作台多用的两条信息（值不一致标注、容器字段置灰原因）
 * 是可选的附加 props，前两者不传即维持原行为。
 *
 * 【为什么组默认展开】Web 端 EditDialog 的 `<details open>` 就是全展开；
 * 折叠只是给 41 个字段提供的收纳手段，默认收起会让「查找某个字段」变得困难。
 */
import { memo, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { exifFieldsByGroup } from '@shaping-memory/core';

import { ExifFieldControl } from './ExifFieldControl';
import type { ExifControlMode } from './ExifFieldControl';
import { Icon } from './primitives';
import { colors, size, space, text } from '../theme';

interface ExifFieldsSectionProps {
  /** tag → canonical 文本 */
  values: Record<string, string>;
  onChange: (tag: string, value: string) => void;
  onClear: (tag: string, label: string) => void;
  mode?: ExifControlMode;
  /** 批量模式下 tag → 是否标记清除 */
  clears?: Record<string, boolean>;
  disabled?: boolean;
  /** tag → 附加说明（本地工作台标「N 张值不一致」） */
  notes?: Record<string, string>;
  /** tag → 置灰原因（本地工作台标 XMP/IPTC 容器字段） */
  disabledReasons?: Record<string, string>;
}

export function ExifFieldsSection({
  values,
  onChange,
  onClear,
  mode = 'single',
  clears,
  disabled = false,
  notes,
  disabledReasons,
}: ExifFieldsSectionProps) {
  const groups = useMemo(() => exifFieldsByGroup(), []);

  return (
    <>
      {groups.map(([group, fields]) => (
        <CollapsibleGroup key={group} title={group} count={fields.length}>
          {fields.map((spec) => (
            <ExifFieldControl
              key={spec.tag}
              spec={spec}
              value={values[spec.tag] ?? ''}
              onChange={(value) => onChange(spec.tag, value)}
              onClear={() => onClear(spec.tag, spec.label)}
              mode={mode}
              cleared={clears?.[spec.tag] ?? false}
              disabled={disabled}
              note={notes?.[spec.tag]}
              disabledReason={disabledReasons?.[spec.tag]}
            />
          ))}
        </CollapsibleGroup>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */

interface CollapsibleGroupProps {
  title: string;
  count: number;
  children: ReactNode;
}

const CollapsibleGroup = memo(function CollapsibleGroup({ title, count, children }: CollapsibleGroupProps) {
  const [open, setOpen] = useState(true);
  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}（${count} 项）`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((prev) => !prev)}
        style={({ pressed }) => [styles.groupHead, pressed && styles.pressed]}
      >
        <Text style={styles.groupTitle}>{title}</Text>
        <Text style={styles.groupCount}>{count}</Text>
        <View style={open ? styles.caretUp : undefined}>
          <Icon name="chevron" size={size.icon.compact} color={colors.text.quaternary} />
        </View>
      </Pressable>
      {open ? <View style={styles.groupBody}>{children}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  group: { gap: space.s8 },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingVertical: space.s4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.base,
  },
  groupTitle: { ...text.label, color: colors.text.secondary, flex: 1 },
  groupCount: { ...text.meta, color: colors.text.quaternary },
  caretUp: { transform: [{ rotate: '180deg' }] },
  groupBody: { gap: space.s12, paddingTop: space.s4 },
  pressed: { opacity: 0.7 },
});
