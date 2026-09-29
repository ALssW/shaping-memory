/**
 * apps/mobile/src/components/ExposurePresetPicker.tsx
 *
 * 曝光三要素（快门 / 光圈 / ISO）的「档位快速选择」弹层 —— 与自由输入并存的那一路。
 * 触发按钮显示当前档位习惯写法（`1/200`、`f/2.8`、`400`），点开弹出底部档位列表。
 *
 * 【档位从哪来】全部取自 core 的 `EXPOSURE_PRESETS`（与 Web / 后台同一份事实源），
 * 本组件不自己列档位；选中即把 canonical 写入值回填，与手输落到同一个字段状态。
 *
 * 【为什么是 Modal + FlatList】RN 没有原生 Picker，项目里也没有现成的下拉控件；
 * 档位最长的快门有 70 项，必须能滚动、且「打开即定位到当前档位」——
 * Modal 承载可滚动列表，又不会被父级 ScrollView 裁掉（绝对定位浮层会被裁）。
 * `getItemLayout` 与行高常量必须一致，否则 `initialScrollIndex` 会出现定位偏移。
 */
import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EXPOSURE_PRESETS, exposureLabelOf, findExposurePreset } from '@shaping-memory/core';
import type { ExposureKind, ExposurePreset } from '@shaping-memory/core';

import { Glass, Icon } from './primitives';
import { accentOpacity, accentRgba, colors, radius, size, space, tabularNums, text } from '../theme';

/** 档位行高：FlatList 的 getItemLayout 必须与它一致（也决定 initialScrollIndex 的落点） */
const ROW_HEIGHT = 44;

const TITLE: Record<ExposureKind, string> = {
  shutter: '选择快门速度',
  aperture: '选择光圈',
  iso: '选择 ISO',
};

/** 触发按钮文案：空值提示去选档，有值则按习惯写法展示（手输的非档位值也照常显示） */
function triggerLabel(kind: ExposureKind, value: string): string {
  return value.trim() === '' ? '按档位选择' : exposureLabelOf(kind, value);
}

interface ExposurePresetPickerProps {
  kind: ExposureKind;
  /** 当前 canonical 文本（空 = 未设置） */
  value: string;
  disabled: boolean;
  /** 选中档位：回填 canonical 值 */
  onChange: (value: string) => void;
}

export function ExposurePresetPicker({ kind, value, disabled, onChange }: ExposurePresetPickerProps) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const presets = EXPOSURE_PRESETS[kind];
  /* 当前值命中的档位；手输的非档位值命中不到（返回 null），列表里就没有高亮项 */
  const current = findExposurePreset(kind, value);
  /* 打开时定位到的下标：命中档位就滚到它，否则从最快 / 最小端开场 */
  const startIndex = current ? presets.findIndex((preset) => preset.value === current.value) : 0;

  const select = (preset: ExposurePreset): void => {
    onChange(preset.value);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${TITLE[kind]}，当前 ${triggerLabel(kind, value)}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.trigger, disabled && styles.disabled, pressed && styles.pressed]}
      >
        <Text style={[styles.triggerText, tabularNums]}>{triggerLabel(kind, value)}</Text>
        <Icon name="chevron" size={size.icon.compact} color={colors.text.quaternary} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        {/* 点击遮罩即关闭；内层接管触摸，避免点列表本身被当成点遮罩 */}
        <Pressable accessibilityRole="button" accessibilityLabel="关闭档位列表" style={styles.backdrop} onPress={() => setOpen(false)}>
          <View
            style={[styles.sheetWrap, { paddingBottom: insets.bottom + space.s12 }]}
            onStartShouldSetResponder={() => true}
          >
            <Glass corner="xl">
              <View style={styles.head}>
                <Text style={styles.title}>{TITLE[kind]}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭"
                  onPress={() => setOpen(false)}
                  hitSlop={8}
                  style={styles.close}
                >
                  <Icon name="close" size={18} color={colors.text.secondary} />
                </Pressable>
              </View>
              <FlatList
                data={presets}
                keyExtractor={(preset) => preset.value}
                initialNumToRender={12}
                initialScrollIndex={startIndex}
                getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
                style={styles.list}
                renderItem={({ item }) => (
                  <PresetRow preset={item} active={item.value === current?.value} onPress={() => select(item)} />
                )}
              />
            </Glass>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function PresetRow({ preset, active, onPress }: { preset: ExposurePreset; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={preset.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.pressed]}
    >
      <Text style={[styles.rowText, tabularNums, active && styles.rowTextActive]}>{preset.label}</Text>
      {active ? <Icon name="check" size={size.icon.compact} color={colors.accent} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    alignSelf: 'flex-start',
    paddingHorizontal: space.s12,
    paddingVertical: space.s4,
    borderRadius: radius.full,
    backgroundColor: colors.material.ultraThin,
  },
  triggerText: { ...text.caption, color: colors.text.secondary },

  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.material.opaque },
  sheetWrap: { paddingHorizontal: space.s12 },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s16,
    paddingVertical: space.s12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.base,
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

  /** 限高后可滚动：快门 70 档也放得下 */
  list: { maxHeight: 360 },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s16,
  },
  rowActive: { backgroundColor: accentRgba(accentOpacity.wash) },
  rowText: { ...text.body, color: colors.text.secondary },
  rowTextActive: { color: colors.accent, fontWeight: '600' },

  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});