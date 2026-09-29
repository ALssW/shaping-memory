/**
 * apps/mobile/src/lib/saveToAlbum.ts
 *
 * 导出到系统相册（需求 3d）：把服务端**写回后的原图字节**直接落盘存入相册。
 *
 * 【硬约束一：不得对字节做任何再处理】`expo-file-system` 的 downloadAsync 是流式写文件，
 * 全程不做解码 / 重编码，因此 EXIF 逐字节保留 —— 这正是「导出含完整 EXIF」的实现方式。
 * 不得改用 ImageManipulator 或先把图读成 base64 再写，那会重编码并丢掉元数据。
 *
 * 【硬约束二：隐私照片一律不导出原片】可以在前端做减法的地方就做减法：
 * 服务端对 locked 照片本就不下发 originalUrl（见 photos.service.ts §toApi），
 * 这里再对 blur / hidden 显式拦一道，任何调用路径都绕不过去。
 */
import * as FileSystem from 'expo-file-system';
import { File as BytesFile } from 'expo-file-system/next';
import * as MediaLibrary from 'expo-media-library';
import type { Photo } from '@shaping-memory/core';

/** 可导出性判定：ok 为 true 才允许取原片字节 */
export type ExportGate = { ok: true } | { ok: false; reason: string };

export function canExportOriginal(photo: Photo): ExportGate {
  const mode = photo.privacy?.mode;
  if (mode === 'blur' || mode === 'hidden') {
    return { ok: false, reason: `隐私照片（${mode === 'blur' ? '模糊' : '隐藏'}）不导出原片` };
  }
  if (photo.privacy?.locked) {
    return { ok: false, reason: '这张照片对当前账号未解锁，不导出原片' };
  }
  if (!photo.originalUrl) {
    return { ok: false, reason: '这张照片没有可下载的原片' };
  }
  return { ok: true };
}

/**
 * 保存到系统相册。失败一律抛出带可读文案的错误（调用方负责展示，不得只 console）。
 *
 * 【为什么申请权限用 writeOnly】这一步只需要写入能力：Android 13+ 不要求读媒体权限，
 * writeOnly 在旧版本上等价于 WRITE_EXTERNAL_STORAGE（清单里已声明），
 * 免得为一个「保存」动作去申请整个相册的读取权限。
 */
export async function savePhotoToAlbum(photo: Photo): Promise<void> {
  const gate = canExportOriginal(photo);
  if (!gate.ok) throw new Error(gate.reason);

  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    throw new Error('未获得相册写入权限，请在系统设置中允许「塑忆」访问照片后重试');
  }

  const target = `${FileSystem.cacheDirectory}shaping-${photo.id}-${Date.now()}.jpg`;
  const result = await FileSystem.downloadAsync(photo.originalUrl!, target);
  if (result.status !== 200) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
    throw new Error(`下载原片失败（HTTP ${result.status}）`);
  }

  try {
    await MediaLibrary.saveToLibraryAsync(result.uri);
  } finally {
    // 临时文件用完即删：它只是交给相册的一道中转，不该长期占着缓存
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
  }
}

/* --------------------------------------------------------------------------
 * 本地 EXIF 工作台（需求 5）用的「本地字节 ↔ 相册」通道
 *
 * 【读走 base64 分块，写走 next 的字节直写】两条路都是为了让峰值内存与文件体积同阶：
 *   · 读：legacy `readAsStringAsync` 只吐字符串，二进制得靠 base64 搬运（无损，
 *     解出来的字节与磁盘逐字节相同），但它一次只在内存留一块，故分块读；
 *   · 写：legacy 的 `writeAsStringAsync` 同样只收字符串 —— 一份 42MB 的 RAW 编成
 *     base64 就是 56MB 的串，JS 与原生还得各持一份，这是导出 NEF 时 OOM 的真凶。
 *     改用 `expo-file-system/next` 的 `File.write(Uint8Array)`，字节直达原生，零文本副本。
 *
 * 【为什么自己写 base64 解码】core 的 exif-io 刻意不用 atob（Hermes 支持度不可靠），
 * 这里沿用同一条约定：自实现的解码只依赖 Uint8Array 与 String，行为在两端一致。
 * -------------------------------------------------------------------------- */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符 → 6 位值。用 Map 而不是 indexOf：解码大图时每字节一次线性查找太慢 */
const B64_VALUE = new Map<string, number>(
  Array.from(B64_ALPHABET, (char, index) => [char, index] as const),
);

