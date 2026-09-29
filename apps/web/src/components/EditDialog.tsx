/**
 * apps/web/src/components/EditDialog.tsx
 *
 * 单张照片编辑（admin 前台专属）：元数据（title/category/likes/tags/privacy）+ EXIF。
 * 元数据走 photoApi.update（只改库），EXIF 走 exifApi.update（只改数据库，照片文件保持原样）。
 *
 * 【EXIF 部分与后台 ExifDrawer 功能完全一致】字段范围取 core 的 `EXIF_FIELDS`
 * （41 个字段 / 7 个分组），值转换与语义比较取 core 的 exif-values（前后台同一份实现），
 * 自定义 tag 校验取 core 的 validateExifCustomTags，定位选点与后台同一套 leaflet 实现。
 * 差异只在「视觉」与「交互载体」：后台是 Drawer + antd 控件，前台是对话框 + 自研基元。
 *
 * 【只提交真正改动的 tag】靠 exifSameText 做语义比较（number 按数值、datetime 按秒级、
 * tags 按逐项），避免每次保存都重写一份没变的元数据。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  EXIF_EDITABLE_TAGS,
  EXIF_FIELDS,
  EXIF_SCOPE_CLASS,
  EXIF_TAG_PATTERN,
  emptyExifCustomTagRow,
  exifFieldsByGroup,
  exifRawToText,
  exifSameText,
  exifTextToSubmit,
  fromWgs84,
  isValidLatLon,
  validateExifCustomTags,
} from '@shaping-memory/core';
import type { CustomTagRow, GeoPoint, Photo } from '@shaping-memory/core';
import { exifApi, photoApi } from '@shaping-memory/sdk';
import type { ExifPatch, PhotoExifResult, PhotoPatch } from '@shaping-memory/sdk';

import { Icon } from './Icon';
import { ExifFieldControl } from './ExifFieldControl';
import { BASEMAPS, GpsPicker } from './GpsPicker';
import type { BasemapKey } from './GpsPicker';

/** 隐私标记 → 中文（与后台 PRIVACY_MARK_LABEL 对齐） */
const PRIVACY_LABEL: Record<NonNullable<PhotoPatch['privacy']>, string> = {
  inherit: '跟随默认',
  visible: '公开',
  blur: '模糊',
  hidden: '隐藏',
};

/** 把文件里的原始值铺成 canonical 文本（与 core 的 exifRawToText 同口径） */
function initialFormText(fields: Record<string, string>): Record<string, string> {
  const text: Record<string, string> = {};
  for (const spec of EXIF_FIELDS) text[spec.tag] = exifRawToText(spec.type, fields[spec.tag]);
  return text;
}

/* -------------------------------------------------------------------------- */
/* 自定义 tag 行（对应后台 CustomTagEditor，视觉换成前台基元）                    */
/* -------------------------------------------------------------------------- */

interface CustomTagRowsProps {
  rows: CustomTagRow[];
  onChange: (rows: CustomTagRow[]) => void;
  disabled?: boolean;
}

