/**
 * apps/web/src/hooks/useRipple.ts
 *
 * 邻位聚拢：hover 某一张照片时，算出其余每一张该朝它靠拢多少（px）；
 * 鼠标离开时先反向扩散、再平滑归位，形成两段式反馈。
 *
 * 【为什么需要测量】墙面是按列轮转排布的瀑布流，DOM 顺序是「列优先」，
 * 因此「DOM 相邻」既不等于「视觉相邻」、也不等于「索引相邻」。所以距离用真实几何算：
 * 在 hover 切换时一次性读完全部卡片的位置，滚动与筛选期间零测量。
 *
 * 【为什么要按 data-index 归位】几何数组的下标必须就是**时间下标**
 * （调用方用 pushes?.[index] 取自己的位移），而 DOM 顺序已改成列优先。
 * 因此读数时认卡片上的 data-index，而不是它出现在 nodes 里的第几个。
 *
 * 【为什么读 offset 而不是 getBoundingClientRect】本组件驱动的动画就是 transform，
 * 而 offsetLeft / offsetTop 是布局值，不受 transform 影响。读 client rect 会取到
 * 「动画跳到一半」的坐标：鼠标从一张移到旁边一张时几何一变、聚拢量跟着变，
 * 周围照片就会跟着鼠标抖。offset 读到的永远是静止位置，同一张照片不论从哪张
 * 移进来被收拢的距离都一样。前提是同一容器内的卡片是兄弟节点、共享 offsetParent。
 *
 * 【为什么释放要显式两段】「先向外扩散再归位」无法靠弹簧过冲表达 ——
 * smooth 档 bounce 为 0，完全不会反向；bouncy 档的过冲也只有几 px，看不出方向。
 * 因此离开时把上一次的向量取反推出去，保持一小段（PUSH_RELEASE_MS）后再归零，
 * 弹簧自己负责两段之间的平滑衔接。
 *
 * 只负责算，不负责画 —— 视图把结果传给 PhotoTile 即可。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PUSH_RANGE, PUSH_RELEASE_MS, pushFalloff } from '../lib/motion';

/** 一张照片的位移（px） */
export interface PushVector {
  x: number;
  y: number;
}

/** 不受影响的静止态。做成模块级常量，引用稳定，memo 才不会白做 */
export const ZERO_PUSH: PushVector = { x: 0, y: 0 };

/** 一张卡片静止时的中心点与尺寸，全部来自布局值 */
interface TileBox {
  x: number;
  y: number;
  size: number;
}

/**
 * 算出每张卡片朝第 index 张靠拢的位移。
 * 单位向量 × 力度：一次除法同时给出方向与大小，省掉一次归一化。
 */
function convergeVectors(boxes: readonly TileBox[], index: number): readonly PushVector[] {
  const origin = boxes[index];
  if (!origin) return boxes.map(() => ZERO_PUSH);

  return boxes.map((box, i) => {
    if (i === index) return ZERO_PUSH;
    const dx = origin.x - box.x;
    const dy = origin.y - box.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return ZERO_PUSH;
    const strength = (PUSH_RANGE * pushFalloff(distance / origin.size)) / distance;
    return { x: dx * strength, y: dy * strength };
  });
}

export function useRipple<T extends HTMLElement>(selector: string) {
  const containerRef = useRef<T>(null);
  /** 每张卡片的中心点与尺寸（布局值），仅在 hover 改变时刷新 */
  const geometry = useRef<TileBox[]>([]);
  /** 上一次算出的聚拢向量：释放相位取反就是「先向外扩散」的推法 */
  const converge = useRef<readonly PushVector[] | null>(null);
  /** 释放相位的收尾定时器，重新 hover 时会被撤销 */
  const releaseTimer = useRef<number | null>(null);

  const [hovered, setHovered] = useState<number | null>(null);
  const [pushes, setPushes] = useState<readonly PushVector[] | null>(null);

  const cancelRelease = useCallback(() => {
    if (releaseTimer.current === null) return;
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = null;
  }, []);

  /** 组件卸载时别把定时器留下 —— 它会在已经卸载的组件上 setState */
  useEffect(() => cancelRelease, [cancelRelease]);

  const onHover = useCallback(
    (index: number | null) => {
      cancelRelease();

      if (index === null) {
        /* 释放第一段：邻位朝反方向扩散。没有上一组向量（例如页面刚进来就移出去）
           就没什么可推的，直接归位。被测的那张自己恒为 ZERO_PUSH，取反后仍是零。 */
        const last = converge.current;
        converge.current = null;
        setHovered(null);
        if (!last) {
          setPushes(null);
          return;
        }
        setPushes(last.map((vector) => ({ x: -vector.x, y: -vector.y })));
        releaseTimer.current = window.setTimeout(() => {
          releaseTimer.current = null;
          /* 释放第二段：归位。清空 pushes 后 PhotoTile 收到 ZERO_PUSH，弹簧接着走回 0 */
          setPushes(null);
        }, PUSH_RELEASE_MS);
        return;
      }

      const root = containerRef.current;
      if (root) {
        // 一次批量读，避免逐张触发强制重排
        const nodes = Array.from(root.querySelectorAll<HTMLElement>(selector));
        if (nodes.length > 0) {
          // 同一栅格内卡片等宽，尺寸取平均即可作为「一个卡片宽」的标尺
          const average = nodes.reduce((sum, node) => sum + node.offsetWidth, 0) / nodes.length;
          const size = Math.max(1, average);
          /* 按卡片自己的 data-index 落位（DOM 顺序是列优先，与时间下标无关）：
             缺失的槽位留成空洞，convergeVectors 遇到 undefined 自然跳过。 */
          const boxes: TileBox[] = [];
          nodes.forEach((node) => {
            const at = Number(node.dataset.index);
            if (!Number.isInteger(at)) return;
            boxes[at] = {
              x: node.offsetLeft + node.offsetWidth / 2,
              y: node.offsetTop + node.offsetHeight / 2,
              size,
            };
          });
          geometry.current = boxes;
        }
      }

      const next = convergeVectors(geometry.current, index);
      converge.current = next;
      setPushes(next);
      setHovered(index);
    },
    [cancelRelease, selector],
  );

  return { containerRef, hovered, onHover, pushes };
}