/** base64 文本 → 字节（忽略换行与 '=' 填充，宽容读取系统返回的各种排版） */
export function base64ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const value = B64_VALUE.get(text[i]);
    if (value === undefined) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    out[at] = (buffer >> bits) & 0xff;
    at += 1;
    // 高位清零：否则 buffer 一直左移会溢出 32 位，后面的字节全错
    buffer &= (1 << bits) - 1;
  }
  return at === out.length ? out : out.subarray(0, at);
}

/**
 * 把完整字节直接落盘（同步，但只做一次原生调用，不产生任何文本副本）。
 *
 * 【为什么用 next 的 File 而不是 writeAsStringAsync】后者只收字符串，二进制必须编成
 * base64 —— 42MB 的 RAW 编出来是 56MB 的串，JS 侧一份、原生侧再一份，堆直接爆。
 * `File.write` 收 Uint8Array，原生拿到的是同一块字节。
 *
 * 【为什么要判 exists】`create()` 对已存在的文件会抛错，而 `write` 不负责建文件，
 * 两者配合才是最稳的「有则覆写、无则新建」。
 */
function writeBytesFile(uri: string, bytes: Uint8Array): void {
  const file = new BytesFile(uri);
  if (!file.exists) file.create();
  file.write(bytes);
}

/**
 * 分块读的块大小：3MB。取 3 的倍数 —— base64 每 3 字节编成 4 字符，
 * 块长是 3 的倍数时每块都不产生 `=` 填充，于是各块可独立解码后直接拼进结果数组。
 */
const READ_CHUNK_BYTES = 3 * 1024 * 1024;

/**
 * 读本地图片的原始字节。
 *
 * 【为什么必须分块读】`readAsStringAsync` 的 base64 结果在原生与 JS 两侧各存一份，
 * 峰值约是文件体积的 **2.7 倍** —— 一张 42MB 的 NEF 实测要一次分配 117MB，
 * 在堆上限 192MB 的机器上直接 OutOfMemoryError（还没走到 EXIF 解析就挂了）。
 * 分块后峰值只剩「最终字节数组 + 一块的 base64 串（约 4MB）」，与文件体积同阶。
 *
 * 【为什么要一次分配到位】边解码边拼接 Uint8Array 会反复重建整块内存，峰值反而翻倍。
 *
 * 【为什么不用 utf8】utf8 会把 >=0x80 的字节改写掉，
 * JPEG / RAW 一旦被改写，EXIF 与像素数据就全废了。
 */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  const total = info.exists ? info.size : 0;

  if (total <= 0) {
    // 极少数 provider 给不出体积：退回一次性读（正确性优先，代价是峰值高）
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return base64ToBytes(base64);
  }

  const out = new Uint8Array(total);
  let at = 0;
  while (at < total) {
    const length = Math.min(READ_CHUNK_BYTES, total - at);
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: at,
      length,
    });
    const chunk = base64ToBytes(base64);
    // 防越界：读取长度理论上恒等于 length，但真越界时会抛错而不是静默写坏
    out.set(chunk.subarray(0, Math.min(chunk.length, total - at)), at);
    at += length;
  }
  return out;
}

/** 申请相册写入权限；被拒抛带可读中文的错误（调用方负责展示，不得只 console） */
export async function ensureAlbumWritePermission(): Promise<void> {
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    throw new Error('未获得相册写入权限，请在系统设置中允许「塑忆」访问照片后重试');
  }
}

/**
 * 把一小段字节写成缓存里的临时文件，返回 file:// 地址。
 * 用途：RAW（NEF/DNG）的内嵌 JPEG 预览 —— RN 与相机软件都解不了 NEF 本体，
 * 但内嵌预览本身就是一张标准 JPEG，落成缓存文件后 expo-image 就能正常渲染。
 */
export async function writeCacheFile(bytes: Uint8Array, fileName: string): Promise<string> {
  const target = `${FileSystem.cacheDirectory}${fileName}`;
  writeBytesFile(target, bytes);
  return target;
}

/**
 * 把**已经写好的完整文件字节**存入系统相册（本地 EXIF 工作台的导出出口）。
 *
 * 【导出不得再动任何 tag】这里对字节只做 base64 直写，全程无解码 / 重编码，
 * 磁盘上落下来的就是 writeLocalExif 的产物本身。
 */
export async function saveBytesToAlbum(bytes: Uint8Array, fileName: string): Promise<void> {
  await ensureAlbumWritePermission();

  const target = `${FileSystem.cacheDirectory}${fileName}`;
  writeBytesFile(target, bytes);
  try {
    await MediaLibrary.saveToLibraryAsync(target);
  } finally {
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
  }
}
