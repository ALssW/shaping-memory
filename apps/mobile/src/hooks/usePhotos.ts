/**
 * apps/mobile/src/hooks/usePhotos.ts
 *
 * 拉取整份照片档案（真实后端）。与 Web 端同源——逻辑一致，只是运行在 RN 的 fetch 上。
 *
 * 【为什么一次取整份】图墙不再分页：一次请求拿回整份档案，墙面 / 列表 / 地图 / 横轨
 * 看到的都是同一份完整数据，没有「续页与已取回数据错位」这类一致性问题；
 * 渲染压力由墙面自己的本地分批窗口消化（见 GalleryScreen 的 WALL_BATCH），与传输无关。
 *
 * 【错误口径】失败记在 error 上，列表呈现整块错误态 + 重试入口。
 *
 * 【为什么排序方向必须交给服务端】取回的是「按当前方向排序后的整档」，
 * sort 一变就按新方向重取，两端口径一致。
 *
 * 【隐私解锁后会自动重取】票据写进 SDK 后，同样的请求会拿到「已解锁」的地址与元数据，
 * 因此这里只要监听解锁广播、把计数写入依赖即可 —— 与 Web 端 usePhotos 同一口径。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { photoApi } from '@shaping-memory/sdk';
import type { Photo, SortOrder } from '@shaping-memory/core';

import { usePrivacyTick } from '../lib/privacy';

export interface PhotosState {
  photos: readonly Photo[];
  /** 首屏（或重取）进行中 */
  loading: boolean;
  error: string | null;
  /** 手动重取（编辑保存后刷新） */
  refresh: () => void;
}

interface FetchState {
  photos: Photo[];
  loading: boolean;
  error: string | null;
}

const EMPTY: FetchState = { photos: [], loading: true, error: null };

export function usePhotos(sort: SortOrder): PhotosState {
  const [state, setState] = useState<FetchState>(EMPTY);
  // 隐私解锁广播计数：解锁后这里自增一次，触发下面的重取
  const tick = usePrivacyTick();
  // 手动刷新（编辑保存后重拉）
  const [refreshTick, setRefreshTick] = useState(0);
  /* 代次：刷新 / 排序变化后旧响应必须作废，否则慢回来的那次会污染当前列表 */
  const generationRef = useRef(0);

  /** 首屏/重取：刷新计数、排序方向或隐私解锁一变就按新方向重取整档 */
  useEffect(() => {
    const generation = ++generationRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    photoApi
      .list({ sort })
      .then((photos) => {
        if (generation !== generationRef.current) return;
        setState({ photos, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        setState({ photos: [], loading: false, error: String(err) });
      });
  }, [refreshTick, sort, tick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  return { ...state, refresh };
}
