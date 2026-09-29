/**
 * packages/storage/src/index.ts
 *
 * 统一对象存储接口（S3 兼容，最小可用）。
 *
 * 【为什么是「S3 兼容」而不是某个云厂商的 SDK】
 * S3 协议已是事实标准：AWS S3、阿里云 OSS、腾讯云 COS、MinIO、Cloudflare R2、七牛……
 * 都讲同一套 HTTP 语义。只对接协议，用户换服务商时不用改一行代码，也免去学习各家专有 SDK。
 *
 * 【配置只有这些，多一个都不要】
 *   provider / bucket / region / prefix / customDomain  ← 与 README 的配置模板一一对应
 *   endpoint                                            ← 可选，自建或第三方兼容服务才需要
 *   + 两个密钥环境变量 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 * 默认 provider = local：什么都不配，照片与生成物都留在本机 STORAGE_DIR，项目照常完整运行。
 *
 * 【对外只有 7 个动作】put / get / exists / remove / list / url / describe。
 * 刻意不做分片上传、生命周期、版本控制、跨区复制等进阶能力 —— 普通人用不上，
 * 而每多一个旋钮，就多一处「配错却不知道错在哪」的可能。
 */
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { GetObjectOutput } from '@aws-sdk/client-s3';

/* ==========================================================================
 * 一、配置与错误
 * ========================================================================== */

/** 存储形态：local = 本机文件系统（默认，零配置）；s3 = 任意 S3 兼容对象存储 */
export type StorageProviderKind = 'local' | 's3';

/**
 * 存储配置 —— 字段与 README 给出的配置模板逐字对应，不额外引入任何参数。
 * 除 `localRoot`（仅本机模式用）外，其余字段都是 s3 模式下的原样透传。
 */
export interface StorageConfig {
  provider: StorageProviderKind;
  /** 桶名（s3 必填），如 your-photos-bucket */
  bucket: string;
  /** 区域（s3 必填），如 us-east-1、cn-hangzhou */
  region: string;
  /** 自定义服务地址；留空走 AWS 官方。阿里云 OSS / MinIO / R2 等必须填 */
  endpoint?: string;
  /**
   * 寻址风格：true = path-style（`endpoint/bucket/key`），false = virtual-hosted（`bucket.endpoint/key`）。
   * 【为什么必须显式给】两种风格不通用：自建 MinIO 依赖 path-style（免去为每个桶配 DNS），
   * 阿里云 OSS 则直接 403（`Please use virtual hosted style to access.`）。
   * 缺省时按「填了 endpoint 即使用 path-style」的既有行为保底。
   */
  pathStyle?: boolean;
  /** 所有操作的公共前缀，如 photos/；留空表示直挂桶根 */
  prefix: string;
  /** 绑定了该桶的自定义域名，如 cdn.yourdomain.com；留空则 url() 返回 null（改走 API 中转） */
  customDomain?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** 本机模式的根目录（provider=local 时才用到） */
  localRoot: string;
}

/** 失败原因分类：上层据此决定「重试 / 提示用户 / 直接 404」，文案则由本模块统一给出 */
export type StorageErrorCode = 'not_found' | 'denied' | 'unreachable' | 'range_invalid' | 'unknown';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    /** 面向用户的说明——**不含密钥、不拼上游原始错误**，那些只进 cause 供日志排查 */
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** 上游错误 → 分类 + 用户能看懂的一句话。技术细节（HTTP 状态码、SDK 错误名）保留在 cause 里 */
function toStorageError(err: unknown, action: string): StorageError {
  if (err instanceof StorageError) return err; // 已经是本模块抛的，原样透出
  const name = (err as { name?: string })?.name ?? '';
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

  if (name === 'NoSuchKey' || name === 'NoSuchBucket' || status === 404) {
    return new StorageError('not_found', '这个文件在存储服务里找不到', err);
  }
  if (status === 416 || name === 'InvalidRange') {
    // 客户端要的字节区间超出了对象范围：这不是「服务坏了」，必须原样告诉上层好回 416
    return new StorageError('range_invalid', '请求的字节区间超出文件范围', err);
  }
  if (name === 'AccessDenied' || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || status === 403) {
    return new StorageError('denied', `${action}被存储服务拒绝，请检查访问密钥与桶权限`, err);
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'TimeoutError', 'EPROTO'].includes(name)) {
    return new StorageError('unreachable', `${action}失败：连不上存储服务，请检查服务地址与网络`, err);
  }
  return new StorageError('unknown', `${action}失败`, err);
}

/* ==========================================================================
 * 二、对外接口
 * ========================================================================== */

/** 列表里的一条对象；`key` 是**去掉公共前缀**的相对键，可直接回传给 put/get/remove */
export interface StoredObject {
  key: string;
  /** 字节数 */
  size: number;
  lastModified: Date;
}

