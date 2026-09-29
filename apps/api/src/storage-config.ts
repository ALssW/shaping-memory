/**
 * apps/api/src/storage-config.ts
 *
 * 环境变量 → 存储配置的**唯一映射点**，以及「这次到底要不要碰对象存储」的判定。
 *
 * 【为什么单独成文件而不是放在 infra.module 里】批量导入（import-cli → import/pipeline）
 * 也要建存储，而那条链路刻意不依赖 NestJS；把映射留在 NestJS 模块里会把整个框架拖进 CLI。
 */
import { createStore } from '@shaping-memory/storage';
import type { ObjectStore, StorageConfig } from '@shaping-memory/storage';
import type { AppConfig } from '@shaping-memory/config';

/** 配置模板里那几个字段 ↔ 环境变量的对应关系，全项目只写在这一处 */
export function storageConfigOf(config: AppConfig): StorageConfig {
  return {
    provider: config.STORAGE_PROVIDER,
    bucket: config.STORAGE_BUCKET,
    region: config.STORAGE_REGION,
    endpoint: config.STORAGE_ENDPOINT || undefined,
    pathStyle: config.STORAGE_PATH_STYLE,
    prefix: config.STORAGE_PREFIX,
    customDomain: config.STORAGE_CUSTOM_DOMAIN || undefined,
    accessKeyId: config.S3_ACCESS_KEY_ID || undefined,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY || undefined,
    localRoot: config.STORAGE_DIR,
  };
}

/**
 * 远端对象存储：配置了 s3 才返回实例，本机模式（默认）返回 null。
 *
 * 【为什么本机模式必须给 null，而不是让 LocalStore 顶上来】
 * LocalStore 的键空间**就是 STORAGE_DIR 本身** —— 对它调用 remove() 删掉的是真实的
 * 缩略图与实况视频。因此「是否远端」只能由 provider 显式判定，全项目统一用 null
 * 作为「不做任何远端动作」的开关（见 photo-objects.ts）。
 */
export function remoteStoreOf(config: AppConfig, store: ObjectStore): ObjectStore | null {
  return config.STORAGE_PROVIDER === 's3' ? store : null;
}

/** 按当前配置装配一个存储实例（没有依赖注入容器的入口用，如 import-cli） */
export function createConfiguredStore(config: AppConfig): ObjectStore {
  return createStore(storageConfigOf(config));
}
