/**
 * apps/web/src/components/LocalExifWorkbench.tsx
 *
 * 本地 EXIF 工作台（工具模块「本地 EXIF 编辑」的 Web 落点）。
 *
 * 【为什么整块独立成组件、而不是并入 ToolsScreen】工作台自带导入 / 勾选 / 草稿 / 确认 / 导出
 * 一整套状态，和计算器卡片（纯函数 + 一个结果）形态完全不同；独立后工具页只负责「进入 / 返回」。
 *
 * 【铁律：这里不碰任何网络】字节全程留在浏览器内存（准确说：留在 Worker 的字节库里），
 * 免登录、断网可用，也不走服务端照片库。导出只把内存副本原字节落盘，导出阶段绝不再改任何 tag。
 *
 * 【导出为什么必须「先应用」】应用 = 把 patch 写进内存副本；若草稿还没应用就导出，
 * 用户会以为改动丢了，所以按钮直接禁用并说明。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { EXIF_FIELDS, EXIF_SCOPE_CLASS } from '@shaping-memory/core';
import type { ExifField, LocalExifDocument } from '@shaping-memory/core';

import { applyExifPatch, exportExifBytes, releaseExifBuffers } from '../lib/exifWorkerClient';
import {
  DEFAULT_NAMING,
  downloadBytes,
  exportFileNameOf,
  isDirectorySupported,
  pickDirectory,
  writeToDirectory,
} from '../lib/exifExport';
import type { ExportNaming } from '../lib/exifExport';
import {
  SKIP_DRAFT,
  buildPatch,
  draftMatchesBase,
  readLocalItem,
  summarizeAll,
  summarizeGps,
  validatePatch,
} from '../lib/localExif';
import type { DraftMerge, FieldDraft, LocalExifItem } from '../lib/localExif';
import { Icon } from './Icon';
import { LocalExifExportPanel } from './LocalExifExportPanel';
import { LocalExifFileList } from './LocalExifFileList';
import { LocalExifFieldPanel } from './LocalExifFieldPanel';

/** 长任务进度：导入 / 应用 / 导出都有「总量里做了多少」，避免界面看起来卡死 */
interface TaskProgress {
  label: string;
  done: number;
  total: number;
}

/** 文件选择器的接受范围：显式列出 RAW 扩展名 —— Windows 上 .NEF 未必注册了 MIME，只写 image/* 会选不中 */
const ACCEPT = 'image/*,.nef,.NEF,.dng,.cr2,.arw,.tif,.tiff';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : '未知错误');

/** 命名规则的一句话说明：导出完成后回述「这次用的是哪条规则」 */
function describeNaming(naming: ExportNaming): string {
  if (naming.mode === 'prefix') return `前缀「${naming.prefix}」`;
  if (naming.mode === 'template') return `模板「${naming.template}」`;
  return `后缀「${naming.suffix}」`;
}

