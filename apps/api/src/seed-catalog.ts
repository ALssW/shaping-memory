/**
 * apps/api/src/seed-catalog.ts
 *
 * 种子脚本（幂等）：把原先写死在前端的分类 / 影集落成数据库记录。
 * 运行：`npm run seed:catalog -w @shaping-memory/api`。可反复执行，不会产生重复行。
 */
import './env';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ALBUM_DEFS, CATEGORIES } from '@shaping-memory/core';
import { albumGroups, albumMedia, albums, categories, createDb, media } from '@shaping-memory/db';
import { loadConfig } from '@shaping-memory/config';
import { albumIdOf, categoryIdOf, DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME } from './catalog/ids';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  // 默认分组：删除分组时相册的回退去处，必须存在且不可删（builtin = true），因此排在最前（sortOrder = -1）
  await db
    .insert(albumGroups)
    .values({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, sortOrder: -1, builtin: true })
    .onConflictDoNothing();

  // 分类：CATEGORIES 首项是前端的「全部」伪分类，不落库；其余按数组顺序写 sortOrder
  const names = CATEGORIES.slice(1);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]!;
    await db
      .insert(categories)
      .values({ id: categoryIdOf(name), name, sortOrder: i })
      .onConflictDoUpdate({ target: categories.id, set: { name, sortOrder: i } });
  }

  // 相册：ALBUM_DEFS 每项建一册，成员 = 该册分类下未删除的照片（拍摄时间降序）
  for (const def of ALBUM_DEFS) {
    const id = albumIdOf(def.name);
    const description = `${def.cats.join(' / ')} 题材`;
    await db
      .insert(albums)
      .values({ id, title: def.name, description, isPublic: true, groupId: DEFAULT_GROUP_ID })
      .onConflictDoUpdate({ target: albums.id, set: { title: def.name, description } });

    const rows = await db
      .select({ id: media.id })
      .from(media)
      .where(and(inArray(media.category, [...def.cats]), eq(media.deleted, false)))
      .orderBy(sql`${media.captureAt} desc nulls last`);

    // 幂等：成员关系整体重建，与「PUT /albums/:id/media」同一套全量替换语义
    await db.transaction(async (tx) => {
      await tx.delete(albumMedia).where(eq(albumMedia.albumId, id));
      if (rows.length > 0) {
        await tx
          .insert(albumMedia)
          .values(rows.map((row, index) => ({ albumId: id, mediaId: row.id, sortOrder: index })));
      }
    });
    // 封面取第一张；空册置空，前台回退逻辑同样得到空封面
    await db.update(albums).set({ coverMediaId: rows[0]?.id ?? null }).where(eq(albums.id, id));

    // eslint-disable-next-line no-console
    console.log(`[seed:catalog] 相册「${def.name}」→ ${rows.length} 张`);
  }

  // eslint-disable-next-line no-console
  console.log(`[seed:catalog] 默认分组、分类 ${names.length} 个、相册 ${ALBUM_DEFS.length} 册已就绪`);
}

void main();
