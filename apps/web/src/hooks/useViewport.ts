/**
 * apps/web/src/hooks/useViewport.ts
 *
 * 视口尺寸（含 resize 跟随）。
 * 查看器的放大动画要用「视口安全区」算最终矩形，尺寸变化时必须重算，
 * 所以这里返回的是会触发重渲染的 state，而不是一个读一次的快照。
 */
import { useEffect, useState } from 'react';

export function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return size;
}