/** 字节区间（含端点），与 HTTP Range 同语义；end 缺省表示「到文件末尾」 */
export interface ByteRange {
  start: number;
  end?: number;
}

/**
 * 一次读取的结果：流 + 转发所需的全部元数据。
 * 【为什么连元数据一起返回】API 转发照片时要设 Content-Length / Content-Range / ETag，
 * 这些值在一次 GetObject 的响应里全都有；若只给流，上层就得再发一次 HeadObject 去补 ——
 * 每张图多一次往返，而实况视频还常常带 Range，次数会被成倍放大。
 */
export interface ObjectRead {
  stream: Readable;
  /** 本次返回的字节数（带 Range 时是区间长度，不是整个对象） */
  size: number;
  /** 对象总字节数（拼 Content-Range 与 416 响应用） */
  totalSize: number;
  /** 可直接回给客户端的 ETag（本机实现给弱校验值） */
  etag: string;
  /** 对象上存的内容类型；本机文件没有这个概念，返回 null 由上层按扩展名保底 */
  contentType: string | null;
}

/**
 * 对象存储。上层只认这 7 个方法，换实现（本机 / S3）上层不用改。
 */
export interface ObjectStore {
  /** 写入（覆盖同名对象）。内容给 Buffer 或字符串即可，图片等二进制的编码由调用方决定 */
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  /**
   * 读取为可读流——不整块进内存，几百 MB 的原片与实况视频也能直接转发给客户端。
   * 传 range 时只取那一段（实况视频拖进度条靠它）；区间超出对象范围抛 `range_invalid`。
   */
  get(key: string, range?: ByteRange): Promise<ObjectRead>;
  /** 判断存在性（只发元数据请求，不拉内容） */
  exists(key: string): Promise<boolean>;
  /** 删除。**幂等**：对象本来就不在也算成功，避免上层为「删两次」写特判 */
  remove(key: string): Promise<void>;
  /** 列出公共前缀下的全部对象（自动分页取完） */
  list(): Promise<StoredObject[]>;
  /** 生成对外直链；未配置 customDomain 时返回 null，由上层退回 API 中转 */
  url(key: string): string | null;
  /** 一句话描述当前存储形态，**已脱敏**，可安全写日志 */
  describe(): string;
}

/* ==========================================================================
 * 三、键与前缀
 * ========================================================================== */

/** 前缀规范化：去掉首尾多余斜杠，非空时补一个结尾斜杠（`photos` 与 `photos/` 等价） */
function normalizePrefix(raw: string): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/**
 * 相对键 → 桶内完整键。
 * 【为什么在这里统一处理】调用方写 `thumbs/a.jpg`、`/thumbs/a.jpg` 都不该出错；
 * 把前缀拼接收敛到一处，上层就不必各自记得「到底要不要带斜杠」。
 */
function fullKey(prefix: string, key: string): string {
  return prefix + key.trim().replace(/^\/+/, '');
}

/** 域名规范化：允许用户只写域名，统一补上 https:// 并去掉结尾斜杠 */
function normalizeDomain(raw?: string): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (value === '') return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * 服务地址规范化：与域名同一条规矩 —— 只写域名（阿里云 OSS 文档里就是
 * `oss-cn-hangzhou.aliyuncs.com` 这种写法）时自动补上 https://。
 * 【为什么必须补】AWS SDK 的 endpoint 会被当成 URL 解析，缺协议头直接抛 `Invalid URL`，
 * 而报错发生在一次真实请求里、离配置项很远，排查成本很高。
 */
function normalizeEndpoint(raw?: string): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (value === '') return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * 对象总长度。
 * 【为什么要解析 Content-Range】带 Range 请求时 `ContentLength` 是**这一段的长度**，
 * 整个对象的长度只出现在 `Content-Range: bytes 5-9/100` 那个斜杠后面的数字里。
 * 取值错误会导致 206 响应头前后不一致，播放器的进度条会直接算错。
 */
function contentTotalOf(res: GetObjectOutput): number {
  const fromContentRange = /^bytes\s+\d+-\d+\/(\d+)$/.exec(res.ContentRange ?? '')?.[1];
  if (fromContentRange) return Number(fromContentRange);
  return res.ContentLength ?? 0;
}

/** 从 `bytes 5-9/100` 里取**服务端实际给出的**末端字节偏移（拿不到时回退到「末尾」） */
function contentRangeEndOf(contentRange: string, fallbackEnd: number): number {
  const end = /^bytes\s+\d+-(\d+)\//.exec(contentRange)?.[1];
  return end ? Number(end) : fallbackEnd;
}

