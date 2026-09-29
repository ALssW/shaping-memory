/**
 * apps/api/src/main.ts
 *
 * NestJS 引导：加载 env → 建应用 → 开 CORS → 监听。
 * 运行方式：`npm run dev -w @shaping-memory/api`（tsx watch）。
 */
import 'reflect-metadata';
import './env';
import { NestFactory } from '@nestjs/core';
import { loadConfig, parseOrigins } from '@shaping-memory/config';
import type { ObjectStore } from '@shaping-memory/storage';
import { AppModule } from './app.module';
import { OBJECT_STORE } from './infra.module';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  // CORS：本地开发（CORS_ORIGINS 留空）全放行；生产用白名单，避免任意站点拿着用户票据读写接口
  const origins = parseOrigins(config.CORS_ORIGINS);
  app.enableCors(origins.length > 0 ? { origin: origins } : undefined);
  await app.listen(config.API_PORT, config.API_HOST);
  // 启动时打印一行存储形态（已脱敏，不含密钥）：不熟悉对象存储的使用者也能直观判断「配置是否生效」
  // eslint-disable-next-line no-console
  console.log(`[shaping-memory api] storage: ${app.get<ObjectStore>(OBJECT_STORE).describe()}`);
  // eslint-disable-next-line no-console
  console.log(`[shaping-memory api] listening on http://${config.API_HOST}:${config.API_PORT}`);
}

void bootstrap();