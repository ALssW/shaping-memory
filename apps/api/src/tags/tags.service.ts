/**
 * apps/api/src/tags/tags.service.ts
 *
 * 标签目录服务：只读。给前台「按标签筛选」提供候选列表（标签名 + 该标签下的未删除照片数）。
 *
 * 【为什么不做增删改】标签的写入随照片编辑走（media_tags 由 PhotosService 维护），
 * 再单独开放一套「标签管理」接口，就会出现「标签表里有、却没有一张照片用它」的孤立行，
 * 而前台的候选列表正是按「有没有照片」排的，孤立行只会污染筛选器。
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { media, mediaTags, tags } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';

/** 前台消费的标签形状：count = 该标签下未删除的照片数 */
export interface ApiTag {
  id: string;
  name: string;
  count: number;
}

@Injectable()
export class TagsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 全部标签，按「照片数从多到少，同数按名称升序」排列（前台筛选器要按热度铺开）。
   *
   * 【为什么「未软删除」写在 ON 里而不是 where】写真 where 会把「只出现在已删照片上的标签」
   * 整行滤掉 —— 那些标签在库里仍然存在，前台筛选器里莫名少一枚比显示 count=0 更难排查。
   * 放进 ON 则只是数不到照片，标签本身照常列出（口径与 categories 的计数一致）。
   */
  async list(): Promise<ApiTag[]> {
    // 左连 media_tags 再左连 media 并聚合：一次查询拿到全部计数，避免逐个标签反查
    const rows = await this.db
      .select({
        id: tags.id,
        name: tags.name,
        count: sql<number>`count(${media.id})::int`,
      })
      .from(tags)
      .leftJoin(mediaTags, eq(mediaTags.tagId, tags.id))
      .leftJoin(media, and(eq(media.id, mediaTags.mediaId), eq(media.deleted, false)))
      .groupBy(tags.id, tags.name)
      .orderBy(desc(sql`count(${media.id})`), asc(tags.name));

    // count() 经 pg 驱动回来是字符串（bigint），统一转成 number 再交给前端
    return rows.map((row) => ({ ...row, count: Number(row.count) }));
  }
}