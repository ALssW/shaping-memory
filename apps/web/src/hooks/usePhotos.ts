/**
 * apps/web/src/hooks/usePhotos.ts
 *
 * 拉取整份照片档案（真实后端，走 /search/photos 专用检索入口）。返回照片、加载态与错误。
 *
 * 【为什么条件交给服务端】检索条件过去在前端内存里过滤，口径容易与后台不一致：
 * 后台是精确匹配、前台是模糊匹配，同一个「光圈 f/2」两边结果就不一样。
 * 现在条件原样交给服务端，SQL 只有一份，两端必然一致。
 *
 * 【为什么一次取整份】图墙不再分页：一次请求拿回全部结果，墙面 / 列表 / 地图 / 横轨
 * 看到的都是同一份完整数据，没有「续页与已取回数据错位」这类一致性问题；
 * 渲染压力由视图自己的虚拟化 / 分批消化，与传输无关。
 *
 * 【隐私解锁后会自动重取】票据写进 SDK 后，同样的请求会拿到「已解锁」的地址与元数据，
 * 因此这里只要监听解锁广播、把计数写入依赖即可，不必知道解锁是密码、分享链接还是账号。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { searchApi } from '@shaping-memory/sdk';
import type { Photo, SearchQuery } from '@shaping-memory/core';

import { usePrivacyTick } from '../lib/privacy';

export interface PhotosState {
  photos: readonly Photo[];
  /** 首屏（或条件变化后的重取）进行中 */
  loading: boolean;
  error: string | null;
  /** 手动重取（编辑保存后刷新；首屏失败的重试也复用它） */
  refresh: () => void;
}

/**
 * 条件的稳定指纹。
 * 【为什么不用对象本身做依赖】面板每次改写都产出新对象，直接写入依赖数组
 * 会让「内容没变、引用变了」也触发一次重取。按固定字段顺序拼串，值一样就一定是同一个指纹。
 *
 * 【标签为什么单独 join】它是唯一的数组维度，不能混进上面那一列交给 .map(String) ——
 * ['a,b'] 与 ['a','b'] 会被拼成同一个串，改一次标签反而不会重新检索。
 * 换一个分隔符（）与字段间用的   区分开，两种边界都不会撞车。
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
    search.province,
    search.city,
    search.tags?.join(''),
  ]
    .map((value) => (value === undefined ? '' : String(value)))
    .join(' ');
}

interface FetchState {
  photos: Photo[];
  loading: boolean;
  error: string | null;
}

const EMPTY: FetchState = { photos: [], loading: true, error: null };

export function usePhotos(search: SearchQuery = {}): PhotosState {
  const [state, setState] = useState<FetchState>(EMPTY);
  const tick = usePrivacyTick();
  // 手动刷新（编辑保存后重拉）：与隐私解锁广播叠加在同一依赖里
  const [refreshTick, setRefreshTick] = useState(0);
  const key = queryKey(search);
  /* 代次：条件变化 / 刷新后旧响应必须作废，否则慢回来的那次会污染当前列表 */
  const generationRef = useRef(0);

  /** 首屏/重取：条件、解锁广播或手动刷新一变就重新取整份 */
  useEffect(() => {
    const generation = ++generationRef.current;
    // 重取时保留已有照片：解锁那一瞬间画面不该整个空掉，只是稍后原地换上清晰版
    setState((prev) => ({ ...prev, loading: true, error: null }));
    searchApi
      .photos(search)
      .then((photos) => {
        if (generation !== generationRef.current) return;
        setState({ photos, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        setState({ photos: [], loading: false, error: String(err) });
      });
    // 依赖用 key 而非 search：见 queryKey 的说明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  return { ...state, refresh };
}
