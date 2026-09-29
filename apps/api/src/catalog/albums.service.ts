/**
 * apps/api/src/catalog/albums.service.ts
 *
 * 相册服务：读公开、写需 admin/editor。
 * 封面回退规则：优先 coverMediaId，未设则取相册内第一张（按 sort_order 升序）。
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { albumMedia, albums, media } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';
import { PhotosService } from '../photos/photos.service';
import type { ApiPhoto } from '../photos/photos.service';
import type { PrivacyPass } from '../privacy/policy';
import { AlbumGroupsService } from './album-groups.service';
import { albumIdOf } from './ids';

/** 前台消费的相册摘要形状（coverUrl 为相对路径，由 SDK 拼绝对地址） */
export interface ApiAlbum {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  count: number;
  isPublic: boolean;
  /** 所属分组 id；正常不会为空（未指定时服务端落到「默认分组」） */
  groupId: string | null;
  createdAt: string;
}

/** 相册详情：摘要 + 相册内照片（按 album_media.sort_order 升序） */
export interface ApiAlbumDetail {
  album: ApiAlbum;
  photos: ApiPhoto[];
}

export interface CreateAlbumDto {
  title: string;
  description?: string;
  isPublic?: boolean;
  /** 所属分组；缺省落到「默认分组」 */
  groupId?: string;
  mediaIds?: string[];
}

export interface UpdateAlbumDto {
  title?: string;
  description?: string;
  isPublic?: boolean;
  /** 传 null 表示清除自定义封面，回到「相册内第一张」 */
  coverMediaId?: string | null;
  /** 改所属分组；传 null 表示回到「默认分组」 */
  groupId?: string | null;
}

