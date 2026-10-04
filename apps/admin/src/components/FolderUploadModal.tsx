/**
 * apps/admin/src/components/FolderUploadModal.tsx
 *
 * 文件夹上传：一次可选多个本地文件夹 → 每个文件夹各建 / 各追加同名相册 → 分片上传并并入相册。
 *
 * 【结构只收一级】浏览器给的相对路径形如「旅行/2024/a.jpg」，出现第三段就是子文件夹里的内容；
 * 本期只收所选文件夹根目录下的照片，子文件夹整体跳过，并在界面上明确说明跳过范围与数量。
 * 【为什么先看清单再传】所选文件夹先整体扫描成树形清单（文件夹根 → 文件），
 * 逐文件勾选、同名文件明确标出，确认后再开始传输 —— 见 lib/uploadPlan 与 UploadPlanTree。
 * 【为什么先建相册再传】断线时才确定照片应归入哪个相册；每张传完立即补上相册归属，
 * 中途中断也不会留下一批「已上传但不属于任何相册」的孤儿照片。
 * 【断点续传靠身份对齐】分片留在服务端，本机仅记录「哪些文件尚未传输完成」与「各相册尚未并入的照片」；
 * 重开页面会提醒续传，用户重新选择同一批文件夹后以「名 / 大小 / 修改时间」匹配回原文件。
 * 【并发分两层】文件之间并发、每个文件内部再按分片并发，两层乘积贴近站点设置 upload.concurrency
 * （只有一个文件时全部并发分配给该文件，文件较多时自动分摊；见 runUpload）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Modal, Progress, Radio, Select, Space, Tag, Tooltip } from 'antd';
import type { Photo } from '@shaping-memory/core';
import { albumApi, albumGroupApi, photoApi } from '@shaping-memory/sdk';
import type { Album, AlbumGroup } from '@shaping-memory/sdk';

import { uploadFileInChunks } from '../lib/chunkUpload';
import { formatBytes } from '../lib/format';
import { clearPendingBatch, readPendingBatch, writePendingBatch } from '../lib/pendingBatch';
import type { PendingAlbum, PendingBatch } from '../lib/pendingBatch';
import { runPool } from '../lib/pool';
import { FALLBACK_RULES, loadUploadRules } from '../lib/uploadRules';
import type { UploadRules } from '../lib/uploadRules';
import {
  allCandidatesOf,
  buildNameIndex,
  classifyFiles,
  overwritableCandidatesOf,
  selectedCandidatesOf,
} from '../lib/uploadPlan';
import type { RejectedFile, UploadCandidate, UploadRoot } from '../lib/uploadPlan';
import { UploadPlanTree } from './UploadPlanTree';

/**
 * 文件级并发上限：浏览器对同一域名（HTTP/1.1）一般只开 6 条连接，
 * 超过该值并不会更快，只是将请求排入浏览器自身的队列 —— 反而使进度显示失真。
 */
const MAX_FILE_CONCURRENCY = 6;

/** 同名相册的处置方式；skip = 放弃本次上传 */
type AlbumChoice = 'append' | 'create' | 'skip';
type Stage = 'pick' | 'confirm' | 'uploading' | 'done';

/** 一次选择（点击或拖拽）得到的一个文件夹：根目录文件 + 被跳过的子目录 */
interface PickedFolder {
  name: string;
  files: File[];
  subdirs: string[];
}

/** 清单里的一个文件夹根：候选文件（续传时只留断点中的那些）与相册归属 */
interface FolderPlan {
  name: string;
  candidates: UploadCandidate[];
  /** 库中的同名相册（标题相同）；没有则为空 */
  album: Album | null;
  subdirs: string[];
  /** 续传时判定为「已传输完成、无需重复上传」的文件数 */
  alreadyDone: number;
  /** 该文件夹是否命中了上次的断点记录 */
  resumed: boolean;
}

interface ScanOutcome {
  folders: FolderPlan[];
  rejected: RejectedFile[];
  /** 全部被跳过的子目录（带所属文件夹名前缀，去重后用于告警） */
  subdirs: string[];
  resumed: boolean;
  alreadyDone: number;
}

