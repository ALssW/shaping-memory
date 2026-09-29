/**
 * apps/web/src/components/LocalExifFieldControl.tsx
 *
 * 本地 EXIF 工作台里单个字段的控件分派 —— 按 core `EXIF_FIELDS` 的 type 选控件。
 *
 * 【为什么不复用 EditDialog 的 ExifFieldControl】那张表单是「单张照片、值来自服务端」，
 * 一个字段只有一个值；工作台是「多张、值可能各不相同」，还要表达三态（不修改 / 写入 / 清除），
 * 外壳与语义都要重写。只有 datetime / select 的控件参数与之保持一致，避免两端交互反馈不一致。
 */
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { exposureKindOfTag } from '@shaping-memory/core';
import type { ExifField } from '@shaping-memory/core';

import { cleanNumberText, numberRange } from '../lib/localExif';
import type { FieldDraft, FieldSummary } from '../lib/localExif';
import { SelectMenu } from './Combobox';
import { ExposureInput } from './ExposureInput';

interface LocalExifFieldControlProps {
  spec: ExifField;
  draft: FieldDraft;
  summary: FieldSummary;
  /** 当前选中（可编辑）张数：用于「N 张值不一致」文案 */
  selectedCount: number;
  /** 非空 = 该字段属 XMP / IPTC 容器，本工具写不了，置灰并说明 */
  containerNote: string | null;
  onChange: (text: string) => void;
  onClear: () => void;
  onReset: () => void;
}

export function LocalExifFieldControl({
  spec,
  draft,
  summary,
  selectedCount,
  containerNote,
  onChange,
  onClear,
  onReset,
}: LocalExifFieldControlProps) {
  const disabled = containerNote !== null;
  // textarea 与 tags 内容长，在栅格里占满整行
  const wide = spec.type === 'textarea' || spec.type === 'tags';
  // 滑块区间只依赖字段规格与「文件里的公共值」，不依赖草稿 —— 否则拖动会自反馈（见 lib 注释）
  const range = useMemo(() => numberRange(spec, summary.base), [spec, summary.base]);

  // 显示值：写入态用草稿，清除态为空，其余显示公共值；不一致时为空，绝不冒充第一张的值
  const shown = draft.action === 'set' ? draft.text : draft.action === 'clear' ? '' : summary.base;

  // 曝光三要素走「自由输入 + 档位下拉」双输入：滑块对 1/8000 ~ 900 这种跨量级区间没有意义
  const exposureKind = exposureKindOfTag(spec.tag);

  const control = (): ReactElement => {
    if (exposureKind !== null) {
      return (
        <ExposureInput
          kind={exposureKind}
          value={shown}
          ariaLabel={spec.label}
          disabled={disabled}
          onChange={onChange}
        />
      );
    }
    switch (spec.type) {
      case 'textarea':
        return (
          <textarea
            className="search-input edit-dialog__area"
            rows={2}
            value={shown}
            placeholder={spec.placeholder ?? '留空表示不修改'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      case 'number': {
        const parsed = Number(shown);
        const sliderValue = Number.isFinite(parsed) ? Math.min(Math.max(parsed, range.min), range.max) : range.min;
        return (
          <div className="localexif-number">
            <input
              className="localexif-number__range"
              type="range"
              aria-label={`${spec.label} 滑块`}
              title={`滑块范围 ${range.min} ~ ${range.max}`}
              min={range.min}
              max={range.max}
              step={range.step}
              value={sliderValue}
              disabled={disabled}
              onChange={(event) => onChange(cleanNumberText(event.target.value))}
            />
            <input
              className="search-input localexif-number__input"
              type="number"
              inputMode="decimal"
              step={range.step}
              min={spec.min}
              max={spec.max}
              value={shown}
              placeholder="不修改"
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
            />
            <span className="localexif-number__bounds">
              {range.min} ~ {range.max}
            </span>
          </div>
        );
      }
      case 'select':
        return (
          <SelectMenu
            ariaLabel={spec.label}
            value={shown}
            options={(spec.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
            placeholder={summary.inconsistent ? '多张取值不同' : '未设置'}
            clearable
            disabled={disabled}
            // 下拉的「清空」按钮 = 明确的删除该 tag，因此走 onClear 而不是「留空」
            onChange={(value) => (value === '' ? onClear() : onChange(value))}
          />
        );
      case 'datetime':
        // 原生控件直接吃 canonical 文本 YYYY-MM-DDTHH:mm:ss；step=1 打开秒位
        return (
          <input
            className="search-input"
            type="datetime-local"
            step={1}
            value={shown}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      case 'tags':
        return (
          <input
            className="search-input"
            value={shown}
            placeholder={spec.placeholder ?? '多个值用半角逗号分隔'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      default:
        return (
          <input
            className="search-input"
            value={shown}
            placeholder={spec.placeholder ?? '留空表示不修改'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
    }
  };

  return (
    <div
      className={`exif-field${wide ? ' exif-field--wide' : ''}${disabled ? ' is-disabled' : ''}${
        summary.inconsistent ? ' is-inconsistent' : ''
      }`}
    >
      <div className="exif-field__head">
        <span className="exif-field__label">
          {spec.label}
          {spec.unit ? <em className="edit-dialog__unit"> {spec.unit}</em> : null}
        </span>
        <div className="localexif-field__meta">
          {summary.inconsistent ? (
            <span className="localexif-badge" title={`已选 ${selectedCount} 张，取值不完全相同`}>
              {selectedCount} 张值不一致
            </span>
          ) : null}
          {draft.action === 'clear' ? <span className="localexif-badge is-danger">将清除</span> : null}
          {draft.action === 'set' ? <span className="localexif-badge is-on">将修改</span> : null}
          <button
            type="button"
            className="edit-dialog__clear-tag"
            disabled={disabled || !summary.present}
            title="清除该项：导出时从照片中移除这项"
            onClick={onClear}
          >
            清除
          </button>
          <button
            type="button"
            className="edit-dialog__clear-tag"
            disabled={disabled || draft.action === 'skip'}
            title="撤回这项改动，回到「不修改」"
            onClick={onReset}
          >
            撤销
          </button>
        </div>
      </div>
      {control()}
      {containerNote ? (
        <p className="exif-field__note">本工具暂不支持修改这项内容，它会随照片原样保留</p>
      ) : spec.hint ? (
        <p className="exif-field__hint">{spec.hint}</p>
      ) : null}
    </div>
  );
}
