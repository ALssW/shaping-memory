/**
 * packages/sdk/src/index.ts
 *
 * 统一 API 客户端：Web 前台 / RN 移动端 / Web 后台共用同一份请求逻辑与类型。
 * 后端返回相对路径（如 /files/{id}/thumbnail），这里统一拼成绝对地址；
 * 登录后 token 保存在内存，管理类请求自动带 Authorization 头。
 */
import { configurePlacesApi, normalizeThemeConfig, THEME_DEFAULTS } from '@shaping-memory/core';
import type {
  CoordSystem,
  DictionaryKind,
  Photo,
  SearchQuery,
  ThemeConfig,
} from '@shaping-memory/core';

/* 主题的客户端实现（解析 / 注入 / 缩放读数）单独一个文件，这里原样转出去，
   调用方只认 `@shaping-memory/sdk` 一个入口。 */
export * from './theme';
import { setActiveTheme } from './theme';

/* 标签目录（候选列表 + 短时缓存）：与主题同理由，单独成文件后原样转出 */
export * from './tag-catalog';
import { configureTagCatalogBase, invalidateTagCatalog } from './tag-catalog';

/**
 * 后端基址：默认直连本地开发端口。
 * 部署或真机联调时由各端入口调用 configureApiBase 覆盖 ——
 *   Web 前台 / 后台：打包期读 VITE_API_BASE
 *   移动端：打包期读 EXPO_PUBLIC_API_BASE（Expo 会内联进 bundle）
 */
let apiBase = 'http://127.0.0.1:3000';

/** 登录态 token（内存即可，刷新后需重新登录；持久化属于后台前端自己的事） */
let authToken: string | null = null;

/** 运行时可改写后端基址（移动端真机联调、或换端口时用） */
export function configureApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, '');
  /* core 的 searchPlaces 直接走 fetch，拿不到 sdk 的 apiBase，因此顺带同步一份 ——
     各端入口只调这一个函数，地点搜索就不会出现「sdk 连对了、搜索连到本地」的错配 */
  configurePlacesApi(apiBase);
  // 标签目录同样自行发起请求，基址也要一并同步（同时丢弃旧环境的缓存）
  configureTagCatalogBase(apiBase);
}

/** 写入/清除登录 token */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

/* --------------------------------------------------------------------------
 * 隐私票据（解锁隐私照片后拿到的访问凭证）
 *
 * 【为什么单独存一份、而不是写入 URL 由前端拼接】票据是后端签发的，图片地址也由后端拼好
 * （见 PhotosService.toApi）。前端只需在读接口上带上它，后端就会把「已解锁」的地址发下来 ——
 * 前端始终不自行拼接原片地址，也就不存在「拼接错误导致泄露」的可能。
 * -------------------------------------------------------------------------- */
let privacyToken: string | null = null;

export function setPrivacyToken(token: string | null): void {
  privacyToken = token;
}

export function getPrivacyToken(): string | null {
  return privacyToken;
}

/** 把票据并进 query（没有票据时原样返回，不产生多余的 ?pt=） */
function withPrivacy(path: string): string {
  if (!privacyToken) return path;
  return `${path}${path.includes('?') ? '&' : '?'}pt=${encodeURIComponent(privacyToken)}`;
}

/**
 * 把错误响应体里的「给人看的文案」抽出来。
 * NestJS 的校验错误体是 `{ statusCode, message, error }`，message 可能是 string 或 string[]。
 * 【为什么必须透出】后端的校验文案是中文且带上下文（「非法的 EXIF 字段名：X」「经纬度超出有效范围」），
 * 只抛 `API 400: /photos/x/exif` 的话，用户和排查的人都看不到到底哪一项不合法。
 */
async function errorDetailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] } | null;
    const message = body?.message;
    if (Array.isArray(message)) return message.join('；');
    return typeof message === 'string' ? message : '';
  } catch {
    // 非 JSON 响应（网关 502 / 连接被中断等）没有可读文案，由调用方回落
    return '';
  }
}