interface ItemState {
  key: string;
  name: string;
  size: number;
  status: 'waiting' | 'uploading' | 'done' | 'error' | 'skipped';
  error?: string;
}

/** 一个待上传文件与其所属文件夹的绑定：相册归属按文件夹决定 */
interface UploadEntry {
  candidate: UploadCandidate;
  folder: string;
}

/** 一个文件夹的相册目标 */
interface AlbumTarget {
  id: string;
  title: string;
  /** 已上传但尚未并入该相册的照片 id（续传时来自断点记录） */
  plannedIds: string[];
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
  /** 本批涉及的相册标题（报告里如实说明照片去了哪里） */
  albumTitles: string[];
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

/**
 * 把 <input webkitdirectory multiple> 的结果按文件夹根分组。
 * 相对路径首段即所选文件夹名；出现第三段即表明该文件位于某个子文件夹中，整体跳过。
 */
function foldersFromPicked(list: readonly File[]): PickedFolder[] {
  const buckets = new Map<string, PickedFolder>();
  for (const file of list) {
    const parts = relativePartsOf(file);
    const name = parts[0];
    if (!name) continue;
    const bucket = buckets.get(name) ?? { name, files: [], subdirs: [] };
    if (parts.length > 2) {
      const subdir = parts.slice(1, -1).join('/');
      if (!bucket.subdirs.includes(subdir)) bucket.subdirs.push(subdir);
    } else {
      bucket.files.push(file);
    }
    buckets.set(name, bucket);
  }
  return [...buckets.values()];
}

/**
 * 读尽一个目录的全部直接子项。
 *
 * 【为什么必须循环读】readEntries 一次最多返回 100 项，且**不报错**：只调一次时
 * 超过 100 项的文件夹会被静默截断（表现为「文件夹里的照片少了一批」），是最难排查的一类失效。
 * 因此反复读取，直到返回空数组才认为读完。
 */
async function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function fileOfEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** 拖入的一个目录：只遍历根目录一层，子目录名记入告警并整体跳过（与点击选择的口径一致） */
async function collectDroppedFolder(entry: FileSystemDirectoryEntry): Promise<PickedFolder> {
  const folder: PickedFolder = { name: entry.name, files: [], subdirs: [] };
  const children = await readEntries(entry.createReader());
  for (const child of children) {
    if (child.isFile) {
      folder.files.push(await fileOfEntry(child as FileSystemFileEntry));
    } else if (child.isDirectory) {
      folder.subdirs.push(child.name);
    }
  }
  return folder;
}

/**
 * 拖拽落下时的文件夹收集：目录逐个读取；散落的单个文件不计入（那属于「上传照片」）。
 *
 * 【为什么必须先同步取完全部 entry，再异步读取】DataTransferItem 的生命周期只覆盖 drop 事件的
 * 同步阶段：一旦 await 过，浏览器就可能回收它，此后 webkitGetAsEntry() 返回 null。
 * 若边遍历边 await，从第二个文件夹起都会被判为「不是目录」而静默丢弃 ——
 * 用户看到的现象正是「拖入 3 个文件夹，只读到了 1 个」。
 * 因此这里先把全部目录 entry 同步取出来，再逐个异步读取。
 *
 * 【为什么用下标遍历而不是 forEach / for...of】DataTransferItemList 并非真正的数组，
 * 用下标访问最稳妥，也避免在遍历中混入异步操作。
 */
async function foldersFromDrop(items: DataTransferItemList): Promise<PickedFolder[]> {
  const entries: FileSystemDirectoryEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index].webkitGetAsEntry();
    if (entry?.isDirectory) entries.push(entry as FileSystemDirectoryEntry);
  }

  const folders: PickedFolder[] = [];
  for (const entry of entries) folders.push(await collectDroppedFolder(entry));
  return folders;
}

/**
 * 合并两次选择的文件夹：文件夹名相同即视为同一个根，后选的那次覆盖先选的。
 *
 * 【为什么要合并】浏览器的目录选择对话框一次只允许选中一个文件夹（见 input 的 webkitdirectory 说明），
 * 用户往往需要分多次点选才能凑齐多个；只做替换的话，后一次会把先前的选择整批丢掉。
 * 【为什么按文件夹名去重】同名根各留一份会在清单里出现两个同名文件夹，相册归属也会撞在一起；
 * 保留后选的那份，语义是「以最后一次选中的内容为准」。
 */
