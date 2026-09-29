/**
 * apps/admin/src/components/ExifGroupFields.tsx
 *
 * 一组 EXIF 字段的栅格布局（两列，多行文本占满一行）。
 * Form.Item 直接从 Form 上下文取实例，所以这里不需要传 form。
 */
import { Col, Row } from 'antd';
import type { ExifField } from '@shaping-memory/core';

import { ExifFieldControl } from './ExifFieldControl';

interface ExifGroupFieldsProps {
  fields: readonly ExifField[];
  onClear: (tag: string) => void;
}

export function ExifGroupFields({ fields, onClear }: ExifGroupFieldsProps) {
  return (
    <Row gutter={[16, 0]}>
      {fields.map((spec) => (
        <Col span={spec.type === 'textarea' ? 24 : 12} key={spec.tag}>
          <ExifFieldControl spec={spec} onClear={onClear} />
        </Col>
      ))}
    </Row>
  );
}
