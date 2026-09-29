/**
 * apps/mobile/src/lib/photo-search.ts
 *
 * 移动端的「检索条件往哪儿落」判定 —— 画廊与地图画廊共用同一份，
 * 两处因此不可能对同一组条件给出不同的结果集。
 *
 * 【为什么要判空】没有真正的检索维度时要走客户端过滤而不是发请求：
 * 分类与排序是常驻筛选栏，它们不改变「要不要走服务端」这件事。
 */
import { searchPhotos } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';
import type { PhotoQuery } from '@shaping-memory/sdk';

/**
 * 搜索条件里是否有「真正的检索维度」。
 * 分类与排序属于筛选栏、常驻在界面上，不算搜索条件 —— 它们不改变「要不要走服务端」。
 */
export function hasSearchConditions(query: PhotoQuery): boolean {
  return (
    query.iso !== undefined ||
    query.hasGps !== undefined ||
    // 标签也是真检索维度：漏掉它会让「只选标签」被判成无条件 —— 结果是本地过滤把全部照片原样放行
    (query.tags?.length ?? 0) > 0 ||
    Boolean(query.q || query.from || query.to || query.cam || query.lens || query.aperture || query.speed)
  );
}

/**
 * 客户端内存过滤：相册模式 / 无搜索条件时使用（core 的 searchPhotos 不含 iso，这里补上）。
 * 与后端同款「精确匹配」口径，避免同一份条件在两条路径上给出不同结果。
 */
export function searchInMemory(photos: readonly Photo[], query: PhotoQuery): readonly Photo[] {
  const matched = searchPhotos(photos, query);
  if (query.iso === undefined) return matched;
  return matched.filter((photo) => photo.iso === query.iso);
}
