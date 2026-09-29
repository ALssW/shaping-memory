/**
 * apps/api/src/original-staging.ts
 *
 * 把某张照片的**原片字节**落到 STORAGE_DIR/tmp 下的临时文件，返回该临时路径。
 *
 * 【为什么要经过临时文件】「下载时注入 EXIF」与「查看原片 EXIF」都要拿到原片本体再动它，
 * 但原片本身（本机文件或云端对象）一律不可变，因此统一改成「先复制到 tmp，再在副本上操作」。
 * 调用方负责 finally 删除。
 *
 * 【云/本机两种来源】云模式从桶取回，本机模式直接复制；两条路径都不修改原片。
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { NotFoundException } from '@nestjs/common';
import type { AppConfig } from '@shaping-memory/config';
import type { ObjectStore } from '@shaping-memory/storage';
import { photoObjectKeys } from './photo-objects';

/** 落盘原片所需的最小 media 行切片 */
export interface OriginalSource {
  id: string;
  sourcePath: string;
  liveVideoPath: string | null;
}

/** 生成临时副本并返回其路径（随机后缀避免并发互相覆盖）；云模式的 StorageError 原样抛出，由调用方映射 */
export async function stageOriginal(
  config: AppConfig,
  remote: ObjectStore | null,
  row: OriginalSource,
): Promise<string> {
  const ext = path.extname(row.sourcePath).toLowerCase();
  const dest = path.join(
    config.STORAGE_DIR,
    'tmp',
    `${row.id}-${randomBytes(6).toString('hex')}${ext}`,
  );
  await mkdir(path.dirname(dest), { recursive: true });

  if (remote) {
    const read = await remote.get(photoObjectKeys(row).original);
    await writeFile(dest, await streamToBuffer(read.stream));
    return dest;
  }
  if (!existsSync(row.sourcePath)) throw new NotFoundException('文件尚未生成');
  await copyFile(row.sourcePath, dest);
  return dest;
}