export function LocalExifWorkbench({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<LocalExifItem[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** 拖放高亮：用计数法判定，否则鼠标划过内部元素时高亮会闪 */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  /** 导出命名规则与目标目录（目录为 null 时回落到逐个下载） */
  const [naming, setNaming] = useState<ExportNaming>(DEFAULT_NAMING);
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = progress !== null;

  /* 缩略图是对象 URL：离开工作台统一回收，并把 Worker 里的字节库一起还掉 */
  const itemsRef = useRef<LocalExifItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(
    () => () => {
      const leaving = itemsRef.current;
      for (const item of leaving) URL.revokeObjectURL(item.previewUrl);
      void releaseExifBuffers(leaving.map((item) => item.id));
    },
    [],
  );

  const activeItems = useMemo(
    () => items.filter((item) => item.readOnlyReason === null && selected.has(item.id)),
    [items, selected],
  );
  const summaries = useMemo(() => summarizeAll(activeItems, EXIF_FIELDS), [activeItems]);
  const gpsSummary = useMemo(() => summarizeGps(activeItems), [activeItems]);
  const patch = useMemo(() => buildPatch(drafts), [drafts]);
  const patchCount = Object.keys(patch).length;
  /** 首个拟导出文件的名字：改命名规则时立刻能看见结果，避免「导完才发现名字不对」 */
  const previewName = useMemo(() => {
    const sample = activeItems[0] ?? items[0];
    return sample ? exportFileNameOf(sample.name, sample.container, naming, new Set()) : '';
  }, [activeItems, items, naming]);

  /**
   * 导入：逐张交给 Worker 读字节并解析，失败项落成只读（原因写进列表），新导入的可编辑照片默认勾上。
   * 【为什么单张 try/catch】一张坏图不应影响整批；只有 Worker 整体崩溃才会抛到这里。
   */
  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    setError(null);
    setNotice(null);
    setProgress({ label: '读取照片', done: 0, total: files.length });
    const imported: LocalExifItem[] = [];
    const failures: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        try {
          imported.push(await readLocalItem(file));
        } catch (err) {
          failures.push(`${file.name}：${messageOf(err)}`);
        }
        setProgress({ label: '读取照片', done: index + 1, total: files.length });
      }
    } finally {
      // 铁律：任何路径都要复位，否则按钮永远停在「读取中…」，用户既看不到原因也无法重试
      setProgress(null);
    }

    const editable = imported.filter((item) => item.readOnlyReason === null);
    setItems((prev) => [...prev, ...imported]);
    setSelected((prev) => new Set([...prev, ...editable.map((item) => item.id)]));
    if (failures.length > 0) {
      setError(`${failures.length} 张未能读取 —— ${failures.slice(0, 3).join('；')}${failures.length > 3 ? ' …' : ''}`);
    }
    if (imported.length > 0) {
      setNotice(
        `已导入 ${imported.length} 张，其中 ${editable.length} 张可编辑${
          imported.length - editable.length > 0 ? `，${imported.length - editable.length} 张只读` : ''
        }`,
      );
    }
    // 置空 input：同一批文件再选一次也要能触发 change
    if (fileRef.current) fileRef.current.value = '';
  };

  /* 拖放导入：dragenter/leave 会随内部元素进出反复触发，用深度计数判定「真的还停在投放区里」 */
  const onDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  /** dragover 必须 preventDefault，否则浏览器不会派发 drop（默认行为是「不接收」） */
  const onDragOver = (event: DragEvent): void => {
    event.preventDefault();
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    // 文件夹拖进来时 files 里会出现「不是图片」的条目，不做猜测，一律交给 Worker 给出只读原因
    void importFiles(Array.from(event.dataTransfer.files));
  };

  /** 选导出目录：不支持 / 取消 / 被拒都给出准确提示，绝不静默失败 */
  const chooseDirectory = async (): Promise<void> => {
    const picked = await pickDirectory();
    if (picked.ok) {
      setDirectory(picked.handle);
      setNotice(`导出目录已设为「${picked.handle.name}」，之后导出会直接写进去`);
      return;
    }
    if (picked.reason === 'unsupported') {
      setNotice('当前浏览器不支持目录选择器（Firefox / Safari 常见），导出会逐个走浏览器下载');
      return;
    }
    if (picked.reason === 'denied') setError('未获得该目录的写入权限，可换一个目录，或直接走浏览器下载');
  };

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // 立刻还内存：一张 NEF 几十 MB，等 GC 太被动
    void releaseExifBuffers([id]);
  }, []);

  const clearItems = (): void => {
    for (const item of items) URL.revokeObjectURL(item.previewUrl);
    void releaseExifBuffers(items.map((item) => item.id));
    setItems([]);
    setSelected(new Set());
    setDrafts({});
    setNotice(null);
    setError(null);
  };

  /** 改字段：改回与文件一致的公共值 ⇒ 收回成「不修改」，避免白写一遍字节 */
  const changeField = (spec: ExifField, text: string): void => {
    const next: FieldDraft =
      text === '' || draftMatchesBase(spec, text, summaries.get(spec.tag)) ? SKIP_DRAFT : { action: 'set', text };
    setDrafts((prev) => ({ ...prev, [spec.tag]: next }));
  };
  const clearField = (spec: ExifField): void => {
    setDrafts((prev) => ({ ...prev, [spec.tag]: { action: 'clear', text: '' } }));
  };
  const resetField = (spec: ExifField): void => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[spec.tag];
      return next;
    });
  };

  /** 按 tag 合并草稿（地图选位一次要落多条）：值为 undefined 表示撤掉该 tag 的草稿 */
  const mergeDrafts = useCallback((merge: DraftMerge) => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const [tag, draft] of Object.entries(merge)) {
        if (draft === undefined) delete next[tag];
        else next[tag] = draft;
      }
      return next;
    });
  }, []);

  const requestApply = (): void => {
    setError(null);
    setNotice(null);
    const problem = validatePatch(patch, EXIF_FIELDS);
    if (problem) {
      setError(problem);
      return;
    }
    if (patchCount === 0) {
      setNotice('暂无需要应用的改动：先在右侧修改内容，或直接导出原始副本');
      return;
    }
    // 二次确认：把「改几张、改几个字段」摆到用户眼前
    setConfirming(true);
  };

  /** 逐张写入：一张失败不中断整批（RAW 的厂商私有结构可能拒绝搬迁，只影响那一张） */
  const confirmApply = async (): Promise<void> => {
    const targets = activeItems;
    setConfirming(false);
    setError(null);
    setProgress({ label: '写入照片', done: 0, total: targets.length });
    const failed: string[] = [];
    const updated = new Map<string, LocalExifDocument>();
    try {
      for (const [index, item] of targets.entries()) {
        try {
          const result = await applyExifPatch(item.id, patch);
          updated.set(item.id, result.doc);
        } catch (err) {
          failed.push(`${item.name}：${messageOf(err)}`);
        }
        setProgress({ label: '写入照片', done: index + 1, total: targets.length });
      }
    } finally {
      setProgress(null);
    }

    // 回读快照来自 Worker：列表与字段回显都基于最新字节
    setItems((prev) => prev.map((item) => (updated.has(item.id) ? { ...item, doc: updated.get(item.id) ?? item.doc } : item)));
    setDrafts({});
    if (failed.length > 0) {
      setError(`${failed.length} 张未能写入 —— ${failed.slice(0, 3).join('；')}${failed.length > 3 ? ' …' : ''}`);
      return;
    }
    setNotice(`已应用到 ${targets.length} 张照片的 ${patchCount} 项内容（只改本次待导出的副本，原始文件不受影响）`);
  };

  /**
   * 导出：逐张从 Worker 取字节副本落盘，全程不联网。
   * 【命名为什么要 taken 集合】同一批里两张同名照片若都叫 `A-edited.jpg`，第二个会把第一个盖掉；
   * 交给命名规则统一避让，目录与下载两条路径的行为才一致。
   */
  const exportSelection = async (): Promise<void> => {
    const targets = activeItems;
    setError(null);
    setProgress({ label: directory ? '写入目录' : '准备下载', done: 0, total: targets.length });
    const failed: string[] = [];
    const taken = new Set<string>();
    try {
      for (const [index, item] of targets.entries()) {
        const filename = exportFileNameOf(item.name, item.container, naming, taken);
        taken.add(filename);
        try {
          const bytes = await exportExifBytes(item.id);
          if (directory) await writeToDirectory(directory, filename, bytes);
          else downloadBytes(bytes, filename, item.container);
        } catch (err) {
          failed.push(`${item.name}：${messageOf(err)}`);
        }
        setProgress({ label: directory ? '写入目录' : '准备下载', done: index + 1, total: targets.length });
      }
    } finally {
      setProgress(null);
    }
    if (failed.length > 0) {
      setError(`${failed.length} 张未能导出 —— ${failed.slice(0, 3).join('；')}${failed.length > 3 ? ' …' : ''}`);
      return;
    }
    setNotice(
      directory
        ? `已把 ${targets.length} 个文件写入目录「${directory.name}」，全程未联网（原文件未被改动）`
        : `已触发 ${targets.length} 个文件的下载，命名规则：${describeNaming(naming)}（原文件未被改动）`,
    );
  };

  return (
    <section
      className={`module ${EXIF_SCOPE_CLASS}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 投放遮罩：全屏覆盖，让用户清楚「现在松手就会导入」 */}
      {dragging ? (
        <div className="localexif-dropzone">
          <Icon name="camera" />
          <span>松手即导入 —— 可一次拖入多张，支持 JPEG / PNG / RAW（含 NEF）</span>
        </div>
      ) : null}
      <div className="shell">
        <button type="button" className="search-action localexif__back" onClick={onBack}>
          <Icon name="arrowLeft" /> 返回工具
        </button>
        <h1 className="page-title">拍摄参数编辑</h1>
        <p className="page-sub">
          在本机导入 JPEG / PNG / RAW（含 NEF），批量勾选后按类型编辑照片的全部拍摄参数并导出；全程本地完成，不联网、不上传
        </p>

        <div className="localexif__toolbar">
          <label className={`search-action is-primary localexif__import${busy ? ' is-busy' : ''}`}>
            {busy ? '处理中…' : '导入照片'}
            <input
              ref={fileRef}
              className="sr-only"
              type="file"
              accept={ACCEPT}
              multiple
              disabled={busy}
              onChange={(event) => {
                if (event.target.files) void importFiles(Array.from(event.target.files));
              }}
            />
          </label>
          {items.length > 0 ? (
            <>
              <button
                type="button"
                className="search-action"
                disabled={patchCount === 0 || busy}
                onClick={() => setDrafts({})}
              >
                重置编辑
              </button>
              <button type="button" className="search-action" disabled={busy} onClick={clearItems}>
                清空列表
              </button>
            </>
          ) : null}
          <span className="localexif__summary">
            可编辑 {activeItems.length} 张 · 待应用改动 {patchCount} 项
          </span>
        </div>

        {progress ? (
          <div className="localexif-progress" role="status" aria-live="polite">
            <span className="localexif-progress__text">
              {progress.label} {progress.done} / {progress.total}
            </span>
            <span className="localexif-progress__track">
              <span
                className="localexif-progress__bar"
                style={{ width: `${progress.total === 0 ? 0 : (progress.done / progress.total) * 100}%` }}
              />
            </span>
          </div>
        ) : null}

        {notice ? <p className="edit-dialog__notice">{notice}</p> : null}
        {error ? <p className="edit-dialog__error">{error}</p> : null}

        {items.length === 0 ? (
          <div className="localexif-empty">
            <h2 className="localexif-empty__title">尚未导入照片</h2>
            <ol className="localexif-empty__steps">
              <li>点「导入照片」选本机图片，或把照片直接拖到本页任意位置（都支持一次多张）</li>
              <li>格式支持 JPEG / PNG / RAW（含 NEF）；不支持的格式会列出并写明原因，不会被静默忽略</li>
              <li>在左栏勾选要一起修改的照片，可用「全选 / 取消全选」</li>
              <li>在右栏修改：留空 = 不修改，点「清除」= 导出时移除该项</li>
              <li>「应用修改」确认后，在底部设定文件名规则与保存位置，再点「导出」保存</li>
            </ol>
          </div>
        ) : (
          <div className="localexif">
            <LocalExifFileList
              items={items}
              selected={selected}
              onToggle={toggleSelect}
              onRemove={removeItem}
              onSelectAll={() =>
                setSelected(new Set(items.filter((item) => !item.readOnlyReason).map((item) => item.id)))
              }
              onClearSelection={() => setSelected(new Set())}
            />
            <div className="localexif__main">
              <LocalExifFieldPanel
                activeItems={activeItems}
                summaries={summaries}
                gpsSummary={gpsSummary}
                drafts={drafts}
                onFieldChange={changeField}
                onFieldClear={clearField}
                onFieldReset={resetField}
                onMergeDrafts={mergeDrafts}
              />
            </div>
          </div>
        )}

        {confirming ? (
          <div className="localexif-confirm" role="alertdialog" aria-label="确认应用修改">
            <span>
              将修改 {activeItems.length} 张照片的 {patchCount} 项内容（只改本次待导出的副本，原始文件不会被覆盖）。确认继续？
            </span>
            <button type="button" className="search-action" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button type="button" className="search-action is-primary" onClick={() => void confirmApply()}>
              确认应用
            </button>
          </div>
        ) : null}

        {items.length > 0 ? (
          <LocalExifExportPanel
            naming={naming}
            onNamingChange={setNaming}
            previewName={previewName}
            directoryName={directory?.name ?? null}
            directorySupported={isDirectorySupported()}
            busy={busy}
            onChooseDirectory={() => void chooseDirectory()}
            onUseDownload={() => setDirectory(null)}
          />
        ) : null}

        {items.length > 0 ? (
          <div className="localexif__footer">
            <span className="localexif__footer-hint">
              {patchCount > 0
                ? `还有 ${patchCount} 项改动尚未应用：先点「应用修改」，导出的照片才会包含它们。`
                : '导出的是改动后的副本，不会覆盖所选择的原文件；全程不联网。'}
            </span>
            <button
              type="button"
              className="search-action"
              disabled={busy || patchCount === 0 || activeItems.length === 0}
              onClick={requestApply}
            >
              应用修改
            </button>
            <button
              type="button"
              className="search-action is-primary"
              disabled={busy || activeItems.length === 0 || patchCount > 0}
              onClick={() => void exportSelection()}
            >
              导出已选 {activeItems.length} 张 → {directory ? directory.name : '浏览器下载'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}