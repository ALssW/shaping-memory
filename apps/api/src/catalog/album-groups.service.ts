/**
 * apps/api/src/catalog/album-groups.service.ts
 *
 * 相册分组服务：读公开、写需 admin。
 *
 * 【缓存策略】分组列表（含各组的相册数）在进程内存里缓存一份：
 * 分组是「读多写极少」的运营数据，前台每次进影集页都会拉一次，缓存能省掉绝大部分查询。
 * 任何写操作（增 / 改 / 删 / 排序）以及**相册归属变动**都会立即让缓存失效，
 * 另设 TTL 作为回退 —— 若存在绕过本服务的写入路径，最多滞后 TTL 也会自动纠正。
 *
 * 【默认分组】删除分组时相册必须有归属，因此存在一个 builtin 的「默认分组」：
 * 它不可改名、不可删除；新建相册未选分组、删除分组未指定目标，均归入该分组。
 * 它由本服务在首次读列表时「缺则补建」（onConflictDoNothing），因此不依赖种子脚本也一定存在。
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { albumGroups, albums } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';
import { albumGroupIdOf, DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME } from './ids';

/** 分组名长度上限：足以容纳「2024 秋季旅行」这类名称，同时避免超出前台导航条的容纳范围 */
const NAME_MAX = 20;
/** 名称禁用字符：这些符号在 HTML / JS 里有特殊含义，直接从源头拒收（XSS 过滤的落点） */
const NAME_FORBIDDEN = /[<>&"'`\\]/;
/** 控制字符（含换行 / 制表）：任何情况下都不该出现在名称里 */
const NAME_CONTROL = /[\u0000-\u001f\u007f]/;
/** 缓存有效期（毫秒）：作为回退，正常路径由写操作主动失效 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 前台消费的分组形状：count = 该分组下的相册数 */
export interface ApiAlbumGroup {
  id: string;
  name: string;
  sortOrder: number;
  count: number;
  /** 内置分组（默认分组）：不可改名、不可删除 */
  builtin: boolean;
  createdAt: string;
}

export interface CreateAlbumGroupDto {
  name: string;
  sortOrder?: number;
}

export interface UpdateAlbumGroupDto {
  name?: string;
  sortOrder?: number;
}

/** 校验并归一化分组名：去空白 + 长度上限 + 字符白名单（黑名单法） */
function normalizeName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (!name) throw new BadRequestException('分组名不能为空');
  if (name.length > NAME_MAX) throw new BadRequestException(`分组名不能超过 ${NAME_MAX} 个字`);
  if (NAME_CONTROL.test(name)) throw new BadRequestException('分组名不能包含换行或制表符');
  if (NAME_FORBIDDEN.test(name)) throw new BadRequestException('分组名不能包含 < > & " \' ` \\ 这些字符');
  return name;
}

