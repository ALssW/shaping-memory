/**
 * apps/mobile/src/components/ExifFieldControl.tsx
 *
 * EXIF 单个字段的控件分派：按 core `EXIF_FIELDS` 的 `type` 选 RN 端对应的控件，
 * 与 Web 端 apps/web/src/components/ExifFieldControl.tsx 同语义（视觉换成移动端基元）。
 *
 * 【专用控件的落点】
 *   - number  → 自建滑块 + 直接输入，双向联动；步进取 step，边界取 min/max（保底见 sliderRangeOf）。
 *              曝光三要素（ExposureTime / FNumber / ISO）在其下再挂一个「档位快速选择」按钮，
 *              档位来自 core 的 EXPOSURE_PRESETS，选中值与手输落到同一个字段状态（见 ExposurePresetPicker）。
 *   - datetime→ 年月日 + 时分秒 六段数字输入。**为什么自建**：RN 没有原生 datetime 控件，
 *               `@react-native-community/datetimepicker` 在 Android 侧只给到分钟，
 *               而 EXIF 的 DateTimeOriginal 必须能精确到秒（时间线排序按它算）。
 *   - select  → 选项胶囊（复用 primitives 的 Chip / ChipRow），另有「未设置」胶囊用于清除
 *   - tags    → 逗号分隔多值（口径与 core exif-values 的 tags 规范化一致）
 *   - textarea/text → 多行 / 单行输入
 *
 * 【「未填写」与「清除」不是一回事】本组件只负责把草稿改成「空串」；
 * 空串最终是「不提交」还是「置 null 删除」，由调用方按 core 的 exifSameText 判定
 * （单张编辑拿它与文件原值比对：一样就跳过、不一样才提交；批量编辑则「空 = 不动」）。
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { canonicalExposureText, exposureKindOfTag, parseExposureValue } from '@shaping-memory/core';
import type { ExifField, ExposureKind } from '@shaping-memory/core';

import { Chip, ChipRow } from './primitives';
import { ExifSlider } from './ExifSlider';
import { ExposurePresetPicker } from './ExposurePresetPicker';
import { colors, radius, size, space, tabularNums, text } from '../theme';

/** single = 单张编辑（清除 = 置空草稿）；batch = 批量编辑（清除 = 标记该字段下发 null） */
export type ExifControlMode = 'single' | 'batch';

interface ExifFieldControlProps {
  spec: ExifField;
  /** canonical 文本（见 core exif-values.ts） */
  value: string;
  onChange: (value: string) => void;
  /** 单张：清空该字段；批量：切换「标记清除」 */
  onClear: () => void;
  mode?: ExifControlMode;
  /** 批量模式下是否已标记清除 */
  cleared?: boolean;
  disabled?: boolean;
  /** 附加说明（本地工作台用来标「N 张值不一致」）：渲染在标题行下方 */
  note?: string;
  /** 置灰原因（本地工作台用来标 XMP/IPTC 容器字段）：给出即整体禁用，并显示原因 */
  disabledReason?: string;
}

