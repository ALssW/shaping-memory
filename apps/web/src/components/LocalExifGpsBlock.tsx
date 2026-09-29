/**
 * apps/web/src/components/LocalExifGpsBlock.tsx
 *
 * 本地 EXIF 工作台里的「地图选位」区块 —— 与后台 ExifDrawer 的定位区同一套交互与读数。
 *
 * 【为什么要单独一块】经纬度不在 core 的 `EXIF_FIELDS` 里（它们是「地图点出来的」而不是
 * 「一个字段一个值」），所以它没法走通用的字段控件；但它是工作台唯一能一次改多个 tag 的地方，
 * 于是外壳单独写，地图本体仍复用与后台同源的 `GpsPicker`。
 *
 * 【坐标系铁律】区块内部只认 WGS-84：GpsPicker 负责底图换算，这里落草稿的永远是 WGS-84。
 */
import { useState } from 'react';
import { formatLatLon } from '@shaping-memory/core';
import type { GeoPoint } from '@shaping-memory/core';

import { draftGpsPoint, gpsDraftMerge, gpsDraftReset } from '../lib/localExif';
import type { DraftMerge, FieldDraft, GpsSummary } from '../lib/localExif';
import { GpsPicker } from './GpsPicker';
import type { BasemapKey } from './GpsPicker';

interface LocalExifGpsBlockProps {
  summary: GpsSummary;
  drafts: Record<string, FieldDraft>;
  /** 已勾选的可编辑张数（用于「N 张定位不一致」文案） */
  selectedCount: number;
  onMergeDrafts: (merge: DraftMerge) => void;
}

export function LocalExifGpsBlock({ summary, drafts, selectedCount, onMergeDrafts }: LocalExifGpsBlockProps) {
  // 底图选择是纯视图偏好，不进草稿 —— 切底图不该产生「待应用的改动」
  const [basemap, setBasemap] = useState<BasemapKey>('amap');
  const { point, pending } = draftGpsPoint(drafts, summary.base);
  // 「清除定位」要有意义：文件里本来有定位，或用户刚选了点
  const canClear = summary.present || point !== null;

  return (
    <div className="localexif-gps">
      <div className="localexif-gps__head">
        <span className="localexif-gps__label">地图选位（写入经纬度）</span>
        <div className="localexif-field__meta">
          {summary.inconsistent ? (
            <span className="localexif-badge" title={`已选 ${selectedCount} 张，定位不完全相同`}>
              {selectedCount} 张定位不一致
            </span>
          ) : null}
          {pending && point ? (
            <span className="localexif-badge is-on">将写入 {formatLatLon(point.lat, point.lon, 5)}</span>
          ) : null}
          {pending && !point ? <span className="localexif-badge is-danger">将清除定位</span> : null}
          <button
            type="button"
            className="edit-dialog__clear-tag"
            disabled={!canClear}
            title="清除定位：导出时从照片中移除位置信息"
            onClick={() => onMergeDrafts(gpsDraftMerge(null))}
          >
            清除定位
          </button>
          <button
            type="button"
            className="edit-dialog__clear-tag"
            disabled={!pending}
            title="撤回定位改动，回到「不修改」"
            onClick={() => onMergeDrafts(gpsDraftReset())}
          >
            撤销
          </button>
        </div>
      </div>
      <GpsPicker
        point={point}
        savedGps={summary.base}
        basemap={basemap}
        onPointChange={(next: GeoPoint) => onMergeDrafts(gpsDraftMerge(next))}
        onBasemapChange={setBasemap}
      />
    </div>
  );
}