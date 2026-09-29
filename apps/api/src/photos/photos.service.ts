/**
 * apps/api/src/photos/photos.service.ts
 *
 * 照片查询与资源管理：读接口（list/get）公开，写接口（update/remove/removeBatch）由控制器加 RBAC。
 * 软删除：删除只把 media.deleted 打标，不物理删文件；Read 一律过滤 deleted=true 的行。
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { exifMetadata, media, mediaTags, tags } from '@shaping-memory/db';
import type { Db, MediaInsert } from '@shaping-memory/db';
import { readExifFull } from '@shaping-memory/exif';
import type { ExifFull, ExifWriteValue } from '@shaping-memory/exif';
import type { ObjectStore } from '@shaping-memory/storage';
import { EXIF_TAG_PATTERN, isValidLatLon, parseGpsValue, toWgs84 } from '@shaping-memory/core';
import type { CoordSystem, PhotoTag, SearchQuery, TagReviewStatus, TagSource } from '@shaping-memory/core';
import type { AppConfig } from '@shaping-memory/config';
import { APP_CONFIG, DB, OBJECT_STORE } from '../infra.module';
import { remoteStoreOf } from '../storage-config';
import { stageOriginal } from '../original-staging';
import { reverseGeocode } from '../geo/regeo';
import { displayPatchOf, mediaDatePatchOf } from './exif-sync';
import { hiddenExclusion, privacyContextOf, verdictOf } from '../privacy/policy';
import type { PrivacyMode, PrivacyPass } from '../privacy/policy';
import type { PageParams } from './filter-params';
import { signGrant } from '../privacy/tokens';

/** 写进图片地址的票据默认寿命：够一次完整浏览，过期后重新解锁即可 */
const GRANT_TTL_SECONDS = 8 * 3600;

/** 前端消费的照片形状（camelCase），与 packages/core 的 Photo 对应，url 为相对路径 */
export interface ApiPhoto {
  id: string;
  title: string;
  /**
   * 上传时的原始文件名（含扩展名）；批量导入的照片没有这条信息，为 null。
   * 文件夹上传要在**上传前**比对「这个文件是不是已经传过」，比对键就是它 + originalSize。
   */
  originalName: string | null;
  /** 上传时的原始字节数；与 originalName 成对出现 */
  originalSize: number | null;
  /** 描述正文（纯文本，保留换行）；没写时为空串 */
  description: string;
  cat: string;
  format: string;
  /**
   * 标签（带来源与审核态）。
   * 【为什么不是 string[]】后台要显示「AI 识别 · 置信度 65%」并按审核态区分待审，
   * 前台要只取已生效的 —— 只给名字的话前端还得再发一次请求才知道能不能显示。
   */
  tags: PhotoTag[];
  cam: string;
  lens: string;
  focal: string;
  aperture: string;
  iso: number | null;
  speed: string;
  temp: string;
  wb: string;
  place: string;
  date: string;
  likes: number;
  size: 'landscape' | 'portrait';
  url: string;
  /** 卡片档缩略图（小尺寸，瀑布流/列表用） */
  cardUrl: string;
  /** 原片可访问地址（「在新标签打开原图」用）；隐私照片对无权者恒为 null */
  originalUrl: string | null;
  /** 是否实况照片（Motion Photo） */
  isLive: boolean;
  /** 实况视频地址；非实况照片、以及隐私照片对无权者均为 null */
  liveUrl: string | null;
  /** 照片文件里的定位（WGS-84）；文件没有 GPS 时为 null */
  gps: { lat: number; lon: number; alt: number | null } | null;
  /** 隐私状态：前台据此渲染模糊蒙版与解锁入口 */
  privacy: { mode: PrivacyMode; locked: boolean; hasOwnPassword: boolean };
  /** 原片像素宽高（EXIF ImageWidth/Height）。锁定照片也下发——瀑布流布局需要真实比例占位，否则换页会跳 */
  width: number | null;
  height: number | null;
}

/**
 * 列表检索条件。所有字段可选，缺省即「不按该维度过滤」——
 * 后台的搜索框、日期范围、相机/镜头下拉、定位筛选最终都落到这里。
 *
 * 【为什么派生 SearchQuery 而非各写一份】检索维度（关键词 / 日期 / 器材 / 标签…）在前台、
 * SDK、后端三处必须同名同义，各写一份必然出现不一致；core 的 SearchQuery 是唯一事实源，
 * 这里只补两个「列表专有」的维度。
 *
 * 【光圈 / 快门 / ISO 为什么是精确匹配】它们的候选值来自字典（规范写法，如 f/4、1/200），
 * 模糊匹配会产生错误结果：选 f/2 用 ilike '%f/2%' 会把 f/20、f/22、f/2.8 一并匹配进来。
 * 字典化之后「精确」才是正确口径，自由输入的容错交给前端联想。
 */