@Injectable()
export class AlbumsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly photos: PhotosService,
    private readonly groups: AlbumGroupsService,
  ) {}

  /**
   * 相册列表：count 与「回退封面」都由一次 album_media 查询在内存里归并。
   * @param includePrivate 匿名调用为 false（只回公开相册），后台带凭证为 true
   */
  async list(includePrivate = false): Promise<ApiAlbum[]> {
    const rows = await this.db
      .select()
      .from(albums)
      .where(includePrivate ? undefined : eq(albums.isPublic, true))
      .orderBy(asc(albums.createdAt));
    const stats = await this.memberStats();
    return rows.map((row) => this.toApi(row, stats));
  }

  /** 相册详情：成员按 sort_order 升序，交给 PhotosService 批量取（自动过滤软删除） */
  async detail(id: string, includePrivate: boolean, pass: PrivacyPass): Promise<ApiAlbumDetail> {
    const row = await this.requireRow(id);
    // 私有相册对匿名者一律按「不存在」处理，不泄露它是否存在
    if (!row.isPublic && !includePrivate) throw new NotFoundException('相册不存在');
    const links = await this.db
      .select({ mediaId: albumMedia.mediaId })
      .from(albumMedia)
      .where(eq(albumMedia.albumId, id))
      .orderBy(asc(albumMedia.sortOrder));
    // 相册可见 ≠ 册内每张都可见：隐私照片由 photosByIds 按 pass 自行过滤 / 打糊
    const photos = await this.photos.photosByIds(links.map((link) => link.mediaId), pass);
    // 详情里 count/封面直接由「实际取到的照片」得出，与列表口径一致
    const stats = new Map([[id, { count: photos.length, firstId: photos[0]?.id ?? null }]]);
    return { album: this.toApi(row, stats), photos };
  }

  /** 隐私上下文（相册详情的照片同样要按它过滤）：转交 PhotosService，避免两处各读一次设置表 */
  privacyPass(req: { user?: { role: string }; query?: Record<string, unknown> }): Promise<PrivacyPass> {
    return this.photos.pass(req);
  }

  /** 新建相册；带 mediaIds 时一并写入成员关系（下标即 sortOrder） */
  async create(dto: CreateAlbumDto): Promise<ApiAlbum> {
    const title = dto.title?.trim();
    if (!title) throw new BadRequestException('相册标题不能为空');

    // 未指定分组就落到「默认分组」：相册永远有归属，前台聚合不会出现无主的一册
    const groupId = dto.groupId ?? (await this.groups.defaultId());
    if (dto.groupId !== undefined) await this.assertGroup(dto.groupId);

    const id = albumIdOf(title);
    // 冲突（同名相册已存在）时只更新标题与描述；groupId 仅在调用方显式指定时才跟着改，
    // 否则「新建同名相册」会把原本挂在其他分组下的相册移入默认分组。
    const conflictSet: Partial<typeof albums.$inferInsert> = { title, description: dto.description ?? null };
    if (dto.groupId !== undefined) conflictSet.groupId = dto.groupId;

    await this.db
      .insert(albums)
      .values({ id, title, description: dto.description ?? null, isPublic: dto.isPublic ?? true, groupId })
      .onConflictDoUpdate({ target: albums.id, set: conflictSet });
    if (dto.mediaIds?.length) await this.replaceMedia(id, dto.mediaIds);

    this.groups.invalidate(); // 分组内相册数变了，缓存作废
    const stats = await this.memberStats();
    const row = await this.requireRow(id);
    return this.toApi(row, stats);
  }

  /** 更新相册基础信息（标题/描述/公开性/自定义封面/所属分组） */
  async update(id: string, dto: UpdateAlbumDto): Promise<ApiAlbum> {
    await this.requireRow(id);
    const sets: Partial<typeof albums.$inferInsert> = {};
    if (dto.title !== undefined) sets.title = dto.title;
    if (dto.description !== undefined) sets.description = dto.description;
    if (dto.isPublic !== undefined) sets.isPublic = dto.isPublic;
    if (dto.coverMediaId !== undefined) sets.coverMediaId = dto.coverMediaId;
    if (dto.groupId !== undefined) {
      // null = 回到默认分组；非空则要求目标分组真实存在，避免悬空外键
      sets.groupId = dto.groupId === null ? await this.groups.defaultId() : dto.groupId;
      if (dto.groupId !== null) await this.assertGroup(dto.groupId);
    }

    if (Object.keys(sets).length > 0) {
      await this.db.update(albums).set(sets).where(eq(albums.id, id));
      if (sets.groupId !== undefined) this.groups.invalidate();
    }
    const row = await this.requireRow(id);
    return this.toApi(row, await this.memberStats());
  }

  /**
   * 批量调整分组：把 ids 里的相册一次性移到 groupId（后台「批量移动到分组」用）。
   * 一次 UPDATE 完成，避免逐册发请求。
   */
  async assignGroup(ids: string[], groupId: string): Promise<{ moved: number }> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) throw new BadRequestException('请先选择相册');
    await this.assertGroup(groupId);
    const updated = await this.db
      .update(albums)
      .set({ groupId })
      .where(inArray(albums.id, unique))
      .returning({ id: albums.id });
    this.groups.invalidate();
    return { moved: updated.length };
  }

  /** 删除相册：album_media 由外键 cascade 自动清理，照片本身不受影响 */
  async remove(id: string): Promise<void> {
    await this.requireRow(id);
    await this.db.delete(albums).where(eq(albums.id, id));
    this.groups.invalidate(); // 分组内相册数变了，缓存作废
  }

  /**
   * 全量替换相册成员（一次完成增 / 删 / 排序）：
   * 先清空该相册的所有关联，再按入参数组的**下标**写 sortOrder ——
   * 因此前端只要把「期望的最终列表」整个传上来即可，不必自己算差异。
   */
  async setMedia(id: string, ids: string[]): Promise<ApiAlbum> {
    await this.requireRow(id);
    await this.replaceMedia(id, ids);
    const row = await this.requireRow(id);
    return this.toApi(row, await this.memberStats());
  }

  /** 幂等重建成员关系：先删后插，顺序 = 数组下标 */
  private async replaceMedia(albumId: string, ids: readonly string[]): Promise<void> {
    // 去重（保留首次出现的位置）：album_media 是复合主键，重复 id 会直接插失败
    const unique = [...new Set(ids)];
    await this.db.transaction(async (tx) => {
      await tx.delete(albumMedia).where(eq(albumMedia.albumId, albumId));
      if (unique.length === 0) return;
      await tx
        .insert(albumMedia)
        .values(unique.map((mediaId, index) => ({ albumId, mediaId, sortOrder: index })));
    });
  }

  /**
   * 各相册的成员统计：count = 未删除照片数，firstId = 按 sort_order 的第一张。
   * 一次查询覆盖所有相册，避免列表里逐个相册反查。
   */
  private async memberStats(): Promise<Map<string, { count: number; firstId: string | null }>> {
    const links = await this.db
      .select({ albumId: albumMedia.albumId, mediaId: albumMedia.mediaId })
      .from(albumMedia)
      .innerJoin(media, eq(media.id, albumMedia.mediaId))
      .where(eq(media.deleted, false))
      .orderBy(asc(albumMedia.albumId), asc(albumMedia.sortOrder));

    const map = new Map<string, { count: number; firstId: string | null }>();
    for (const link of links) {
      const entry = map.get(link.albumId);
      if (entry) entry.count += 1;
      else map.set(link.albumId, { count: 1, firstId: link.mediaId });
    }
    return map;
  }

  /** 行 → API 形状：封面优先 coverMediaId，未设则回退第一张 */
  private toApi(
    row: typeof albums.$inferSelect,
    stats: Map<string, { count: number; firstId: string | null }>,
  ): ApiAlbum {
    const stat = stats.get(row.id);
    const coverId = row.coverMediaId ?? stat?.firstId ?? null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      coverUrl: coverId ? `/files/${coverId}/thumbnail` : null,
      count: stat?.count ?? 0,
      isPublic: row.isPublic,
      groupId: row.groupId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 目标分组必须真实存在（否则外键会拒写，报错信息对用户毫无意义，这里提前拦下） */
  private async assertGroup(groupId: string): Promise<void> {
    const known = await this.groups.list();
    if (!known.some((group) => group.id === groupId)) throw new NotFoundException('分组不存在');
  }

  private async requireRow(id: string): Promise<typeof albums.$inferSelect> {
    const row = await this.db.query.albums.findFirst({ where: eq(albums.id, id) });
    if (!row) throw new NotFoundException('相册不存在');
    return row;
  }
}
