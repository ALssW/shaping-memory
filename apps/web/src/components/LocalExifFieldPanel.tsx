/**
 * apps/web/src/components/LocalExifFieldPanel.tsx
 *
 * 工作台的参数面板：按 core `exifFieldsByGroup()` 的 7 组分区、组可折叠地渲染全部字段。
 *
 * 【分组来自 core 而不是本地再排一遍】字段清单与分组是单一事实源，
 * 这里只负责「取分组 → 取该组字段 → 交给字段控件」，避免两处清单不一致。
 */
import { useMemo } from 'react';
import { EXIF_FIELDS, exifFieldsByGroup } from '@shaping-memory/core';
import type { ExifField, ExifGroup } from '@shaping-memory/core';

import { SKIP_DRAFT, containerOnlyOf } from '../lib/localExif';
import type { DraftMerge, FieldDraft, FieldSummary, GpsSummary, LocalExifItem } from '../lib/localExif';
import { Icon } from './Icon';
import { LocalExifFieldControl } from './LocalExifFieldControl';
import { LocalExifGpsBlock } from './LocalExifGpsBlock';

/** 地图选位区块挂在这一组下面：经纬度不在 EXIF_FIELDS 里，由它单独承担 */
const GPS_GROUP: ExifGroup = '地理位置';

interface LocalExifFieldPanelProps {
  /** 已勾选的可编辑项（整对象：定位区块要读每张已有的 GPS，不只是数量） */
  activeItems: readonly LocalExifItem[];
  summaries: ReadonlyMap<string, FieldSummary>;
  gpsSummary: GpsSummary;
  drafts: Record<string, FieldDraft>;
  onFieldChange: (spec: ExifField, text: string) => void;
  onFieldClear: (spec: ExifField) => void;
  onFieldReset: (spec: ExifField) => void;
  /** 直接按 tag 合并草稿：地图选点一次要落 GPSLatitude / GPSLongitude 两条，走不了「一个 spec」的入口 */
  onMergeDrafts: (merge: DraftMerge) => void;
}

export function LocalExifFieldPanel({
  activeItems,
  summaries,
  gpsSummary,
  drafts,
  onFieldChange,
  onFieldClear,
  onFieldReset,
  onMergeDrafts,
}: LocalExifFieldPanelProps) {
  const groups = useMemo(() => exifFieldsByGroup(), []);
  const activeCount = activeItems.length;

  if (activeCount === 0) {
    return (
      <p className="localexif-empty">
        在左侧勾选照片后，这里会列出全部 {EXIF_FIELDS.length} 项可编辑内容。留空表示不修改，「清除」表示导出时从照片中移除该项。
      </p>
    );
  }

  return (
    <div className="localexif-panel">
      <p className="edit-dialog__hint">
        留空 = 不修改该项；点「清除」= 导出时从照片中移除该项，两者含义不同。编辑内容会应用到当前勾选的全部照片。
      </p>
      {groups.map(([group, fields]) => (
        <details className="exif-group" key={group} open>
          <summary className="exif-group__summary">
            {group}
            <span className="exif-group__count">{fields.length}</span>
            <span className="exif-group__caret" aria-hidden="true">
              <Icon name="chevron" />
            </span>
          </summary>
          {group === GPS_GROUP ? (
            <LocalExifGpsBlock
              summary={gpsSummary}
              drafts={drafts}
              selectedCount={activeCount}
              onMergeDrafts={onMergeDrafts}
            />
          ) : null}
          <div className="exif-grid">
            {fields.map((spec) => (
              <LocalExifFieldControl
                key={spec.tag}
                spec={spec}
                draft={drafts[spec.tag] ?? SKIP_DRAFT}
                summary={summaries.get(spec.tag) ?? { base: '', distinct: 0, inconsistent: false, present: false }}
                selectedCount={activeCount}
                containerNote={containerOnlyOf(spec.tag)}
                onChange={(text) => onFieldChange(spec, text)}
                onClear={() => onFieldClear(spec)}
                onReset={() => onFieldReset(spec)}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