function mergePicked(prev: readonly PickedFolder[], next: readonly PickedFolder[]): PickedFolder[] {
  const merged = new Map(prev.map((folder) => [folder.name, folder]));
  for (const folder of next) merged.set(folder.name, folder);
  return [...merged.values()];
}

/** 默认分组 id：优先内置的「默认分组」（服务端保证它一定存在），否则回退取列表首项 */
function defaultGroupIdOf(list: readonly AlbumGroup[]): string {
  return list.find((group) => group.builtin)?.id ?? list[0]?.id ?? '';
}

/**
 * 扫描所选文件夹：结构过滤（只收根目录）+ 格式体积校验 + 同名比对 + 断点匹配。
 * 不发写请求；同名索引、相册列表与断点记录由调用方先准备好。
 */
function buildScan(
  picked: readonly PickedFolder[],
  rules: UploadRules,
  photos: readonly Photo[],
  albums: readonly Album[],
  resume: PendingBatch | null,
): ScanOutcome {
  const index = buildNameIndex(photos);
  const folders: FolderPlan[] = [];
  const rejected: RejectedFile[] = [];
  const subdirs: string[] = [];
  let resumed = false;
  let alreadyDone = 0;

  for (const folder of picked) {
    const { accepted, rejected: blocked } = classifyFiles(folder.files, rules, index);
    rejected.push(...blocked);
    subdirs.push(...folder.subdirs.map((subdir) => `${folder.name}/${subdir}`));

    /* 续传仅在「重新选择了同一文件夹」时成立：换文件夹说明用户已改变选择，
       按普通新批次处理，否则会被断点记录过滤为空列表。 */
    const hitResume = resume !== null && resume.folderNames.includes(folder.name);
    const pending = hitResume ? resume.files : null;
    const candidates = pending ? accepted.filter((item) => pending.includes(item.key)) : accepted;
    if (hitResume) resumed = true;
    alreadyDone += accepted.length - candidates.length;
    // 没有待补传文件的文件夹不进清单，也不建相册
    if (candidates.length === 0) continue;

    folders.push({
      name: folder.name,
      candidates,
      album: albums.find((item) => item.title === folder.name) ?? null,
      subdirs: folder.subdirs,
      alreadyDone: accepted.length - candidates.length,
      resumed: hitResume,
    });
  }

  return { folders, rejected, subdirs, resumed, alreadyDone };
}

/** 把本批上传成功的照片并进相册：现有成员 ∪ 本轮新增，顺序按加入先后 */
async function flushPlannedToAlbum(albumId: string, plannedIds: readonly string[]): Promise<void> {
  if (plannedIds.length === 0) return;
  const detail = await albumApi.detail(albumId);
  const existing = detail.photos.map((photo) => photo.id);
  const merged = [...existing, ...plannedIds.filter((id) => !existing.includes(id))];
  await albumApi.setMedia(albumId, merged);
}

