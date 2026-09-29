/**
 * apps/api/src/catalog/categories.service.ts
 *
 * 分类目录服务：读公开、写需 admin。
 * 【本文件的核心约束】分类名与 media.category 是「文本关联」（见 schema.ts 注释），
 * 因此**改名必须同步改照片的分类值**，否则照片会掉出所有筛选。
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { categories, media } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';
import { categoryIdOf } from './ids';

/** 前台消费的分类形状：count = 该分类下未删除照片数 */
export interface ApiCategory {
  id: string;
  name: string;
  sortOrder: number;
  count: number;
}

export interface CreateCategoryDto {
  name: string;
  sortOrder?: number;
}

export interface UpdateCategoryDto {
  name?: string;
  sortOrder?: number;
}

@Injectable()
export class CategoriesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 分类列表（按 sortOrder 升序），带上各分类的未删除照片数 */
  async list(): Promise<ApiCategory[]> {
    // 左连 media 并聚合计数：一次查询拿到全部计数，避免逐个分类反查
    const rows = await this.db
      .select({
        id: categories.id,
        name: categories.name,
        sortOrder: categories.sortOrder,
        count: sql<number>`count(${media.id})::int`,
      })
      .from(categories)
      .leftJoin(media, and(eq(media.category, categories.name), eq(media.deleted, false)))
      .groupBy(categories.id, categories.name, categories.sortOrder)
      .orderBy(asc(categories.sortOrder));

    return rows.map((row) => ({ ...row, count: Number(row.count) }));
  }

  /** 新建分类：名称唯一，id 由名称稳定派生 */
  async create(dto: CreateCategoryDto): Promise<ApiCategory> {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('分类名不能为空');

    const exists = await this.findByName(name);
    if (exists) throw new ConflictException(`分类「${name}」已存在`);

    const row = { id: categoryIdOf(name), name, sortOrder: dto.sortOrder ?? 0 };
    await this.db.insert(categories).values(row);
    return { ...row, count: await this.countOf(name) };
  }

  /**
   * 更新分类。改名时在**同一事务**里同步 media.category：
   * 两条写要么都成功、要么都回滚，绝不会出现「分类表已改名、照片还挂着旧名」的中间态。
   */
  async update(id: string, dto: UpdateCategoryDto): Promise<ApiCategory> {
    const current = await this.requireRow(id);
    const nextName = dto.name?.trim();
    if (nextName === '') throw new BadRequestException('分类名不能为空');

    const sets: Partial<typeof categories.$inferInsert> = {};
    if (nextName && nextName !== current.name) {
      const dup = await this.findByName(nextName);
      if (dup) throw new ConflictException(`分类「${nextName}」已存在`);
      sets.name = nextName;
    }
    if (dto.sortOrder !== undefined) sets.sortOrder = dto.sortOrder;

    const renamed = sets.name !== undefined;
    if (Object.keys(sets).length > 0) {
      await this.db.transaction(async (tx) => {
        await tx.update(categories).set(sets).where(eq(categories.id, id));
        // 照片表的分类是文本，改名要跟着改，否则这些照片会从所有分类筛选里消失
        if (renamed) {
          await tx.update(media).set({ category: nextName! }).where(eq(media.category, current.name));
        }
      });
    }

    return { id, name: nextName ?? current.name, sortOrder: sets.sortOrder ?? current.sortOrder, count: await this.countOf(nextName ?? current.name) };
  }

  /** 删除分类：仍有照片时拒绝（409），避免照片变成「无主分类」 */
  async remove(id: string): Promise<void> {
    const current = await this.requireRow(id);
    const count = await this.countOf(current.name);
    if (count > 0) {
      throw new ConflictException(`分类「${current.name}」下仍有 ${count} 张照片，请先移出或删除后再删分类`);
    }
    await this.db.delete(categories).where(eq(categories.id, id));
  }

  /** 取分类行，不存在即 404 */
  private async requireRow(id: string): Promise<{ id: string; name: string; sortOrder: number }> {
    const row = await this.db.query.categories.findFirst({ where: eq(categories.id, id) });
    if (!row) throw new NotFoundException('分类不存在');
    return row;
  }

  private async findByName(name: string): Promise<{ id: string } | undefined> {
    return this.db.query.categories.findFirst({ where: eq(categories.name, name) });
  }

  /** 某分类下未删除的照片数 */
  private async countOf(name: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(media)
      .where(and(eq(media.category, name), eq(media.deleted, false)));
    return Number(rows[0]?.n ?? 0);
  }
}
