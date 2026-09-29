/**
 * apps/admin/src/components/CustomTagEditor.tsx
 *
 * 自定义 tag 区块：规格清单（EXIF_FIELDS）之外的冷门 tag 在此处补写。
 *
 * 【为什么要前端先校验】后端只接受「字母开头，仅含字母/数字/下划线/冒号/点」的 tag
 * （tag 会直接拼进 exiftool 命令行，放行 `-foo` 等同于交出任意参数控制权），非法直接 400。
 * 前端用同一套规则先行拦截，用户无需等待一次失败请求即可获知填写错误。
 */
import { Button, Input } from 'antd';
import { EXIF_TAG_PATTERN, emptyExifCustomTagRow } from '@shaping-memory/core';
import type { CustomTagRow } from '@shaping-memory/core';

interface CustomTagEditorProps {
  rows: CustomTagRow[];
  onChange: (rows: CustomTagRow[]) => void;
  /** 规格清单里的 tag：重复时会覆盖上方表单字段，需要提示 */
  specTags: ReadonlySet<string>;
}

export function CustomTagEditor({ rows, onChange, specTags }: CustomTagEditorProps) {
  const patchRow = (key: string, patch: Partial<CustomTagRow>): void => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  return (
    <div>
      {rows.map((row) => {
        const invalid = row.tag !== '' && !EXIF_TAG_PATTERN.test(row.tag);
        const duplicated = !invalid && row.tag !== '' && specTags.has(row.tag);
        const error = invalid
          ? '需以字母开头，只能包含字母、数字、下划线、冒号、点'
          : duplicated
            ? '该项已在上方表单中，这里填写的值会覆盖上方'
            : null;
        return (
          <div key={row.key} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                style={{ flex: '0 0 220px' }}
                placeholder="参数名，如 XMP:Rating"
                value={row.tag}
                status={invalid ? 'error' : undefined}
                onChange={(event) => patchRow(row.key, { tag: event.target.value })}
              />
              <Input
                style={{ flex: 1 }}
                placeholder="参数值（留空表示清除）"
                value={row.value}
                onChange={(event) => patchRow(row.key, { value: event.target.value })}
              />
              <Button
                type="text"
                danger
                onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
              >
                删除
              </Button>
            </div>
            {error && (
              <div className="t-danger" style={{ fontSize: 11 }}>
                {error}
              </div>
            )}
          </div>
        );
      })}
      <Button type="dashed" block onClick={() => onChange([...rows, emptyExifCustomTagRow()])}>
        + 添加自定义参数
      </Button>
    </div>
  );
}
