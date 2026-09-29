/**
 * apps/admin/src/components/ExposureDualInput.tsx
 *
 * 曝光三要素（快门速度 / 光圈 / ISO）的「双输入」控件：左侧自由输入数值，右侧档位下拉。
 *
 * 【为什么合成一个受控组件，而不是两个 Form.Item】
 * AntD 的 Form.Item 只会把 value / onChange 注入给它的**直接子元素**。若把两个控件各自
 * 写成一个 Form.Item，表单里就会存在两份状态，保存时按 tag 取值必然不一致（下拉选了档位、
 * 输入框还是旧值，或反之）。这里让两个控件读写同一个 value，下拉只是「把 canonical 值写回
 * 同一字段」的快捷方式 —— 任何时刻都只有一份 state。
 *
 * 【为什么下拉 option.value 用 canonical 而不是 label】
 * 写进文件的值必须与 exiftool 的 -n 口径一致（`0.005` / `2.8` / `400`），
 * `1/200` `f/2.8` 这类只是给人看的 label；用 label 当 value 会污染「有没有改」的数值比较。
 *
 * 【为什么非法值只提示、不禁用保存】
 * 文件里本来就可能是档位表之外的合法值（如 1/16000），工具不该替用户做取舍；
 * 因此这里只在越界时给一行红字，保存路径与判重逻辑一概不动。
 */
import { Flex, InputNumber, Select } from 'antd';
import { EXIF_FIELDS, EXPOSURE_PRESETS, exposureKindOfTag, findExposurePreset, withinExposureRange } from '@shaping-memory/core';

interface ExposureDualInputProps {
  /** exiftool 短名（ExposureTime / FNumber / ISO），由它反查档位种类与字段规格 */
  tag: string;
  /** 档位下拉与自由输入共用：Form.Item 注入的数字；null = 留空（提交时清除该 tag） */
  value?: number | null;
  /** 档位下拉与自由输入共用：任一控件变更都写回同一个字段 */
  onChange?: (value: number | null) => void;
  disabled?: boolean;
}

export function ExposureDualInput({ tag, value, onChange, disabled }: ExposureDualInputProps) {
  // 非三要素 tag 不应进入此分支；直接不渲染，避免误用产生脏数据
  const kind = exposureKindOfTag(tag);
  if (!kind) return null;

  const spec = EXIF_FIELDS.find((field) => field.tag === tag);
  const presets = EXPOSURE_PRESETS[kind];
  // 当前值命中的档位；手输的非档位值无法命中，下拉就回落到占位「自定义」
  const matched = value == null ? null : findExposurePreset(kind, String(value));

  // 越界提示（档位表只是「常用范围」，不是写入的硬约束，所以只提示不拦截）
  const rangeText = `${presets[0].label} ~ ${presets[presets.length - 1].label}`;
  const hint =
    value != null && value <= 0
      ? '数值必须大于 0'
      : value != null && !withinExposureRange(kind, String(value))
        ? `超出常用档位范围（${rangeText}），仍会按输入值保存`
        : null;

  return (
    <Flex vertical gap={2}>
      <Flex gap={8}>
        <InputNumber
          style={{ flex: 1, minWidth: 0 }}
          placeholder={spec?.placeholder}
          min={spec?.min}
          max={spec?.max}
          step={spec?.step}
          // 单位走 suffix：addonAfter / addonBefore 在 AntD 5 已弃用并会打出警告
          suffix={spec?.unit}
          disabled={disabled}
          value={value ?? null}
          onChange={(next) => onChange?.(next ?? null)}
        />
        <Select
          showSearch
          optionFilterProp="label"
          // 固定宽度：档位文案长度接近（1/8000、f/2.8、25600），无需自适应调整
          style={{ flex: '0 0 120px' }}
          placeholder="自定义"
          disabled={disabled}
          // 命中档位时显示档位；未命中（手输的非档位值）显示占位「自定义」
          value={matched?.value}
          options={presets.map((preset) => ({ value: preset.value, label: preset.label }))}
          // 选档位 → 写回 canonical 数值，与手输落到同一个字段、同一种形态
          onChange={(next: string) => onChange?.(Number(next))}
        />
      </Flex>
      {hint && (
        <div className="t-danger" style={{ fontSize: 11 }}>
          {hint}
        </div>
      )}
    </Flex>
  );
}