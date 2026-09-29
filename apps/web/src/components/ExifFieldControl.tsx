/**
 * apps/web/src/components/ExifFieldControl.tsx
 *
 * EXIF 单个字段的控件分派 —— 按 core `EXIF_FIELDS` 里的 `type` 选前台对应的控件。
 *
 * 【为什么不引 antd】前台的设计体系是自研 CSS token（apps/web/src/styles/app.css），
 * 后台的 6 种控件（Input/TextArea/InputNumber/Select/DatePicker/Tags）在这里
 * 用同语义的前台基元重做一遍：视觉走前台风格，**功能参数与处理逻辑与后台完全一致**。
 *
 * 【number 为什么用 type="text" 而不是 type="number"】`<input type="number">` 在输入
 * `-`、`1.` 这类中间态时 `.value` 会返回空串，负海拔 / 小数无法设定。因此这里保持
 * 「字符串进、字符串出」，越界由提交前的范围校验拦（等价于后台 InputNumber 的 min/max）。
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { exposureKindOfTag } from '@shaping-memory/core';
import type { ExifField } from '@shaping-memory/core';

import { Icon } from './Icon';
import { SelectMenu } from './Combobox';
import { ExposureInput } from './ExposureInput';

/* -------------------------------------------------------------------------- */
/* 多值 tag 输入（对应后台的 Select mode="tags"）                               */
/* -------------------------------------------------------------------------- */

interface TagInputProps {
  /** canonical 文本（", " 拼接）；空串 = 无标签 */
  text: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function TagInput({ text, onChange, disabled, placeholder }: TagInputProps) {
  /** 尚未回车确认的草稿：只在本地存，避免半截输入被写进提交值 */
  const [draft, setDraft] = useState('');
  const tags = text === '' ? [] : text.split(', ');

  const commit = (raw: string): void => {
    const next = raw.trim();
    if (next === '') return;
    onChange([...tags, next].join(', '));
  };

  const removeAt = (index: number): void => {
    onChange(tags.filter((_, i) => i !== index).join(', '));
  };

  return (
    <div className={`exif-tags${disabled ? ' is-disabled' : ''}`}>
      {tags.map((tag, index) => (
        <span className="chip chip--removable" key={`${tag}-${index}`}>
          {tag}
          <button
            type="button"
            className="exif-tags__remove"
            aria-label={`移除「${tag}」`}
            disabled={disabled}
            onClick={() => removeAt(index)}
          >
            <Icon name="close" />
          </button>
        </span>
      ))}
      <input
        className="exif-tags__input"
        value={draft}
        disabled={disabled}
        placeholder={tags.length === 0 ? (placeholder ?? '输入后回车添加') : ''}
        onChange={(event) => {
          const raw = event.target.value;
          // 半角 / 全角逗号都当作「确认这个标签」
          if (raw.endsWith(',') || raw.endsWith('，')) {
            commit(raw.slice(0, -1));
            setDraft('');
            return;
          }
          setDraft(raw);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(draft);
            setDraft('');
            return;
          }
          // 空草稿时按退格 = 撤掉最后一个标签（与后台 Tags 组件的交互反馈一致）
          if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
            removeAt(tags.length - 1);
          }
        }}
        onBlur={() => {
          commit(draft);
          setDraft('');
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 字段外壳 + 控件分派                                                          */
/* -------------------------------------------------------------------------- */

interface ExifFieldControlProps {
  spec: ExifField;
  /** canonical 文本形态的值（见 core exif-values.ts） */
  value: string;
  onChange: (value: string) => void;
  /** 清空草稿：保存时该 tag 会从文件里删除 */
  onClear: () => void;
  disabled?: boolean;
}

export function ExifFieldControl({ spec, value, onChange, onClear, disabled }: ExifFieldControlProps) {
  // textarea 与 tags 内容较长，在栅格里占满整行
  const wide = spec.type === 'textarea' || spec.type === 'tags';

  const control = (): ReactElement => {
    switch (spec.type) {
      case 'textarea': {
        return (
          <textarea
            className="search-input edit-dialog__area"
            rows={2}
            value={value}
            placeholder={spec.placeholder ?? '请输入'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      }
      case 'number': {
        // 曝光三要素（ExposureTime / FNumber / ISO）换成「自由输入 + 档位下拉」的双输入控件：
        // 用户既能按摄影习惯写 `1/200`、`f/2.8`，也能直接选标准档位；
        // 控件对外仍回调 canonical（十进制秒 / f 数 / ISO 整数），与保存链路的
        // Number 校验、exifSameText 比对、exifTextToSubmit 提交天然兼容。
        // 【为什么按 tag 而非 type 判断】这三个与 Rating、GPSImgDirection 等同为 number，
        // 只有它们有专属档位表，其余 number 字段必须保持原来的纯文本输入。
        const exposureKind = exposureKindOfTag(spec.tag);
        if (exposureKind) {
          return (
            <ExposureInput
              kind={exposureKind}
              value={value}
              ariaLabel={spec.label}
              placeholder={spec.placeholder}
              disabled={disabled}
              onChange={onChange}
            />
          );
        }
        return (
          <input
            className="search-input"
            type="text"
            inputMode="decimal"
            value={value}
            placeholder={spec.placeholder ?? '请输入'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      }
      case 'select':
        return (
          <SelectMenu
            ariaLabel={spec.label}
            value={value}
            options={(spec.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
            placeholder="未设置"
            clearable
            disabled={disabled}
            onChange={onChange}
          />
        );
      case 'datetime':
        // 原生控件直接吃 canonical 文本 YYYY-MM-DDTHH:mm:ss；step=1 打开秒位
        return (
          <input
            className="search-input"
            type="datetime-local"
            step={1}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      case 'tags':
        return (
          <TagInput text={value} placeholder={spec.placeholder} disabled={disabled} onChange={onChange} />
        );
      default:
        return (
          <input
            className="search-input"
            value={value}
            placeholder={spec.placeholder ?? '请输入'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        );
    }
  };

  return (
    <div className={`exif-field${wide ? ' exif-field--wide' : ''}`}>
      <div className="exif-field__head">
        <span className="exif-field__label">
          {spec.label}
          {spec.unit ? <em className="edit-dialog__unit"> {spec.unit}</em> : null}
        </span>
        <button
          type="button"
          className="edit-dialog__clear-tag"
          disabled={disabled || value === ''}
          title="清空该项，保存后将从这张照片中移除"
          onClick={onClear}
        >
          清除
        </button>
      </div>
      {control()}
      {spec.hint ? <p className="exif-field__hint">{spec.hint}</p> : null}
    </div>
  );
}