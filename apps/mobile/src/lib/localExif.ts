/**
 * apps/mobile/src/lib/localExif.ts
 *
 * 本地 EXIF 编辑工作台的数据层（需求 5）：
 *   相册多选导入 → 读字节 → readLocalExifAny 解析 → 「多张值不一致」统计 →
 *   界面草稿收敛成 writeLocalExif 的补丁 → 导出文件名。
 *
 * 【多容器】导入的不再只是 JPEG：PNG 与 RAW（NEF / CR2 / ARW / DNG 等纯 TIFF）同样可读可写，
 * 由 core 的 sniffContainer / readLocalExifAny / writeLocalExif 统一分派，本文件只负责界面数据。
 *
 * 【为什么不走 exifTextToSubmit】那份口径是给**服务端 exiftool** 用的（读写都带 -n，
 * 快门要写成秒数 `0.005`）。而本地编解码器读出来的快门是分数形态 `1/200`，
 * 交给 exifTextToSubmit 会被判成「非法数字 → null」，等于把快门静默删除。
 * 因此本工作台以「本地读出来的原样文本」为唯一口径：读出来什么样就编辑什么样，
 * 回写时原样交回 writeLocalExif（它同时接受 `1/200` 与 `0.005`）。
 *
 * 【不一致就不回填】多张选中且取值不同时，一律留空并标注「N 张值不一致」：
 * 静默取第一张的值会让用户以为「所有照片都是这个值」，一保存就把差异抹平了。
 */
import * as ImagePicker from 'expo-image-picker';
import {
  EXIF_FIELDS,
  containerLabel,
  extractEmbeddedPreview,
  isWritableContainer,
  readLocalExifAny,
  sniffContainer,
  writeLocalExif,
} from '@shaping-memory/core';
import type { ContainerKind } from '@shaping-memory/core';

import { ensureAlbumWritePermission, readFileBytes, saveBytesToAlbum, writeCacheFile } from './saveToAlbum';

/* ========================================================================== */
/* 1. 列表项                                                                    */
/* ========================================================================== */

export interface LocalExifPhoto {
  /** 稳定标识（列表 key 与选择集都用它），直接取相册返回的 uri */
  id: string;
  /** 原始 uri：导出/回读字节用它，**不要**拿它当图片源（RAW 渲染不出来） */
  uri: string;
  /** 列表缩略图源。RAW 会用「内嵌 JPEG 预览」落成的缓存文件替代 uri，见 thumbnailOf */
  thumbUri: string;
  /** 展示文件名 */
  name: string;
  /** 容器类型（jpeg / png / tiff / other），决定文案与导出扩展名 */
  container: ContainerKind;
  /** null = 不可编辑（认不出的格式 / 解析失败），此时由 reason 给出可读原因 */
  bytes: Uint8Array | null;
  /** 只读原因；可编辑时为空串 */
  reason: string;
  /** tag → 文件里的原样文本 */
  values: Record<string, string>;
  /** 未登记但真实存在的 tag 数（「原样保留 N 个未知字段」提示） */
  unknownCount: number;
}

/* ========================================================================== */
/* 2. 导入                                                                      */
/* ========================================================================== */

/**
 * 从系统相册多选导入。取消返回空数组；权限被拒抛带可读中文的错误。
 * 【为什么先申请读取权限】Android 13+ / iOS 都要显式授权才能拿到可读的 uri，
 * 否则选完返回的是一串无法读取内容的路径，报错会来得莫名其妙。
 */
export async function pickLocalPhotos(): Promise<LocalExifPhoto[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('未获得相册读取权限，请在系统设置中允许「塑忆」访问照片后重试');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    /* 用 SDK 52 的 MediaType 数组写法：MediaTypeOptions 已弃用，用旧写法会在工作台顶部
       弹出一条弃用警告黄条，盖住导出按钮 */
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    /* quality 取 1 = ImagePickerConstants.MAXIMUM_QUALITY，此时 Android 侧走 RawImageExporter，
       底层是一次 copyFile 纯字节拷贝（**不重编码**）—— 这正是不允许二次处理时的正确档位：
       RAW（NEF/DNG）与 JPEG 的元数据、像素都能原样进到缓存文件里。 */
    quality: 1,
  });
  if (result.canceled) return [];

  return Promise.all((result.assets ?? []).map(loadLocalPhoto));
}