/** 统一请求：拼基址 + 带凭证 + 非 2xx 抛错（错误信息优先用后端文案） */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${apiBase}${path}`, { ...init, headers });
  if (!res.ok) {
    const detail = await errorDetailOf(res);
    // 状态码与路径属实现细节，只写进控制台；界面上只呈现可读的文案
    console.warn(`[api] ${res.status} ${path}`);
    throw new Error(detail || '操作失败，请稍后重试');
  }
  return (await res.json()) as T;
}

/** 把后端返回的相对路径拼成绝对地址 */
function absolute(p: string | undefined): string | undefined {
  return p ? `${apiBase}${p}` : undefined;
}

/**
 * 把原片地址（`/files/:id/original`，可能带隐私票据 `?pt=…`）改写成
 * 「带最新 EXIF 的原片」出口地址。`extra` 是要追加的查询参数。
 *
 * 【为什么从 originalUrl 派生而不是让后端多下发两个字段】原片可能带隐私票据，
 * 票据是服务端按访客判定的；派生一次就能把票据原样带上，不必再多发两个字段、
 * 也就不存在「两个字段遗漏票据」的不一致。
 */
function exifOriginalUrl(originalUrl: string, extra?: string): string {
  const [pathPart, query] = originalUrl.split('?');
  const base = pathPart.replace(/\/original$/, '/download');
  const params = [query, extra].filter(Boolean).join('&');
  return params ? `${base}?${params}` : base;
}

/** 后端返回的照片（相对路径）→ 前端 Photo（绝对地址） */
function toPhoto(raw: Photo): Photo {
  const originalUrl = absolute(raw.originalUrl);
  return {
    ...raw,
    url: absolute(raw.url)!,
    cardUrl: absolute(raw.cardUrl),
    originalUrl,
    liveUrl: absolute(raw.liveUrl ?? undefined),
    // 原片的两个出口：下载（落盘）与就地预览（viewer 显示），都是「注入最新 EXIF」的同一份字节
    downloadUrl: originalUrl ? exifOriginalUrl(originalUrl) : undefined,
    originalPreviewUrl: originalUrl ? exifOriginalUrl(originalUrl, 'inline=1') : undefined,
  };
}

/**
 * multipart 请求（整包上传与分片上传共用）。
 * 【为什么不能走 request()】request() 会让调用方传 JSON 的 Content-Type，
 * 而 FormData 必须由浏览器自己补上带 boundary 的头，手动设反而会把请求体切坏。
 */
async function postForm<T>(path: string, form: FormData, method: 'POST' | 'PUT'): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    const detail = await errorDetailOf(res);
    console.warn(`[api] ${res.status} ${path}`);
    throw new Error(detail || '上传失败，请稍后重试');
  }
  return (await res.json()) as T;
}

/**
 * 照片列表的检索条件：全部可选，缺省即「不按该维度过滤」。
 *
 * 【为什么派生 SearchQuery】检索维度是前台、SDK、后端三处共用的同一组概念，
 * core 的 SearchQuery 是唯一事实源；这里只补两个「列表专有」维度，
 * 加一个检索维度只需改 core 一处，三端不会再出现「一端有、一端没有」。
 */
export type PhotoQuery = SearchQuery & {
  category?: string;
  sort?: 'asc' | 'desc';
};

/**
 * 分页参数。
 * 【为什么不并入 PhotoQuery】它是**传输层**概念，不是检索维度 —— PhotoQuery 与 core 的
 * SearchQuery 同构，同一份条件既能发到服务端筛、也能在本地筛（移动端离线过滤就靠这个）；
 * 把 limit/offset 混进去，本地过滤时就会多出两个无意义的字段。
 */
export interface PageQuery {
  /** 每页条数；不传即「整份档案」 */
  limit?: number;
  /** 起始偏移；仅在 limit 存在时有意义 */
  offset?: number;
}

/**
 * 检索条件 → URLSearchParams。
 * 【为什么要抽出来】/photos 与 /search/photos 必须接受完全相同的一组参数，
 * 两处各写一遍拼串终将产生不一致（一处加了 iso、另一处遗漏），此处只写一份。
 */
function buildPhotoParams(query: PhotoQuery, page: PageQuery = {}): string {
  const params = new URLSearchParams();
  if (query.category && query.category !== '全部') params.set('category', query.category);
  if (query.sort) params.set('sort', query.sort);
  // 空串一律不拼进 query：把「用户没填」与「用户填了空」当成同一件事，后端就不必再判一次空值
  const optional: [string, string | undefined][] = [
    ['q', query.q],
    ['from', query.from],
    ['to', query.to],
    ['cam', query.cam],
    ['lens', query.lens],
    ['aperture', query.aperture],
    ['speed', query.speed],
  ];
  for (const [key, value] of optional) {
    if (value) params.set(key, value);
  }
  // 这两个是数字/布尔：0 与 false 也是有效条件，因此不能走上面那条「空值即省略」的规则
  if (query.iso !== undefined) params.set('iso', String(query.iso));
  if (query.hasGps !== undefined) params.set('hasGps', query.hasGps ? '1' : '0');
  /* 标签是唯一的多值维度，必须 append 而不是 set —— set 会把前面几枚覆盖掉，
     后端也就只能拿到最后一枚，多选静默退化成单选。 */
  for (const name of query.tags ?? []) params.append('tags', name);
  /* 分页是传输层的事，与上面的检索条件无关：offset 只在 limit 存在时才拼，
     免得后端收到一个「孤立的 offset」还要自行判断如何处理。 */
  if (page.limit !== undefined) {
    params.set('limit', String(page.limit));
    if (page.offset) params.set('offset', String(page.offset));
  }
  return params.toString();
}

/** 可编辑的元数据字段 */
export interface PhotoPatch {
  title?: string;
  /** 描述正文（纯文本，保留换行）；传空串即清除 */
  description?: string;
  category?: string;
  likes?: number;
  tags?: string[];
  /** 隐私标记：inherit / visible / blur / hidden */
  privacy?: 'inherit' | 'visible' | 'blur' | 'hidden';
}

export interface LoginResult {
  token: string;
  username: string;
  role: string;
}

export const authApi = {
  async login(username: string, password: string): Promise<LoginResult> {
    const res = await fetch(`${apiBase}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error('登录失败：账号或密码错误');
    const data = (await res.json()) as LoginResult;
    setAuthToken(data.token);
    return data;
  },

  logout(): void {
    setAuthToken(null);
  },
};