export function ExifFieldControl({
  spec,
  value,
  onChange,
  onClear,
  mode = 'single',
  cleared = false,
  disabled = false,
  note,
  disabledReason,
}: ExifFieldControlProps) {
  const blocked = disabled || disabledReason !== undefined;
  const inputDisabled = blocked || cleared;
  const clearLabel = mode === 'batch' ? (cleared ? '已标记清除' : '标记清除') : '清除';
  /* 单张编辑里草稿为空表示「文件里没有 / 已被清空」，此时再按清除没有意义，故禁用 */
  const clearDisabled = blocked || (mode === 'single' && value === '');

  return (
    /* 置灰：整个字段（标签 + 控件）一起降透明度，可直观看出该项不可编辑 */
    <View style={[styles.field, disabledReason !== undefined && styles.dimmed]}>
      <View style={styles.head}>
        <Text style={styles.label}>
          {spec.label}
          {spec.unit ? <Text style={styles.unit}> {spec.unit}</Text> : null}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${clearLabel} ${spec.label}`}
          accessibilityState={{ selected: mode === 'batch' ? cleared : undefined }}
          disabled={clearDisabled}
          onPress={onClear}
          style={({ pressed }) => [
            styles.clear,
            cleared && styles.clearOn,
            clearDisabled && styles.clearDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.clearText, cleared && styles.clearTextOn]}>{clearLabel}</Text>
        </Pressable>
      </View>

      <Control spec={spec} value={value} onChange={onChange} disabled={inputDisabled} />

      {/* 本地工作台的两条附加信息：容器字段说明为什么不可编辑；值不一致时提示「不会代为选择」 */}
      {disabledReason !== undefined ? <Text style={styles.blocked}>{disabledReason}</Text> : null}
      {note !== undefined ? <Text style={styles.note}>{note}</Text> : null}
      {spec.hint ? <Text style={styles.hint}>{spec.hint}</Text> : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* 按 type 分派                                                                 */
/* -------------------------------------------------------------------------- */

interface ControlProps {
  spec: ExifField;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

function Control({ spec, value, onChange, disabled }: ControlProps) {
  switch (spec.type) {
    case 'textarea':
      return <TextInput {...inputProps(spec)} style={[styles.input, styles.area]} value={value} editable={!disabled} multiline onChangeText={onChange} />;
    case 'number':
      return <NumberControl spec={spec} value={value} onChange={onChange} disabled={disabled} />;
    case 'select':
      return <SelectControl spec={spec} value={value} onChange={onChange} disabled={disabled} />;
    case 'datetime':
      return <DatetimeControl value={value} onChange={onChange} disabled={disabled} />;
    case 'tags':
      return <TextInput {...inputProps(spec)} style={styles.input} value={value} editable={!disabled} onChangeText={onChange} placeholder={spec.placeholder ?? '逗号分隔多个关键词'} />;
    default:
      return <TextInput {...inputProps(spec)} style={styles.input} value={value} editable={!disabled} onChangeText={onChange} />;
  }
}

/** 输入框共用属性：placeholder 落在规格的 placeholder，缺省用中性提示语 */
function inputProps(spec: ExifField) {
  return {
    placeholder: spec.placeholder ?? '请输入',
    placeholderTextColor: colors.text.quaternary,
    underlineColorAndroid: 'transparent' as const,
  };
}

/* ------------------------------- number ---------------------------------- */

/** 允许负值的数值字段：缺 min/max 时从数值本身看不出符号域（值为 0 时更看不出来），只能显式列出 */
const SIGNED_NUMBER_TAGS: ReadonlySet<string> = new Set(['ExposureCompensation']);

/**
 * 滑块区间保底：字段自带 min/max 就用它，没有则以 `anchor` 为中心往两侧各留一倍。
 * 【为什么不能固定成 0..100】`EXIF_FIELDS` 里多数数值字段（快门/光圈/ISO/色温/焦距…）没给 min/max：
 * 固定区间会把大数值（色温 5656）全挤到最右端、把小数值（快门 0.04）永远钉在最左端，拖动等同于无效拖动。
 * 【为什么以「原值」为中心】在原值附近就能左右微调，正是改 EXIF 的用法；
 * 精确值仍可直接在输入框输入（两者双向联动），滑块只负责粗调。
 * 【anchor 为什么不取实时值】区间若跟着实时值重算会自反馈：拖到哪，区间就变成「该值 ×2」，
 * 拇指随即被拉回轨道中央，怎么拖都不动 —— 这是实测中已确认的问题，因此锚点只在挂载时取一次。
 */
function sliderRangeOf(spec: ExifField, anchor: string): { min: number; max: number } {
  const num = Number(anchor);
  const has = anchor.trim() !== '' && Number.isFinite(num);
  if (!has) return { min: spec.min ?? 0, max: spec.max ?? 100 };
  const signed = num < 0 || SIGNED_NUMBER_TAGS.has(spec.tag);
  /* 负号域给 2 的起步半宽，避免原值恰好为 0 时区间塌成 ±1，连一档都拖不出来 */
  const span = Math.max(Math.abs(num) * 2, signed ? 4 : 1);
  const min = spec.min ?? (signed ? -Math.ceil(span) : 0);
  const max = spec.max ?? Math.ceil(span);
  return max > min ? { min, max } : { min, max: min + 1 };
}

/** 值非法时的中文提示：与 core 的宽容解析口径对应（见 exposure-presets.ts） */
const INVALID_HINT: Record<ExposureKind, string> = {
  shutter: '快门需填秒值（如 0.005）或 1/200 这类写法',
  aperture: '光圈需填 f 数（如 2.8）',
  iso: 'ISO 需填整数（如 400）',
};

function NumberControl({ spec, value, onChange, disabled }: ControlProps) {
  const num = Number(value);
  /* 锚点=挂载时的草稿（即文件原值）：整场编辑里刻度固定，拖动才稳定 */
  const anchor = useRef(value);
  const { min, max } = sliderRangeOf(spec, anchor.current);
  const step = spec.step && spec.step > 0 ? spec.step : 1;
  /* 曝光三要素（快门 / 光圈 / ISO）额外挂一个「档位快速选择」入口，与滑块 + 输入框并存 */
  const kind = exposureKindOfTag(spec.tag);
  const invalidHint =
    kind != null && value.trim() !== '' && parseExposureValue(kind, value) == null ? INVALID_HINT[kind] : null;

  /* 失焦时把 `1/200`、`f/2.8`、`2"` 这类习惯写法归一到 canonical，与档位选择落到同一口径 */
  const normalizeExposure = (): void => {
    if (kind == null) return;
    const canonical = canonicalExposureText(kind, value);
    if (canonical !== '' && canonical !== value) onChange(canonical);
  };

  return (
    <View style={styles.numberWrap}>
      <View style={styles.numberRow}>
        <ExifSlider
          value={value.trim() !== '' && Number.isFinite(num) ? num : null}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          /* 滑块出的是纯数值；字符串口径由调用方在提交时经 core 规范化 */
          onChange={(next) => onChange(String(next))}
        />
        <TextInput
          {...inputProps(spec)}
          style={[styles.input, styles.numberInput, tabularNums]}
          value={value}
          editable={!disabled}
          keyboardType="numbers-and-punctuation"
          onChangeText={onChange}
          onBlur={kind != null ? normalizeExposure : undefined}
        />
      </View>
      {kind != null ? (
        <ExposurePresetPicker kind={kind} value={value} disabled={disabled} onChange={onChange} />
      ) : null}
      {invalidHint ? <Text style={styles.invalid}>{invalidHint}</Text> : null}
    </View>
  );
}

/* ------------------------------- select ---------------------------------- */

function SelectControl({ spec, value, onChange, disabled }: ControlProps) {
  return (
    <View pointerEvents={disabled ? 'none' : 'auto'} style={disabled ? styles.disabled : undefined}>
      <ChipRow>
        {/* 「未设置」等价于 Web 端 SelectMenu 的 clearable：把它置回空串 */}
        <Chip label="未设置" active={value === ''} onPress={() => onChange('')} />
        {(spec.options ?? []).map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={option.value === value}
            onPress={() => onChange(option.value)}
          />
        ))}
      </ChipRow>
    </View>
  );
}

