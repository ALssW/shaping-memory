/**
 * apps/api/src/admin/stats.service.ts
 *
 * 数据概览：后台首页要展示的几个数，一次请求给全。
 *
 * 【为什么用 filter (where ...) 而不是发七条 count 查询】照片的六个统计量都来自
 * media 表同一次全表扫描，拆成多条查询等于把同一张表扫七遍；一条 SQL 里用
 * 条件聚合即可一次算完，其余三张表各自一条 count。
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { albums, categories, media, privacyShares, users } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';

/** 概览数据形状，与前端 SDK 的 AdminStats 一一对应 */
export interface AdminStats {
  photos: number;
  deletedPhotos: number;
  livePhotos: number;
  markedPhotos: number;
  albums: number;
  categories: number;
  users: number;
  shares: number;
  activeShares: number;
  latestCapture: string | null;
}

const countOf = () => sql<number>`count(*)::int`;

@Injectable()
export class StatsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async overview(): Promise<AdminStats> {
    // markedPhotos 只统计「显式标了受保护」的两种：inherit 是默认值（等于没标），
    // visible 是显式公开，两者放进「已标记隐私」都会让这个数字失去意义。
    const [mediaRow] = await this.db
      .select({
        photos: sql<number>`count(*) filter (where ${media.deleted} = false)::int`,
        deletedPhotos: sql<number>`count(*) filter (where ${media.deleted} = true)::int`,
        livePhotos: sql<number>`count(*) filter (where ${media.deleted} = false and ${media.liveVideoPath} is not null)::int`,
        markedPhotos: sql<number>`count(*) filter (where ${media.deleted} = false and ${media.privacy} in ('blur', 'hidden'))::int`,
        // ::text 是为了拿到 YYYY-MM-DD 字符串 —— date 列经 pg 默认解析器会变成 Date 对象
        latestCapture: sql<string | null>`max(${media.captureAt}) filter (where ${media.deleted} = false)::text`,
      })
      .from(media);

    const [[albumRow], [categoryRow], [userRow], [shareRow], [activeShareRow]] = await Promise.all([
      this.db.select({ n: countOf() }).from(albums),
      this.db.select({ n: countOf() }).from(categories),
      this.db.select({ n: countOf() }).from(users),
      this.db.select({ n: countOf() }).from(privacyShares),
      // 「仍有效」= 未撤销且未过期，与 openShare 的判定口径一致
      this.db
        .select({ n: countOf() })
        .from(privacyShares)
        .where(and(eq(privacyShares.revoked, false), gt(privacyShares.expiresAt, new Date()))),
    ]);

    return {
      photos: Number(mediaRow?.photos ?? 0),
      deletedPhotos: Number(mediaRow?.deletedPhotos ?? 0),
      livePhotos: Number(mediaRow?.livePhotos ?? 0),
      markedPhotos: Number(mediaRow?.markedPhotos ?? 0),
      latestCapture: mediaRow?.latestCapture ?? null,
      albums: Number(albumRow?.n ?? 0),
      categories: Number(categoryRow?.n ?? 0),
      users: Number(userRow?.n ?? 0),
      shares: Number(shareRow?.n ?? 0),
      activeShares: Number(activeShareRow?.n ?? 0),
    };
  }
}