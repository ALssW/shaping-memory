/**
 * apps/web/src/components/LocalExifFileList.tsx
 *
 * 工作台左栏：导入照片的缩略图列表 —— 勾选框（含全选 / 取消全选）、文件名、格式体积与可编辑性状态。
 *
 * 【不支持/损坏的文件为什么也留在列表里】用户点错、导错格式时，最需要的是「知道它为什么没被改」，
 * 直接从列表里隐藏会使文件被误判为丢失；因此列出但置灰、勾选框禁用，并写清原因。
 *
 * 【RAW 的缩略图从哪来】NEF 本体浏览器渲染不了，`previewUrl` 指向的是 Worker 从文件里
 * 抽出来的内嵌 JPEG 预览；抽不到时 `<img>` 会报错并被隐藏，露出相机占位图标。
 */
import { containerLabel } from '@shaping-memory/core';

import type { LocalExifItem } from '../lib/localExif';
import { Icon } from './Icon';

interface LocalExifFileListProps {
  items: readonly LocalExifItem[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}

/** 44MB 的 RAW 与 800KB 的 JPEG 混在一批里时，体积是用户确认「这张拖对了没」最快的一条线索 */
function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** 某一行可编辑状态下的补充信息：格式 + 体积 + 字段数 + 有多少未知 tag 会被原样保留 */
function detailOf(item: LocalExifItem): string {
  if (item.readOnlyReason) return item.readOnlyReason;
  const known = Object.keys(item.doc?.values ?? {}).length;
  const unknown = item.doc?.unknownCount ?? 0;
  return `${containerLabel(item.container)} · ${formatBytes(item.sizeBytes)} · 已识别 ${known} 项拍摄信息${
    unknown > 0 ? ` · 另有 ${unknown} 项无法识别的内容将原样保留` : ''
  }`;
}

export function LocalExifFileList({
  items,
  selected,
  onToggle,
  onRemove,
  onSelectAll,
  onClearSelection,
}: LocalExifFileListProps) {
  const editableCount = items.filter((item) => !item.readOnlyReason).length;

  return (
    <div className="localexif-list">
      <div className="localexif-list__head">
        <span className="localexif-list__count">
          已选 {selected.size} / 共 {items.length}
        </span>
        <div className="localexif-list__acts">
          <button type="button" className="edit-dialog__clear-tag" disabled={editableCount === 0} onClick={onSelectAll}>
            全选
          </button>
          <button
            type="button"
            className="edit-dialog__clear-tag"
            disabled={selected.size === 0}
            onClick={onClearSelection}
          >
            取消全选
          </button>
        </div>
      </div>
      <ul className="localexif-list__items">
        {items.map((item) => {
          const isSelected = selected.has(item.id);
          return (
            <li
              key={item.id}
              className={`localexif-item${isSelected ? ' is-selected' : ''}${
                item.readOnlyReason ? ' is-readonly' : ''
              }`}
            >
              <label className="localexif-item__main">
                <input
                  type="checkbox"
                  className="localexif-item__box"
                  checked={isSelected}
                  disabled={item.readOnlyReason !== null}
                  onChange={() => onToggle(item.id)}
                />
                <span className="localexif-item__thumb">
                  <img
                    src={item.previewUrl}
                    alt=""
                    draggable={false}
                    // 非图片（或浏览器不认的格式）渲染不出：隐藏图片，保留下方的相机占位
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                  <Icon name="camera" />
                </span>
                <span className="localexif-item__text">
                  <span className="localexif-item__name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="localexif-item__meta">{detailOf(item)}</span>
                </span>
              </label>
              <button
                type="button"
                className="exif-custom__remove"
                aria-label={`从列表移除 ${item.name}`}
                onClick={() => onRemove(item.id)}
              >
                <Icon name="close" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