/**
 * 上传文件体的两种形态：
 *   - Web：直接给 File / Blob（FormData 原生支持）
 *   - RN：给 { uri, name, type }，由 RN 的 FormData 实现识别并读本地文件
 * 两者在运行期都是「能被 FormData 的 file 字段接受的东西」，因此类型上并列即可。
 */
export type UploadFileBody = Blob | { uri: string; name: string; type?: string };

/**
 * 分片上传的文件身份：这三个值共同决定服务端的 uploadId。
 * 【为什么把修改时间也算进身份】同名同大小但内容改过的文件是另一份东西，
 * 应当重传而不是接上上一版的半截分片；加上它，「同名不同版本」就不会串味。
 */
export interface ChunkFileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

/** 一次分片上传的会话：分片口径 + 已收到的分片号，客户端据此只补缺失的那些 */
export interface ChunkUploadSession {
  uploadId: string;
  chunkBytes: number;
  concurrency: number;
  /** 服务端已确认收好的分片号（0 起），升序 */
  received: number[];
}

/**
 * 云端副本的同步结果：failed > 0 表示照片已入库、本地也在，只是云端那份没传全。
 * 本机模式下恒为全 0（服务端一个远端请求都不发）。
 */
export interface ObjectSyncResult {
  uploaded: number;
  failed: number;
  errors: string[];
}

/**
 * 两个上传入口（整包 upload / 分片 completeChunkUpload）统一的返回：照片本体 + 云端同步结果。
 * 【为什么不是只给 Photo】上云失败原本对用户不可见，照片表面上「已传好」、
 * 异地副本却缺了；把 upload 一起交出来，前端才能如实提示。
 */
export interface PhotoUploadResult {
  photo: Photo;
  upload: ObjectSyncResult;
}

export const photoApi = {
  /**
   * 整份档案读取（可带筛选）。专用检索入口见 searchApi.photos。
   * 传 page 即分页（前台懒加载用）；不传就是整份档案（后台管理端依赖这个口径）。
   */
  async list(query: PhotoQuery = {}, page: PageQuery = {}): Promise<Photo[]> {
    const qs = buildPhotoParams(query, page);
    const photos = await request<Photo[]>(withPrivacy(`/photos${qs ? `?${qs}` : ''}`));
    return photos.map(toPhoto);
  },

  async detail(id: string): Promise<Photo> {
    return toPhoto(await request<Photo>(withPrivacy(`/photos/${id}`)));
  },

  /** 编辑元数据（需 admin/editor 登录态） */
  async update(id: string, patch: PhotoPatch): Promise<Photo> {
    const photo = toPhoto(
      await request<Photo>(`/photos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
    // 改了标签就让候选目录作废，否则筛选器要等 TTL 到期才肯显示新标签
    if (patch.tags !== undefined) invalidateTagCatalog();
    return photo;
  },

  /** 软删除单张（需 admin） */
  async remove(id: string): Promise<{ removed: number }> {
    return request(`/photos/${id}`, { method: 'DELETE' });
  },

  /** 批量软删除（需 admin） */
  async removeBatch(ids: string[]): Promise<{ removed: number }> {
    return request('/photos/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  },

  /**
   * 批量改元数据（需 admin/editor）：把同一份补丁套到选中的每一张上。
   * 只改补丁里**出现过**的字段 —— 与单张编辑同一套语义，因此不会把没勾选的项清空。
   */
  async updateBatch(ids: string[], patch: PhotoPatch): Promise<{ updated: number }> {
    const result = await request<{ updated: number }>('/photos/batch', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, patch }),
    });
    // 同上：批量改标签同样会让候选目录（标签名与计数）过期
    if (patch.tags !== undefined) invalidateTagCatalog();
    return result;
  },

  /**
   * 上传照片（需 admin/editor）：multipart 单文件。
   * file 传 File/Blob（Web）或 { uri, name, type }（RN），见 UploadFileBody。
   * 返回照片与云端同步结果 —— upload.failed > 0 表示已入库但云端副本没传全。
   */
  async upload(file: UploadFileBody): Promise<PhotoUploadResult> {
    const form = new FormData();
    form.append('file', file as unknown as Blob);
    const raw = await postForm<{ photo: Photo; upload: ObjectSyncResult }>('/photos/upload', form, 'POST');
    return { photo: toPhoto(raw.photo), upload: raw.upload };
  },

  /* ---------------------------------------------------------------- 分片上传
   * 整包 upload() 适合单张小图；文件夹上传动辄几十 GB，一次 POST 传不完，
   * 中途断网 / 关页面也难避免。于是走「init → 并发送片 → complete」三步：
   * init 的 uploadId 由文件身份算出，重新 init 会自动接上已传的分片，这就是断点续传。
   * ---------------------------------------------------------------- */

  /** 开一次分片上传（同时是续传入口）：返回分片口径与「已收到哪些片」 */
  async initChunkUpload(file: ChunkFileIdentity): Promise<ChunkUploadSession> {
    return request<ChunkUploadSession>('/photos/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(file),
    });
  },

  /** 送第 index 片（0 起）。片长必须与服务端口径一致，否则会被当场拒收（好让客户端只重传这一片） */
  async uploadChunk(uploadId: string, index: number, chunk: Blob): Promise<void> {
    const form = new FormData();
    form.append('chunk', chunk);
    await postForm(`/photos/upload/${uploadId}/chunks/${index}`, form, 'PUT');
  },

  /**
   * 合并并入库，返回入库后的照片与云端同步结果。
   * overwriteId 传了就「原地替换那张照片」—— 服务端沿用旧照片的落盘文件名，
   * 而落盘名就是 id 的来源，因此 id 不变，相册归属 / 点赞 / 分享链接全部保住。
   */
  async completeChunkUpload(
    uploadId: string,
    file: ChunkFileIdentity,
    overwriteId?: string,
  ): Promise<PhotoUploadResult> {
    const raw = await request<{ photo: Photo; upload: ObjectSyncResult }>(
      `/photos/upload/${uploadId}/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 身份要与 init 完全一致，服务端靠它确认「拼的是同一个文件」
        body: JSON.stringify(overwriteId ? { ...file, overwriteId } : file),
      },
    );
    return { photo: toPhoto(raw.photo), upload: raw.upload };
  },

  /** 放弃这次上传：清掉服务端的临时分片（用户点「取消」或「放弃续传」时走这里） */
  async abortChunkUpload(uploadId: string): Promise<{ removed: number }> {
    return request(`/photos/upload/${uploadId}`, { method: 'DELETE' });
  },
};

