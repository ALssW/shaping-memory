/**
 * apps/api/src/photo-objects.ts
 *
 * 照片资产在对象存储里的键约定，以及「上传 / 清除」两个动作。
 * 导入管线与上传接口共用这一份，避免两处各写一遍路径拼法（霰弹式修改）。
 *
 * 【混合存储：只有原片与实况上云】缩略图 / 卡图 / 模糊图恒留本机（见 files.controller），
 * 因此 photoObjectKeys 虽然仍推导出四个键，但上传只会用 original 与 live；
 * thumb / card 键保留下来专供 removePhotoObjects 清理历史遗留的云端副本。
 *
 * 【键为什么用 mediaId 而不是源文件名】源文件名可能带中文、空格、大小写混排，
 * 拼进 URL 要额外转义；mediaId 是源文件名的稳定哈希（见 import/infer.ts），
 * 天然唯一、URL 安全，和桶里的其它对象也不会撞名。
 *
 * 【键为什么不落库】四个键都能由 media 行推导（id + 源文件扩展名 + 是否有实况视频），
 * 多存一列只会多一处「库里的键与文件对不上」的可能，还要搭一次数据迁移。
 *
 * 【store 传 null 是什么意思】本机模式（provider=local）。所有函数一律**直接返回**，
 * 一个远端请求都不发 —— 尤其不能拿 LocalStore 顶上，它的键空间就是 STORAGE_DIR，
 * 删起来删的是真实文件（见 storage-config.ts 的说明）。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStore } from '@shaping-memory/storage';

/** 推导键所需的最小 media 行切片（断言不出来源是 DB 行还是内存对象，测试里也好造） */
export interface PhotoObjectSource {
  id: string;
  sourcePath: string;
  thumbPath: string | null;
  liveVideoPath: string | null;
}

/** 一张照片在桶里的完整键；live 为 null 表示不是实况照片 */
export interface PhotoObjectKeys {
  original: string;
  thumb: string;
  card: string;
  live: string | null;
}

/** 按扩展名给出内容类型：桶里存了错误的内容类型，浏览器可能不按图片渲染 */
function contentTypeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.mp4') return 'video/mp4';
  return 'image/jpeg';
}

/** media 行 → 桶内相对键（前缀由存储接口统一拼，这里只管相对路径） */
export function photoObjectKeys(row: Pick<PhotoObjectSource, 'id' | 'sourcePath' | 'liveVideoPath'>): PhotoObjectKeys {
  return {
    // 原片保留真实扩展名：从桶里取回时还能知道它原本是什么格式
    original: `originals/${row.id}${path.extname(row.sourcePath).toLowerCase()}`,
    thumb: `thumbs/${row.id}.jpg`,
    card: `thumbs/${row.id}-card.jpg`,
    live: row.liveVideoPath ? `live/${row.id}.mp4` : null,
  };
}

/** 待上传的一项：键 ↔ 本机文件 ↔ 内容类型 */
interface UploadTask {
  key: string;
  file: string;
  contentType: string;
}

/**
 * 本地文件 → 待上传项。
 * 【只上原片与实况】缩略图 / 卡图 / 模糊图刻意留在本机（混合存储策略），
 * 它们是最热的展示端点，本地 sendFile 自带 Range / ETag / 304，零云端带宽。
 * 【为什么先过滤存在的文件】旧数据可能还没生成某类文件；缺一项就跳过一项，
 * 不让一张照片的历史遗留问题把它整批上传判成失败。
 */
function uploadTasksOf(row: PhotoObjectSource): UploadTask[] {
  const keys = photoObjectKeys(row);
  const tasks: UploadTask[] = [
    { key: keys.original, file: row.sourcePath, contentType: contentTypeOf(row.sourcePath) },
  ];
  if (keys.live && row.liveVideoPath) {
    tasks.push({ key: keys.live, file: row.liveVideoPath, contentType: 'video/mp4' });
  }
  return tasks.filter((task) => existsSync(task.file));
}

/** 上传结果：只计数与收集文案，由调用方决定怎么说给用户听 */
export interface ObjectSyncResult {
  uploaded: number;
  failed: number;
  errors: string[];
}

/** 什么都不做的结果（本机模式走它） */
function noopResult(): ObjectSyncResult {
  return { uploaded: 0, failed: 0, errors: [] };
}

/** 单个对象的重试次数：对象存储偶发 5xx / 连接抖动很常见，一次不成就罢会留下「本机有、云上没有」的照片 */
const PUT_ATTEMPTS = 3;
/** 重试间隔基数（毫秒），按尝试次数线性退避 */
const PUT_RETRY_BASE_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 放一个对象，失败按次数退避重试。
 * 【为什么值得重试】云副本的意义是「异地那一份」，漏传往往很久以后翻桶才发现；
 * 而这类失败多数是瞬时网络问题（多文件并发上传时更密集），重试一两次基本都能过。
 * 【为什么先读一次字节】重试只重发、不重读，省掉每次都把整个原片读进内存。
 */
async function putWithRetry(store: ObjectStore, task: UploadTask): Promise<void> {
  // 整块读入内存再上传：S3 兼容服务（OSS / MinIO / R2）对定长 Body 的支持最稳，
  // 流式上传在部分服务商上会因分块编码被拒。照片单文件有上传上限兜着，内存可控。
  const body = await readFile(task.file);
  let lastError: unknown;
  for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
    try {
      await store.put(task.key, body, task.contentType);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < PUT_ATTEMPTS) await sleep(PUT_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

/**
 * 把一张照片的**原片 + 实况视频**推到对象存储。
 *
 * 【失败为什么不抛】本地已经落盘，上云只是「多一份副本」的加分项：
 * 上传挂了不该让照片导入失败，而应该让用户看到「这几张没上云，回头重导一次即可」。
 */
export async function uploadPhotoObjects(
  store: ObjectStore | null,
  row: PhotoObjectSource,
): Promise<ObjectSyncResult> {
  if (!store) return noopResult();

  const result = noopResult();
  for (const task of uploadTasksOf(row)) {
    try {
      await putWithRetry(store, task);
      result.uploaded += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${task.key}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * 清除某张照片在云端的全部副本（原片 + 生成物）。
 * 【为什么本机文件不动】本地才是正本，云端只是一份副本；这里删的是副本。
 * `remove()` 本身幂等，因此对「从没上传过」的照片调用也不会出错。
 */
export async function removePhotoObjects(store: ObjectStore | null, row: PhotoObjectSource): Promise<void> {
  if (!store) return;
  const keys = photoObjectKeys(row);
  for (const key of [keys.original, keys.thumb, keys.card, keys.live]) {
    if (key) await store.remove(key);
  }
}