/** 断点记录中的相册段：由「本次的相册目标 + 当前待并入的 id」实时生成 */
function pendingAlbumsOf(targets: ReadonlyMap<string, AlbumTarget>, planned: ReadonlyMap<string, string[]>): PendingAlbum[] {
  return [...targets].map(([folderName, target]) => ({
    folderName,
    albumId: target.id,
    albumTitle: target.title,
    plannedIds: planned.get(folderName) ?? [],
  }));
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
  const [dragging, setDragging] = useState(false);
  const [rules, setRules] = useState<UploadRules>(FALLBACK_RULES);
  const [albumChoice, setAlbumChoice] = useState<AlbumChoice>('create');
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [overwriteKeys, setOverwriteKeys] = useState<Set<string>>(new Set());
  /** 可选分组（本次新建 / 追加的相册要归到哪个分组） */
  const [groups, setGroups] = useState<AlbumGroup[]>([]);
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
  const albumRef = useRef<{ targets: Map<string, AlbumTarget> } | null>(null);
  /** 失败的条目（供「重试失败的文件」用） */
  const failedRef = useRef<UploadEntry[]>([]);
  /**
   * 本轮已加入的原始文件夹（按文件夹名去重）。
   * 【为什么用 ref 而不是 state】它只在用户点选 / 拖入时变更，且每次追加都要基于「最新一份」再合并；
   * 放进 state 就得在 setState 的更新函数里发起扫描（副作用），在并发渲染下可能重复执行。
   */
  const pickedRef = useRef<PickedFolder[]>([]);
  /**
   * 上一轮清单里的候选键全集：追加文件夹时用它区分「用户主动取消过勾选」与「本次新加入」，
   * 否则每追加一个文件夹都会把用户已做的勾选全部重置为默认值。
   */
  const plannedKeysRef = useRef<Set<string>>(new Set());

  /* webkitdirectory 不是标准属性，React 不支持该属性，只能在挂载后手动设置 ——
     设置后该选择器只选择文件夹。注意：多数浏览器（含 Chrome）的目录选择对话框只允许
     选中一个文件夹并忽略 multiple，因此多文件夹有两条路径：拖拽一次拖入多个，
     或反复点选由 appendPicked 累加。multiple 仍保留，以兼容少数支持多选目录的实现。 */
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
    setDragging(false);
    setAlbumChoice('create');
    setCheckedKeys([]);
    setOverwriteKeys(new Set());
    setGroups([]);
    setGroupId('');
    setTransferred(0);
    setSettled(0);
    setTotalBytes(0);
    setResume(readPendingBatch());
    albumRef.current = null;
    failedRef.current = [];
    pickedRef.current = [];
    plannedKeysRef.current = new Set();
    void loadUploadRules().then((loaded) => {
      if (loaded) setRules(loaded);
    });
  }, [open]);

  const patchItem = useCallback((key: string, patch: Partial<ItemState>): void => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  /** 文件夹选择完成后的统一入口：比对同名 → 生成清单 → 进确认页 */
  const prepare = useCallback(
    async (picked: PickedFolder[]): Promise<void> => {
      setScanning(true);
      try {
        // 同名比对需要全库照片的原始文件名与大小；相册列表用来找同名相册；分组列表给分组下拉
        const [photos, albums, groupList] = await Promise.all([
          photoApi.list(),
          albumApi.list(),
          albumGroupApi.list(),
        ]);
        const outcome = buildScan(picked, rules, photos, albums, resume);
        if (outcome.folders.length === 0) {
          message.warning(
            outcome.resumed
              ? '所选文件夹中没有需要补传的文件，上一批次可能已完成上传'
              : '所选文件夹的根目录下没有可上传的照片',
          );
          return;
        }
        const roots: UploadRoot[] = outcome.folders.map((folder) => ({
          name: folder.name,
          candidates: folder.candidates,
        }));
        /* 追加文件夹时不得重置用户已做的选择。planned 必须在写回 ref 之前取出，
           否则下面两个更新函数会读到新一轮的键集，失去「新旧之分」。 */
        const planned = plannedKeysRef.current;
        const isFirstScan = planned.size === 0;
        const keys = allCandidatesOf(roots).map((candidate) => candidate.key);

        setScan(outcome);
        setGroups(groupList);
        if (isFirstScan) {
          // 追加到已有相册时默认沿用首个同名册的分组，否则默认「默认分组」——避免用户的选择被意外修改
          setGroupId(outcome.folders[0]?.album?.groupId ?? defaultGroupIdOf(groupList));
          // 续传时相册已经定下，不再问「追加还是新建」
          setAlbumChoice(outcome.folders.some((folder) => folder.album && !folder.resumed) ? 'append' : 'create');
        }
        setCheckedKeys((prev) => {
          const kept = new Set(prev);
          // 已出现过的候选沿用用户此前的勾选；本次新加入的候选默认勾选
          return keys.filter((key) => !planned.has(key) || kept.has(key));
        });
        // 默认沿用既有行为：同名且同大小的项按「覆盖原有照片」处理，用户可在清单里逐条改回
        setOverwriteKeys((prev) => {
          const next = new Set<string>();
          for (const candidate of overwritableCandidatesOf(roots)) {
            if (!planned.has(candidate.key) || prev.has(candidate.key)) next.add(candidate.key);
          }
          return next;
        });
        plannedKeysRef.current = new Set(keys);
        setStage('confirm');
      } catch (error) {
        message.error(error instanceof Error ? error.message : '读取照片库失败，无法比对同名文件');
      } finally {
        setScanning(false);
      }
    },
    [message, resume, rules],
  );

  /**
   * 追加一批新选的文件夹：先与本轮已加入的合并，再整体重新扫描。
   * 合并而非替换，是「选完一个再选一个」凑齐多个文件夹一次上传的前提。
   */
  const appendPicked = useCallback(
    (incoming: PickedFolder[]): void => {
      if (incoming.length === 0) return;
      pickedRef.current = mergePicked(pickedRef.current, incoming);
      void prepare(pickedRef.current);
    },
    [prepare],
  );

  /** 清空重选：丢弃本轮已加入的全部文件夹，回到选择阶段 */
  const clearPicked = useCallback((): void => {
    pickedRef.current = [];
    plannedKeysRef.current = new Set();
    setScan(null);
    setCheckedKeys([]);
    setOverwriteKeys(new Set());
    setStage('pick');
  }, []);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const list = Array.from(event.target.files ?? []);
      // 清空 value：否则再选同一批文件夹不会触发 change
      event.target.value = '';
      if (list.length === 0) return;
      appendPicked(foldersFromPicked(list));
    },
    [appendPicked],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
      event.preventDefault();
      setDragging(false);
      const picked = await foldersFromDrop(event.dataTransfer.items);
      if (picked.length === 0) {
        message.warning('未识别到文件夹：请拖入文件夹本身（散落的单个文件请用「上传照片」）');
        return;
      }
      appendPicked(picked);
    },
    [appendPicked, message],
  );

  const roots: UploadRoot[] = useMemo(
    () =>
      (scan?.folders ?? []).map((folder) => ({ name: folder.name, candidates: folder.candidates })),
    [scan],
  );
  const targets = useMemo(() => selectedCandidatesOf(roots, checkedKeys), [roots, checkedKeys]);
  const targetBytes = useMemo(() => targets.reduce((sum, item) => sum + item.size, 0), [targets]);
  const namedAlbums = useMemo(() => (scan?.folders ?? []).filter((folder) => folder.album), [scan]);
  /** 分组下拉候选：内置「默认分组」加标注，便于识别回退目标 */
  const groupOptions = useMemo(
    () => groups.map((group) => ({ label: group.builtin ? `${group.name}（默认）` : group.name, value: group.id })),
    [groups],
  );
  const percent = totalBytes === 0 ? 0 : Math.min(100, Math.round(((transferred + settled) / totalBytes) * 100));
  const uploading = stage === 'uploading';

  /**
   * 上传主循环：**多文件并发**，每个文件内部再按分片并发；相册归属按文件所属文件夹决定。
   *
   * 【并发总量怎么控】文件级 × 文件内分片级 ≈ 站点设置 upload.concurrency：
   * 只有一个文件时该文件独占全部并发，文件较多时自动分摊为多文件并发。
   * 【进度为什么仍然准确】每个文件的 onProgress 只累加进自己的 confirmedBytes 与共享的 transferred；
   * 文件结束时再把「未传输的字节」计入 settled。transferred + settled 恒等于总体积，
   * 进度条因此不会因为并发而提前达到 100%，也不会因某个文件中途失败而停滞不动。
   */
  const runUpload = async (
    list: readonly UploadEntry[],
    albumTargets: Map<string, AlbumTarget>,
    concurrency: number,
  ): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStage('uploading');
    setItems(
      list.map((entry) => ({
        key: entry.candidate.key,
        name: entry.candidate.name,
        size: entry.candidate.size,
        status: 'waiting',
      })),
    );
    setTransferred(0);
    setSettled(0);
    setTotalBytes(list.reduce((sum, entry) => sum + entry.candidate.size, 0));

    const fileConcurrency = Math.max(1, Math.min(concurrency, list.length, MAX_FILE_CONCURRENCY));
    const chunkConcurrency = Math.max(1, Math.floor(concurrency / fileConcurrency));
    setParallelism({ files: fileConcurrency, chunks: chunkConcurrency });

    /* 各相册待并入的照片：从断点带来的旧 id 起算，每传完一张追加一个 */
    const planned = new Map<string, string[]>(
      [...albumTargets].map(([folderName, target]) => [folderName, [...target.plannedIds]]),
    );
    const failedItems: UploadEntry[] = [];
    /* 云端上传失败的文件：照片本身计为成功（已在本地），单独记录一份用于事后完整提示 */
    const cloudFailedItems: UploadEntry[] = [];
    /* 尚未传输成功的文件身份键 —— 即断点记录里的 files，成功一个即移除一个；
       中断 / 失败的文件因此自然保留在记录中，重开页面后可继续补传。 */
    const outstanding = new Set(list.map((entry) => entry.candidate.key));
    let ok = 0;
    let fail = 0;
    let skipped = 0;
    let transferredBytes = 0;
    let settledBytes = 0;

    /** 处理一个文件：申领分片、实时上报进度，把结果（含失败）作为返回值返回，不向外抛出 */
    const uploadOne = async (entry: UploadEntry): Promise<FileOutcome> => {
      const { candidate } = entry;
      if (controller.signal.aborted) {
        patchItem(candidate.key, { status: 'skipped' });
        return { status: 'skipped', confirmedBytes: 0, cloudFailed: 0 };
      }
      patchItem(candidate.key, { status: 'uploading' });
      // 本文件已确认到达服务端的字节：只计其自身，避免并发文件之间互相干扰
      let confirmedBytes = 0;
      try {
        const result = await uploadFileInChunks(candidate.file, {
          concurrency: chunkConcurrency,
          // 同名且用户选择覆盖时传目标 id：服务端沿用它的落盘名，因此 id 不变、相册归属保持
          overwriteId: candidate.canOverwrite && overwriteKeys.has(candidate.key)
            ? candidate.sameName?.id
            : undefined,
          onProgress: (delta) => {
            confirmedBytes += delta;
            transferredBytes += delta;
            setTransferred(transferredBytes);
          },
          signal: controller.signal,
        });
        patchItem(candidate.key, { status: 'done' });
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
        patchItem(candidate.key, aborted ? { status: 'skipped' } : { status: 'error', error: detail });
        return { status: aborted ? 'skipped' : 'error', confirmedBytes, cloudFailed: 0 };
      }
    };

    await runPool(list, fileConcurrency, async (entry) => {
      const outcome = await uploadOne(entry);
      if (outcome.status === 'done') {
        ok += 1;
        if (outcome.photoId) planned.get(entry.folder)?.push(outcome.photoId);
        // 云端副本未全部成功的文件单独记录：文件本身计为成功，但需在报告中明确说明
        if (outcome.cloudFailed > 0) cloudFailedItems.push(entry);
        // 仅传输成功的文件才被移除；中断 / 失败的文件保留，续传时仍需补传
        outstanding.delete(entry.candidate.key);
      } else if (outcome.status === 'skipped') {
        skipped += 1;
      } else {
        fail += 1;
        failedItems.push(entry);
      }
      /* 未传输的字节计入 settled：已上传的那部分由 onProgress 记在 transferred 里，
         两者相加恰好等于文件体积，进度条不会因某个文件中途失败而停留在中间位置。 */
      settledBytes += Math.max(0, entry.candidate.size - outcome.confirmedBytes);
      setSettled(settledBytes);
      // 每个文件完成后即刷新一次断点记录：重开页面时据此确定剩余待传文件
      writePendingBatch({
        folderNames: [...albumTargets.keys()],
        files: [...outstanding],
        albums: pendingAlbumsOf(albumTargets, planned),
      });
    });

    // 收尾：把本轮成功的照片各自并进所属相册
    let flushError = '';
    try {
      for (const [folderName, target] of albumTargets) {
        await flushPlannedToAlbum(target.id, planned.get(folderName) ?? []);
      }
    } catch (error) {
      flushError = error instanceof Error ? error.message : '并入相册失败';
    }
    albumRef.current = { targets: albumTargets };
    failedRef.current = failedItems;

    /* 仅在全部成功完成时才清除断点；仍存在未传输成功（失败或被中止）或未归入相册的文件时，保留断点记录。
       被中止的文件必须计入 —— 否则用户点击「停止」反而会清除续传记录。
       并入成功时清空待并入 id（它们已进相册），仅保留尚未传完的文件。 */
    if (fail === 0 && skipped === 0 && flushError === '') {
      clearPendingBatch();
    } else {
      writePendingBatch({
        folderNames: [...albumTargets.keys()],
        files: [...outstanding],
        albums: flushError
          ? pendingAlbumsOf(albumTargets, planned)
          : pendingAlbumsOf(albumTargets, new Map()),
      });
    }

    setReport({
      ok,
      fail,
      skipped,
      failedNames: failedItems.map((entry) => entry.candidate.name),
      flushError,
      cloudFailedNames: cloudFailedItems.map((entry) => entry.candidate.name),
      albumTitles: [...albumTargets.values()].map((target) => target.title),
    });
    setStage('done');
    if (ok > 0) onUploaded();
  };

  /**
   * 定下一个文件夹的相册：续传沿用原相册；否则按用户对同名相册的处置追加到已有册或新建。
   * 相册归属必须在传输前确定 —— 否则中断时会留下不属于任何相册的孤儿照片。
   */
  const resolveAlbum = async (folder: FolderPlan, choice: AlbumChoice): Promise<AlbumTarget> => {
    const resumable = resume?.albums.find((item) => item.folderName === folder.name);
    if (folder.resumed && resumable) {
      return { id: resumable.albumId, title: resumable.albumTitle, plannedIds: resumable.plannedIds };
    }
    if (folder.album && choice === 'append') {
      // 追加同时改了分组选择：把该册也归到新分组（用户显式选过才动，未改则原样保留）
      if (groupId && folder.album.groupId !== groupId) await albumApi.update(folder.album.id, { groupId });
      return { id: folder.album.id, title: folder.album.title, plannedIds: [] };
    }
    const created = await albumApi.create({ title: folder.name, groupId: groupId || undefined });
    return { id: created.id, title: created.title, plannedIds: [] };
  };

  /** 勾选结果 → 待上传条目（按所属文件夹绑定相册归属） */
  const entriesOf = (list: readonly FolderPlan[]): UploadEntry[] => {
    const checked = new Set(checkedKeys);
    return list.flatMap((folder) =>
      folder.candidates
        .filter((candidate) => checked.has(candidate.key))
        .map((candidate) => ({ candidate, folder: folder.name })),
    );
  };

  const handleStart = async (): Promise<void> => {
    if (!scan) return;
    const entries = entriesOf(scan.folders);
    if (entries.length === 0) return;
    const albumTargets = new Map<string, AlbumTarget>();
    try {
      // 逐册先定归属：先建册（或追加），再开始传输
      for (const folder of scan.folders) {
        if (!entries.some((entry) => entry.folder === folder.name)) continue;
        albumTargets.set(folder.name, await resolveAlbum(folder, albumChoice));
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '相册准备失败');
      return;
    }
    await runUpload(entries, albumTargets, rules.concurrency);
  };

  const handleRetry = (): void => {
    const album = albumRef.current;
    if (!album || failedRef.current.length === 0) return;
    void runUpload(failedRef.current, album.targets, rules.concurrency);
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
          {/* 目录选择框一次只能选一个文件夹，因此提供追加与清空，凑齐多个文件夹一次上传 */}
          <Button loading={scanning} onClick={() => inputRef.current?.click()}>
            继续添加文件夹
          </Button>
          <Button disabled={scanning} onClick={clearPicked}>
            清空重选
          </Button>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            disabled={targets.length === 0 || albumChoice === 'skip'}
            onClick={() => void handleStart()}
          >
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
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={handleInputChange} />
      <Modal
        open={open}
        width={860}
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
                message={`上次有一批上传未完成：${resume.folderNames.length} 个文件夹还剩 ${resume.files.length} 个文件`}
                description={`涉及文件夹「${resume.folderNames.join('、')}」。重新选择同一批文件夹即可从断点继续 —— 已完成的分片保存在服务端，不会重复传输。`}
                action={<Button size="small" onClick={handleAbandonResume}>放弃续传</Button>}
              />
            )}
            <Alert
              type="info"
              showIcon
              message="选中的文件夹各自变成一个相册"
              description="相册标题取文件夹名；只收文件夹根目录下的照片，子文件夹会被跳过。可一次拖入多个文件夹，也可反复点选逐个添加，上传前会先列出完整清单并比对同名相册与同名文件。"
            />
            <div
              className={dragging ? 'upload-drop upload-drop--active' : 'upload-drop'}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => void handleDrop(event)}
            >
              <p className="t-sec" style={{ marginBottom: 4 }}>
                把文件夹拖到此处
              </p>
              <p className="t-qua" style={{ fontSize: 11, marginBottom: 12 }}>
                可一次拖入多个文件夹；点选一次添加一个，之后还能在清单页继续添加
              </p>
              <Button type="primary" loading={scanning} onClick={() => inputRef.current?.click()}>
                选择文件夹
              </Button>
            </div>
          </Space>
        )}

        {stage === 'confirm' && scan && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div className="t-sec" style={{ fontSize: 12 }}>
              共 {scan.folders.length} 个文件夹：待上传 {allCandidatesOf(roots).length} 个文件
              {scan.resumed && scan.alreadyDone > 0 && `，其中 ${scan.alreadyDone} 个已完成传输，无需重复上传`}
              {scan.subdirs.length > 0 && `；跳过子文件夹 ${scan.subdirs.length} 个`}
            </div>

            {scan.subdirs.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`已跳过 ${scan.subdirs.length} 个子文件夹（本期只收文件夹根目录下的照片）`}
                description={scan.subdirs.slice(0, 8).join('、') + (scan.subdirs.length > 8 ? ' 等' : '')}
              />
            )}

            {scan.resumed && resume ? (
              <Alert
                type="info"
                showIcon
                message="续传：已完成的分片不会重复传输"
                description="续传不会新建相册，上传完成的照片会继续写入各自原有的相册。"
              />
            ) : namedAlbums.length > 0 ? (
              <div>
                <div className="t-sec" style={{ fontSize: 12, marginBottom: 6 }}>
                  以下文件夹已存在同名相册：
                  {namedAlbums.map((folder) => `${folder.name}（${folder.album?.count} 张）`).join('、')}
                </div>
                <Radio.Group value={albumChoice} onChange={(event) => setAlbumChoice(event.target.value as AlbumChoice)}>
                  <Space direction="vertical">
                    <Radio value="append">把照片追加到各自已有的同名相册</Radio>
                    <Radio value="create">各文件夹分别新建一个同名相册</Radio>
                    <Radio value="skip">放弃本次上传</Radio>
                  </Space>
                </Radio.Group>
              </div>
            ) : (
              <div className="t-sec" style={{ fontSize: 12 }}>
                将新建相册：{scan.folders.map((folder) => folder.name).join('、')}
              </div>
            )}

            {/* 目标分组：新建时决定新册归属，追加时把该册改挂到所选分组（续传不动分组） */}
            {scan.resumed ? null : (
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
                  {namedAlbums.length > 0 && albumChoice === 'append'
                    ? '追加到已有相册时，改这里会同时把这些相册移动到新分组'
                    : '作用于本次涉及的全部相册，默认归入「默认分组」'}
                </div>
              </div>
            )}

            <UploadPlanTree
              roots={roots}
              rejected={scan.rejected}
              checkedKeys={checkedKeys}
              onCheckedKeysChange={setCheckedKeys}
              overwriteKeys={overwriteKeys}
              onOverwriteKeysChange={setOverwriteKeys}
            />
          </Space>
        )}

        {uploading && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Progress percent={percent} />
            <Tooltip title="分片上传：中断后重新选同一批文件夹即可从断点继续">
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
              {report.albumTitles.length > 0 && `；照片已并入相册「${report.albumTitles.join('」「')}」`}
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