export interface ListFilter extends SearchQuery {
  category?: string;
  sort?: 'asc' | 'desc';
}

/** 可编辑的元数据字段：标题 / 描述 / 分类 / 点赞 / 标签 / 隐私标记（其余 EXIF 为只读） */
export interface UpdatePhotoDto {
  title?: string;
  /** 描述正文（纯文本）；传空串即清除 */
  description?: string;
  category?: string;
  likes?: number;
  tags?: string[];
  /** 隐私标记：inherit=跟随全局默认 / visible / blur / hidden */
  privacy?: string;
}

/** 写入 EXIF 的入参：字段值（tag → 值）、定位（可单独用地图选点写）、定位坐标系 */
export interface UpdateExifDto {
  /** 逐 tag 的写入值；null / 空串表示清除该 tag */
  fields?: Record<string, string | string[] | null>;
  /** 地图选点结果；传 null 表示清除定位；不传表示本次不改定位 */
  gps?: { lat: number; lon: number; alt?: number | null } | null;
  /** gps 用的是哪套坐标系（高德底图传 gcj02，百度传 bd09），后端统一转 WGS-84 再写 */
  crs?: CoordSystem;
}

/** EXIF 读取/写入的统一返回：文件里的全量字段 + 归一后的定位 + 更新后的照片 */
export interface PhotoExifResult {
  /** tag（exiftool 短名）→ -n 口径原始值 */
  fields: ExifFull;
  /** 文件里实际存在的定位（WGS-84）；没有则为 null */
  gps: { lat: number; lon: number; alt: number | null } | null;
  photo: ApiPhoto;
}

/** 「查看原片 EXIF」的返回：原片本体的全量字段 + 定位；不附带照片（调用方已有） */
export interface OriginalExifResult {
  fields: ExifFull;
  gps: { lat: number; lon: number; alt: number | null } | null;
}

/** 合法的隐私标记取值：单张编辑与批量编辑共用一份，避免两处校验口径不一致 */
const PRIVACY_MARKS = ['inherit', 'visible', 'blur', 'hidden'];

type Row = {
  id: string;
  title: string;
  /** 上传时的原始文件名与字节数；批量导入的照片两者皆为 null */
  originalName: string | null;
  originalSize: number | null;
  /** 描述正文；没写时为 null */
  description: string | null;
  category: string;
  format: string;
  captureAt: string | null;
  orientation: string;
  likes: number;
  liveVideoPath: string | null;
  /** 隐私标记（inherit/visible/blur/hidden）与单张独立密码哈希 */
  privacy: string | null;
  privacyPasswordHash: string | null;
  cam: string | null;
  lens: string | null;
  focal: string | null;
  aperture: string | null;
  iso: number | null;
  speed: string | null;
  temp: string | null;
  wb: string | null;
  /** 拍摄地点（定位反解出的可读地名）；无定位或反解失败时为空 */
  place: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAlt: number | null;
  /** 原片像素宽高（来自 media 表，导入时由 EXIF 写入） */
  width: number | null;
  height: number | null;
};

/**
 * list / get / photosByIds 三处共用的列集。
 * 【为什么抽出来】三者的 select 字段必须永远一致，否则会出现「列表里有坐标、详情里没有」
 * 这类字段不一致 —— 加一列只改这里一处。
 */
const PHOTO_COLUMNS = {
  id: media.id,
  title: media.title,
  originalName: media.originalName,
  originalSize: media.originalSize,
  description: media.description,
  category: media.category,
  format: media.format,
  captureAt: media.captureAt,
  orientation: media.orientation,
  likes: media.likes,
  liveVideoPath: media.liveVideoPath,
  privacy: media.privacy,
  privacyPasswordHash: media.privacyPasswordHash,
  cam: exifMetadata.cam,
  lens: exifMetadata.lens,
  focal: exifMetadata.focal,
  aperture: exifMetadata.aperture,
  iso: exifMetadata.iso,
  speed: exifMetadata.speed,
  temp: exifMetadata.temp,
  wb: exifMetadata.wb,
  place: exifMetadata.place,
  gpsLat: exifMetadata.gpsLat,
  gpsLon: exifMetadata.gpsLon,
  gpsAlt: exifMetadata.gpsAlt,
  /* 原片像素宽高在 media 表（不在 exif_metadata），与导入时的 orientation 同源 */
  width: media.width,
  height: media.height,
} as const;

