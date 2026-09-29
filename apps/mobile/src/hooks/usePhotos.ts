/**
 * apps/mobile/src/hooks/usePhotos.ts
 *
 * 拉取整份照片档案（真实后端）。与 Web 端同源——逻辑一致，只是运行在 RN 的 fetch 上。
 *
 * 【为什么改成「一页一页攒」】档案可能上万张，首屏只看得见头十几张，
 * 一次全量拉下来既慢又费流量。这里按 limit/offset 取第一页，
 * 滚到列表底部由相应屏幕触发 loadMore 追加下一页；地图要全量点位，调 loadAll 取整份。
 *
 * 【错误口径】首屏失败记在 error 上（列表会呈现整块错误态）；
 * 追加失败也记在 error 上，但**保留已取回的照片**，用户可以直接重试而不必从头再拉。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { photoApi } from '@shaping-memory/sdk';
import type { Photo } from '@shaping-memory/core';

/** 单页条数：手机上首屏可见不到十张，60 张足够填满几屏，翻页也不会太碎 */
const PAGE_SIZE = 60;

export interface PhotosState {
  photos: readonly Photo[];
  /** 首屏进行中 */
  loading: boolean;
  /** 正在追加下一页 */
  loadingMore: boolean;
  error: string | null;
  /** 服务端上一页返回满页，说明后面可能还有 */
  hasMore: boolean;
  /** 追加下一页；已有请求在飞或已到底时自动忽略 */
  loadMore: () => void;
  /** 取回整份档案（地图需要全量点位）；结果会替换当前列表 */
  loadAll: () => void;
  /** 手动重取第一页（编辑保存后刷新） */
  refresh: () => void;
}

/** 追加去重：翻页与新上传错位时，同一张可能出现在两页里（与 Web 端同一口径） */
function appendUnique(prev: Photo[], incoming: readonly Photo[]): Photo[] {
  const seen = new Set(prev.map((photo) => photo.id));
  const merged = [...prev];
  for (const photo of incoming) {
    if (seen.has(photo.id)) continue;
    seen.add(photo.id);
    merged.push(photo);
  }
  return merged;
}

interface PageState {
  photos: Photo[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
}

const EMPTY: PageState = { photos: [], loading: true, loadingMore: false, error: null, hasMore: false };

export function usePhotos(): PhotosState {
  const [state, setState] = useState<PageState>(EMPTY);
  // 手动刷新（编辑保存后重拉）
  const [refreshTick, setRefreshTick] = useState(0);

  /** 已取回的照片数，也就是下一页的 offset（放 ref：它是请求游标，不是渲染数据） */
  const offsetRef = useRef(0);
  /** 串行闸门：滚动事件触发极频繁，不加这道锁会把同一页重复请求几十遍 */
  const busyRef = useRef(false);
  /** hasMore 的同步副本，供 loadMore 判断而不必依赖 state */
  const hasMoreRef = useRef(false);
  /** 代次：刷新后旧响应必须作废，否则慢回来的上一页会污染当前列表 */
  const generationRef = useRef(0);

  /** 首屏/重取：刷新计数一变就回到第一页 */
  useEffect(() => {
    const generation = ++generationRef.current;
    busyRef.current = true;
    offsetRef.current = 0;
    hasMoreRef.current = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    photoApi
      .list({}, { limit: PAGE_SIZE })
      .then((photos) => {
        if (generation !== generationRef.current) return;
        offsetRef.current = photos.length;
        hasMoreRef.current = photos.length === PAGE_SIZE;
        setState({ photos, loading: false, loadingMore: false, error: null, hasMore: hasMoreRef.current });
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        setState({ photos: [], loading: false, loadingMore: false, error: String(err), hasMore: false });
      })
      .finally(() => {
        // 只有「当前代次」才解锁闸门：旧请求结束得再晚，也不能替新请求放行
        if (generation === generationRef.current) busyRef.current = false;
      });
  }, [refreshTick]);

  /** 追加下一页：偏移量取「已取回条数」，结果按 id 去重后接到列表尾部 */
  const loadMore = useCallback(() => {
    if (busyRef.current || !hasMoreRef.current) return;
    const generation = generationRef.current;
    const offset = offsetRef.current;
    busyRef.current = true;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    photoApi
      .list({}, { limit: PAGE_SIZE, offset })
      .then((photos) => {
        if (generation !== generationRef.current) return;
        offsetRef.current = offset + photos.length;
        hasMoreRef.current = photos.length === PAGE_SIZE;
        setState((prev) => ({
          ...prev,
          photos: appendUnique(prev.photos, photos),
          loadingMore: false,
          hasMore: hasMoreRef.current,
        }));
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        setState((prev) => ({ ...prev, loadingMore: false, error: String(err) }));
      })
      .finally(() => {
        if (generation === generationRef.current) busyRef.current = false;
      });
  }, []);

  /**
   * 取整份档案：不带 limit 即「不限制」，返回后也就没有下一页了。
   * 【为什么允许抢占正在飞的请求】进地图时可能刚好处在「第一页还在路上」的窗口内，
   * 若照旧被闸门挡住，地图就只能拿到一页点位；照发不误，由代次判定胜负即可。
   */
  const loadAll = useCallback(() => {
    const generation = ++generationRef.current;
    busyRef.current = true;
    setState((prev) => ({ ...prev, loading: prev.photos.length === 0, error: null }));
    photoApi
      .list()
      .then((photos) => {
        if (generation !== generationRef.current) return;
        offsetRef.current = photos.length;
        hasMoreRef.current = false;
        setState({ photos, loading: false, loadingMore: false, error: null, hasMore: false });
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        setState((prev) => ({ ...prev, loading: false, loadingMore: false, error: String(err) }));
      })
      .finally(() => {
        if (generation === generationRef.current) busyRef.current = false;
      });
  }, []);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  return { ...state, loadMore, loadAll, refresh };
}