function CustomTagRows({ rows, onChange, disabled }: CustomTagRowsProps) {
  const patchRow = (key: string, patch: Partial<CustomTagRow>): void => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  return (
    <div className="exif-custom">
      {rows.map((row) => {
        const invalid = row.tag !== '' && !EXIF_TAG_PATTERN.test(row.tag);
        return (
          <div className="exif-custom__row" key={row.key}>
            <input
              className={`search-input exif-custom__tag${invalid ? ' is-invalid' : ''}`}
              placeholder="参数名，如 XMP:Rating"
              value={row.tag}
              disabled={disabled}
              onChange={(event) => patchRow(row.key, { tag: event.target.value })}
            />
            <input
              className="search-input exif-custom__value"
              placeholder="参数值（留空表示清除）"
              value={row.value}
              disabled={disabled}
              onChange={(event) => patchRow(row.key, { value: event.target.value })}
            />
            <button
              type="button"
              className="exif-custom__remove"
              aria-label="删除这条自定义参数"
              disabled={disabled}
              onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
            >
              <Icon name="close" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="exif-custom__add"
        disabled={disabled}
        onClick={() => onChange([...rows, emptyExifCustomTagRow()])}
      >
        + 添加自定义参数
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 主对话框                                                                     */
/* -------------------------------------------------------------------------- */

interface EditDialogProps {
  photo: Photo;
  /** 分类候选（列表去重而来） */
  categories: readonly string[];
  onClose: () => void;
  /** 保存成功且数据已变（父级据此重拉列表/同步查看器） */
  onChanged: () => void;
}

export function EditDialog({ photo, categories, onClose, onChanged }: EditDialogProps) {
  // 元数据草稿
  const [title, setTitle] = useState(photo.title);
  const [description, setDescription] = useState(photo.description);
  const [category, setCategory] = useState<string>(photo.cat);
  const [likes, setLikes] = useState(photo.likes);
  // 标签编辑用的是名字：来源与审核态由后端维护，这里只改「有哪些标签」这一件事
  const [tags, setTags] = useState(photo.tags.map((tag) => tag.name).join(', '));
  const [privacy, setPrivacy] = useState<NonNullable<PhotoPatch['privacy']>>(
    photo.privacy?.mode ?? 'visible',
  );

  // EXIF 草稿：canonical 文本（不是文件里的原始值，见 core exif-values.ts）
  const [exif, setExif] = useState<PhotoExifResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [formText, setFormText] = useState<Record<string, string>>({});
  const [customRows, setCustomRows] = useState<CustomTagRow[]>([]);

  // 定位：手输（字符串态，允许只填一半 / 允许 `-` 这种中间态）+ 地图选点
  const [manual, setManual] = useState<{ lat: string; lon: string }>({ lat: '', lon: '' });
  const [basemap, setBasemap] = useState<BasemapKey>('amap');
  const [gpsCleared, setGpsCleared] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = useMemo(() => exifFieldsByGroup(), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    exifApi
      .get(photo.id)
      .then((result) => {
        if (cancelled) return;
        setExif(result);
        setFormText(initialFormText(result.fields));
        setCustomRows([]);
        setManual({
          lat: result.gps ? String(result.gps.lat) : '',
          lon: result.gps ? String(result.gps.lon) : '',
        });
        setGpsCleared(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取拍摄参数失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [photo.id]);

  /** 手输的两半都填齐且合法才构成选点（只填一半不参与提交，也不清掉已有定位） */
  const manualLat = manual.lat.trim() === '' ? null : Number(manual.lat);
  const manualLon = manual.lon.trim() === '' ? null : Number(manual.lon);
  const gpsPoint: GeoPoint | null =
    manualLat != null && manualLon != null && isValidLatLon(manualLat, manualLon)
      ? { lat: manualLat, lon: manualLon }
      : null;

  const handleMapPick = (point: GeoPoint): void => {
    setManual({ lat: String(point.lat), lon: String(point.lon) });
    setGpsCleared(false);
  };

  const handleClearGps = (): void => {
    setManual({ lat: '', lon: '' });
    setGpsCleared(true);
  };

  const handleClearField = (tag: string, label: string): void => {
    // 置空即「清除」：提交时归一成 null，后端会删掉这个 tag
    setFormText((prev) => ({ ...prev, [tag]: '' }));
    setNotice(`已清空「${label}」，保存后将从这张照片中移除`);
  };

  const handleSave = async (): Promise<void> => {
    if (!exif) return;
    setError(null);
    setNotice(null);

    // 前置校验：数值范围 / 时间格式 / 自定义 tag —— 与后台同一套规则，先拦一道再发请求
    for (const spec of EXIF_FIELDS) {
      const text = formText[spec.tag] ?? '';
      if (text.trim() === '') continue;
      if (spec.type === 'number') {
        const num = Number(text);
        if (!Number.isFinite(num)) {
          setError(`「${spec.label}」需要填一个数字`);
          return;
        }
        if ((spec.min != null && num < spec.min) || (spec.max != null && num > spec.max)) {
          setError(`「${spec.label}」需在 ${spec.min} ~ ${spec.max} 之间`);
          return;
        }
      }
      if (spec.type === 'datetime' && exifTextToSubmit('datetime', text) === null) {
        setError(`「${spec.label}」时间格式不正确，请重新选择`);
        return;
      }
    }
    const tagError = validateExifCustomTags(customRows, EXIF_EDITABLE_TAGS);
    if (tagError) {
      setError(tagError);
      return;
    }

    // 元数据：单张是全量编辑，直接提交当前值
    const metaPatch: PhotoPatch = {
      title: title.trim(),
      description: description.trim(),
      category,
      likes,
      tags: tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      privacy,
    };
    const metaDirty =
      metaPatch.title !== photo.title ||
      metaPatch.description !== photo.description ||
      metaPatch.category !== photo.cat ||
      metaPatch.likes !== photo.likes ||
      metaPatch.privacy !== (photo.privacy?.mode ?? 'visible') ||
      metaPatch.tags!.join(',') !== photo.tags.map((tag) => tag.name).join(',');

    // EXIF：逐字段语义比对，只提交真正改动的 tag
    const fieldPatch: Record<string, string | string[] | null> = {};
    for (const spec of EXIF_FIELDS) {
      const text = formText[spec.tag] ?? '';
      if (exifSameText(spec.type, text, exifRawToText(spec.type, exif.fields[spec.tag]))) continue;
      fieldPatch[spec.tag] = exifTextToSubmit(spec.type, text);
    }
    for (const row of customRows) {
      if (row.tag === '') continue;
      fieldPatch[row.tag] = row.value === '' ? null : row.value;
    }

    const patch: ExifPatch = {};
    if (Object.keys(fieldPatch).length > 0) patch.fields = fieldPatch;
    if (gpsCleared) {
      patch.gps = null;
    } else if (gpsPoint) {
      // 与后台一致：提交「底图原始坐标 + 坐标系」，坐标系归一由后端 toWgs84 统一完成
      const baseConfig = BASEMAPS[basemap];
      const basePoint = fromWgs84(gpsPoint, baseConfig.crs);
      patch.gps = { lat: basePoint.lat, lon: basePoint.lon };
      patch.crs = baseConfig.crs;
    }

    const exifDirty = patch.fields !== undefined || patch.gps !== undefined;
    if (!exifDirty && !metaDirty) {
      setNotice('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      if (metaDirty) await photoApi.update(photo.id, metaPatch);
      if (exifDirty) await exifApi.update(photo.id, patch);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const fileInfo = [
    { label: '文件类型', value: exif?.fields.FileType ?? '—' },
    { label: '像素尺寸', value: `${exif?.fields.ImageWidth ?? '?'} × ${exif?.fields.ImageHeight ?? '?'}` },
    { label: '图像格式', value: exif?.fields.MIMEType ?? '—' },
  ];

  return (
    <div className={`edit-dialog edit-dialog--wide ${EXIF_SCOPE_CLASS}`} role="dialog" aria-label="编辑照片">
      <header className="edit-dialog__head">
        <h2 className="edit-dialog__title">编辑照片</h2>
        <button type="button" className="search-panel__close" aria-label="关闭编辑" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <div className="edit-dialog__body">
        <div className="exif-fileinfo">
          {fileInfo.map((item) => (
            <div className="exif-fileinfo__item" key={item.label}>
              <span className="exif-fileinfo__label">{item.label}</span>
              <span className="exif-fileinfo__value">{item.value}</span>
            </div>
          ))}
        </div>

        <h3 className="edit-dialog__section">照片信息</h3>
        <label className="search-field">
          <span className="search-field__label">标题</span>
          <input className="search-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {/* 描述是多行纯文本：换行与空行原样保留，前台查看器里整段展示 */}
        <label className="search-field">
          <span className="search-field__label">描述</span>
          <textarea
            className="search-input search-input--multiline"
            rows={5}
            placeholder="想为这张照片留一段话…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="search-field">
          <span className="search-field__label">分类</span>
          <select className="search-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="search-field">
          <span className="search-field__label">点赞数</span>
          <input
            className="search-input"
            type="number"
            min={0}
            step={1}
            value={likes}
            onChange={(e) => setLikes(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <label className="search-field">
          <span className="search-field__label">标签（逗号分隔）</span>
          <input className="search-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如 上海, 街头" />
        </label>
        <label className="search-field">
          <span className="search-field__label">隐私标记</span>
          <select
            className="search-input"
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as NonNullable<PhotoPatch['privacy']>)}
          >
            {(Object.keys(PRIVACY_LABEL) as Array<NonNullable<PhotoPatch['privacy']>>).map((value) => (
              <option key={value} value={value}>
                {PRIVACY_LABEL[value]}
              </option>
            ))}
          </select>
        </label>

        <h3 className="edit-dialog__section">拍摄参数</h3>
        {loading ? (
          <p className="edit-dialog__hint">正在读取拍摄参数…</p>
        ) : (
          <>
            {groups.map(([group, fields]) => (
              <details className="exif-group" key={group} open>
                <summary className="exif-group__summary">
                  {group}
                  <span className="exif-group__count">{fields.length}</span>
                  <span className="exif-group__caret" aria-hidden="true">
                    <Icon name="chevron" />
                  </span>
                </summary>
                <div className="exif-grid">
                  {fields.map((spec) => (
                    <ExifFieldControl
                      key={spec.tag}
                      spec={spec}
                      value={formText[spec.tag] ?? ''}
                      disabled={saving}
                      onChange={(value) => setFormText((prev) => ({ ...prev, [spec.tag]: value }))}
                      onClear={() => handleClearField(spec.tag, spec.label)}
                    />
                  ))}
                </div>
              </details>
            ))}

            <h4 className="edit-dialog__section">定位（经纬度）</h4>
            <div className="exif-gps">
              <label className="search-field">
                <span className="search-field__label">纬度</span>
                <input
                  className="search-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="如 39.9042"
                  value={manual.lat}
                  disabled={saving}
                  onChange={(e) => {
                    setManual((prev) => ({ ...prev, lat: e.target.value }));
                    setGpsCleared(false);
                  }}
                />
              </label>
              <label className="search-field">
                <span className="search-field__label">经度</span>
                <input
                  className="search-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="如 116.4074"
                  value={manual.lon}
                  disabled={saving}
                  onChange={(e) => {
                    setManual((prev) => ({ ...prev, lon: e.target.value }));
                    setGpsCleared(false);
                  }}
                />
              </label>
              <div className="exif-gps__status">
                <span className={`exif-badge${exif?.gps ? ' is-on' : ''}`}>
                  {exif?.gps ? '这张照片已有定位' : '这张照片暂无定位'}
                </span>
                <button
                  type="button"
                  className={`edit-dialog__clear-tag${gpsCleared ? ' is-on' : ''}`}
                  disabled={saving || (!exif?.gps && !gpsPoint)}
                  onClick={handleClearGps}
                >
                  清除定位
                </button>
              </div>
            </div>
            <p className="edit-dialog__hint">
              手动输入时请填标准 GPS 坐标；也可以直接在地图上选点，坐标会自动换算。
              {gpsCleared ? ' 保存后将移除这张照片的定位。' : ''}
            </p>

            <GpsPicker
              key={photo.id}
              point={gpsPoint}
              savedGps={exif?.gps ? { lat: exif.gps.lat, lon: exif.gps.lon } : null}
              basemap={basemap}
              onPointChange={handleMapPick}
              onBasemapChange={setBasemap}
            />

            <h4 className="edit-dialog__section">其他拍摄参数</h4>
            <CustomTagRows rows={customRows} onChange={setCustomRows} disabled={saving} />
          </>
        )}

        {notice ? <p className="edit-dialog__notice">{notice}</p> : null}
        {error ? <p className="edit-dialog__error">{error}</p> : null}
        <p className="edit-dialog__hint">
          保存只更新数据库中的 EXIF 记录，照片文件保持原样；下载时会把最新 EXIF 写入下载的图片。把某项内容清空再保存，即可移除该项。
        </p>
      </div>

      <footer className="edit-dialog__actions">
        <button type="button" className="search-action" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="search-action is-primary"
          onClick={() => void handleSave()}
          disabled={saving || loading || !exif}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </footer>
    </div>
  );
}