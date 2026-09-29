/**
 * packages/db/src/index.ts
 *
 * 数据层统一出口：schema + 客户端工厂。
 */
export * from './schema';
export { createDb } from './client';
export type { Db } from './client';