/* --------------------------------------------------------------------------
 * 通用字典 + 专用检索
 *
 * 【两类接口的边界】dictionaryApi 管「字典内容本身」（候选值有哪些、怎么维护），
 * searchApi 管「检索行为」（按条件找照片、按输入联想候选）。
 * 搜索框要下拉候选时走 searchApi.suggest，后台字典管理页走 dictionaryApi。
 * -------------------------------------------------------------------------- */

/** 一条字典值 */
export interface DictionaryEntry {
  id: string;
  kind: DictionaryKind;
  value: string;
  /** 展示文案；为空时用 value 显示 */
  label: string | null;
  sortOrder: number;
  /** 是否内置标准档位（曝光三要素的常用值） */
  builtin: boolean;
  /** 数值口径（光圈 f 数 / 快门秒数 / ISO 数值）；机身镜头等文本类为 null */
  order: number | null;
}

export interface DictionaryCreateInput {
  kind: DictionaryKind;
  value: string;
  label?: string | null;
}

export interface DictionaryPatch {
  value?: string;
  label?: string | null;
}

/** 一次「从现有数据整理」的结果 */
export interface DictionarySyncReport {
  kind: DictionaryKind;
  label: string;
  added: number;
  total: number;
}

export const dictionaryApi = {
  /** 字典内容（公开）：按类型过滤，不传即全部 */
  async list(kind?: DictionaryKind): Promise<DictionaryEntry[]> {
    return request<DictionaryEntry[]>(`/dictionary${kind ? `?kind=${kind}` : ''}`);
  },

  /** 新增一条（需 admin） */
  async create(input: DictionaryCreateInput): Promise<DictionaryEntry> {
    return request<DictionaryEntry>('/dictionary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  /** 改值或展示文案（需 admin）；改值不会去改照片 EXIF */
  async update(id: string, patch: DictionaryPatch): Promise<DictionaryEntry> {
    return request<DictionaryEntry>(`/dictionary/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  /** 删除一条（需 admin） */
  async remove(id: string): Promise<{ removed: number }> {
    return request(`/dictionary/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** 把现有照片 EXIF 里出现过的值整理进字典（需 admin，幂等，可反复执行） */
  async sync(): Promise<DictionarySyncReport[]> {
    return request<DictionarySyncReport[]>('/dictionary/sync', { method: 'POST' });
  },
};

export const searchApi = {
  /**
   * 照片多维检索（专用检索入口，公开）。
   * 与 photoApi.list 同参同义，但属于「搜索」这条独立通道：
   * 前台搜索面板与后台照片检索都走它，便于单独演进（分页、排序策略、结果计数）。
   * 传 page 即分页（前台懒加载用）；不传就是整份结果。
   */
  async photos(query: PhotoQuery = {}, page: PageQuery = {}): Promise<Photo[]> {
    const qs = buildPhotoParams(query, page);
    const photos = await request<Photo[]>(withPrivacy(`/search/photos${qs ? `?${qs}` : ''}`));
    return photos.map(toPhoto);
  },

  /** 字典联想（公开）：搜索框「输入即联想」用；q 为空时返回最靠前的一屏 */
  async suggest(kind: DictionaryKind, q = '', limit = 20): Promise<DictionaryEntry[]> {
    const params = new URLSearchParams({ kind, q, limit: String(limit) });
    return request<DictionaryEntry[]>(`/search/suggest?${params.toString()}`);
  },
};

/* --------------------------------------------------------------------------
 * 全量 EXIF（后台元数据编辑）：数据库是唯一事实源，读写都只落 exif_metadata；
 * 云端原始图片文件自上传起不可变（例外见 getOriginal：只读解析原片本体）。
 * -------------------------------------------------------------------------- */

/** 后端返回的 EXIF 结构（照片部分仍是相对路径） */
interface RawExifResult {
  fields: Record<string, string>;
  gps: { lat: number; lon: number; alt: number | null } | null;
  photo: Photo;
}

/** 前端消费的 EXIF 结构（照片地址已拼成绝对路径） */
export interface PhotoExifResult {
  /** tag（exiftool 短名）→ 原始值；字段缺失即不出现 */
  fields: Record<string, string>;
  /** 文件里实际存在的定位（WGS-84）；没有则为 null */
  gps: { lat: number; lon: number; alt: number | null } | null;
  photo: Photo;
}

/** EXIF 写入入参 */
export interface ExifPatch {
  /** 逐 tag 写入；null / 空串表示清除该 tag；数组表示多值 tag（如 Keywords） */
  fields?: Record<string, string | string[] | null>;
  /** 地图选点结果；null 表示清除定位；不传表示本次不动定位 */
  gps?: { lat: number; lon: number; alt?: number | null } | null;
  /** gps 用的坐标系（高德底图传 'gcj02'，百度传 'bd09'），后端统一转 WGS-84 再写 */
  crs?: CoordSystem;
}

/** 「查看原片 EXIF」的返回：原片本体里的全量字段 + 定位（不含照片本体，调用方已有） */
export interface OriginalExifResult {
  /** tag（exiftool 短名）→ 原始值；这里是原片里**真实存在**的值，不是库里记的 */
  fields: Record<string, string>;
  /** 原片里实际存在的定位（WGS-84）；没有则为 null */
  gps: { lat: number; lon: number; alt: number | null } | null;
}

function toExifResult(raw: RawExifResult): PhotoExifResult {
  return { ...raw, photo: toPhoto(raw.photo) };
}

export const exifApi = {
  /** 读取数据库里的全量 EXIF（需 admin/editor 登录态） */
  async get(id: string): Promise<PhotoExifResult> {
    return toExifResult(await request<RawExifResult>(`/photos/${id}/exif`));
  },

  /**
   * 只读解析**原片本体**的 EXIF（需 admin/editor）。
   * 与 get() 的区别：get 读库（最新编辑结果），这里读原片（自上传起不可变的原始信息）；
   * 不写库、不改任何文件，供两边对照。
   */
  async getOriginal(id: string): Promise<OriginalExifResult> {
    return request<OriginalExifResult>(`/photos/${id}/original-exif`);
  },

  /** 把 EXIF 改动写进数据库（需 admin/editor）；云端原片文件保持不变 */
  async update(id: string, patch: ExifPatch): Promise<PhotoExifResult> {
    return toExifResult(
      await request<RawExifResult>(`/photos/${id}/exif`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  },

  /**
   * 批量写回同一份 EXIF 补丁（需 admin/editor）。
   * 【为什么只做「同一份」】批量编辑的语义是「把这些照片的这几个字段统一成同一个值」，
   * 因此补丁是共享的，不是每张一份；需要逐张不同的场景留给单张编辑。
   */
  async updateBatch(ids: string[], patch: ExifPatch): Promise<{ updated: number }> {
    return request<{ updated: number }>('/photos/batch-exif', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, ...patch }),
    });
  },
};

/* --------------------------------------------------------------------------
 * 公开分享：社交爬虫抓后端 HTML 端点解析 OpenGraph，用户点击后跳回前台
 * -------------------------------------------------------------------------- */

/** 生成某相册的公开分享链接：指向后端 HTML 端点（含 og 元数据） */
export function shareAlbumUrl(albumId: string): string {
  return `${apiBase}/share/album/${encodeURIComponent(albumId)}`;
}

/* --------------------------------------------------------------------------
 * 隐私与授权（需求 4）：策略 / 密码解锁 / 时效分享链接
 * -------------------------------------------------------------------------- */

/**
 * 模糊管线的完整规格：一次模糊实际用到的全部参数。
 * 与 packages/image 的 BlurSpec 同形 —— SDK 是浏览器侧契约，不能 import 那个包
 * （它依赖 sharp，是 Node-only），因此在这里独立声明一份。
 */
export interface BlurSpec {
  /** 总闸：后台滑杆调的那个整数（6~20） */
  strength: number;
  /** 降采样底线（长边像素）：不可逆的信息销毁在这一步完成 */
  floorPx: number;
  /** 展示尺寸下的高斯模糊 sigma（像素） */
  sigma: number;
  /** 噪点抖动 sigma（0~255 标度） */
  noiseSigma: number;
  /** JPEG 编码质量 */
  quality: number;
  /** 输出长边像素 */
  outputPx: number;
}

/** 后台设置的全局隐私策略（前台也要读它，据此决定是否展示「输入密码解锁」入口） */
export interface PrivacyPolicy {
  defaultMode: 'visible' | 'blur' | 'hidden';
  /** 可以直接查看隐私照片的角色（授权查看机制之一） */
  accessRoles: string[];
  /** 是否已设全局查看密码 */
  hasPassword: boolean;
  /** 模糊占位图的总闸强度，6~20，越大越糊 */
  blurStrength: number;
  /** 当前强度对应的完整规格参数（由后端算，后台只读展示） */
  blurSpec: BlurSpec;
  /** 全部可选强度的规格表：后台滑杆拖动时本地查表 */
  blurSpecTable: BlurSpec[];
}

/** 分享链接（后台视角） */
export interface PrivacyShare {
  id: string;
  mediaIds: string[];
  /** 提取码；为 null 表示这条链接不需要提取码 */
  accessCode: string | null;
  expiresAt: string;
  revoked: boolean;
  expired: boolean;
  createdBy: string | null;
  createdAt: string;
  /** 前台可直接打开的地址（不含提取码） */
  url: string;
}

/** 打开分享链接的结果：ok 时含照片；needCode 时前端弹提取码输入 */
export type ShareOpenResult =
  | { status: 'ok'; token: string; expiresAt: string; photos: Photo[] }
  | { status: 'needCode' }
  | { status: 'invalid' };

export const privacyApi = {
  /** 全局策略（公开） */
  async policy(): Promise<PrivacyPolicy> {
    return request<PrivacyPolicy>('/privacy/policy');
  },

  /** 改全局默认策略 / 授权角色 / 模糊强度（需 admin） */
  async updatePolicy(
    patch: Partial<Pick<PrivacyPolicy, 'defaultMode' | 'accessRoles' | 'blurStrength'>>,
  ): Promise<PrivacyPolicy> {
    return request<PrivacyPolicy>('/privacy/policy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  /** 设 / 清全局查看密码（需 admin；传 null 清除） */
  async setPassword(password: string | null): Promise<PrivacyPolicy> {
    return request<PrivacyPolicy>('/privacy/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  },

  /** 全局密码解锁：成功后票据写入 sdk，后续读接口自动带上 */
  async unlock(password: string): Promise<void> {
    const res = await request<{ token: string }>('/privacy/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setPrivacyToken(res.token);
  },

  /** 单张独立密码解锁 */
  async unlockPhoto(id: string, password: string): Promise<void> {
    const res = await request<{ token: string }>(`/privacy/photos/${encodeURIComponent(id)}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setPrivacyToken(res.token);
  },

  /** 给某张照片设 / 清独立密码（需 admin/editor） */
  async setPhotoPassword(id: string, password: string | null): Promise<void> {
    await request(`/privacy/photos/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  },

  /* ---- 分享链接 ---- */

  async shares(): Promise<PrivacyShare[]> {
    return request<PrivacyShare[]>('/privacy/shares');
  },

  /** 生成时效链接（需 admin/editor）：code 传 null 表示不要提取码，不传则后端自动生成一个 */
  async createShare(input: { ids: string[]; expiresInHours?: number; code?: string | null }): Promise<PrivacyShare> {
    return request<PrivacyShare>('/privacy/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  async revokeShare(id: string): Promise<void> {
    await request(`/privacy/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /**
   * 打开分享链接。需要区分三态（成功 / 缺提取码 / 链接无效），
   * 因此不走通用的 request（它把所有非 2xx 都压成同一个 Error）。
   */
  async openShare(token: string, code?: string): Promise<ShareOpenResult> {
    const query = code ? `?code=${encodeURIComponent(code)}` : '';
    const res = await fetch(`${apiBase}/privacy/shares/${encodeURIComponent(token)}${query}`);
    if (res.status === 401) return { status: 'needCode' };
    if (!res.ok) return { status: 'invalid' };
    const data = (await res.json()) as { token: string; expiresAt: string; photos: Photo[] };
    // 票据写入 sdk：分享页后续的图片请求都靠它（地址里已带 pt，这里只是保持状态一致）
    setPrivacyToken(data.token);
    return { status: 'ok', token: data.token, expiresAt: data.expiresAt, photos: data.photos.map(toPhoto) };
  },
};

/* --------------------------------------------------------------------------
 * 分类目录与相册（M2 动态化）：读接口公开，写接口需登录态
 * -------------------------------------------------------------------------- */

/** 分类：count = 该分类下未删除照片数 */
export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  count: number;
}

/** 相册分组：count = 该分组下的相册数 */
export interface AlbumGroup {
  id: string;
  name: string;
  sortOrder: number;
  count: number;
  /** 内置分组（默认分组）：不可改名、不可删除 */
  builtin: boolean;
  createdAt: string;
}

/** 相册摘要（coverUrl 已拼成绝对地址；无封面时为 undefined） */
export interface Album {
  id: string;
  title: string;
  description: string | null;
  coverUrl?: string;
  count: number;
  isPublic: boolean;
  /** 所属分组 id；正常不会为空（未指定时服务端落到「默认分组」） */
  groupId: string | null;
  createdAt: string;
}

/** 相册详情：摘要 + 册内照片（顺序 = 后台设定的 sortOrder） */
export interface AlbumDetail {
  album: Album;
  photos: Photo[];
}

/** 后端返回的相册（coverUrl 是相对路径） */
interface RawAlbum {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  count: number;
  isPublic: boolean;
  groupId: string | null;
  createdAt: string;
}

/** 相册写接口入参 */
export interface AlbumInput {
  title: string;
  description?: string;
  isPublic?: boolean;
  /** 所属分组；缺省落到「默认分组」 */
  groupId?: string;
  mediaIds?: string[];
}

export interface AlbumPatch {
  title?: string;
  description?: string;
  isPublic?: boolean;
  /** 传 null 清除自定义封面，回退到册内第一张 */
  coverMediaId?: string | null;
  /** 改所属分组；传 null 回到「默认分组」 */
  groupId?: string | null;
}

/** 相对路径 → 绝对地址（coverUrl 与照片 url 同一套规则） */
function toAlbum(raw: RawAlbum): Album {
  return { ...raw, coverUrl: absolute(raw.coverUrl ?? undefined) };
}

export const categoryApi = {
  /** 分类列表（公开） */
  async list(): Promise<Category[]> {
    return request<Category[]>('/categories');
  },

  /** 新建分类（需 admin） */
  async create(name: string, sortOrder?: number): Promise<Category> {
    return request<Category>('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, sortOrder }),
    });
  },

  /** 改名（需 admin）；后端会在同一事务里同步照片的分类值 */
  async rename(id: string, name: string): Promise<Category> {
    return request<Category>(`/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },

  /** 删除分类（需 admin）；分类下仍有照片时后端返回 409 */
  async remove(id: string): Promise<{ removed: number }> {
    return request(`/categories/${id}`, { method: 'DELETE' });
  },
};

export const albumApi = {
  /** 相册列表（公开） */
  async list(): Promise<Album[]> {
    return (await request<RawAlbum[]>('/albums')).map(toAlbum);
  },

  /** 相册详情（公开）：含册内照片，url 已拼绝对地址 */
  async detail(id: string): Promise<AlbumDetail> {
    const raw = await request<{ album: RawAlbum; photos: Photo[] }>(withPrivacy(`/albums/${id}`));
    return { album: toAlbum(raw.album), photos: raw.photos.map(toPhoto) };
  },

  /** 新建相册（需 admin/editor） */
  async create(input: AlbumInput): Promise<Album> {
    return toAlbum(
      await request<RawAlbum>('/albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
  },

  /** 改相册信息（需 admin/editor） */
  async update(id: string, patch: AlbumPatch): Promise<Album> {
    return toAlbum(
      await request<RawAlbum>(`/albums/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  },

  /** 删除相册（需 admin） */
  async remove(id: string): Promise<{ removed: number }> {
    return request(`/albums/${id}`, { method: 'DELETE' });
  },

  /** 全量替换册内成员（需 admin/editor）：ids 的顺序即新的展示顺序 */
  async setMedia(id: string, ids: string[]): Promise<Album> {
    return toAlbum(
      await request<RawAlbum>(`/albums/${id}/media`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      }),
    );
  },

  /** 批量移动到指定分组（需 admin/editor）：把多个相册一次性改归属 */
  async assignGroup(ids: string[], groupId: string): Promise<{ moved: number }> {
    return request(`/albums/group`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, groupId }),
    });
  },
};

export const albumGroupApi = {
  /** 分组列表（公开）：前台导航条与后台分组管理页共用 */
  async list(): Promise<AlbumGroup[]> {
    return request<AlbumGroup[]>('/album-groups');
  },

  /** 新建分组（需 admin）；同名返回 409 */
  async create(name: string, sortOrder?: number): Promise<AlbumGroup> {
    return request<AlbumGroup>('/album-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, sortOrder }),
    });
  },

  /** 改名 / 改排序（需 admin） */
  async update(id: string, patch: { name?: string; sortOrder?: number }): Promise<AlbumGroup> {
    return request<AlbumGroup>(`/album-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  /** 全量重写排序（需 admin）：ids 的顺序即新的 sortOrder */
  async reorder(ids: string[]): Promise<AlbumGroup[]> {
    return request<AlbumGroup[]>('/album-groups/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  },

  /** 删除分组（需 admin）：moveTo 指定组内相册的去处，缺省落「默认分组」 */
  async remove(id: string, moveTo?: string): Promise<{ removed: number; moved: number }> {
    return request(`/album-groups/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moveTo }),
    });
  },
};

/* --------------------------------------------------------------------------
 * 后台管理（需求 3）：账号 / 数据概览 / 系统设置 / 操作审计
 * 全部需要 admin 登录态；返回结构与后端 AdminService 的形状一一对应。
 * -------------------------------------------------------------------------- */

/** 账号（列表与新建返回同一个形状；绝不含密码哈希） */
export interface AdminUser {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

export interface UserCreateInput {
  username: string;
  password: string;
  /** 角色名：admin / editor / viewer */
  role: string;
}

export interface UserPatch {
  role?: string;
  /** 只传新密码；不传即不改 */
  password?: string;
}

export const userApi = {
  async list(): Promise<AdminUser[]> {
    return request<AdminUser[]>('/users');
  },

  async create(input: UserCreateInput): Promise<AdminUser> {
    return request<AdminUser>('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  async update(id: string, patch: UserPatch): Promise<AdminUser> {
    return request<AdminUser>(`/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  async remove(id: string): Promise<{ removed: number }> {
    return request(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

/** 数据概览：一次请求拿齐首页要展示的几个数 */
export interface AdminStats {
  photos: number;
  /** 已软删除的照片数（后台可见，前台不出现） */
  deletedPhotos: number;
  livePhotos: number;
  /** 已显式标记为受保护（blur / hidden）的照片数；inherit 是默认值、visible 是显式公开，都不计入 */
  markedPhotos: number;
  albums: number;
  categories: number;
  users: number;
  /** 分享链接总数 / 其中仍有效的条数 */
  shares: number;
  activeShares: number;
  /** 最新一张的拍摄日期（YYYY-MM-DD），没有照片时为 null */
  latestCapture: string | null;
}

export const statsApi = {
  async get(): Promise<AdminStats> {
    return request<AdminStats>('/stats');
  },
};

/**
 * 站点设置：全部是「改动后确实生效」的项，不做装饰性开关。
 *   - site.title / site.slogan：前台页头的品牌名与标语
 *   - upload.maxMb：单文件上传上限（MB），服务端在落盘前校验
 *   - upload.formats：允许上传的扩展名，逗号分隔（如 .jpg,.png）
 *   - upload.defaultCategory：无法从文件名与 EXIF 推断分类时使用的保底分类
 *   - upload.chunkMb：分片上传的每片大小（MB），客户端按它切片
 *   - upload.concurrency：分片上传的并发数，客户端凭它限流，避免打满网关
 */
export interface SiteSettings {
  'site.title': string;
  'site.slogan': string;
  'upload.maxMb': string;
  'upload.formats': string;
  'upload.defaultCategory': string;
  'upload.chunkMb': string;
  'upload.concurrency': string;
}

export const settingsApi = {
  /** 读全部站点设置（**公开**：前台页头也要读标题与标语） */
  async all(): Promise<SiteSettings> {
    return request<SiteSettings>('/settings');
  },

  /** 改设置（需 admin）：只传要改的项，返回改后的全量 */
  async update(patch: Partial<SiteSettings>): Promise<SiteSettings> {
    return request<SiteSettings>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
};

/**
 * 主题配置：颜色与字号倍率。
 *
 * 【为什么与 settingsApi 分开】settings 只认 7 个扁平的文本键（白名单防覆盖 privacy.*），
 * 而主题是一棵结构化对象；混在一起会让「系统设置」与「主题配置」两个页面互相踩值。
 * 存储仍复用 settings 表（键 theme.config），但读写走独立端点。
 */
export const themeApi = {
  /** 读主题配置（**公开**：前台首屏就要读，否则无法在渲染前套用样式） */
  async get(): Promise<ThemeConfig> {
    return request<ThemeConfig>('/theme');
  },

  /** 改主题配置（需 admin）：只传要改的项，返回**归一化后**的全量 */
  async update(patch: Partial<ThemeConfig>): Promise<ThemeConfig> {
    return request<ThemeConfig>('/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  /** 恢复出厂（需 admin）：整体替换为出厂值 —— 不是补丁，空值也能清掉 */
  async reset(): Promise<ThemeConfig> {
    return request<ThemeConfig>('/theme/reset', { method: 'POST' });
  },
};

/* --------------------------------------------------------------------------
 * 启动时套用主题
 *
 * 【为什么必须发生在 render 之前】首屏若先按出厂样式画一遍、再套上真实主题，
 * 用户会看到字号与配色「跳一下」。因此入口处 await 它，拿到结果再渲染。
 *
 * 【为什么还要一份 localStorage 缓存】网络差或后端未就绪时不能让首屏一直空着：
 * 缓存先顶上（通常与真实值一致），接口回来后用真实值覆盖；接口失败则缓存即最终结果。
 * 缓存读写都套了 try —— 隐私模式禁用 storage、配额写满都不该影响页面可用。
 * -------------------------------------------------------------------------- */

const THEME_CACHE_KEY = 'shaping-memory.theme';
const THEME_LOAD_TIMEOUT_MS = 1500;

/** 读上次缓存的主题（已是归一化后的安全值；读不到或解析失败返回 null） */
function readThemeCache(): ThemeConfig | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    return raw ? normalizeThemeConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeThemeCache(config: ThemeConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(config));
  } catch {
    // 缓存只是「快一点」，写不进去不影响任何功能，静默即可
  }
}

/** 给接口加个上限：超过 ms 仍未返回即视为失败，以缓存保底，避免首屏被网络阻塞 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('theme load timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 入口调用：把主题套到页面上（**必须 await 之后再 render**）。
 * 顺序是「缓存先上 → 接口覆盖 → 都拿不到才用出厂值」，
 * 因此任何一步失败都还有东西可渲染，不会出现无样式的瞬间。
 */
export async function bootstrapTheme(): Promise<ThemeConfig> {
  const cached = readThemeCache();
  if (cached) setActiveTheme(cached);

  try {
    const config = await withTimeout(themeApi.get(), THEME_LOAD_TIMEOUT_MS);
    setActiveTheme(config);
    writeThemeCache(config);
    return config;
  } catch {
    // 接口不可用（或超时）：缓存即最终结果；连缓存都没有才回落到出厂默认（含 PC 放大）
    if (cached) return cached;
    return setActiveTheme(normalizeThemeConfig(THEME_DEFAULTS)).config;
  }
}

/** 操作审计：一次写操作一条记录 */
export interface AuditEntry {
  id: number;
  actor: string | null;
  method: string;
  path: string;
  status: number;
  at: string;
}

export const auditApi = {
  /** 最近的操作记录（需 admin），默认最近 200 条 */
  async list(limit = 200): Promise<AuditEntry[]> {
    return request<AuditEntry[]>(`/audit?limit=${limit}`);
  },
};