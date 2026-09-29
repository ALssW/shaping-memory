/**
 * apps/web/src/components/BatchEditDialog.tsx
 *
 * 批量编辑（admin 前台专属）：把同一份补丁套到选中的每张照片上。
 * 元数据走 photoApi.updateBatch（共享补丁，只提交填写过的项），
 * EXIF 走 exifApi.updateBatch（共享 tag 补丁 + 标记清除，未标记的 tag 不动）。
 *
 * 【与后台 BatchMetaModal / BatchExifDrawer 同语义】留空的项保持原值；
 * EXIF 的「标记清除」提交 null 删除该 tag，否则填了才写、没填不动。
 * 批量 tag 范围也与后台 FIELD_KEYS 一致：时间 / 机身 / 镜头。
 */
import { useState } from 'react';
import { EXIF_SCOPE_CLASS, exifTextToSubmit, fromWgs84, isValidLatLon } from '@shaping-memory/core';
import type { GeoPoint } from '@shaping-memory/core';
import { exifApi, photoApi } from '@shaping-memory/sdk';
import type { ExifPatch, PhotoPatch } from '@shaping-memory/sdk';

import { Icon } from './Icon';
import { BASEMAPS, GpsPicker } from './GpsPicker';
import type { BasemapKey } from './GpsPicker';

/** 批量可统一的 EXIF tag（与后台 BatchExifDrawer 一致：时间 / 机身 / 镜头） */
const BATCH_EXIF_TAGS = ['DateTimeOriginal', 'Model', 'LensModel'] as const;
const BATCH_EXIF_LABEL: Record<(typeof BATCH_EXIF_TAGS)[number], string> = {
  DateTimeOriginal: '拍摄时间',
  Model: '机身型号',
  LensModel: '镜头型号',
};

const PRIVACY_LABEL: Record<NonNullable<PhotoPatch['privacy']>, string> = {
  inherit: '跟随默认',
  visible: '公开',
  blur: '模糊',
  hidden: '隐藏',
};

interface BatchEditDialogProps {
  /** 本次要改的照片数量 / id 列表 */
  ids: string[];
  /** 分类候选 */
  categories: readonly string[];
  onClose: () => void;
  /** 保存成功（父级清空选中并重拉） */
  onDone: () => void;
}

