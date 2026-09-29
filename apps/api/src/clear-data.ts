/**
 * apps/api/src/clear-data.ts
 *
 * 维护脚本：清空业务数据（照片 / 相册 / 分组 / 分类 / 标签 / 字典 / 分享 / 审计）。
 *
 * 用法（在仓库根执行）：
 *   npm run db:clear                            → 预演：只统计与打印，不动任何数据
 *   npm run db:clear -- --yes                   → 真正清空数据库
 *   npm run db:clear -- --yes --with-objects    → 同时清空对象存储里的全部对象
 *
 * 【为什么要有这个脚本】后端的删除接口一律是软删除（media.deleted = true），
 * 线上数据「彻底清空」没有任何 API 可走，只能直接写 SQL；固化成脚本以避免每次手工执行。
 *
 * 【为什么默认只预演】清空不可逆。不带 --yes 时只打印「哪台库、哪张表、多少行」，
 * 确认无误后再加参数真正执行 —— 少传一个参数不会造成损失。
 *
 * 【保留什么】账号 / 角色 / 权限 / 系统设置一律保留，否则清空后连后台都进不去；
 * 内置「默认分组」也保留 —— 它是删除分组时相册的回退去处，服务端假定它一直存在。
 *
 * 【不碰什么】PHOTO_SOURCE_DIR 里的原始档案、data/ 下的缩略图等本机衍生文件，
 * 以及对象存储之外的任何文件，一个字节都不动。本机存储模式（provider != s3）下
 * 连 store.remove 都不会调用 —— LocalStore 的键空间就是 data/ 本身（见 storage-config.ts）。
 */
import './env';
import { sql } from 'drizzle-orm';
import { createDb } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { loadConfig } from '@shaping-memory/config';
import { DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME } from './catalog/ids';
import { createConfiguredStore, remoteStoreOf } from './storage-config';

/** 要清空的业务表；label 只用于打印，便于预演结果一目了然 */
const BUSINESS_TABLES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'media', label: '照片' },
  { name: 'exif_metadata', label: '照片 EXIF' },
  { name: 'media_tags', label: '照片-标签关联' },
  { name: 'tags', label: '标签' },
  { name: 'albums', label: '相册' },
  { name: 'album_media', label: '相册-照片关联' },
  { name: 'categories', label: '分类' },
  { name: 'dictionary', label: '器材/曝光字典' },
  { name: 'privacy_shares', label: '隐私分享链接' },
  { name: 'audit_logs', label: '操作审计' },
];

/** 从连接串里取出「主机 / 端口 / 库名」用于打印目标；口令绝不回显 */
function describeDatabase(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(DATABASE_URL 解析失败)';
  }
}

/** 单表行数；表名走 sql.identifier 转义，不能直接拼进 SQL 串 */
async function countOf(db: Db, table: string, where = sql`true`): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)} where ${where}`,
  );
  return (result.rows as Array<{ n: number }>)[0]?.n ?? 0;
}

/** 对象键按一级目录归拢，输出成「originals/ 1200 个、live/ 8 个」这样的一行 */
function summarizeKeys(keys: string[]): string {
  const buckets = new Map<string, number>();
  for (const key of keys) {
    const cut = key.indexOf('/');
    const top = cut < 0 ? '(根)' : key.slice(0, cut);
    buckets.set(top, (buckets.get(top) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([name, n]) => `${name}/ ${n} 个`).join('、');
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const confirmed = flags.has('--yes');
  const withObjects = flags.has('--with-objects');

  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const remote = remoteStoreOf(config, createConfiguredStore(config));

  // eslint-disable-next-line no-console
  console.log(`[clear] 目标库：${describeDatabase(config.DATABASE_URL)}`);
  // eslint-disable-next-line no-console
  console.log(`[clear] 对象存储：${remote ? remote.describe() : '未启用（STORAGE_PROVIDER 不是 s3）'}`);

  /* ---- ① 预演：把「将要发生的事」逐项列清 ---- */
  // eslint-disable-next-line no-console
  console.log('[clear] 将要清空：');
  let total = 0;
  for (const table of BUSINESS_TABLES) {
    const n = await countOf(db, table.name);
    total += n;
    // eslint-disable-next-line no-console
    console.log(`  - ${table.label}（${table.name}）：${n} 行`);
  }
  // 分组只删非内置的：内置「默认分组」要保留作为回退，服务端假定它一直存在
  const groupRows = await countOf(db, 'album_groups', sql`builtin = false`);
  total += groupRows;
  // eslint-disable-next-line no-console
  console.log(`  - 相册分组（album_groups）：${groupRows} 行（内置「默认分组」保留）`);
  // eslint-disable-next-line no-console
  console.log(`[clear] 合计 ${total} 行；保留 users / roles / permissions / role_permissions / settings`);

  /* ---- ② 对象存储：先只列不删，让预演能看到体量 ---- */
  let objectKeys: string[] = [];
  if (remote) {
    objectKeys = (await remote.list()).map((object) => object.key);
    // eslint-disable-next-line no-console
    console.log(`[clear] 桶内对象 ${objectKeys.length} 个（${summarizeKeys(objectKeys) || '空'}）`);
  }

  if (!confirmed) {
    // eslint-disable-next-line no-console
    console.log(
      `[clear] 预演结束，未改动任何数据。确认后执行：\n` +
        `  npm run db:clear -- --yes${withObjects ? ' --with-objects' : ''}` +
        `${withObjects ? '' : '\n  （如需一并清空对象存储，再加上 --with-objects）'}`,
    );
    await db.$client.end();
    return;
  }

  /* ---- ③ 执行：先删组再清表，两者必须在同一事务里 ---- */
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from album_groups where builtin = false`);
    await tx.execute(
      sql`truncate table ${sql.join(
        BUSINESS_TABLES.map((table) => sql.identifier(table.name)),
        sql`, `,
      )} restart identity cascade`,
    );
    // 回退处理：默认分组若曾被手工删除，这里补回（服务端 ensureDefault 假定它存在）
    await tx.execute(
      sql`insert into album_groups (id, name, sort_order, builtin)
          values (${DEFAULT_GROUP_ID}, ${DEFAULT_GROUP_NAME}, -1, true)
          on conflict (id) do nothing`,
    );
  });
  // eslint-disable-next-line no-console
  console.log(`[clear] 数据库已清空 ${total} 行，仅保留内置「默认分组」`);

  /* ---- ④ 对象：逐个 remove（remove 幂等，重复执行不会报错） ---- */
  if (!remote) return;
  if (!withObjects) {
    // eslint-disable-next-line no-console
    console.log('[clear] 按当前参数保留对象存储内容（要清空请加 --with-objects）');
    await db.$client.end();
    return;
  }

  let removed = 0;
  const failures: string[] = [];
  for (const key of objectKeys) {
    try {
      await remote.remove(key);
      removed += 1;
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[clear] 对象存储已删除 ${removed}/${objectKeys.length} 个对象`);
  for (const detail of failures) {
    // eslint-disable-next-line no-console
    console.error(`  - ${detail}`);
  }

  await db.$client.end();
  // 有对象没删掉时以失败态退出，便于脚本化调用时发现问题
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[clear] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});