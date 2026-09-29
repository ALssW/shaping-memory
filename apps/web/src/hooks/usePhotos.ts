/**
 * apps/web/src/hooks/usePhotos.ts
 *
 * 拉取照片档案（真实后端，走 /search/photos 专用检索入口）。返回照片、加载态、错误与翻页能力。
 *
 * 【为什么不再全量拉取】检索条件过去在前端内存里过滤，口径容易与后台不一致：
 * 后台是精确匹配、前台是模糊匹配，同一个「光圈 f/2」两边结果就不一样。
 * 现在条件原样交给服务端，SQL 只有一份，两端必然一致。
 *
 * 【为什么改成「一页一页攒」】档案可能上万张，首屏只看得见头十几张，
 * 一次全量拉下来既慢又费流量。这里按 limit/offset 取第一页，
 * 滚动到底由调用方触发 loadMore 追加下一页 —— 列表外观不变，请求量却只与「看过多少」相关。
 * 地图这类需要全量点位的场景，调 loadAll 显式取整份。
 *
 * 【隐私解锁后会自动重取】票据写进 SDK 后，同样的请求会拿到「已解锁」的地址与元数据，
 * 因此这里只要监听解锁广播、把计数写入依赖即可，不必知道解锁是密码、分享链接还是账号。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { searchApi } from '@shaping-memory/sdk';
import type { Photo, SearchQuery } from '@shaping-memory/core';

import { usePrivacyTick } from '../lib/privacy';

/** 单页条数：一屏约十几张，60 张足够填满首屏并留出「即将进入视口」的缓冲，翻页次数也不至于太碎 */
const PAGE_SIZE = 60;

export interface PhotosState {
  photos: readonly Photo[];
  /** 首屏（或条件变化后的重取）进行中 */
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

/**
 * 条件的稳定指纹。
 * 【为什么不用对象本身做依赖】面板每次改写都产出新对象，直接写入依赖数组
 * 会让「内容没变、引用变了」也触发一次重取。按固定字段顺序拼串，值一样就一定是同一个指纹。
 *
 * 【标签为什么单独 join】它是唯一的数组维度，不能混进上面那一列交给 .map(String) ——
 * ['a,b'] 与 ['a','b'] 会被拼成同一个串，改一次标签反而不会重新检索。
 * 换一个分隔符（\u0001）与字段间用的 \u0000 区分开，两种边界都不会撞车。
 */
function queryKey(search: SearchQuery): string {
  return [
    search.q,
    search.from,
    search.to,
    search.cam,
    search.lens,
    search.aperture,
    search.speed,
    search.iso,
    search.hasGps,
    search.tags?.join('\u0001'),
  ]
    .map((value) => (value === undefined ? '' : String(value)))
    .join('\u0000');
}

/**
 * 追加去重。
 * 【为什么必须去重】翻页与「隐私解锁后重取」可能前后脚发生，服务端两页之间也可能因
 * 新上传而整体错位一两位，同一张就会出现在两页里；按 id 去重能保证列表不出重复卡片。
 */
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

export function usePhotos(search: SearchQuery = {}): PhotosState {
  const [state, setState] = useState<PageState>(EMPTY);
  const tick = usePrivacyTick();
  // 手动刷新（编辑保存后重拉）：与隐私解锁广播叠加在同一依赖里
  const [refreshTick, setRefreshTick] = useState(0);
  const key = queryKey(search);

  /* 已取回的照片数，也就是下一页的 offset。放 ref 不放 state：它是「请求游标」而非渲染数据，
     进 state 只会让每翻一页多一次无谓的重渲染。 */
  const offsetRef = useRef(0);
  /* 串行闸门：滚动事件一秒能触发几十次，不加这道锁会把同一页重复请求几十遍 */
  const busyRef = useRef(false);
  /* 并列一份 hasMore，供 loadMore 在回调里同步判断，不必为了读 state 而把回调做成不稳定引用 */
  const hasMoreRef = useRef(false);
  /* 代次：条件变化 / 刷新后旧响应必须作废，否则慢回来的上一页会污染当前列表 */
  const generationRef = useRef(0);
  /* 条件放 ref 供 loadMore/loadAll 读取：面板每次改写都是新对象，
     若进 useCallback 依赖，回调引用一变，滚动监听就会被反复重建。 */
  const searchRef = useRef(search);
  searchRef.current = search;

  /** 首屏/重取：条件、解锁广播或手动刷新一变就回到第一页 */
  useEffect(() => {
    const generation = ++generationRef.current;
    busyRef.current = true;
    offsetRef.current = 0;
    hasMoreRef.current = false;
    // 重取时保留已有照片：解锁那一瞬间画面不该整个空掉，只是稍后原地换上清晰版
    setState((prev) => ({ ...prev, loading: true, error: null }));
    searchApi
      .photos(search, { limit: PAGE_SIZE })
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
    // 依赖用 key 而非 search：见 queryKey 的说明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, refreshTick]);

  /** 追加下一页：偏移量取「已取回条数」，结果按 id 去重后接到列表尾部 */
  const loadMore = useCallback(() => {
    if (busyRef.current || !hasMoreRef.current) return;
    const generation = generationRef.current;
    const offset = offsetRef.current;
    busyRef.current = true;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    searchApi
      .photos(searchRef.current, { limit: PAGE_SIZE, offset })
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
        // 失败只收起加载态并记下错误，已取回的照片保持原样，用户可以直接重试而不必从头再拉
        if (generation !== generationRef.current) return;
        setState((prev) => ({ ...prev, loadingMore: false, error: String(err) }));
      })
      .finally(() => {
        if (generation === generationRef.current) busyRef.current = false;
      });
  }, []);

  /**
   * 取整份档案：不带 limit 即「不限制」，返回后也就没有下一页了。
   * 【为什么允许抢占正在飞的请求】进地图时可能刚好处在「首屏第一页还在路上」的窗口内，
   * 若照旧被闸门挡住，地图就只能拿到一页点位。这里照发不误，由代次判定胜负 ——
   * 整档的代次一定比先发的那次晚，先到的那份因此会被丢弃，不会覆盖整档。
   */
  const loadAll = useCallback(() => {
    const generation = ++generationRef.current;
    busyRef.current = true;
    setState((prev) => ({ ...prev, loading: prev.photos.length === 0, loadingMore: prev.photos.length > 0, error: null }));
    searchApi
      .photos(searchRef.current)
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