@Injectable()
export class AlbumGroupsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 缓存槽：null = 未命中；cachedAt 用于 TTL 判定 */
  private cache: ApiAlbumGroup[] | null = null;
  private cachedAt = 0;

  /** 分组列表（按 sortOrder、创建时间升序），带各组的相册数 */
  async list(): Promise<ApiAlbumGroup[]> {
    if (this.cache && Date.now() - this.cachedAt < CACHE_TTL_MS) return this.cache;

    // 先补建默认分组：它是删除分组时的回退去处，必须始终存在
    await this.ensureDefault();
    const rows = await this.db
      .select({
        id: albumGroups.id,
        name: albumGroups.name,
        sortOrder: albumGroups.sortOrder,
        builtin: albumGroups.builtin,
        createdAt: albumGroups.createdAt,
        // 左连相册并按组计数：一次查询拿到全部计数，避免逐个分组反查
        count: sql<number>`count(${albums.id})::int`,
      })
      .from(albumGroups)
      .leftJoin(albums, eq(albums.groupId, albumGroups.id))
      .groupBy(albumGroups.id, albumGroups.name, albumGroups.sortOrder, albumGroups.builtin, albumGroups.createdAt)
      .orderBy(asc(albumGroups.sortOrder), asc(albumGroups.createdAt));

    this.cache = rows.map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
      count: Number(row.count),
      builtin: row.builtin,
      createdAt: row.createdAt.toISOString(),
    }));
    this.cachedAt = Date.now();
    return this.cache;
  }

  /** 默认分组 id（缺则补建）。相册服务在「未指定分组」时以它作为回退 */
  async defaultId(): Promise<string> {
    await this.ensureDefault();
    return DEFAULT_GROUP_ID;
  }

  /** 清空缓存：任何写操作后调用，保证下次读拿到最新数据 */
  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }

  /** 新建分组：名称唯一（同名返回 409），id 由名称稳定派生 */
  async create(dto: CreateAlbumGroupDto): Promise<ApiAlbumGroup> {
    const name = normalizeName(dto.name);
    if (await this.findByName(name)) throw new ConflictException(`分组「${name}」已存在`);

    // 未指定排序值时排到末尾：取当前最大值 +1，新分组不会插队到已有分组前面
    const sortOrder = dto.sortOrder ?? (await this.nextSortOrder());
    const id = albumGroupIdOf(name);
    await this.db
      .insert(albumGroups)
      .values({ id, name, sortOrder })
      // 同名同 id 的极端并发下退化为「已有即可」，不抛错
      .onConflictDoNothing();
    this.invalidate();

    const row = await this.requireRow(id);
    return { id, name: row.name, sortOrder: row.sortOrder, count: 0, builtin: row.builtin, createdAt: row.createdAt.toISOString() };
  }

  /** 更新分组（改名 / 改排序）；内置分组不可改名 */
  async update(id: string, dto: UpdateAlbumGroupDto): Promise<ApiAlbumGroup> {
    const current = await this.requireRow(id);
    const sets: Partial<typeof albumGroups.$inferInsert> = {};

    if (dto.name !== undefined) {
      const name = normalizeName(dto.name);
      if (current.builtin) throw new BadRequestException('默认分组不可改名');
      if (name !== current.name) {
        if (await this.findByName(name)) throw new ConflictException(`分组「${name}」已存在`);
        // 名称即 id 的派生源，改名必须换 id；但换 id 会牵动 albums.group_id，代价太大，
        // 因此这里只改展示名、保留原 id —— id 是内部标识，用户看不到。
        sets.name = name;
      }
    }
    if (dto.sortOrder !== undefined) sets.sortOrder = dto.sortOrder;

    if (Object.keys(sets).length > 0) {
      await this.db.update(albumGroups).set(sets).where(eq(albumGroups.id, id));
      this.invalidate();
    }
    return (await this.list()).find((group) => group.id === id) ?? this.toShallow(current);
  }

  /**
   * 删除分组：先把组内相册迁到目标分组，再删组 —— 两步在同一事务里，
   * 不会出现「组没了、册还指着一个不存在的组」的中间态。
   * @param moveTo 目标分组 id；缺省落到「默认分组」
   */
  async remove(id: string, moveTo?: string): Promise<{ removed: number; moved: number }> {
    const current = await this.requireRow(id);
    if (current.builtin) throw new BadRequestException('默认分组不可删除');

    const target = moveTo ?? DEFAULT_GROUP_ID;
    if (target === id) throw new BadRequestException('不能把相册移动到正在删除的分组');
    await this.requireRow(target);

    const moved = await this.db.transaction(async (tx) => {
      const updated = await tx.update(albums).set({ groupId: target }).where(eq(albums.groupId, id)).returning({ id: albums.id });
      await tx.delete(albumGroups).where(eq(albumGroups.id, id));
      return updated.length;
    });
    this.invalidate();
    return { removed: 1, moved };
  }

  /**
   * 全量重写排序：入参数组的**下标即 sortOrder**（与「PUT /albums/:id/media」同一套语义），
   * 因此后台拖拽结束后把「期望的最终顺序」整个传上来即可，不必自己算差异。
   */
  async reorder(ids: string[]): Promise<ApiAlbumGroup[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return this.list();

    await this.db.transaction(async (tx) => {
      for (let index = 0; index < unique.length; index += 1) {
        await tx.update(albumGroups).set({ sortOrder: index }).where(eq(albumGroups.id, unique[index]!));
      }
    });
    this.invalidate();
    return this.list();
  }

  /** 缺则补建默认分组（幂等：靠主键 / 唯一名冲突时静默跳过） */
  private async ensureDefault(): Promise<void> {
    await this.db
      .insert(albumGroups)
      .values({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, sortOrder: -1, builtin: true })
      .onConflictDoNothing();
  }

  /** 新分组的默认排序值：当前最大 sortOrder + 1（空表时为 0） */
  private async nextSortOrder(): Promise<number> {
    const rows = await this.db
      .select({ max: sql<number | null>`max(${albumGroups.sortOrder})` })
      .from(albumGroups);
    const max = rows[0]?.max;
    return max == null ? 0 : Number(max) + 1;
  }

  private async requireRow(id: string): Promise<typeof albumGroups.$inferSelect> {
    const row = await this.db.query.albumGroups.findFirst({ where: eq(albumGroups.id, id) });
    if (!row) throw new NotFoundException('分组不存在');
    return row;
  }

  private async findByName(name: string): Promise<{ id: string } | undefined> {
    return this.db.query.albumGroups.findFirst({ where: eq(albumGroups.name, name) });
  }

  /** 行 → 浅形状（不查相册数；用于 update 命中缓存失败时的回退返回） */
  private toShallow(row: typeof albumGroups.$inferSelect): ApiAlbumGroup {
    return {
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
      count: 0,
      builtin: row.builtin,
      createdAt: row.createdAt.toISOString(),
    };
  }
}