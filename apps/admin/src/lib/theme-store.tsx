/**
 * apps/admin/src/lib/theme-store.tsx
 *
 * 主题配置的「草稿 / 已保存」双份状态，供后台外壳与主题配置页共享。
 *
 * 【为什么草稿要挂在全局而不是页面内】草稿一变就要立刻套到整站（实时预览），
 * 而 ConfigProvider 的 AntD token 在外壳那一层 —— 状态若只活在主题页里，
 * 外壳拿不到，导致「页面变、菜单不变」的半预览。
 *
 * 【为什么改草稿不落库】用户期望的是「调滑杆看到效果，满意了再保存」。
 * 因此草稿只走 setActiveTheme（写 <style> 节点），保存才调接口；
 * 撤销 = 把已保存值再套一遍，天然回退。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getResolvedTheme, setActiveTheme, themeApi } from '@shaping-memory/sdk';
import { THEME_SCALE_MIN_WIDTH } from '@shaping-memory/core';
import type { ThemeConfig } from '@shaping-memory/core';

interface ThemeStoreValue {
  /** 已保存到服务端的配置（撤销的落点） */
  saved: ThemeConfig;
  /** 编辑中的草稿：已实时套在页面上 */
  draft: ThemeConfig;
  /** 是否有未保存的改动 */
  dirty: boolean;
  /** 当前视口是否处于缩放生效的档位（CSS 媒体查询同一断点，用于 AntD token） */
  scaleOn: boolean;
  /** 改草稿（即改即预览） */
  updateDraft: (next: ThemeConfig) => void;
  /** 保存草稿到服务端 */
  commit: () => Promise<void>;
  /** 丢弃草稿，回到已保存值 */
  discard: () => void;
  /** 恢复出厂设置（直接落库） */
  resetFactory: () => Promise<void>;
}

const ThemeStoreContext = createContext<ThemeStoreValue | null>(null);

/** 两份配置是否等价：字段少且扁平，序列化比对足够，不值得为它写逐字段 diff */
function isSameConfig(a: ThemeConfig, b: ThemeConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ThemeStoreProvider({ children }: { children: ReactNode }) {
  /* 初值取「入口已套用的那份」—— 后台 main.tsx 在 render 前 await bootstrapTheme()，
     因此这里同步拿到的就是服务端配置（或缓存 / 出厂默认值），不存在二次闪烁。 */
  const initial = getResolvedTheme().config;
  const [saved, setSaved] = useState<ThemeConfig>(initial);
  const [draft, setDraft] = useState<ThemeConfig>(initial);
  const [scaleOn, setScaleOn] = useState(() => window.matchMedia(`(min-width: ${THEME_SCALE_MIN_WIDTH}px)`).matches);

  // 断点变化时同步一次：AntD 的 token 不能用媒体查询，只能由 JS 告知该不该放大
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${THEME_SCALE_MIN_WIDTH}px)`);
    const onChange = (event: MediaQueryListEvent): void => setScaleOn(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  /** 改草稿：先落到页面（实时预览），再进状态 */
  const updateDraft = useCallback((next: ThemeConfig) => {
    setActiveTheme(next);
    setDraft(next);
  }, []);

  const commit = useCallback(async () => {
    const updated = await themeApi.update(draft);
    setSaved(updated);
    setDraft(updated);
    setActiveTheme(updated);
  }, [draft]);

  const discard = useCallback(() => {
    setActiveTheme(saved);
    setDraft(saved);
  }, [saved]);

  const resetFactory = useCallback(async () => {
    const config = await themeApi.reset();
    setSaved(config);
    setDraft(config);
    setActiveTheme(config);
  }, []);

  const value = useMemo<ThemeStoreValue>(
    () => ({
      saved,
      draft,
      dirty: !isSameConfig(draft, saved),
      scaleOn,
      updateDraft,
      commit,
      discard,
      resetFactory,
    }),
    [saved, draft, scaleOn, updateDraft, commit, discard, resetFactory],
  );

  return <ThemeStoreContext.Provider value={value}>{children}</ThemeStoreContext.Provider>;
}

export function useThemeStore(): ThemeStoreValue {
  const value = useContext(ThemeStoreContext);
  if (!value) throw new Error('useThemeStore 必须在 ThemeStoreProvider 内使用');
  return value;
}