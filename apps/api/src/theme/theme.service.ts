/**
 * apps/api/src/theme/theme.service.ts
 *
 * 主题配置的读写。
 *
 * 【存储为什么复用 settings 表】该表的注释明确说明：「设置项会随需求不断增删，
 * 逐项建列意味着每加一项就要一次迁移」。主题是一棵结构化对象，正好整棵写入一个值中，
 * 键为 theme.config —— 既无需迁移，也不触碰 settings 服务的 5 键白名单。
 *
 * 【为什么读出来还要再归一化一遍】库里的值可能被手工改写为异常值、也可能由旧版本写入。
 * 读接口永远返回 normalize 之后的结果：异常字段静默回落出厂默认，避免整站样式失效。
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { settings } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import {
  THEME_CONFIG_KEY,
  THEME_DEFAULTS,
  isSafeCssColor,
  normalizeThemeConfig,
} from '@shaping-memory/core';
import type { FontTier, ThemeColors, ThemeConfig } from '@shaping-memory/core';
import { DB } from '../infra.module';

/** 判断是不是普通对象（数组 / null 都不算） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ThemeService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** JSON 解析失败（空串、半截内容、非法字符）一律当「没配过」处理 */
  private parse(value: string | undefined): unknown {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  async get(): Promise<ThemeConfig> {
    const rows = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, THEME_CONFIG_KEY))
      .limit(1);
    return normalizeThemeConfig(this.parse(rows[0]?.value));
  }

  /**
   * 局部补丁语义：只改传进来的那一部分，其余保持库里现值。
   *
   * 【为什么在服务层做「只挑合法值」】先过滤再合并，非法输入就会被**整条忽略**，
 * 现值因此原样保留；如果直接把异常值合并进去再交给 normalize，那一项会被回落成
 * **出厂默认**（而不是现值）—— 那等同于「修改出错反而被重置」，不符合用户预期。
   */
  async update(patch: unknown): Promise<ThemeConfig> {
    const current = await this.get();
    const source = isPlainObject(patch) ? patch : {};

    const colors: Partial<ThemeColors> = {};
    if (isPlainObject(source.colors)) {
      for (const [key, value] of Object.entries(source.colors)) {
        if (isSafeCssColor(value)) colors[key as keyof ThemeColors] = value.trim();
      }
    }

    const fontOverrides: Partial<Record<FontTier, number>> = {};
    if (isPlainObject(source.fontOverrides)) {
      for (const [tier, value] of Object.entries(source.fontOverrides)) {
        if (typeof value === 'number' && Number.isFinite(value)) fontOverrides[tier as FontTier] = value;
      }
    }

    const merged = normalizeThemeConfig({
      colors: { ...current.colors, ...colors },
      /* 【逐档微调是整体替换，不是合并】它表达的是「哪些档位被显式指定过」的**完整集合**：
         客户端把某一档删掉，语义就是「这一档回到跟随倍率」。若按合并处理，被删的那一档
         会被库里现值补回来 —— 于是「重置这档」永远失效。 */
      fontOverrides: isPlainObject(source.fontOverrides) ? fontOverrides : current.fontOverrides,
      fontScale: typeof source.fontScale === 'number' ? source.fontScale : current.fontScale,
      exifScale: typeof source.exifScale === 'number' ? source.exifScale : current.exifScale,
    });

    return this.write(merged);
  }

  /**
   * 恢复出厂：写回默认值。
   * 【为什么不能复用 update】update 是「合并」语义 —— 传空 fontOverrides 进去等于「这一项没提」，
   * 现值会被保留，出厂值反而清不掉。恢复出厂要的是整体替换，因此单独一条路。
   */
  async reset(): Promise<ThemeConfig> {
    return this.write(normalizeThemeConfig(THEME_DEFAULTS));
  }

  /** 落库并回读同一份（写入的值即归一化后的值，因此直接返回） */
  private async write(config: ThemeConfig): Promise<ThemeConfig> {
    const value = JSON.stringify(config);
    await this.db
      .insert(settings)
      .values({ key: THEME_CONFIG_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    return config;
  }
}