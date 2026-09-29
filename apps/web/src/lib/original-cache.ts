/**
 * apps/web/src/lib/original-cache.ts
 *
 * 查看原片的内存缓存：同一张照片第二次点「加载原片」直接复用，不再走网络。
 *
 * 【为什么要自己缓存】原片出口带的是 `private, no-store`（隐私原片尤其如此），
 * 浏览器不会自动保留一份；想在页面生命周期内复用，只能自行缓存字节。
 * 缓存以 blob → objectURL 的形式放在内存里，页面刷新或关闭即随之清空 ——
 * 不落盘、不进 sessionStorage：原图动辄十几 MB，且落盘会让票据过期后仍能把它调出来。
 */
import type { Photo } from '@shaping-memory/core';

/** 最多同时留住几张：够「来回对比几张」用，再多也只是无谓占用内存 */
const MAX_ENTRIES = 6;

/**
 * photoId → objectURL。
 * 直接用 Map 当 LRU：Map 的迭代顺序就是插入顺序，命中时先 delete 再 set 即把它挪到队尾，
 * 淘汰时从队首取就是「最久没用过的那个」，不必自己维护链表。
 */
const cache = new Map<string, string>();

/**
 * 这张照片的原片值不值得缓存。
 * 【为什么只缓存「公开可见」的原片】获准后拿到的隐私原片在服务端是 no-store，
 * 把它留在内存里，票据过期或退出登录之后仍能被调出来 —— 等于绕过了隐私策略。
 */
export function isOriginalCacheable(photo: Photo): boolean {
  return photo.privacy?.mode === 'visible';
}

/** 取缓存（命中即算「刚用过」，挪到 LRU 队尾）；没缓存过返回 undefined */
export function cachedOriginal(photoId: string): string | undefined {
  const url = cache.get(photoId);
  if (!url) return undefined;
  cache.delete(photoId);
  cache.set(photoId, url);
  return url;
}

/**
 * 加载原片：命中缓存直接返回，否则下载成 blob 再交给 objectURL。
 * `cacheable` 为 false 时照常返回可用地址，只是不留在缓存里。
 */
export async function loadOriginal(photoId: string, src: string, cacheable: boolean): Promise<string> {
  const hit = cachedOriginal(photoId);
  if (hit) return hit;

  const res = await fetch(src);
  if (!res.ok) throw new Error('原片加载失败，请稍后重试');
  const objectUrl = URL.createObjectURL(await res.blob());
  if (!cacheable) return objectUrl;

  cache.set(photoId, objectUrl);
  evictOverflow();
  return objectUrl;
}

/** 超出上限就从队首淘汰，并 revoke 释放句柄 —— 不 revoke 的话 blob 会一直占着内存 */
function evictOverflow(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldestId = cache.keys().next().value;
    if (oldestId === undefined) return;
    const url = cache.get(oldestId);
    cache.delete(oldestId);
    if (url) URL.revokeObjectURL(url);
  }
}