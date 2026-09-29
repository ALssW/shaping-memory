/**
 * apps/api/src/photos/upload-common.ts
 *
 * 两个上传入口（整包上传 / 分片上传）共用的三件小事：返回形态、入参怎么校验、落盘名怎么起。
 *
 * 【为什么要抽出来】上限口径、命名规则与返回结构必须永远一致 —— 各写一份迟早会出现不一致
 * （修改分片入口却遗漏整包入口，同一文件从两个入口进入会得到两种文件名与两种拒绝提示）。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BadRequestException } from '@nestjs/common';

import type { ObjectSyncResult } from '../photo-objects';
import type { ApiPhoto } from './photos.service';

/**
 * 两个上传入口（整包上传 / 分片上传）统一的返回：照片本体 + 云端同步结果。
 *
 * 【为什么要带上 upload】云副本失败（upload.failed > 0）时照片本身是好的、本地也在，
 * 但用户看不到任何异常 —— 导致那份「异地副本」静默缺失。两个入口共用同一个口径，
 * 否则前台会出现「分片上传有提示、整包上传无提示」这类不一致现象。
 */
export interface PhotoUploadResult {
  photo: ApiPhoto;
  upload: ObjectSyncResult;
}

/**
 * multipart 层的硬上限（MB）。
 * 【为什么与设置里的上限并存】FileInterceptor 的 limits 在装饰器求值时就要定下来，
 * 拿不到「每请求读一次设置」，因此这里给一个宽松的硬天花板先挡住超大请求（避免内存被耗尽）；
 * 真正的上限由设置值在 handler 里二次校验 —— 两道关各管一件事。
 */
export const UPLOAD_CEILING_MB = 256;

/** 体积与扩展名校验（上限与白名单都来自站点设置，后台改完立即生效） */
export function assertAllowed(
  originalName: string,
  size: number,
  limits: { maxBytes: number; formats: Set<string> },
): void {
  if (size > limits.maxBytes) {
    const mb = Math.round(limits.maxBytes / 1024 / 1024);
    throw new BadRequestException(`单个文件不能超过 ${mb}MB`);
  }
  const ext = path.extname(originalName).toLowerCase();
  if (!limits.formats.has(ext)) {
    throw new BadRequestException(`不支持的图片格式，允许：${[...limits.formats].join(' ')}`);
  }
}

/** 随机前缀 + 清洗后的原名（去扩展名），既避同名覆盖又保留可读性 */
export function persistName(originalname: string, ext: string): string {
  const base = path.basename(originalname, ext).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60);
  return `upload-${randomBytes(6).toString('hex')}-${base || 'photo'}${ext}`;
}