/**
 * apps/web/src/components/ExposureInput.tsx
 *
 * 曝光三要素（快门 / 光圈 / ISO）的「双输入」控件：左边自由输入、右边档位下拉。
 *
 * 【为什么单做一个控件】前台查看器的编辑弹窗与工具模块的本地工作台都要这一套，
 * 但两处的字段外壳完全不同（一个是单张全量表单、一个是多张三态草稿）——
 * 把「怎么写、怎么解析、档位怎么选、错了怎么提示」收在控件内部，两处只剩外壳差异。
 *
 * 【为什么显示文本与提交值要分开】用户看到的是摄影习惯写法（`1/200`、`f/2.8`），
 * 而写入文件、判断「有没有改」用的是 canonical（十进制秒 `0.005`、f 数 `2.8`）。
 * 两者解耦，界面才既好看又不会把「改了」判成「没改」。
 */
import { useEffect, useState } from 'react';
import type { ExposureKind } from '@shaping-memory/core';
import { EXPOSURE_PRESETS, canonicalExposureText, exposureLabelOf, findExposurePreset, withinExposureRange } from '@shaping-memory/core';

import { SelectMenu } from './Combobox';

interface ExposureInputProps {
  kind: ExposureKind;
  /** canonical 值（十进制秒 / f 数 / ISO 整数）；空串 = 未设置 */
  value: string;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
  /** 每次输入都回调 canonical 值；解析不出时回调空串 */
  onChange: (value: string) => void;
}

/** canonical → 输入框里给人看的文本 */
function displayOf(kind: ExposureKind, value: string): string {
  return value === '' ? '' : exposureLabelOf(kind, value);
}

export function ExposureInput({ kind, value, ariaLabel, disabled = false, placeholder, onChange }: ExposureInputProps) {
  const [text, setText] = useState(() => displayOf(kind, value));

  /**
   * 外部值变了（切换选中照片、选档位、撤销改动）就同步回输入框。
   * 【为什么要比一次 canonical】用户手输 `0.005` 时 canonical 就等于 value，
   * 不比就会把用户正在敲的文本改成 `1/200`，光标也会跳。
   */
  useEffect(() => {
    setText((prev) => (canonicalExposureText(kind, prev) === value ? prev : displayOf(kind, value)));
  }, [kind, value]);

  const presets = EXPOSURE_PRESETS[kind].map((preset) => ({ value: preset.value, label: preset.label }));
  const matched = findExposurePreset(kind, value);

  // 输入非空却解析不出 → 明确报错；解析得出但超出档位覆盖范围 → 只提示，不阻断
  const invalid = text.trim() !== '' && canonicalExposureText(kind, text) === '';
  const outOfRange = !invalid && value !== '' && !withinExposureRange(kind, value);

  const handleText = (next: string): void => {
    setText(next);
    onChange(canonicalExposureText(kind, next));
  };

  // 选档位：输入框落成摄影习惯写法，提交值仍是 canonical
  const handlePreset = (next: string): void => {
    setText(displayOf(kind, next));
    onChange(next);
  };

  return (
    <div className="exposure-input">
      <input
        className={`search-input${invalid ? ' is-invalid' : ''}`}
        value={text}
        placeholder={placeholder ?? '留空表示不修改'}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        onChange={(event) => handleText(event.target.value)}
      />
      <SelectMenu
        ariaLabel={`${ariaLabel}档位`}
        value={matched?.value ?? ''}
        options={presets}
        placeholder="档位"
        disabled={disabled}
        onChange={handlePreset}
      />
      {invalid ? (
        <p className="exposure-input__error">请输入数字，或 1/200、2"、f/2.8 这类写法</p>
      ) : outOfRange ? (
        <p className="exposure-input__note">超出常用档位范围，仍会按所输入的值写入</p>
      ) : null}
    </div>
  );
}