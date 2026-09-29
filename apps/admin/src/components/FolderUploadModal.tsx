/**
 * apps/admin/src/components/FolderUploadModal.tsx
 *
 * 文件夹上传：选一个本地文件夹 → 自动以文件夹名建相册 → 分片上传根目录下的照片 → 并入相册。
 *
 * 【结构只收一级】浏览器给的相对路径形如「旅行/2024/a.jpg」，出现第三段就是子文件夹里的内容；
 * 本期只收根目录文件，子文件夹整体跳过，并在界面上明确说明跳过范围与数量。
 * 【为什么先建相册再传】断线时才确定照片应归入哪个相册；每张传完立即补上相册归属，
 * 中途中断也不会留下一批「已上传但不属于任何相册」的孤儿照片。
 * 【同名先问再动】同名相册（标题相同）与同名文件（原始文件名 + 大小相同）都会在上传前列出，
 * 由用户决定追加 / 新建 / 覆盖 / 跳过 —— 不进行任何自动覆盖。
 * 【断点续传靠身份对齐】分片留在服务端，本机仅记录「哪些文件尚未传输完成」；
 * 重开页面会提醒续传，用户重新选择同一文件夹后以「名 / 大小 / 修改时间」匹配回原文件。
 * 【并发分两层】文件之间并发、每个文件内部再按分片并发，两层乘积贴近站点设置 upload.concurrency
 * （只有一个文件时全部并发分配给该文件，文件较多时自动分摊；见 runUpload）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, Modal, Progress, Radio, Select, Space, Tag, Tooltip } from 'antd';
import type { Photo } from '@shaping-memory/core';
import { albumApi, albumGroupApi, photoApi } from '@shaping-memory/sdk';
import type { Album, AlbumGroup } from '@shaping-memory/sdk';

import { uploadFileInChunks } from '../lib/chunkUpload';
import { clearPendingBatch, fileKeyOf, readPendingBatch, writePendingBatch } from '../lib/pendingBatch';
import type { PendingBatch } from '../lib/pendingBatch';
import { runPool } from '../lib/pool';
import { FALLBACK_RULES, extOf, loadUploadRules } from '../lib/uploadRules';
import type { UploadRules } from '../lib/uploadRules';

/**
 * 文件级并发上限：浏览器对同一域名（HTTP/1.1）一般只开 6 条连接，
 * 超过该值并不会更快，只是将请求排入浏览器自身的队列 —— 反而使进度显示失真。
 */
const MAX_FILE_CONCURRENCY = 6;

/** 同名相册的处置方式；skip = 放弃本次上传 */
type AlbumChoice = 'append' | 'create' | 'skip';
/** 同名文件的批量处置方式；custom = 逐条微调 */
type FileChoice = 'overwrite' | 'skip' | 'custom';
/** 单个文件的最终处置 */
type Decision = 'upload' | 'skip';
type Stage = 'pick' | 'confirm' | 'uploading' | 'done';

interface ScannedFile {
  file: File;
  name: string;
  size: number;
  /** 库中「同名同大小」的照片；没有冲突时为空 */
  conflict?: Photo;
}

interface ScanOutcome {
  folderName: string;
  /** 待处理的文件（续传时只留断点里那些） */
  accepted: ScannedFile[];
  /** 本次是否延续上次的断点 */
  resumed: boolean;
  /** 续传时被跳过的「实际已传输完成」的文件数 */
  alreadyDone: number;
  /** 被跳过的子文件夹（去重） */
  subdirs: string[];
  /** 格式 / 体积不符的文件 */
  rejected: { name: string; reason: string }[];
  /** 同名相册 */
  album: Album | null;
}

interface ItemState {
  key: string;
  name: string;
  size: number;
  status: 'waiting' | 'uploading' | 'done' | 'error' | 'skipped';
  error?: string;
}

interface UploadContext {
  albumId: string;
  albumTitle: string;
  folderName: string;
  plannedIds: string[];
  concurrency: number;
}

interface Report {
  ok: number;
  fail: number;
  skipped: number;
  failedNames: string[];
  /** 已上传但未并入相册时的错误（照片已存在，仅尚未归入相册） */
  flushError: string;
  /** 已入库、本地也存在，但云端副本未完整上传的文件名（对象存储不稳定或凭据错误） */
  cloudFailedNames: string[];
}