/* ==========================================================================
 * 四、本机文件系统实现（默认；也是「什么都不配也能完整跑起来」的落点）
 * ========================================================================== */

/** 递归收集目录下的所有文件（相对根目录的键用 `/` 分隔，与 S3 的键形式保持一致） */
async function walkFiles(root: string, dir: string = root): Promise<StoredObject[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: StoredObject[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, abs)));
      continue;
    }
    const info = await stat(abs);
    out.push({ key: path.relative(root, abs).split(path.sep).join('/'), size: info.size, lastModified: info.mtime });
  }
  return out;
}

/** 本机目录实现：键即相对路径，行为与 S3 版完全一致（便于本地开发，也是默认形态） */
export class LocalStore implements ObjectStore {
  private readonly root: string;

  constructor(localRoot: string) {
    this.root = path.resolve(localRoot);
  }

  /**
   * 相对键 → 本机绝对路径。
   * 【为什么必须校验】键一旦来自请求参数，`../../` 就能读到 STORAGE_DIR 之外的文件，
   * 这是最典型的路径穿越漏洞，因此在唯一的出入口处挡掉。
   */
  private resolve(key: string): string {
    const abs = path.resolve(this.root, key.trim().replace(/^\/+/, ''));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new StorageError('denied', '文件名不合法');
    }
    return abs;
  }

  async put(key: string, body: Uint8Array | string): Promise<void> {
    const abs = this.resolve(key);
    await mkdir(path.dirname(abs), { recursive: true }); // 父目录按需创建，免去上层手动建目录
    await writeFile(abs, body);
  }

  async get(key: string, range?: ByteRange): Promise<ObjectRead> {
    const abs = this.resolve(key);
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new StorageError('not_found', '这个文件在本机找不到');
    }
    const totalSize = info.size;
    // 带 Range 时把区间换算成「真实存在的那一段」：end 超出末尾按末尾夹紧（与 S3 行为一致），
    // 起点越界则抛 range_invalid，让上层有据可依地回 416
    const start = range ? range.start : 0;
    const end = range ? Math.min(range.end ?? totalSize - 1, totalSize - 1) : totalSize - 1;
    if (range && (start >= totalSize || end < start)) {
      throw new StorageError('range_invalid', '请求的字节区间超出文件范围');
    }
    return {
      stream: createReadStream(abs, range ? { start, end } : undefined),
      size: end - start + 1,
      totalSize,
      // 本机文件没有内容哈希，用「大小 + 修改时间」拼一个弱校验值：足够做 If-None-Match
      etag: `W/"${totalSize}-${Math.round(info.mtimeMs)}"`,
      contentType: null, // 本机不存内容类型，由上层按扩展名保底
    };
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true }); // force = 不存在也不报错，天然幂等
  }

  async list(): Promise<StoredObject[]> {
    return walkFiles(this.root);
  }

  /** 本机文件没有对外地址：返回 null，上层自然退回「由 API 转发」 */
  url(): string | null {
    return null;
  }

  describe(): string {
    return `local(root=${this.root})`;
  }
}

/* ==========================================================================
 * 五、S3 兼容实现（AWS S3 / 阿里云 OSS / MinIO / R2 …）
 * ========================================================================== */

