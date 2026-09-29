/**
 * apps/api/src/settings/settings.service.ts
 *
 * 站点设置的「读写与回退」。
 *
 * 【为什么要有白名单】settings 是一张通用 KV 表，隐私系统（privacy.*）也在用它。
 * 如果这里开放任意键，后台就有机会覆盖掉隐私密码哈希 —— 因此本服务只认下面这七个键，
 * 其余键一律忽略（读不回、写不进）。
 *
 * 【为什么读出来是字符串】设置表本身只存 text，保持「后端不猜语义」：
 * 需要数字的体积上限由消费方（上传接口）自己转；这里的 DEFAULT 只是缺省值，
 * 因此首次部署不写任何设置行也能正常工作。
 */
import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { settings } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';

/** 站点设置的全部合法键：后台能改的只有这些 */
export const SITE_KEYS = {
  title: 'site.title',
  slogan: 'site.slogan',
  maxMb: 'upload.maxMb',
  formats: 'upload.formats',
  defaultCategory: 'upload.defaultCategory',
  chunkMb: 'upload.chunkMb',
  concurrency: 'upload.concurrency',
} as const;

/** 站点设置的形态（键名与前端 SDK 的 SiteSettings 完全一致） */
export interface SiteSettings {
  'site.title': string;
  'site.slogan': string;
  'upload.maxMb': string;
  'upload.formats': string;
  'upload.defaultCategory': string;
  /** 分片上传的单片大小（MB）：文件夹上传据此切片，前后端必须同口径 */
  'upload.chunkMb': string;
  /** 分片上传的并发路数：同时最多传几片 */
  'upload.concurrency': string;
}

/** 缺省值：与历史上写死的表现一致，因此「没配置」不会改变任何现有行为 */
export const SITE_DEFAULTS: SiteSettings = {
  'site.title': 'Shaping Memory',
  'site.slogan': 'shape of my memory, snapshot of my mind',
  'upload.maxMb': '50',
  'upload.formats': '.jpg,.jpeg,.png,.webp,.heic,.tif,.tiff',
  'upload.defaultCategory': '纪实',
  'upload.chunkMb': '8',
  'upload.concurrency': '3',
};

const ALL_KEYS = Object.values(SITE_KEYS) as string[];

/** 允许上传的扩展名集合（由设置串解析而来，统一小写、去掉空白项） */
export function parseFormats(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      // 允许后台填「jpg」或「.jpg」两种写法，统一补上点
      .map((item) => (item.startsWith('.') ? item : `.${item}`)),
  );
}

/** 单文件体积上限（字节）；配置非法时回落到缺省值，绝不返回 NaN 导致上传全部失败 */
export function parseMaxBytes(value: string): number {
  const mb = Number.parseFloat(value);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : Number.parseFloat(SITE_DEFAULTS['upload.maxMb']);
  return Math.round(safeMb * 1024 * 1024);
}

/** 分片大小（字节）；非法配置回落到缺省值，且不低于 1MB —— 过小的分片会急剧放大请求数 */
export function parseChunkBytes(value: string): number {
  const mb = Number.parseFloat(value);
  const safeMb = Number.isFinite(mb) && mb >= 1 ? mb : Number.parseFloat(SITE_DEFAULTS['upload.chunkMb']);
  return Math.round(safeMb * 1024 * 1024);
}

/** 分片并发路数；非法配置回落到缺省值，并限制在 1..8 —— 更高的并发只会共同挤占服务端 IO */
export function parseConcurrency(value: string): number {
  const raw = Number.parseInt(value, 10);
  const safe = Number.isInteger(raw) && raw > 0 ? raw : Number.parseInt(SITE_DEFAULTS['upload.concurrency'], 10);
  return Math.min(8, Math.max(1, safe));
}

@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 读全部站点设置：缺失的键用缺省值补齐（只查白名单内的键） */
  async all(): Promise<SiteSettings> {
    const rows = await this.db.select().from(settings).where(inArray(settings.key, ALL_KEYS));
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const result = { ...SITE_DEFAULTS };
    for (const key of ALL_KEYS as (keyof SiteSettings)[]) {
      const value = stored.get(key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  /** 改设置：只接受白名单内的键，返回改后的全量（后台表单因此可以整体替换表单值） */
  async update(patch: Record<string, unknown>): Promise<SiteSettings> {
    for (const [key, value] of Object.entries(patch)) {
      if (!ALL_KEYS.includes(key) || typeof value !== 'string') continue;
      await this.db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    }
    return this.all();
  }

  /** 上传接口要用的派生值：一次读完，避免每张文件都查一遍库 */
  async uploadLimits(): Promise<{
    maxBytes: number;
    formats: Set<string>;
    defaultCategory: string;
    chunkBytes: number;
    concurrency: number;
  }> {
    const value = await this.all();
    return {
      maxBytes: parseMaxBytes(value['upload.maxMb']),
      formats: parseFormats(value['upload.formats']),
      defaultCategory: value['upload.defaultCategory'],
      chunkBytes: parseChunkBytes(value['upload.chunkMb']),
      concurrency: parseConcurrency(value['upload.concurrency']),
    };
  }
}