/** 单张：读字节 + 解析 EXIF；任何失败都收敛成「只读 + 可读原因」，不中断整批导入 */
async function loadLocalPhoto(asset: ImagePicker.ImagePickerAsset, index: number): Promise<LocalExifPhoto> {
  const name = asset.fileName ?? `照片-${index + 1}.jpg`;
  const id = asset.assetId ?? asset.uri;
  const base: LocalExifPhoto = {
    /* 去重键优先用 assetId（Android MediaStore 的稳定 id）：系统选择器每次返回的 uri 可能不同，
       拿 uri 当键会让同一张照片被重复导入成多行。provider 不给 assetId 时才回落到 uri。 */
    id,
    uri: asset.uri,
    thumbUri: asset.uri,
    name,
    container: 'other',
    bytes: null,
    reason: '',
    values: {},
    unknownCount: 0,
  };
  try {
    const bytes = await readFileBytes(asset.uri);
    /* 先认容器再决定留不留字节：RAW 动辄几十 MB、DNG 上百 MB，
       认不出的格式（HEIC / WebP…）保留这坨字节毫无用处，只会白白占用内存。 */
    const container = sniffContainer(bytes);
    if (!isWritableContainer(container)) {
      return {
        ...base,
        container,
        reason: `该文件不是可编辑的图片容器（${containerLabel(container)}），仅支持 JPEG / PNG / RAW(TIFF)`,
      };
    }
    const document = readLocalExifAny(bytes);
    return {
      ...base,
      container,
      thumbUri: await thumbnailOf(container, bytes, asset.uri, id),
      bytes,
      values: document.values,
      unknownCount: document.unknownCount,
    };
  } catch (err) {
    return { ...base, reason: reasonOf(err) };
  }
}

/**
 * 列表缩略图源：RAW 本体 RN 解不了，改用它内嵌的 JPEG 预览。
 * JPEG / PNG 直接用系统给的 uri（expo-image 本来就能读，省一次缓存落盘）；
 * 抽取失败或完全无内嵌预览（如 DxO 输出的线性 DNG）时回退到原 uri ——
 * 那张会显示成占位图，但字节照样可读可写，编辑与导出不受影响。
 */
async function thumbnailOf(
  container: ContainerKind,
  bytes: Uint8Array,
  uri: string,
  id: string,
): Promise<string> {
  if (container !== 'tiff') return uri;
  const preview = extractEmbeddedPreview(bytes);
  if (!preview) return uri;
  try {
    return await writeCacheFile(preview, `thumb-${id.replace(/[^\w.-]+/g, '_')}.jpg`);
  } catch {
    return uri;
  }
}

/**
 * 把底层异常翻成人话。
 * 最需要翻译的是 OOM：分块读之后仍可能撞上（RAW 的峰值内存天然是文件体积的两倍
 * —— 原始字节已全在内存里，writeLocalExif 还要再产出一份），此时 Java 原文
 * `Failed to allocate a 117062216 byte allocation with ... until OOM` 甩给用户等于什么都没说。
 */
function reasonOf(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : '';
  if (/OutOfMemoryError|out of memory|until OOM/i.test(raw)) {
    return '本机内存不足以在本地处理这张大图，建议改用更小的照片，或在电脑端的工具模块里处理';
  }
  return raw || '读取照片失败';
}

/** 导出成功后就地把新字节换成列表里的当前版本（同一批再改再导出时不会丢上一次的改动） */
export function refreshWithBytes(photo: LocalExifPhoto, bytes: Uint8Array): LocalExifPhoto {
  try {
    const document = readLocalExifAny(bytes);
    return { ...photo, bytes, values: document.values, unknownCount: document.unknownCount };
  } catch {
    return { ...photo, bytes };
  }
}

/* ========================================================================== */
/* 3. 不支持写入的字段（XMP / IPTC 容器）                                        */
/* ========================================================================== */

/**
 * EXIF_FIELDS 里这 4 个字段**不属于 EXIF APP1(TIFF)**，住在 XMP / IPTC 段里，
 * 纯 TIFF 编解码器装不下 —— writeLocalExif 会抛错。
 * 因此界面上直接置灰并说明归属，不让用户填完才报错。
 * 归属口径与 exif-io.ts 内部的 NOT_TIFF_HINT 一致（那份表未对外导出，故此处按契约复述）。
 */
const UNSUPPORTED_SEGMENT: ReadonlyMap<string, string> = new Map([
  ['ColorTemperature', 'XMP-crs'],
  ['Category', 'IPTC'],
  ['Subject', 'XMP-dc'],
  ['Rating', 'XMP-xmp'],
]);

/** 置灰原因：说清「值去哪了」比只说「不支持」有用 */
export function unsupportedFieldReasons(): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const [tag, segment] of UNSUPPORTED_SEGMENT) reasons[tag] = `属 XMP/IPTC 段（${segment}），本工具暂不支持`;
  return reasons;
}

/* ========================================================================== */
/* 4. 草稿 → 补丁                                                               */
/* ========================================================================== */

/** 面板草稿：值 + 用户是否动过 + 是否标记清除 */
export interface LocalDraft {
  values: Record<string, string>;
  /** 只有动过的字段才进补丁 —— 只是「回填了公共值」不算修改 */
  touched: Record<string, boolean>;
  /** 标记清除 → patch[tag] = null */
  clears: Record<string, boolean>;
}

/**
 * 读出来的日期是 `YYYY-MM-DD HH:mm:ss`（exif-io 口径），而秒级六段控件只认带 T 的
 * canonical 串 —— 界面上统一成 T 形态。回写时 exif-io 的日期正则两种分隔符都收，
 * 因此提交前不必再转换回去。
 */