export function BatchEditDialog({ ids, categories, onClose, onDone }: BatchEditDialogProps) {
  // 元数据：空 = 不修改
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [likes, setLikes] = useState('');

  // EXIF：值 + 标记清除（三态：清除 > 填值 > 不动）
  const [exifValues, setExifValues] = useState<Record<string, string>>({});
  const [clears, setClears] = useState<Record<string, boolean>>({});

  // 定位：统一设置 / 统一清除 / 不动
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>('amap');
  const [gpsCleared, setGpsCleared] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    // 元数据补丁：只提交填写过的项
    const metaPatch: PhotoPatch = {};
    if (category) metaPatch.category = category;
    if (tags.trim() !== '') metaPatch.tags = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    if (privacy) metaPatch.privacy = privacy as NonNullable<PhotoPatch['privacy']>;
    if (likes !== '') metaPatch.likes = Math.max(0, Number(likes) || 0);

    // EXIF 补丁：标记清除提交 null，填了值提交值，两者都没有则该 tag 不进补丁
    const fieldPatch: Record<string, string | null> = {};
    for (const tag of BATCH_EXIF_TAGS) {
      if (clears[tag]) {
        fieldPatch[tag] = null;
        continue;
      }
      const value = (exifValues[tag] ?? '').trim();
      if (value === '') continue;
      if (tag === 'DateTimeOriginal') {
        // datetime 经 core 规范化成 exiftool 口径；解析不出（不该发生）按清处理
        const normalized = exifTextToSubmit('datetime', value);
        fieldPatch[tag] = typeof normalized === 'string' ? normalized : null;
        continue;
      }
      fieldPatch[tag] = value;
    }
    const exifPatch: ExifPatch = {};
    if (Object.keys(fieldPatch).length > 0) exifPatch.fields = fieldPatch;

    if (gpsCleared) {
      exifPatch.gps = null;
    } else if (point && isValidLatLon(point.lat, point.lon)) {
      // 与后台一致：提交「底图原始坐标 + 坐标系」，坐标系归一由后端统一完成
      const baseConfig = BASEMAPS[basemap];
      const basePoint = fromWgs84(point, baseConfig.crs);
      exifPatch.gps = { lat: basePoint.lat, lon: basePoint.lon };
      exifPatch.crs = baseConfig.crs;
    }

    if (Object.keys(metaPatch).length === 0 && !exifPatch.fields && exifPatch.gps === undefined) {
      setError('尚未填写要修改的内容');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (Object.keys(metaPatch).length > 0) await photoApi.updateBatch(ids, metaPatch);
      if (exifPatch.fields || exifPatch.gps !== undefined) await exifApi.updateBatch(ids, exifPatch);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量修改失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`edit-dialog edit-dialog--wide ${EXIF_SCOPE_CLASS}`} role="dialog" aria-label="批量编辑">
      <header className="edit-dialog__head">
        <h2 className="edit-dialog__title">批量编辑（已选 {ids.length} 张）</h2>
        <button type="button" className="search-panel__close" aria-label="关闭批量编辑" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <div className="edit-dialog__body">
        <p className="edit-dialog__hint">仅修改已填写过的项，留空的内容保持原样。拍摄参数只更新数据库记录，照片文件保持原样。</p>

        <h3 className="edit-dialog__section">照片信息（统一设置）</h3>
        <label className="search-field">
          <span className="search-field__label">分类</span>
          <select className="search-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">不修改分类</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="search-field">
          <span className="search-field__label">标签（逗号分隔）</span>
          <input className="search-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="清空后保存，即清掉这批照片的标签" />
        </label>
        <label className="search-field">
          <span className="search-field__label">隐私标记</span>
          <select className="search-input" value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
            <option value="">不修改隐私标记</option>
            {(Object.keys(PRIVACY_LABEL) as Array<NonNullable<PhotoPatch['privacy']>>).map((value) => (
              <option key={value} value={value}>
                {PRIVACY_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="search-field">
          <span className="search-field__label">点赞数</span>
          <input className="search-input" type="number" min={0} step={1} value={likes} onChange={(e) => setLikes(e.target.value)} placeholder="不修改点赞数" />
        </label>

        <h3 className="edit-dialog__section">拍摄参数（统一更新记录）</h3>
        {BATCH_EXIF_TAGS.map((tag) => (
          <label className="search-field" key={tag}>
            <span className="search-field__label">
              {BATCH_EXIF_LABEL[tag]}
              <button
                type="button"
                className={clears[tag] ? 'edit-dialog__clear-tag is-on' : 'edit-dialog__clear-tag'}
                onClick={() => setClears((prev) => ({ ...prev, [tag]: !prev[tag] }))}
              >
                {clears[tag] ? '已标记清除，点此取消' : '清除该项'}
              </button>
            </span>
            <input
              className="search-input"
              // 拍摄时间用原生 datetime-local（EXIF 时间是无时区墙钟时间，不做任何时区换算）
              type={tag === 'DateTimeOriginal' ? 'datetime-local' : 'text'}
              step={tag === 'DateTimeOriginal' ? 1 : undefined}
              value={exifValues[tag] ?? ''}
              disabled={clears[tag]}
              onChange={(e) => setExifValues((prev) => ({ ...prev, [tag]: e.target.value }))}
              placeholder={tag === 'DateTimeOriginal' ? '' : `统一设置为这个${BATCH_EXIF_LABEL[tag]}`}
            />
          </label>
        ))}

        <h4 className="edit-dialog__section">定位（统一设置）</h4>
        <label className="edit-dialog__clear">
          <input
            type="checkbox"
            checked={gpsCleared}
            onChange={(e) => {
              setGpsCleared(e.target.checked);
              if (e.target.checked) setPoint(null);
            }}
          />
          清除这批照片的定位
        </label>
        {gpsCleared ? (
          <p className="edit-dialog__hint">已标记清除：保存后这批照片的定位将被移除。</p>
        ) : (
          <GpsPicker
            point={point}
            savedGps={null}
            basemap={basemap}
            onPointChange={(next) => {
              setPoint(next);
              setGpsCleared(false);
            }}
            onBasemapChange={setBasemap}
          />
        )}

        {error ? <p className="edit-dialog__error">{error}</p> : null}
      </div>

      <footer className="edit-dialog__actions">
        <button type="button" className="search-action" onClick={onClose}>
          取消
        </button>
        <button type="button" className="search-action is-primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? '应用中…' : '应用到选中的照片'}
        </button>
      </footer>
    </div>
  );
}