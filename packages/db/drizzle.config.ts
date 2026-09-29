/**
 * packages/db/drizzle.config.ts
 *
 * drizzle-kit 配置：从仓库根 .env 读 DATABASE_URL（drizzle-kit 不自动加载 .env）。
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

// 仓库根 = 本文件再上两级
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadEnv({ path: path.join(root, '.env') });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});