export class S3Store implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string | null;
  private readonly customDomain: string | null;
  private readonly prefix: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.region = config.region;
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.customDomain = normalizeDomain(config.customDomain);
    this.prefix = normalizePrefix(config.prefix);

    this.client = new S3Client({
      region: this.region,
      // 寻址风格由配置决定（见 StorageConfig.pathStyle）：自建 MinIO 用 path-style，
      // 阿里云 OSS 等托管服务必须用 virtual-hosted；AWS 官方不填 endpoint，走默认风格。
      forcePathStyle: config.pathStyle ?? this.endpoint !== null,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      credentials: {
        accessKeyId: config.accessKeyId ?? '',
        secretAccessKey: config.secretAccessKey ?? '',
      },
    });
  }

  async put(key: string, body: Uint8Array | string, contentType?: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: fullKey(this.prefix, key),
          Body: body,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      );
    } catch (err) {
      throw toStorageError(err, '上传');
    }
  }

  async get(key: string, range?: ByteRange): Promise<ObjectRead> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: fullKey(this.prefix, key),
          // `bytes=5-` 表示「从 5 到末尾」，是 Range 的合法写法，因此 end 缺省时留空即可
          ...(range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}),
        }),
      );
      if (!res.Body) throw new StorageError('not_found', '这个文件在存储服务里找不到');

      const totalSize = contentTotalOf(res);
      const start = range ? range.start : 0;
      // 从 Content-Range 回读服务端**实际**给出的末端（可能比请求的更早结束），
      // 这样 Content-Length 与 Content-Range 永远自洽，不会被客户端的越界请求带偏
      const end = res.ContentRange ? contentRangeEndOf(res.ContentRange, totalSize) : totalSize - 1;
      return {
        stream: res.Body as Readable,
        size: res.ContentLength ?? Math.max(0, end - start + 1),
        totalSize,
        etag: res.ETag ?? `W/"${totalSize}"`,
        contentType: res.ContentType ?? null,
      };
    } catch (err) {
      throw toStorageError(err, '读取');
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fullKey(this.prefix, key) }));
      return true;
    } catch (err) {
      // HeadObject 找不到时不带响应体，SDK 只给得出 404 状态码或 NotFound 错误名
      const name = (err as { name?: string })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return false;
      throw toStorageError(err, '检查文件');
    }
  }

  async remove(key: string): Promise<void> {
    try {
      // S3 的 DeleteObject 本身幂等：删不存在的键也返回成功
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fullKey(this.prefix, key) }));
    } catch (err) {
      throw toStorageError(err, '删除');
    }
  }

  async list(): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    try {
      // 单次最多返回 1000 条，用 ContinuationToken 循环取完（调用方不必关心分页）
      do {
        const res = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const item of res.Contents ?? []) {
          if (!item.Key) continue;
          out.push({
            key: item.Key.slice(this.prefix.length), // 去掉公共前缀，回给调用方的是相对键
            size: item.Size ?? 0,
            lastModified: item.LastModified ?? new Date(0),
          });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      throw toStorageError(err, '获取文件列表');
    }
    return out;
  }

  url(key: string): string | null {
    if (!this.customDomain) return null;
    // 键里可能有空格、中文，做一次 URL 转义；encodeURI 不会动 `/`，路径层级得以保留
    return `${this.customDomain}/${encodeURI(fullKey(this.prefix, key))}`;
  }

  /**
   * 脱敏描述。
   * 【安全铁律】密钥永不进日志：这里只报「配了什么」，不报任何凭证。
   * 桶名 / 区域 / 域名属于运维必需信息，可以出现。
   */
  describe(): string {
    return [
      's3',
      `bucket=${this.bucket}`,
      `region=${this.region}`,
      `prefix=${this.prefix || '(root)'}`,
      this.endpoint ? `endpoint=${this.endpoint}` : null,
      this.customDomain ? `customDomain=${this.customDomain}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');
  }
}

/* ==========================================================================
 * 六、工厂
 * ========================================================================== */

/** 按配置装配存储实现。provider 缺省即 local，因此不配对象存储也能完整运行 */
export function createStore(config: StorageConfig): ObjectStore {
  return config.provider === 's3' ? new S3Store(config) : new LocalStore(config.localRoot);
}

/* ==========================================================================
 * 七、本机资产路径约定（EXIF 备份 / 实况视频）
 *
 * 这几项只在本机模式下存在：EXIF 写回要能立刻改真实文件，
 * 实况视频的提取也依赖外部 exiftool 读本地文件，因此不参与对象存储上传。
 * ========================================================================== */

/** 备份目录：原片的「第一次被改写前」快照，只增不改 */
export const BACKUP_DIR_NAME = 'originals-backup';

/** 实况照片内嵌视频的落盘目录（与缩略图同属生成物，故放在 STORAGE_DIR 下） */
export const LIVE_DIR_NAME = 'live';

/**
 * 实况照片内嵌视频的目标路径：以 media.id 命名，扩展名固定 .mp4。
 * 【为什么不用原名】同一张照片的「图 + 视频」是一对，用 id 命名天然成对且不会撞名；
 * Android Motion Photo 的内嵌轨就是 MP4 容器，浏览器 video 标签可直接播。
 */
export function liveVideoPathFor(storageDir: string, mediaId: string): string {
  return path.join(storageDir, LIVE_DIR_NAME, `${mediaId}.mp4`);
}

/**
 * 写入 EXIF 前的原片备份（幂等：已备份过就直接返回旧快照路径）。
 *
 * 【为什么需要它】EXIF 是**真实写回照片文件**的，写坏了没有撤销键。
 * 备份放在 STORAGE_DIR 而不是源目录：源目录被导入管线按扩展名扫描，
 * 在那儿留下 `xxx_original.jpg` 会被当成新照片重复导入。
 * 保留原扩展名是为了备份文件仍能用看图软件直接打开核对。
 */
export async function ensureOriginalBackup(
  storageDir: string,
  mediaId: string,
  sourcePath: string,
): Promise<string> {
  const backupDir = path.join(storageDir, BACKUP_DIR_NAME);
  const target = path.join(backupDir, `${mediaId}${path.extname(sourcePath)}`);
  if (existsSync(target)) return target;
  await mkdir(backupDir, { recursive: true });
  await copyFile(sourcePath, target);
  return target;
}
