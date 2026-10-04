/**
 * apps/admin/src/lib/uploadPlan.ts
 *
 * 待上传文件清单的**唯一口径**：同名比对、格式与体积校验、勾选与覆盖的快捷计算。
 *
 * 【为什么必须抽出来】单文件 / 多文件上传（PhotoUploadModal）与文件夹上传（FolderUploadModal）
 * 都要「先看清单、按文件勾选、同名标出来」；口径分散在两处，迟早出现
 * 「拖拽上传放行、文件夹上传拦截」这类不一致。
 *
 * 【同名与覆盖是两件事】判定「同名」只看原始文件名 —— 用户重新导出一张照片时
 * 字节数常常会变，只认「同名 + 同大小」会让用户看到名字一样却查不到对应记录。
 * 但「覆盖」必须同名**且同大小**：只有字节数一致才构成真正的原地替换，
 * 否则覆盖会丢掉库里那份文件的内容，且不可恢复。
 */
import type { Photo } from '@shaping-memory/core';

import { fileKeyOf } from './pendingBatch';
import { extOf } from './uploadRules';
import type { UploadRules } from './uploadRules';

/** 同名索引：原始文件名 → 库中同名照片（同名多张时以最后写入的一张为准，仅用于提示与覆盖） */
export type NameIndex = Map<string, Photo>;

/** 一条待上传的候选文件 */
export interface UploadCandidate {
  file: File;
  /** 身份键（名 | 大小 | 修改时间），勾选状态与覆盖选择都以它为准 */
  key: string;
  name: string;
  size: number;
  /** 库中同名照片（只按文件名判定）；没有同名时为空 */
  sameName?: Photo;
  /** 同名且字节数也相同 —— 只有这种情况才允许「覆盖」（沿用原照片 id 与相册归属） */
  canOverwrite: boolean;
}

/** 被拦下的文件：格式或体积不符，不进清单 */
export interface RejectedFile {
  name: string;
  reason: string;
}

export interface ClassifyResult {
  accepted: UploadCandidate[];
  rejected: RejectedFile[];
}

/** 一个清单根节点：文件夹上传时是所选文件夹，单 / 多文件上传时是整批文件的容器 */
export interface UploadRoot {
  name: string;
  candidates: UploadCandidate[];
}

/**
 * 建同名索引。只收有 `originalName` 的照片 —— 批量导入的照片没有这一列，
 * 它们本来就不存在「上传时叫什么名字」这回事。
 */
export function buildNameIndex(photos: readonly Photo[]): NameIndex {
  const index: NameIndex = new Map();
  for (const photo of photos) {
    if (!photo.originalName) continue;
    index.set(photo.originalName, photo);
  }
  return index;
}

/**
 * 一批文件 → 候选与拒绝项。逐文件判：格式 → 体积 → 同名。
 * 拒绝项一并返回而不是直接丢弃：确认页要如实说明「跳过了几个、为什么」。
 */
export function classifyFiles(
  files: readonly File[],
  rules: UploadRules,
  index: NameIndex,
): ClassifyResult {
  const accepted: UploadCandidate[] = [];
  const rejected: RejectedFile[] = [];

  for (const file of files) {
    if (!rules.formats.includes(extOf(file.name))) {
      rejected.push({ name: file.name, reason: '格式不在允许列表' });
      continue;
    }
    if (file.size / 1024 / 1024 > rules.maxMb) {
      rejected.push({ name: file.name, reason: `超过 ${rules.maxMb} MB` });
      continue;
    }
    const sameName = index.get(file.name);
    accepted.push({
      file,
      key: fileKeyOf(file),
      name: file.name,
      size: file.size,
      sameName,
      // 同名 + 字节数一致才算同一个文件，才允许覆盖
      canOverwrite: sameName !== undefined && sameName.originalSize === file.size,
    });
  }

  return { accepted, rejected };
}

/** 全部候选的身份键（「全部勾选」按钮据此一次性勾中所有文件） */
export function candidateKeysOf(roots: readonly UploadRoot[]): string[] {
  return allCandidatesOf(roots).map((candidate) => candidate.key);
}

/** 展平所有候选 */
export function allCandidatesOf(roots: readonly UploadRoot[]): UploadCandidate[] {
  return roots.flatMap((root) => root.candidates);
}

/** 按勾选结果取出待上传的候选（勾选状态里可能含文件夹根节点的键，因此按候选键过滤） */
export function selectedCandidatesOf(
  roots: readonly UploadRoot[],
  checkedKeys: readonly string[],
): UploadCandidate[] {
  const checked = new Set(checkedKeys);
  return allCandidatesOf(roots).filter((candidate) => checked.has(candidate.key));
}

/** 同名项（不论大小是否一致）—— 「取消勾选全部同名文件」以它为准 */
export function sameNameCandidatesOf(roots: readonly UploadRoot[]): UploadCandidate[] {
  return allCandidatesOf(roots).filter((candidate) => candidate.sameName !== undefined);
}

/** 可覆盖项（同名且同大小）—— 「同名文件全部覆盖」以它为准 */
export function overwritableCandidatesOf(roots: readonly UploadRoot[]): UploadCandidate[] {
  return allCandidatesOf(roots).filter((candidate) => candidate.canOverwrite);
}