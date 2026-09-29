/**
 * apps/api/src/infra.module.ts
 *
 * 全局基础设施模块：注入 AppConfig 与 Drizzle 客户端（Db）。
 * 用 @Global 让 Photos / Files 等模块无需重复 import，直接 @Inject 使用。
 */
import { Global, Module } from '@nestjs/common';
import { loadConfig } from '@shaping-memory/config';
import type { AppConfig } from '@shaping-memory/config';
import { createDb } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { createStore } from '@shaping-memory/storage';
import type { ObjectStore } from '@shaping-memory/storage';
import { storageConfigOf } from './storage-config';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const DB = Symbol('DB');
export const OBJECT_STORE = Symbol('OBJECT_STORE');

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      // 工厂在 bootstrap 时才执行，此刻 .env 一定已加载
      useFactory: (): AppConfig => loadConfig(),
    },
    {
      provide: DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Db => createDb(config.DATABASE_URL),
    },
    {
      provide: OBJECT_STORE,
      inject: [APP_CONFIG],
      // 只装配客户端，不发任何网络请求，因此配置错误也不会拖慢启动
      useFactory: (config: AppConfig): ObjectStore => createStore(storageConfigOf(config)),
    },
  ],
  exports: [APP_CONFIG, DB, OBJECT_STORE],
})
export class InfraModule {}