function toDatetimeDraft(raw: string): string {
  return raw.length >= 11 && raw[10] === ' ' ? `${raw.slice(0, 10)}T${raw.slice(11)}` : raw;
}

/** 单字段在选中照片里的取值情况 */
function countDistinct(tag: string, selected: readonly LocalExifPhoto[]): number {
  const seen = new Set<string>();
  /* 比较用「原样文本」而不是 exifSameText：后者按类型归一，会把 `1/200` 与 `1/60`
     都归成空串（number 口径认不出分数），差异就被判成一致了 */
  for (const photo of selected) seen.add(photo.values[tag] ?? '');
  return seen.size;
}

/** 面板回填：把选中的这一组照片折叠成一份可编辑草稿 + 每字段的不一致提示 */
export function draftFromSelection(selected: readonly LocalExifPhoto[]): {
  draft: LocalDraft;
  notes: Record<string, string>;
} {
  const values: Record<string, string> = {};
  const notes: Record<string, string> = {};

  for (const spec of EXIF_FIELDS) {
    const distinct = countDistinct(spec.tag, selected);
    if (distinct > 1) {
      notes[spec.tag] = `${distinct} 张值不一致`;
      continue; // 留空：不回填任何一张的值
    }
    const raw = selected[0]?.values[spec.tag] ?? '';
    values[spec.tag] = spec.type === 'datetime' ? toDatetimeDraft(raw) : raw;
  }
  return { draft: { values, touched: {}, clears: {} }, notes };
}

/**
 * 收敛成补丁：字段留空 = 不修改；只有「标记清除」才写 null —— 二者不能混淆。
 * 纯 TIFF 装不下的字段直接跳过（界面上已置灰，这里再兜一道，防止补丁里混进必然报错的 tag）。
 */
export function buildPatch(draft: LocalDraft): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const spec of EXIF_FIELDS) {
    const tag = spec.tag;
    if (UNSUPPORTED_SEGMENT.has(tag)) continue;
    if (draft.clears[tag]) {
      patch[tag] = null;
      continue;
    }
    if (!draft.touched[tag]) continue;
    const value = (draft.values[tag] ?? '').trim();
    if (value === '') continue;
    patch[tag] = value;
  }
  return patch;
}

/**
 * 导出文件名：`<原名>-edited<原扩展名>`，并剔掉文件名里不能出现的字符。
 * 【为什么必须保住扩展名】NEF / DNG 若被改成 `.jpg`，相机与后期软件会拿 JPEG 解码器去解，
 * 直接报「文件损坏」；保住 `.NEF` 才是「同一张 RAW 的改过版本」这个语义。
 * 系统没给扩展名时回落到 `.jpg`（相册对无后缀文件不太友好）。
 */
export function exportNameOf(photo: LocalExifPhoto): string {
  const matched = /^(.*?)(\.[^.]+)?$/.exec(photo.name);
  const base = (matched?.[1] || 'photo').replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
  return `${base}-edited${matched?.[2] ?? '.jpg'}`;
}

/* ========================================================================== */
/* 5. 导出                                                                      */
/* ========================================================================== */

export interface ExportOutcome {
  photo: LocalExifPhoto;
  /** 已写进相册的新字节；失败时为空 */
  bytes?: Uint8Array;
  /** 失败原因（成功时为空串） */
  failure: string;
}

/**
 * 导出：把同一份补丁套到每张选中的照片上，写进系统相册。
 *
 * 【先把全部新字节算完，再逐张写盘】writeLocalExif 会对值做校验（日期格式、数字合法性…），
 * 任一张抛错就整体中止 —— 不会出现「前三张改了、第四张报错」这种改了一半的相册残留。
 * 【导出不再动任何 tag】交给相册的就是 writeLocalExif 的产物本身（RAW 亦逐字节搬，非重编码）。
 * 【RAW 永远是「另存一份」】写回不就地覆盖原片，导出的是一张带 `-edited` 的**新副本**，
 * 原片保持相机出厂状态，用户拿后期软件一比就知道改了哪些字段。
 */
export async function exportPatchedToAlbum(
  targets: readonly LocalExifPhoto[],
  patch: Record<string, string | null>,
): Promise<ExportOutcome[]> {
  await ensureAlbumWritePermission(); // 先申请相册权限：被拒就整批停下，给出可读提示

  const outputs = targets.map((photo) => ({ photo, bytes: writeLocalExif(photo.bytes!, patch) }));

  const outcomes: ExportOutcome[] = [];
  for (const output of outputs) {
    try {
      await saveBytesToAlbum(output.bytes, exportNameOf(output.photo));
      outcomes.push({ photo: output.photo, bytes: output.bytes, failure: '' });
    } catch (err) {
      outcomes.push({ photo: output.photo, failure: err instanceof Error ? err.message : '写入相册失败' });
    }
  }
  return outcomes;
}