/** 单个文件的处理结果：字节数随结果一并返回 —— 多文件并发时不能依赖单一全局变量记录「该文件已传输多少」 */
interface FileOutcome {
  status: 'done' | 'error' | 'skipped';
  /** 本文件已确认到达服务端的字节（含续传时服务端已接收的部分） */
  confirmedBytes: number;
  /** 入库后的照片 id（成功时才有，用于并入相册；覆盖上传时沿用原 id） */
  photoId?: string;
  /** 云端副本未成功上传的对象数（0 = 云端完整或本机模式）；失败不影响该文件本身计为成功 */
  cloudFailed: number;
}

/** 相对路径（如「旅行/2024/a.jpg」）拆成各段；非标准属性 webkitRelativePath 需显式取 */
function relativePartsOf(file: File): string[] {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  return relative.split('/').filter((part) => part !== '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 默认分组 id：优先内置的「默认分组」（服务端保证它一定存在），否则回退取列表首项 */
function defaultGroupIdOf(list: readonly AlbumGroup[]): string {
  return list.find((group) => group.builtin)?.id ?? list[0]?.id ?? '';
}

/**
 * 扫描选中的文件夹：一级过滤 + 格式体积校验 + 同名比对。
 * 不发请求，冲突索引与相册列表由调用方先准备好。
 */
function buildScan(
  list: readonly File[],
  rules: UploadRules,
  photos: readonly Photo[],
  albums: readonly Album[],
  resume: PendingBatch | null,
): ScanOutcome {
  /* 同名索引：原始文件名 + 字节数。media.id 取自带随机前缀的落盘名，
     「同一个文件以前传过没有」只能依据这两项判断。 */
  const conflictIndex = new Map<string, Photo>();
  for (const photo of photos) {
    if (!photo.originalName || photo.originalSize == null) continue;
    conflictIndex.set(`${photo.originalName}|${photo.originalSize}`, photo);
  }

  const subdirs = new Set<string>();
  const rejected: ScanOutcome['rejected'] = [];
  const accepted: ScannedFile[] = [];
  let folderName = '';

  for (const file of list) {
    const parts = relativePartsOf(file);
    folderName ||= parts[0] ?? '';
    // 一级结构：只收根目录下的文件，出现第三段即表明该文件位于某个子文件夹中
    if (parts.length > 2) {
      subdirs.add(parts.slice(1, -1).join('/'));
      continue;
    }
    if (!rules.formats.includes(extOf(file.name))) {
      rejected.push({ name: file.name, reason: '格式不在允许列表' });
      continue;
    }
    if (file.size / 1024 / 1024 > rules.maxMb) {
      rejected.push({ name: file.name, reason: `超过 ${rules.maxMb} MB` });
      continue;
    }
    accepted.push({
      file,
      name: file.name,
      size: file.size,
      conflict: conflictIndex.get(fileKeyOf(file)),
    });
  }

  /* 续传仅在「重新选择了同一文件夹」时成立：更换文件夹说明用户已改变选择，
     按普通新批次处理，否则会被断点记录过滤为空列表。 */
  const resumed = resume !== null && resume.folderName === folderName;
  const pending = resumed ? resume.files : null;
  const targets = pending
    ? accepted.filter((item) => pending.includes(fileKeyOf(item.file)))
    : accepted;

  return {
    folderName,
    accepted: targets,
    resumed,
    alreadyDone: accepted.length - targets.length,
    subdirs: [...subdirs],
    rejected,
    album: albums.find((item) => item.title === folderName) ?? null,
  };
}

/** 把本批上传成功的照片并进相册：现有成员 ∪ 本轮新增，顺序按加入先后 */
async function flushPlannedToAlbum(albumId: string, plannedIds: readonly string[]): Promise<void> {
  if (plannedIds.length === 0) return;
  const detail = await albumApi.detail(albumId);
  const existing = detail.photos.map((photo) => photo.id);
  const merged = [...existing, ...plannedIds.filter((id) => !existing.includes(id))];
  await albumApi.setMedia(albumId, merged);
}

interface FolderUploadModalProps {
  open: boolean;
  onClose: () => void;
  /** 本轮有照片成功上传时回调（刷新照片 / 相册列表） */
  onUploaded: () => void;
}

export function FolderUploadModal({ open, onClose, onUploaded }: FolderUploadModalProps) {
  const { message } = App.useApp();
  const [stage, setStage] = useState<Stage>('pick');
  const [scan, setScan] = useState<ScanOutcome | null>(null);
  const [scanning, setScanning] = useState(false);
  const [rules, setRules] = useState<UploadRules>(FALLBACK_RULES);
  const [albumChoice, setAlbumChoice] = useState<AlbumChoice>('create');
  const [fileChoice, setFileChoice] = useState<FileChoice>('overwrite');
  const [perFile, setPerFile] = useState<Record<string, Decision>>({});
  /** 可选分组（本次上传的相册要归到哪个分组） */
  const [groups, setGroups] = useState<AlbumGroup[]>([]);
  /** 目标分组 id：追加到已有相册时默认取该册当前分组，新建时默认「默认分组」 */
  const [groupId, setGroupId] = useState('');
  /** 本机记着的未完成批次（续传用） */
  const [resume, setResume] = useState<PendingBatch | null>(null);
  const [items, setItems] = useState<ItemState[]>([]);
  const [transferred, setTransferred] = useState(0);
  const [settled, setSettled] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  /** 本批实际的并发档位（同时几个文件 × 每个文件几片），仅用于进度区如实说明 */
  const [parallelism, setParallelism] = useState({ files: 1, chunks: 1 });
  const [report, setReport] = useState<Report | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 本批的相册（重试失败文件时继续用它） */
  const albumRef = useRef<{ id: string; title: string } | null>(null);
  /** 失败的条目（供「重试失败的文件」用） */
  const failedRef = useRef<ScannedFile[]>([]);

  /* webkitdirectory 不是标准属性，React 不支持该属性，只能在挂载后手动设置 ——
     设置后该选择器只选择文件夹，而非多个分散文件。 */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  // 每次打开重置整轮状态；同时检查本机是否存在未完成的批次
  useEffect(() => {
    if (!open) return;
    setStage('pick');
    setScan(null);
    setReport(null);
    setItems([]);
    setAlbumChoice('create');
    setFileChoice('overwrite');
    setPerFile({});
    setGroups([]);
    setGroupId('');
    setTransferred(0);
    setSettled(0);
    setTotalBytes(0);
    setResume(readPendingBatch());
    albumRef.current = null;
    failedRef.current = [];
    void loadUploadRules().then((loaded) => {
      if (loaded) setRules(loaded);
    });
  }, [open]);

  const patchItem = useCallback((key: string, patch: Partial<ItemState>): void => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const handlePick = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const list = Array.from(event.target.files ?? []);
      // 清空 value：否则再选同一个文件夹不会触发 change
      event.target.value = '';
      if (list.length === 0) return;
      setScanning(true);
      try {
        // 冲突比对需要全库照片的原始文件名与大小；相册列表用来找同名相册；分组列表给分组下拉
        const [photos, albums, groupList] = await Promise.all([
          photoApi.list(),
          albumApi.list(),
          albumGroupApi.list(),
        ]);
        const outcome = buildScan(list, rules, photos, albums, resume);
        if (outcome.accepted.length === 0) {
          message.warning(
            outcome.resumed
              ? '该文件夹中没有需要补传的文件，上一批次可能已完成上传'
              : '该文件夹的根目录下没有可上传的照片',
          );
          return;
        }
        setScan(outcome);
        setGroups(groupList);
        // 追加到已有相册时默认沿用该册当前分组，否则默认「默认分组」——避免用户的选择被意外修改
        setGroupId(outcome.album?.groupId ?? defaultGroupIdOf(groupList));
        // 续传时相册已经定下，不再问「追加还是新建」
        setAlbumChoice(outcome.album ? 'append' : 'create');
        setStage('confirm');
      } catch (error) {
        message.error(error instanceof Error ? error.message : '读取照片库失败，无法比对同名文件');
      } finally {
        setScanning(false);
      }
    },
    [message, resume, rules],
  );

  /** 该文件最终是传还是跳过 */
  const decisionOf = useCallback(
    (item: ScannedFile): Decision => {
      // 没冲突的直接传；'skip' 只对「库里有同名」的文件有意义
      if (!item.conflict) return 'upload';
      if (fileChoice === 'custom') return perFile[fileKeyOf(item.file)] ?? 'upload';
      return fileChoice === 'skip' ? 'skip' : 'upload';
    },
    [fileChoice, perFile],
  );

  const conflicts = useMemo(
    () => (scan?.accepted ?? []).filter((item) => item.conflict),
    [scan],
  );
  const targets = useMemo(
    () => (scan?.accepted ?? []).filter((item) => decisionOf(item) === 'upload'),
    [scan, decisionOf],
  );
  const skippedByDecision = (scan?.accepted.length ?? 0) - targets.length;
  const targetBytes = useMemo(() => targets.reduce((sum, item) => sum + item.size, 0), [targets]);
  /** 分组下拉候选：内置「默认分组」加标注，便于识别回退目标 */
  const groupOptions = useMemo(
    () => groups.map((group) => ({ label: group.builtin ? `${group.name}（默认）` : group.name, value: group.id })),
    [groups],
  );
  const percent = totalBytes === 0 ? 0 : Math.min(100, Math.round(((transferred + settled) / totalBytes) * 100));
  const uploading = stage === 'uploading';

  /**
   * 上传主循环：**多文件并发**，每个文件内部再按分片并发。
   *
   * 【为什么从「文件串行」改成「文件级并发」】原先的判断是「分片并发已占满带宽、文件再并行没有收益」，
   * 但该判断对「一个文件夹里数千张小图」并不成立：小图往往只有一片，串行等于一条连接依次等待 RTT，
   * 总耗时近似「文件数 × 往返时延」。多文件并发将等待时间重叠起来，才能真正占满带宽。
   *
   * 【并发总量怎么控】文件级 × 文件内分片级 ≈ 站点设置 upload.concurrency：
   * 只有一个文件时该文件独占全部并发（行为与改造前完全一致），文件较多时自动分摊为多文件并发。
   *
   * 【进度为什么仍然准确】每个文件的 onProgress 只累加进自己的 confirmedBytes 与共享的 transferred；
   * 文件结束时再把「未传输的字节」计入 settled。transferred + settled 恒等于总体积，
   * 进度条因此不会因为并发而提前达到 100%，也不会因某个文件中途失败而停滞不动。
   */
  const runUpload = async (list: readonly ScannedFile[], context: UploadContext): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStage('uploading');
    setItems(list.map((item) => ({ key: fileKeyOf(item.file), name: item.name, size: item.size, status: 'waiting' })));
    setTransferred(0);
    setSettled(0);
    setTotalBytes(list.reduce((sum, item) => sum + item.size, 0));

    const fileConcurrency = Math.max(1, Math.min(context.concurrency, list.length, MAX_FILE_CONCURRENCY));
    const chunkConcurrency = Math.max(1, Math.floor(context.concurrency / fileConcurrency));
    setParallelism({ files: fileConcurrency, chunks: chunkConcurrency });

    const planned = [...context.plannedIds];
    const failedItems: ScannedFile[] = [];
    /* 云端上传失败的文件：照片本身计为成功（已在本地），单独记录一份用于事后完整提示 */
    const cloudFailedItems: ScannedFile[] = [];
    /* 尚未传输成功的文件身份键 —— 即断点记录里的 files，成功一个即移除一个；
       中断 / 失败的文件因此自然保留在记录中，重开页面后可继续补传。 */
    const outstanding = new Set(list.map((item) => fileKeyOf(item.file)));
    let ok = 0;
    let fail = 0;
    let skipped = 0;
    let transferredBytes = 0;
    let settledBytes = 0;

    /** 处理一个文件：申领分片、实时上报进度，把结果（含失败）作为返回值返回，不向外抛出 */
    const uploadOne = async (item: ScannedFile): Promise<FileOutcome> => {
      const key = fileKeyOf(item.file);
      if (controller.signal.aborted) {
        patchItem(key, { status: 'skipped' });
        return { status: 'skipped', confirmedBytes: 0, cloudFailed: 0 };
      }
      patchItem(key, { status: 'uploading' });
      // 本文件已确认到达服务端的字节：只计其自身，避免并发文件之间互相干扰
      let confirmedBytes = 0;
      try {
        const result = await uploadFileInChunks(item.file, {
          concurrency: chunkConcurrency,
          // 同名且选择覆盖时传目标 id：服务端沿用它的落盘名，因此 id 不变、相册归属保持
          overwriteId: item.conflict?.id,
          onProgress: (delta) => {
            confirmedBytes += delta;
            transferredBytes += delta;
            setTransferred(transferredBytes);
          },
          signal: controller.signal,
        });
        patchItem(key, { status: 'done' });
        return {
          status: 'done',
          confirmedBytes,
          photoId: result.photo.id,
          // 本地已成功，云端副本可能缺失 —— 交由上层汇总提示
          cloudFailed: result.upload.failed,
        };
      } catch (error) {
        const aborted = controller.signal.aborted;
        const detail = error instanceof Error ? error.message : '上传失败';
        patchItem(key, aborted ? { status: 'skipped' } : { status: 'error', error: detail });
        return { status: aborted ? 'skipped' : 'error', confirmedBytes, cloudFailed: 0 };
      }
    };

    await runPool(list, fileConcurrency, async (item) => {
      const key = fileKeyOf(item.file);
      const outcome = await uploadOne(item);
      if (outcome.status === 'done') {
        ok += 1;
        if (outcome.photoId) planned.push(outcome.photoId);
        // 云端副本未全部成功的文件单独记录：文件本身计为成功，但需在报告中明确说明
        if (outcome.cloudFailed > 0) cloudFailedItems.push(item);
        // 仅传输成功的文件才被移除；中断 / 失败的文件保留，续传时仍需补传
        outstanding.delete(key);
      } else if (outcome.status === 'skipped') {
        skipped += 1;
      } else {
        fail += 1;
        failedItems.push(item);
      }
      /* 未传输的字节计入 settled：已上传的那部分由 onProgress 记在 transferred 里，
         两者相加恰好等于文件体积，进度条不会因某个文件中途失败而停留在中间位置。 */
      settledBytes += Math.max(0, item.size - outcome.confirmedBytes);
      setSettled(settledBytes);
      // 每个文件完成后即刷新一次断点记录：重开页面时据此确定剩余待传文件
      writePendingBatch({
        albumId: context.albumId,
        albumTitle: context.albumTitle,
        folderName: context.folderName,
        files: [...outstanding],
        plannedIds: planned,
      });
    });

    // 收尾：把本轮成功的照片并进相册
    let flushError = '';
    try {
      await flushPlannedToAlbum(context.albumId, planned);
    } catch (error) {
      flushError = error instanceof Error ? error.message : '并入相册失败';
    }
    albumRef.current = { id: context.albumId, title: context.albumTitle };
    failedRef.current = failedItems;

    const failedNames = failedItems.map((item) => item.name);
    /* 仅在全部成功完成时才清除断点；仍存在未传输成功（失败或被中止）或未归入相册的文件时，保留断点记录。
       被中止的文件必须计入 —— 否则用户点击「停止」反而会清除续传记录。 */
    if (fail === 0 && skipped === 0 && flushError === '') {
      clearPendingBatch();
    } else {
      writePendingBatch({
        albumId: context.albumId,
        albumTitle: context.albumTitle,
        folderName: context.folderName,
        files: [...outstanding],
        plannedIds: flushError ? planned : [],
      });
    }

    setReport({
      ok,
      fail,
      skipped,
      failedNames,
      flushError,
      cloudFailedNames: cloudFailedItems.map((item) => item.name),
    });
    setStage('done');
    if (ok > 0) onUploaded();
  };

  const handleStart = async (): Promise<void> => {
    if (!scan) return;
    const folderName = scan.folderName.trim() || '未命名文件夹';
    let albumId = '';
    let albumTitle = folderName;
    // 续传时相册已确定；否则按用户的处置：追加到同名相册 / 新建
    if (scan.resumed && resume) {
      albumId = resume.albumId;
      albumTitle = resume.albumTitle;
    } else if (scan.album && albumChoice === 'append') {
      albumId = scan.album.id;
      albumTitle = scan.album.title;
      // 追加同时改了分组选择：把该册也归到新分组（用户显式选过才动，未改则原样保留）
      if (groupId && scan.album.groupId !== groupId) {
        try {
          await albumApi.update(albumId, { groupId });
        } catch (error) {
          message.error(error instanceof Error ? error.message : '调整相册分组失败');
          return;
        }
      }
    } else {
      try {
        const created = await albumApi.create({ title: folderName, groupId: groupId || undefined });
        albumId = created.id;
        albumTitle = created.title;
      } catch (error) {
        message.error(error instanceof Error ? error.message : '创建相册失败');
        return;
      }
    }
    await runUpload(targets, {
      albumId,
      albumTitle,
      folderName,
      plannedIds: scan.resumed && resume ? resume.plannedIds : [],
      concurrency: rules.concurrency,
    });
  };

  const handleRetry = (): void => {
    const album = albumRef.current;
    if (!album || failedRef.current.length === 0) return;
    void runUpload(failedRef.current, {
      albumId: album.id,
      albumTitle: album.title,
      folderName: scan?.folderName ?? album.title,
      // 上一轮没归册的 id 还在断点里，重试后一并补上
      plannedIds: readPendingBatch()?.plannedIds ?? [],
      concurrency: rules.concurrency,
    });
  };

  const handleAbandonResume = (): void => {
    clearPendingBatch();
    setResume(null);
    message.info('已放弃续传；服务端的临时分片会在下次同名上传时重新利用');
  };

  const footer = ((): React.ReactNode => {
    if (stage === 'confirm') {
      return (
        <Space>
          <span className="t-qua" style={{ fontSize: 11 }}>
            将上传 {targets.length} 个文件（{formatBytes(targetBytes)}）
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={targets.length === 0} onClick={() => void handleStart()}>
            开始上传
          </Button>
        </Space>
      );
    }
    if (uploading) {
      return (
        <Space>
          <span className="t-qua" style={{ fontSize: 11 }}>
            {formatBytes(transferred)} / {formatBytes(totalBytes)}
          </span>
          <Button onClick={() => abortRef.current?.abort()}>停止</Button>
        </Space>
      );
    }
    if (stage === 'done') {
      return (
        <Space>
          {failedRef.current.length > 0 && <Button onClick={handleRetry}>重试失败的文件</Button>}
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </Space>
      );
    }
    return (
      <Space>
        <Button onClick={onClose}>关闭</Button>
      </Space>
    );
  })();

  return (
    <>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={handlePick} />
      <Modal
        open={open}
        width={760}
        title="文件夹上传"
        footer={footer}
        onCancel={uploading ? () => abortRef.current?.abort() : onClose}
        maskClosable={!uploading}
      >
        {stage === 'pick' && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {resume && (
              <Alert
                type="warning"
                showIcon
                message={`上次有一批上传未完成：文件夹「${resume.folderName}」还剩 ${resume.files.length} 个文件`}
                description="重新选择同一文件夹即可从断点继续 —— 已完成的分片保存在服务端，不会重复传输。"
                action={<Button size="small" onClick={handleAbandonResume}>放弃续传</Button>}
              />
            )}
            <Alert
              type="info"
              showIcon
              message="选中的文件夹会变成一个相册"
              description="相册标题取文件夹名；只收根目录下的照片，子文件夹会被跳过。上传前会先比对同名相册与同名文件，由用户决定处理方式。"
            />
            <Button type="primary" loading={scanning} onClick={() => inputRef.current?.click()}>
              选择文件夹
            </Button>
          </Space>
        )}

        {stage === 'confirm' && scan && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div className="t-sec" style={{ fontSize: 12 }}>
              文件夹「{scan.folderName}」：待上传 {scan.accepted.length} 个（{formatBytes(targetBytes)}）
              {scan.alreadyDone > 0 && `，其中 ${scan.alreadyDone} 个已完成传输，无需重复上传`}
              {scan.subdirs.length > 0 && `；跳过子文件夹 ${scan.subdirs.length} 个`}
              {scan.rejected.length > 0 && `；格式或体积不符 ${scan.rejected.length} 个`}
            </div>

            {scan.subdirs.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`已跳过 ${scan.subdirs.length} 个子文件夹（本期只收根目录下的照片）`}
                description={scan.subdirs.slice(0, 8).join('、') + (scan.subdirs.length > 8 ? ' 等' : '')}
              />
            )}

            {scan.rejected.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`已跳过 ${scan.rejected.length} 个不符合规则的文件`}
                description={scan.rejected
                  .slice(0, 5)
                  .map((item) => `${item.name}（${item.reason}）`)
                  .join('；') + (scan.rejected.length > 5 ? ' 等' : '')}
              />
            )}

            {scan.resumed && resume ? (
              <Alert
                type="info"
                showIcon
                message={`续传目标：相册「${resume.albumTitle}」`}
                description="续传不会新建相册，上传完成的照片会追加到这个相册里。"
              />
            ) : scan.album ? (
              <div>
                <div className="t-sec" style={{ fontSize: 12, marginBottom: 6 }}>
                  已存在同名相册「{scan.album.title}」（{scan.album.count} 张）
                </div>
                <Radio.Group value={albumChoice} onChange={(event) => setAlbumChoice(event.target.value as AlbumChoice)}>
                  <Space direction="vertical">
                    <Radio value="append">把照片追加到已有相册</Radio>
                    <Radio value="create">另建一个同名相册</Radio>
                    <Radio value="skip">放弃本次上传</Radio>
                  </Space>
                </Radio.Group>
              </div>
            ) : (
              <div className="t-sec" style={{ fontSize: 12 }}>
                将新建相册「{scan.folderName}」
              </div>
            )}

            {/* 目标分组：新建时决定新册归属，追加时把该册改挂到所选分组（续传不动分组） */}
            {scan.resumed && resume ? null : (
              <div>
                <div className="t-sec" style={{ fontSize: 12, marginBottom: 6 }}>
                  归入分组
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={groupId || undefined}
                  onChange={setGroupId}
                  options={groupOptions}
                  placeholder="选择分组"
                />
                <div className="t-qua" style={{ fontSize: 11, marginTop: 4 }}>
                  {scan.album && albumChoice === 'append'
                    ? '追加到已有相册时，改这里会同时把该相册移动到新分组'
                    : '默认归入「默认分组」'}
                </div>
              </div>
            )}

            {conflicts.length > 0 && (
              <div>
                <div className="t-sec" style={{ fontSize: 12, marginBottom: 6 }}>
                  有 {conflicts.length} 个文件与库中已有照片同名同大小
                </div>
                <Radio.Group value={fileChoice} onChange={(event) => setFileChoice(event.target.value as FileChoice)}>
                  <Space direction="vertical">
                    <Radio value="overwrite">全部覆盖（原地替换文件，保留原 id、相册归属与编辑过的信息）</Radio>
                    <Radio value="skip">全部跳过，不传这些文件</Radio>
                    <Radio value="custom">逐条选择</Radio>
                  </Space>
                </Radio.Group>

                {fileChoice === 'custom' && (
                  <Collapse
                    size="small"
                    style={{ marginTop: 8 }}
                    items={[
                      {
                        key: 'list',
                        label: `展开逐条选择（${conflicts.length} 个）`,
                        children: (
                          <div className="upload-progress__list">
                            {conflicts.map((item) => {
                              const key = fileKeyOf(item.file);
                              return (
                                <div key={key} className="upload-progress__row">
                                  <span className="upload-progress__name">
                                    {item.name}
                                    <span className="t-qua" style={{ fontSize: 11 }}>
                                      {' '}
                                      → 库中「{item.conflict?.title || item.conflict?.id}」
                                    </span>
                                  </span>
                                  <Radio.Group
                                    size="small"
                                    value={perFile[key] ?? 'upload'}
                                    onChange={(event) =>
                                      setPerFile((prev) => ({ ...prev, [key]: event.target.value as Decision }))
                                    }
                                    optionType="button"
                                    buttonStyle="solid"
                                    options={[
                                      { label: '覆盖', value: 'upload' },
                                      { label: '跳过', value: 'skip' },
                                    ]}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            )}

            {skippedByDecision > 0 && (
              <div className="t-qua" style={{ fontSize: 11 }}>
                按当前选择，本次将跳过 {skippedByDecision} 个文件
              </div>
            )}

            <div className="upload-progress">
              <div className="upload-progress__head">
                <span className="t-sec" style={{ fontSize: 12 }}>
                  文件清单
                </span>
              </div>
              <div className="upload-progress__list">
                {scan.accepted.slice(0, 200).map((item) => (
                  <div key={fileKeyOf(item.file)} className="upload-progress__row">
                    <span className="upload-progress__name">{item.name}</span>
                    <span className="t-qua" style={{ fontSize: 11 }}>
                      {formatBytes(item.size)}
                    </span>
                    {item.conflict && <Tag color="orange">同名</Tag>}
                  </div>
                ))}
                {scan.accepted.length > 200 && (
                  <div className="t-qua" style={{ fontSize: 11 }}>
                    仅列出前 200 个，其余 {scan.accepted.length - 200} 个同样会上传
                  </div>
                )}
              </div>
            </div>
          </Space>
        )}

        {uploading && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Progress percent={percent} />
            <Tooltip title="分片上传：中断后重新选同一个文件夹即可从断点继续">
              <span className="t-qua" style={{ fontSize: 11 }}>
                已传输 {formatBytes(transferred)} / 共 {formatBytes(totalBytes)}；同时上传 {parallelism.files} 个文件，
                每个文件 {parallelism.chunks} 片并发（每片 {rules.chunkMb} MB）
              </span>
            </Tooltip>
            <div className="upload-progress__list">
              {items.map((item) => (
                <div key={item.key} className="upload-progress__row">
                  <span className="upload-progress__name">{item.name}</span>
                  <span className="t-qua" style={{ fontSize: 11 }}>
                    {formatBytes(item.size)}
                  </span>
                  {item.status === 'waiting' && <Tag>等待</Tag>}
                  {item.status === 'uploading' && <Tag color="processing">上传中</Tag>}
                  {item.status === 'done' && <Tag color="green">已完成</Tag>}
                  {item.status === 'skipped' && <Tag>已停止</Tag>}
                  {item.status === 'error' && <Tag color="red">{item.error ?? '失败'}</Tag>}
                </div>
              ))}
            </div>
          </Space>
        )}

        {stage === 'done' && report && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div className="t-sec" style={{ fontSize: 13 }}>
              成功 {report.ok} 个 · 失败 {report.fail} 个 · 未传 {report.skipped} 个
              {albumRef.current && `；照片已并入相册「${albumRef.current.title}」`}
            </div>
            {report.failedNames.length > 0 && (
              <Alert
                type="error"
                showIcon
                message={`${report.failedNames.length} 个文件未传输完成`}
                description={
                  report.failedNames.slice(0, 8).join('、') +
                  (report.failedNames.length > 8 ? ' 等' : '') +
                  '；点击「重试失败的文件」将从断点继续，无需重传已完成的分片。'
                }
              />
            )}
            {report.flushError && (
              <Alert
                type="warning"
                showIcon
                message="照片已上传，但并入相册时出错"
                description={`${report.flushError}；照片本身未丢失，可在相册管理中手动加入，或点击「重试失败的文件」重试一次。`}
              />
            )}
            {report.cloudFailedNames.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`${report.cloudFailedNames.length} 张照片未同步到云端`}
                description={
                  report.cloudFailedNames.slice(0, 8).join('、') +
                  (report.cloudFailedNames.length > 8 ? ' 等' : '') +
                  '；照片已上传并入库，本机与前台均不受影响，仅对象存储中缺少一份异地副本。' +
                  '可在服务器上执行 npm run backfill:objects 补传。'
                }
              />
            )}
            {report.ok > 0 && report.fail === 0 && report.cloudFailedNames.length === 0 && (
              <Alert type="success" showIcon message="本次上传已全部完成" />
            )}
          </Space>
        )}
      </Modal>
    </>
  );
}