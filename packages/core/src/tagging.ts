/**
 * packages/core/src/tagging.ts
 *
 * 照片标签的「跨端展示契约」：标签来源、审核态，以及读接口的形状。
 *
 * 【为什么放 core】三端都要知道「这枚标签该不该出现在前台」（审核态），
 * 放一份在这里，前后台与 mobile 就不可能对同一枚标签产生不同的显示口径。
 */

/* ==========================================================================
 * 标签来源：这条路是「谁打的」
 * ========================================================================== */

/** 标签来源。manual = 人打的（当前全部标签都是这一类） */
export const TAG_SOURCES = ['manual', 'ai'] as const;
export type TagSource = (typeof TAG_SOURCES)[number];

/* ==========================================================================
 * 审核态：这条路是「这枚标签算不算数」
 * ========================================================================== */

/**
 * 审核态三档。
 * 【为什么 approved 也是显式一档】人工标签天然可信，必须有个状态表示「不用审」，
 * 否则查询侧只能写成「pending 之外」，将来加第四档时每处都要改。
 */
export const TAG_REVIEW_STATUSES = ['approved', 'pending', 'rejected'] as const;
export type TagReviewStatus = (typeof TAG_REVIEW_STATUSES)[number];

/* ==========================================================================
 * 读接口的形状：照片上挂的一枚标签
 * ========================================================================== */

/**
 * 服务端读回的单枚标签。
 * 【为什么不用纯字符串】前台需要按审核态过滤，只给名字的话前端需要再发一次
 * 请求才能判断「这枚标签能否显示」。
 */
export interface PhotoTag {
  name: string;
  source: TagSource;
  /** 0~100；人工标签没有这个概念，恒为 null */
  confidence: number | null;
  reviewStatus: TagReviewStatus;
}

/**
 * 前台展示口径：只保留「已生效」的标签名。
 * 【为什么要集中实现】网站前台的卡片、列表、大图查看器都要「只显示已生效的标签」，
 * 若各自写一遍 filter，将来审核态加一档就会漏掉某一处。
 */
export function approvedTagNames(list: readonly PhotoTag[]): string[] {
  return list.filter((tag) => tag.reviewStatus === 'approved').map((tag) => tag.name);
}