/** 经纬度必须成对才有意义（海拔可以缺），任一为空即视为「这张照片没有定位」 */
function toGps(lat: number | null, lon: number | null, alt: number | null): ApiPhoto['gps'] {
  if (lat == null || lon == null) return null;
  return { lat, lon, alt };
}

const placeholder = (value: string | null | undefined): string => value ?? '';

/**
 * 从全量 EXIF 里取出定位。
 * EXIF 的 GPS 天生是 WGS-84，因此这里**不做任何坐标系转换** —— 转换只发生在
 * 「底图 ↔ EXIF」的边界上（前端地图选点、后端写入前），读取路径上转了反而会偏。
 *
 * 【为什么要拼 Ref】EXIF 把「数值」与「方向」拆成两组 tag：本体可能是无符号的，
 * 南纬/西经由 GPSLatitudeRef=S / GPSLongitudeRef=W 表达。exiftool 带 -n 时通常已把
 * 符号并进数值，但相机直出的文件不保证 —— 因此这里只在「数值为正且 Ref 指明反向」
 * 时补符号，既纠正无符号数据，又不会把已带符号的值翻成正的。
 */
function signedGps(raw: number, ref: string | undefined, negativeRef: string): number {
  return raw > 0 && ref === negativeRef ? -raw : raw;
}

function gpsOf(fields: ExifFull): PhotoExifResult['gps'] {
  const rawLat = parseGpsValue(fields.GPSLatitude);
  const rawLon = parseGpsValue(fields.GPSLongitude);
  if (rawLat == null || rawLon == null) return null;
  const lat = signedGps(rawLat, fields.GPSLatitudeRef, 'S');
  const lon = signedGps(rawLon, fields.GPSLongitudeRef, 'W');
  if (!isValidLatLon(lat, lon)) return null;
  const rawAlt = parseGpsValue(fields.GPSAltitude);
  return { lat, lon, alt: rawAlt == null ? null : signedGps(rawAlt, fields.GPSAltitudeRef, '1') };
}

@Injectable()
export class PhotosService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async list(filter: ListFilter, page: PageParams, pass: PrivacyPass): Promise<ApiPhoto[]> {
    const ascending = filter.sort === 'asc';
    /* 次级排序键取 id：capture_at 是 date 列（同一天的照片全部并列），只按它排序时
       PostgreSQL 对并列行的次序不作保证 —— 分页取第二页时可能与第一页重叠或漏掉几张。
       加上 id 之后顺序唯一，翻页因此稳定。 */
    const order = ascending
      ? [asc(media.captureAt), asc(media.id)]
      : [desc(media.captureAt), desc(media.id)];

    const query = this.db
      .select(PHOTO_COLUMNS)
      .from(media)
      .leftJoin(exifMetadata, eq(exifMetadata.mediaId, media.id))
      // 每层只拼自己那一半：这里负责「未软删除」，检索条件交给 conditionsOf
      .where(and(eq(media.deleted, false), ...this.conditionsOf(filter, pass)))
      .orderBy(...order);

    // 只有调用方显式传 limit 才分页；不传就是「整份档案」（后台管理端依赖这个口径）
    const rows =
      page.limit == null ? await query : await query.limit(page.limit).offset(page.offset ?? 0);