/* ------------------------------ datetime --------------------------------- */

/** canonical `YYYY-MM-DDTHH:mm:ss` → 六段草稿；解析不出即全空（未设置） */
function splitDatetime(value: string): string[] {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  return matched ? matched.slice(1, 7) : ['', '', '', '', '', ''];
}

/** 六段草稿 → canonical；日期三段不齐即视为「未设置」（返回空串） */
function joinDatetime(parts: readonly string[]): string {
  const [year, month, day, hour = '', minute = '', second = ''] = parts;
  if (!/^\d{4}$/.test(year ?? '') || !month || !day) return '';
  const pad = (text: string, fallback: string) => (text === '' ? fallback : text.padStart(2, '0'));
  return `${year}-${pad(month, '01')}-${pad(day, '01')}T${pad(hour, '00')}:${pad(minute, '00')}:${pad(second, '00')}`;
}

/** 年月日 / 时分秒两行六段：EXIF 时间是墙钟时间，不做任何时区换算，因此只用数字输入 */
const DATE_PARTS = [
  { key: 'year', label: '年', max: 4, width: 52 },
  { key: 'month', label: '月', max: 2, width: 40 },
  { key: 'day', label: '日', max: 2, width: 40 },
] as const;
const TIME_PARTS = [
  { key: 'hour', label: '时', max: 2, width: 40 },
  { key: 'minute', label: '分', max: 2, width: 40 },
  { key: 'second', label: '秒', max: 2, width: 40 },
] as const;

