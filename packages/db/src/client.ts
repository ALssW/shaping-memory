/**
 * packages/db/src/client.ts
 *
 * Drizzle 客户端：pg 连接池 + drizzle 实例。
 * 只负责「建连接」，不落任何业务 —— 查询在各模块/脚本里用导入的 db 写。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

/** 由连接串构造 Pool + drizzle；导出 schema 供查询层直接使用 */
export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return db;
}