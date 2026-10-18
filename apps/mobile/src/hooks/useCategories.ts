/**
 * apps/mobile/src/hooks/useCategories.ts
 *
 * 分类候选项（来自后端 GET /categories）。与 Web 端各处「先取列表、再用 ['全部', ...names]」
 * 的做法同一口径，抽成一处实现，避免画廊筛选条、地图筛选条与两个编辑对话框各写一份。
 *
 * 【为什么首项固定是「全部」】它是「不按分类筛选」的入口，不属于后端维护的档案分类，
 * 因此由前端补在最前；后端返回的分类名原样追加在后。
 * 拉取失败时静默降级：只保留「全部」，筛选条与编辑表单永远可用、不会白屏。
 */
import { useEffect, useState } from 'react';
import { categoryApi } from '@shaping-memory/sdk';

export function useCategories(): readonly string[] {
  const [categories, setCategories] = useState<readonly string[]>(['全部']);

  useEffect(() => {
    let cancelled = false;
    categoryApi
      .list()
      .then((list) => {
        if (!cancelled) setCategories(['全部', ...list.map((item) => item.name)]);
      })
      .catch(() => {
        /* 静默降级：保留「全部」，不打断浏览 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return categories;
}
