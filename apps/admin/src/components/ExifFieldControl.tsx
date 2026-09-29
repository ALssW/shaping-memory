/**
 * apps/admin/src/components/ExifFieldControl.tsx
 *
 * 单个 EXIF 字段的表单项：按 ExifField.type 映射到 AntD 控件。
 *
 * 例外：曝光三要素（ExposureTime / FNumber / ISO）虽然同为 number，
 * 但要额外给一路档位下拉，交给 ExposureDualInput 处理（见 controlOf）。
 *
 * 【值一律原样进出】读写都带 exiftool 的 -n，所以 select 的 option.value
 * 就是数字字符串（WhiteBalance 的 "1"），提交时也原样回传，不做任何「还原为可读文本」的转换。
 * label / hint / placeholder / min / max / step / unit 全部来自 packages/core 的字段规格。
 */
import type { ReactNode } from 'react';
import { Button, DatePicker, Form, Input, InputNumber, Select } from 'antd';
import { exposureKindOfTag } from '@shaping-memory/core';
import type { ExifField } from '@shaping-memory/core';

import { ExposureDualInput } from './ExposureDualInput';

interface ExifFieldControlProps {
  spec: ExifField;
  /** 点「清除」：把该字段置为 null 提交（后端会删掉这个 tag） */
  onClear: (tag: string) => void;
}

/** 按字段类型选控件 */
function controlOf(spec: ExifField): ReactNode {
  // 曝光三要素用「自由输入 + 档位下拉」双输入；其余 number 字段保持原来的单输入框
  if (exposureKindOfTag(spec.tag)) return <ExposureDualInput tag={spec.tag} />;
  switch (spec.type) {
    case 'textarea':
      return <Input.TextArea rows={2} placeholder={spec.placeholder} allowClear />;
    case 'number':
      return (
        <InputNumber
          style={{ width: '100%' }}
          placeholder={spec.placeholder}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          // 单位走 suffix：addonAfter / addonBefore 在 AntD 5 已弃用并会打出警告
          suffix={spec.unit}
        />
      );
    case 'select':
      return (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={spec.placeholder ?? '请选择'}
          options={(spec.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
        />
      );
    case 'datetime':
      return <DatePicker showTime style={{ width: '100%' }} format="YYYY-MM-DD HH:mm:ss" />;
    case 'tags':
      return <Select mode="tags" placeholder="输入后回车添加" tokenSeparators={[',', '，']} />;
    default:
      return <Input placeholder={spec.placeholder} allowClear />;
  }
}

export function ExifFieldControl({ spec, onClear }: ExifFieldControlProps) {
  return (
    <Form.Item
      name={spec.tag}
      style={{ marginBottom: 12 }}
      extra={spec.hint ? <span style={{ fontSize: 11 }}>{spec.hint}</span> : undefined}
      label={
        <span className="exif-field-head">
          <span>{spec.label}</span>
          <Button
            type="text"
            size="small"
            className="exif-field-head__clear"
            onClick={() => onClear(spec.tag)}
          >
            清除
          </Button>
        </span>
      }
    >
      {controlOf(spec)}
    </Form.Item>
  );
}