function DatetimeControl({ value, onChange, disabled }: Omit<ControlProps, 'spec'>) {
  const [draft, setDraft] = useState<string[]>(() => splitDatetime(value));
  /* 外部改动（重新载入 / 被「清除」）才回灌草稿；自己打字产生的值不回灌，否则会打断输入 */
  const lastEmitted = useRef(value);
  useEffect(() => {
    if (value !== lastEmitted.current) setDraft(splitDatetime(value));
    lastEmitted.current = value;
  }, [value]);

  const update = (index: number, raw: string) => {
    const next = [...draft];
    next[index] = raw.replace(/\D/g, '');
    setDraft(next);
    const canonical = joinDatetime(next);
    lastEmitted.current = canonical;
    onChange(canonical);
  };

  return (
    <View style={styles.datetime}>
      <View style={styles.datetimeRow}>
        {DATE_PARTS.map((part, index) => (
          <Segment
            key={part.key}
            label={part.label}
            width={part.width}
            maxLength={part.max}
            value={draft[index] ?? ''}
            disabled={disabled}
            onChange={(text) => update(index, text)}
          />
        ))}
      </View>
      <View style={styles.datetimeRow}>
        {TIME_PARTS.map((part, offset) => (
          <Segment
            key={part.key}
            label={part.label}
            width={part.width}
            maxLength={part.max}
            value={draft[offset + 3] ?? ''}
            disabled={disabled}
            onChange={(text) => update(offset + 3, text)}
          />
        ))}
      </View>
    </View>
  );
}

function Segment({
  label,
  width,
  maxLength,
  value,
  disabled,
  onChange,
}: {
  label: string;
  width: number;
  maxLength: number;
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <View style={styles.segment}>
      {/* 秒段带 accent：可直观看出「此处可精确到秒」 */}
      <Text style={[styles.segmentLabel, label === '秒' && styles.segmentLabelAccent]}>{label}</Text>
      <TextInput
        style={[styles.input, styles.segmentInput, tabularNums, { width }]}
        value={value}
        editable={!disabled}
        maxLength={maxLength}
        keyboardType="number-pad"
        placeholder="00"
        placeholderTextColor={colors.text.quaternary}
        underlineColorAndroid="transparent"
        onChangeText={onChange}
      />
    </View>
  );
}

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  field: { gap: space.s6 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s8 },
  label: { ...text.caption, color: colors.text.tertiary, flexShrink: 1 },
  unit: { ...text.caption, color: colors.text.quaternary },
  hint: { ...text.meta, color: colors.text.quaternary },
  /** 「N 张值不一致」：只是一条提示，用中性三级色，不抢眼也不报警 */
  note: { ...text.meta, color: colors.text.tertiary },
  /** XMP/IPTC 容器字段的说明：说明它「为什么不能改」，不当作错误色处理 */
  blocked: { ...text.meta, color: colors.text.quaternary },
  dimmed: { opacity: 0.45 },

  clear: {
    paddingHorizontal: space.s8,
    paddingVertical: space.s2,
    borderRadius: radius.full,
    backgroundColor: colors.material.thin,
  },
  clearOn: { backgroundColor: colors.material.thick },
  clearDisabled: { opacity: 0.4 },
  clearText: { ...text.caption, color: colors.text.quaternary },
  clearTextOn: { color: colors.danger },
  pressed: { opacity: 0.7 },

  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },
  area: { height: size.button.md * 2, paddingTop: space.s8, textAlignVertical: 'top' },

  numberWrap: { gap: space.s6 },
  numberRow: { flexDirection: 'row', alignItems: 'center', gap: space.s12 },
  numberInput: { width: 96, textAlign: 'center' },
  /** 曝光值非法提示：红字一行，与清除按钮的 danger 同色（不新造视觉） */
  invalid: { ...text.meta, color: colors.danger },

  datetime: { gap: space.s6 },
  datetimeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s8 },
  segment: { alignItems: 'center', gap: space.s2 },
  segmentLabel: { ...text.meta, color: colors.text.quaternary },
  segmentLabelAccent: { color: colors.accent },
  segmentInput: { paddingHorizontal: space.s4, textAlign: 'center' },

  disabled: { opacity: 0.4 },
});