    const tagMap = await this.tagsForMany(rows.map((row) => row.id));
    const grant = this.filesGrant(pass);
    return this.visibleOnly(rows.map((row) => this.toApi(row, tagMap.get(row.id) ?? [], pass, grant)));
  }

  /** 丢弃「对当前请求者不可见」的条目（toApi 用 null 表达），并将类型收窄为非空 */
  private visibleOnly(photos: (ApiPhoto | null)[]): ApiPhoto[] {
    return photos.filter((photo): photo is ApiPhoto => photo !== null);
  }

  /**
   * 把检索条件翻译成 SQL 条件数组。
   * 【为什么返回数组】调用方还要并上「未软删除」等自有条件，
   * 返回数组让它直接展开；未命中的维度返回 undefined，drizzle 的 and() 会自行跳过。
   *
   * 【为什么要 pass】隐私的「隐藏」判定必须和检索条件一样落在 SQL 里：
   * 先取一页再在内存里丢弃照片会使每页条数不齐，前端的「不足一页即到底」判断会提前结束分页。
   */
  private conditionsOf(filter: ListFilter, pass: PrivacyPass): (SQL | undefined)[] {
    const keyword = filter.q?.trim();
    const like = keyword ? `%${keyword}%` : null;
    return [
      filter.category && filter.category !== '全部' ? eq(media.category, filter.category) : undefined,
      // 关键词同时覆盖「照片自身的标识」与「器材线索」：后台检索时通常依据的正是相机或镜头
      like
        ? or(
            ilike(media.title, like),
            ilike(media.id, like),
            ilike(media.category, like),
            ilike(exifMetadata.cam, like),
            ilike(exifMetadata.lens, like),
          )
        : undefined,
      filter.from ? gte(media.captureAt, filter.from) : undefined,
      filter.to ? lte(media.captureAt, filter.to) : undefined,
      filter.cam ? eq(exifMetadata.cam, filter.cam) : undefined,
      filter.lens ? eq(exifMetadata.lens, filter.lens) : undefined,
      filter.aperture ? eq(exifMetadata.aperture, filter.aperture) : undefined,
      filter.speed ? eq(exifMetadata.speed, filter.speed) : undefined,
      filter.iso == null ? undefined : eq(exifMetadata.iso, filter.iso),
      // 定位筛选：经纬度任一为空都算「没有定位」，与 toGps 的口径保持一致
      filter.hasGps === undefined
        ? undefined
        : filter.hasGps
          ? and(isNotNull(exifMetadata.gpsLat), isNotNull(exifMetadata.gpsLon))
          : or(isNull(exifMetadata.gpsLat), isNull(exifMetadata.gpsLon)),
      this.tagsCondition(filter.tags ?? []),
      // 隐私「隐藏」档在此排除：口径与 toApi 的判定同源（见 policy.ts 的 hiddenExclusion）
      hiddenExclusion(pass.settings, pass.ctx),
    ];
  }

  /**
   * 标签条件：每一枚选中的标签都必须命中（AND）。
   *
   * 【为什么用 EXISTS 而不是 join + group by】list() 已经 leftJoin 了 exif_metadata，
   * 再 join media_tags 会让「一张多标签照片」在结果里裂成多行（还需依赖 group by 收回）；
   * EXISTS 是逐标签的半连接判断，既不放大行数，AND 语义也天然成立。
   * 未选标签时返回 undefined，drizzle 的 and() 会自行跳过。
   */
  private tagsCondition(names: string[]): SQL | undefined {
    if (names.length === 0) return undefined;
    return and(...names.map((name) => this.tagExists(name)));
  }

  /** 单枚标签是否存在：media_tags 里有一条 (本照片, 该标签名) 即成立 */
  private tagExists(name: string): SQL {
    return exists(
      this.db
        .select({ hit: mediaTags.tagId })
        .from(mediaTags)
        .innerJoin(tags, eq(tags.id, mediaTags.tagId))
        .where(and(eq(mediaTags.mediaId, media.id), eq(tags.name, name))),
    );
  }

  async get(id: string, pass: PrivacyPass): Promise<ApiPhoto | null> {
    const rows = await this.db
      .select(PHOTO_COLUMNS)
      .from(media)
      .leftJoin(exifMetadata, eq(exifMetadata.mediaId, media.id))
      .where(and(eq(media.id, id), eq(media.deleted, false)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    const photo = this.toApi(row, await this.tagsOf(id), pass, this.filesGrant(pass));
    // hidden 的照片对无权者按「不存在」处理：返回 null 让控制器抛 404，不暴露它被隐藏过
    return photo;
  }

  /**
   * 按 id 批量取照片（相册详情用）：**返回顺序与入参一致**，并过滤已软删除的行。
   * 与 list() 的差别只在「排序来源」：这里由调用方给定的 ids 顺序决定，
   * 因为相册的展示顺序来自 album_media.sort_order，不是拍摄时间。
   */
  async photosByIds(ids: string[], pass: PrivacyPass): Promise<ApiPhoto[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select(PHOTO_COLUMNS)
      .from(media)
      .leftJoin(exifMetadata, eq(exifMetadata.mediaId, media.id))
      .where(and(inArray(media.id, ids), eq(media.deleted, false)));

    const tagMap = await this.tagsForMany(rows.map((row) => row.id));
    const grant = this.filesGrant(pass);
    const byId = new Map(
      rows.map((row) => [row.id, this.toApi(row, tagMap.get(row.id) ?? [], pass, grant)]),
    );
    // 按入参顺序回填；已删除 / 不存在 / 对当前请求者不可见的 id 直接跳过（filter 同时收窄类型）
    return ids.map((id) => byId.get(id)).filter((photo): photo is ApiPhoto => photo != null);
  }

  /**
   * 本次响应里所有「受隐私保护的照片」共用的访问票据（拼在图片地址上）。
   *
   * 【为什么能共用一张】票据只表达「谁 / 能看哪几张」，同一响应里这两项恒定；
   * 逐张签一张既浪费也算不出任何额外安全 —— 反而更难失效。
   * 请求本身已带票据时直接复用，避免同一秒内签出一堆等价票据。
   */
  private filesGrant(pass: PrivacyPass): string | null {
    const { ctx } = pass;
    if (ctx.token) return ctx.token;
    const exp = Math.floor(Date.now() / 1000) + (ctx.grantTtlSeconds ?? GRANT_TTL_SECONDS);
    if (ctx.authorized && ctx.role) return signGrant(this.config.JWT_SECRET, { role: ctx.role, exp });
    if (ctx.sharedIds && ctx.sharedIds.size > 0) {
      return signGrant(this.config.JWT_SECRET, { role: 'share', ids: [...ctx.sharedIds], exp });
    }
    return null;
  }

  /** 单张标签 */
  private async tagsOf(mediaId: string): Promise<PhotoTag[]> {
    const map = await this.tagsForMany([mediaId]);
    return map.get(mediaId) ?? [];
  }

  /**
   * 批量取标签：一次查询覆盖一批 id，避免列表里逐张反查。
   * 【为什么连来源与审核态一起取】后台要在同一张表里显示 AI 角标与置信度、
   * 前台要按审核态筛，若这里只给名字，两端都得再回查一次 media_tags。
   */
  private async tagsForMany(ids: string[]): Promise<Map<string, PhotoTag[]>> {
    const map = new Map<string, PhotoTag[]>();
    if (ids.length === 0) return map;
    const rows = await this.db
      .select({
        mediaId: mediaTags.mediaId,
        name: tags.name,
        source: mediaTags.source,
        confidence: mediaTags.confidence,
        reviewStatus: mediaTags.reviewStatus,
      })
      .from(mediaTags)
      .innerJoin(tags, eq(tags.id, mediaTags.tagId))
      .where(inArray(mediaTags.mediaId, ids));
    for (const row of rows) {
      const tag: PhotoTag = {
        name: row.name,
        // 历史行可能缺这两列（默认值回退），落到界面上的取值必须始终是合法枚举
        source: (row.source ?? 'manual') as TagSource,
        confidence: row.confidence,
        reviewStatus: (row.reviewStatus ?? 'approved') as TagReviewStatus,
      };
      const list = map.get(row.mediaId);
      if (list) list.push(tag);
      else map.set(row.mediaId, [tag]);
    }
    return map;
  }

  /**
   * 由请求解出隐私上下文（策略 + 身份）。控制器统一走这里，
   * 避免每个端点在控制器里各自去读一次设置表、或各自判一次角色。
   */
  pass(req: { user?: { role: string }; query?: Record<string, unknown> }): Promise<PrivacyPass> {
    return privacyContextOf(this.db, this.config.JWT_SECRET, req);
  }

  /** 编辑元数据（标题/分类/点赞/标签/隐私标记）。返回更新后的完整照片 */
  async update(id: string, patch: UpdatePhotoDto, pass: PrivacyPass): Promise<ApiPhoto> {
    const existing = await this.get(id, pass);
    if (!existing) throw new NotFoundException('照片不存在');

    const sets = this.mediaPatchOf(patch);
    if (Object.keys(sets).length > 0) {
      await this.db.update(media).set(sets).where(eq(media.id, id));
    }
    if (patch.tags !== undefined) await this.replaceTags(id, patch.tags);

    const updated = await this.get(id, pass);
    if (!updated) throw new NotFoundException('照片不存在');
    return updated;
  }

  /**
   * 批量改元数据：把同一份补丁套到选中的每一张上。
   * 【为什么共享一份补丁】批量编辑的语义就是「把这些照片的这几个字段统一成同一个值」。
   * 与单张编辑共用 mediaPatchOf，因此「没传的字段不动」这条语义两处一致。
   */
  async updateBatch(ids: string[], patch: UpdatePhotoDto): Promise<number> {
    const alive = await this.aliveIds(ids);
    if (alive.length === 0) return 0;

    const sets = this.mediaPatchOf(patch);
    if (Object.keys(sets).length > 0) {
      await this.db.update(media).set(sets).where(inArray(media.id, alive));
    }
    // 标签是「整组替换」：批量的含义是把选中照片的标签统一成这一组
    if (patch.tags !== undefined) {
      for (const id of alive) await this.replaceTags(id, patch.tags);
    }
    return alive.length;
  }

  /** 把「补丁里出现过」的字段整理成 media 的 update set（未出现的字段绝不动） */
  private mediaPatchOf(patch: UpdatePhotoDto): Partial<MediaInsert> {
    const sets: Partial<MediaInsert> = {};
    if (patch.title !== undefined) sets.title = patch.title;
    /* 描述走同一个「出现过才写」的口径：传空串即清除（NULL 与空串在展示上等价） */
    if (patch.description !== undefined) sets.description = patch.description;
    if (patch.category !== undefined) sets.category = patch.category;
    if (patch.likes !== undefined) sets.likes = patch.likes;
    if (patch.privacy !== undefined) {
      if (!PRIVACY_MARKS.includes(patch.privacy)) {
        throw new BadRequestException('隐私标记只能是 inherit / visible / blur / hidden');
      }
      sets.privacy = patch.privacy;
    }
    return sets;
  }

  /** 过滤出真实存在且未软删除的 id：批量操作先收敛一次，后续写入不必逐张判空 */
  private async aliveIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: media.id })
      .from(media)
      .where(and(inArray(media.id, ids), eq(media.deleted, false)));
    return rows.map((row) => row.id);
  }

  /** 幂等重建某张照片的标签关联 */
  private async replaceTags(mediaId: string, tagNames: readonly string[]): Promise<void> {
    await this.db.delete(mediaTags).where(eq(mediaTags.mediaId, mediaId));
    for (const name of tagNames) {
      await this.db.insert(tags).values({ id: name, name }).onConflictDoNothing();
      await this.db.insert(mediaTags).values({ mediaId, tagId: name });
    }
  }

  /** 软删除：打标，不物理删文件 */
  async remove(id: string): Promise<void> {
    await this.db.update(media).set({ deleted: true }).where(eq(media.id, id));
  }

  /** 批量软删除，返回命中行数 */
  async removeBatch(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db.update(media).set({ deleted: true }).where(inArray(media.id, ids));
    return result.rowCount ?? 0;
  }

  /* ------------------------------------------------------------------------
   * 全量 EXIF 读写（数据库是唯一事实源）
   *
   * 【为什么不再动照片文件】云端原片自上传起不可变（混合存储决策），
   * EXIF 的一切修改只落 exif_metadata；需要「带新 EXIF 的文件」时，
   * 由下载端点把库里最新的 extra 动态注入临时副本（见 files.controller 的 download）。
   * ---------------------------------------------------------------------- */

  /** 读取某张照片的 EXIF：以数据库 exif_metadata 为准（extra 里存全量原始 tag） */
  async exifOf(id: string, pass: PrivacyPass): Promise<PhotoExifResult> {
    await this.requireRow(id);
    const meta = await this.db.query.exifMetadata.findFirst({ where: eq(exifMetadata.mediaId, id) });
    const fields = (meta?.extra ?? {}) as ExifFull;
    const gps = toGps(meta?.gpsLat ?? null, meta?.gpsLon ?? null, meta?.gpsAlt ?? null);
    return { fields, gps, photo: await this.requirePhoto(id, pass) };
  }

  /**
   * 更新 EXIF：把写入表应用进「内存里的全量 extra」，再同步展示列 / 日期 / 地点。
   * 全程零 exiftool spawn —— 云端原片保持原样，只改数据库。
   */
  async updateExif(id: string, payload: UpdateExifDto, pass: PrivacyPass): Promise<PhotoExifResult> {
    await this.requireRow(id);
    const writes = this.buildExifWrites(payload);
    if (Object.keys(writes).length === 0) return this.exifOf(id, pass);

    const fields = await this.applyExifWrites(id, writes);
    return { fields, gps: gpsOf(fields), photo: await this.requirePhoto(id, pass) };
  }

  /**
   * 批量更新同一份 EXIF 补丁（需 admin/editor）。
   * 纯数据库写入，串行足够快；批量选择通常是十几张的量级。
   */
  async updateExifBatch(ids: string[], payload: UpdateExifDto): Promise<number> {
    const writes = this.buildExifWrites(payload);
    if (Object.keys(writes).length === 0) throw new BadRequestException('还没有填写要修改的内容');

    const alive = await this.aliveIds(ids);
    for (const id of alive) {
      await this.applyExifWrites(id, writes);
    }
    return alive.length;
  }

  /**
   * 「查看原片 EXIF」：把**原片本体**取回后只读解析，用于与「库里记的」对照。
   *
   * 【为什么必须读原片】云端原片自上传起不可变，库里记的是「最新编辑结果」；
   * 要分辨「这张图最初包含哪些信息」，只能读原片本体。全程不写 DB、不改任何文件。
   */
  async originalExifOf(id: string): Promise<OriginalExifResult> {
    const row = await this.requireRow(id);
    const remote = remoteStoreOf(this.config, this.store);
    const tmpPath = await stageOriginal(this.config, remote, row);
    try {
      const fields = await readExifFull(this.config.TOOLS_DIR, tmpPath);
      return { fields, gps: gpsOf(fields) };
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  /**
   * 把写入表应用进 DB 里的全量 EXIF：
   * 值非 null 则 set，null 则 delete；多值数组按 exiftool 的读取口径 join 成 ", "。
   * 写完后立刻重推展示列 / 拍摄日期 / 地点并 upsert —— 展示列与 extra 始终保持一致。
   */
  private async applyExifWrites(id: string, writes: Record<string, ExifWriteValue>): Promise<ExifFull> {
    const meta = await this.db.query.exifMetadata.findFirst({ where: eq(exifMetadata.mediaId, id) });
    const fields: ExifFull = { ...((meta?.extra ?? {}) as ExifFull) };
    for (const [tag, value] of Object.entries(writes)) {
      if (value == null || value === '') {
        delete fields[tag];
      } else {
        fields[tag] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
      }
    }
    await this.syncFromExtra(id, fields);
    return fields;
  }

  /** 把入参整理成待写入的 tag 表（含定位的坐标系归一与 tag 合法性校验） */
  private buildExifWrites(payload: UpdateExifDto): Record<string, ExifWriteValue> {
    const writes: Record<string, ExifWriteValue> = {};

    for (const [tag, value] of Object.entries(payload.fields ?? {})) {
      // 白名单正则与前后台共用同一份（core 的 EXIF_TAG_PATTERN）：
      // 这条边界仍要守 —— 只有已知 tag 才允许进 extra，避免异常键污染「全量 EXIF」这份事实源
      if (!EXIF_TAG_PATTERN.test(tag)) throw new BadRequestException(`无法识别的拍摄参数名：${tag}`);
      writes[tag] = Array.isArray(value) ? value.map((v) => String(v)) : value == null ? null : String(value);
    }

    if (payload.gps === null) {
      // 显式清除定位（地图上「取消定位」）
      writes.GPSLatitude = null;
      writes.GPSLongitude = null;
      writes.GPSLatitudeRef = null;
      writes.GPSLongitudeRef = null;
      writes.GPSAltitude = null;
      writes.GPSAltitudeRef = null;
    } else if (payload.gps) {
      // 前端底图可能是 GCJ-02 / BD-09，进 EXIF 前一律转成 WGS-84
      const wgs = toWgs84({ lat: payload.gps.lat, lon: payload.gps.lon }, payload.crs ?? 'wgs84');
      if (!isValidLatLon(wgs.lat, wgs.lon)) throw new BadRequestException('纬度 / 经度超出有效范围');
      // EXIF 的经纬度本体是**无符号**的（保留 6 位小数，约 0.1 米；再长只是浮点噪声），
      // 南纬/西经必须靠 Ref 表达，所以数值取绝对值、方向单独写。
      writes.GPSLatitude = Number(Math.abs(wgs.lat).toFixed(6));
      writes.GPSLongitude = Number(Math.abs(wgs.lon).toFixed(6));
      writes.GPSLatitudeRef = wgs.lat >= 0 ? 'N' : 'S';
      writes.GPSLongitudeRef = wgs.lon >= 0 ? 'E' : 'W';
      // 海拔本体同样无符号：exiftool 不会按正负自动补 GPSAltitudeRef（实测负数写进去只剩绝对值），
      // 因此这里显式写 Ref（0=海平面以上，1=以下），与经纬度保持同一套「本体 + 方向」写法。
      if (payload.gps.alt != null) {
        writes.GPSAltitude = Number(Math.abs(payload.gps.alt).toFixed(2));
        writes.GPSAltitudeRef = payload.gps.alt < 0 ? 1 : 0;
      }
    }

    return writes;
  }

  /** 以内存里的全量 EXIF 为准回填 DB：展示列 + GPS 列 + 拍摄地点 + extra，并同步拍摄日期 */
  private async syncFromExtra(id: string, fields: ExifFull): Promise<void> {
    const display = displayPatchOf(fields);
    const datePatch = mediaDatePatchOf(fields);
    /* 定位变了，地点必须跟着重解：不同步就会出现「地图上已经挪到上海、卡片还写着深圳」。
       改动坐标是这里唯一会动 gpsLat/gpsLon 的路径，因此只需在这一处刷新。 */
    const place = await this.placeOf(display.gpsLat, display.gpsLon);
    if (Object.keys(datePatch).length > 0) {
      await this.db.update(media).set(datePatch).where(eq(media.id, id));
    }
    await this.db
      .insert(exifMetadata)
      .values({ mediaId: id, ...display, place, extra: fields })
      .onConflictDoUpdate({
        target: exifMetadata.mediaId,
        set: { ...display, place, extra: fields },
      });
  }

  /**
   * 有定位就反解成可读地名，没有（或清除了定位）就返回 null —— 旧地点必须一起失效，
   * 否则会留下「没有坐标、却还写着某地」的错位数据。
   * 反解失败同样返回 null：地点是展示增强，不该阻断 EXIF 的保存。
   */
  private async placeOf(lat: number | null, lon: number | null): Promise<string | null> {
    if (lat == null || lon == null) return null;
    return reverseGeocode(this.config.AMAP_KEY, lat, lon);
  }

  /** 取未删除的 media 行（带源文件路径与实况路径），不存在即 404 */
  private async requireRow(id: string): Promise<{ id: string; sourcePath: string; liveVideoPath: string | null }> {
    const row = await this.db.query.media.findFirst({
      where: and(eq(media.id, id), eq(media.deleted, false)),
    });
    if (!row) throw new NotFoundException('照片不存在');
    return { id: row.id, sourcePath: row.sourcePath, liveVideoPath: row.liveVideoPath };
  }

  private async requirePhoto(id: string, pass: PrivacyPass): Promise<ApiPhoto> {
    const photo = await this.get(id, pass);
    if (!photo) throw new NotFoundException('照片不存在');
    return photo;
  }

  /**
   * 组装对外照片对象。**对无权者返回 null**（hidden 的照片直接不出口）。
   *
   * 【隐私在这里做减法，而不是在前端做遮挡】locked 时：原片/实况地址直接为 null、
   * EXIF 与 GPS 一律清空 —— 前端拿不到任何可推断原图的信息，也拿不到能取原图的地址。
   * 图片地址本身指向的仍是 /files/:id/...，由静态文件层统一改写为模糊图（见 FilesController），
   * 因此「模糊展示」是服务端强制的，与前端是否遵守约定无关。
   */
  private toApi(row: Row, tagList: PhotoTag[], pass: PrivacyPass, grant: string | null): ApiPhoto | null {
    const privacy = verdictOf(row, pass.settings, pass.ctx);
    // hidden 且无权：整条不出口（404 / 从列表里消失），连「这里有一张被藏起来的照片」都不透露
    if (privacy.locked && privacy.mode === 'hidden') return null;

    const locked = privacy.locked;
    // 只有「受保护 + 已获准」的地址才需要票据；公开照片带上纯属噪声
    const attach = !locked && privacy.mode !== 'visible' && grant ? `?pt=${encodeURIComponent(grant)}` : '';
    const file = (suffix: string): string => `/files/${row.id}/${suffix}${attach}`;

    return {
      id: row.id,
      title: row.title,
      /* 原文件名与大小不下沉隐私判定：它们与 title 同一档（标题本身就出自文件名），
         且后台的「同名比对」必须在加密照片上也看得到 —— 否则覆盖判断会对隐私照片失效。 */
      originalName: row.originalName,
      originalSize: row.originalSize,
      // 描述与标签、EXIF 同一档：锁定照片连描述一起不出口，避免正文泄露照片内容
      description: locked ? '' : placeholder(row.description),
      cat: row.category,
      format: row.format,
      tags: locked ? [] : tagList,
      // 技术元数据与定位对无权者一律清空：EXIF 能反推拍摄地点与设备，同样属于隐私内容
      cam: locked ? '' : placeholder(row.cam),
      lens: locked ? '' : placeholder(row.lens),
      focal: locked ? '' : placeholder(row.focal),
      aperture: locked ? '' : placeholder(row.aperture),
      iso: locked ? null : row.iso,
      speed: locked ? '' : placeholder(row.speed),
      temp: locked ? '' : placeholder(row.temp),
      wb: locked ? '' : placeholder(row.wb),
      place: locked ? '' : placeholder(row.place),
      date: placeholder(row.captureAt),
      likes: row.likes,
      size: row.orientation === 'portrait' ? 'portrait' : 'landscape',
      url: file('thumbnail'),
      cardUrl: file('card'),
      originalUrl: locked ? null : file('original'),
      isLive: !locked && row.liveVideoPath != null,
      liveUrl: locked || !row.liveVideoPath ? null : file('live'),
      gps: locked ? null : toGps(row.gpsLat, row.gpsLon, row.gpsAlt),
      privacy: { mode: privacy.mode, locked, hasOwnPassword: privacy.hasOwnPassword },
      // 像素宽高即使在锁定照片也下发：瀑布流要按真实比例占位，否则加载完成会跳布局
      width: row.width,
      height: row.height,
    };
  }
}