/**
 * apps/web/src/components/ProgressiveImage.tsx
 *
 * 渐进式图片：先用「底片色块 + 固定纵横比」占位，原片加载完成后再淡入。
 *
 * 为什么必须固定纵横比（§8.2）：瀑布流里图片一旦加载完成改变高度，
 * 整列内容都会重排，正在看的照片会跳走。占位先把高度钉死，加载前后零位移。
 *
 * 外壳与 <img> 都是普通元素：渐显是 opacity 的一次性过渡，交给 CSS 即可，不需要逐帧插值。
 * 墙面卡片的放大由卡片自己的 Motion 变换承担 —— 照片长在卡片里、跟着同比放大（见 PhotoTile），
 * 因此这里不需要接住任何 MotionValue。查看器的放大动画由 Viewer 自己按矩形做 FLIP
 * （见 Viewer.tsx），与本组件无关。
 */
import { memo, useCallback, useState } from 'react';
import type { ReactNode } from 'react';

interface ProgressiveImageProps {
  src: string;
  alt: string;
  /** [宽, 高]，来自 photoAspect() */
  aspect: readonly [number, number];
  /** 占位渐变的两端色，来自 placeholderColors() */
  colors: readonly [string, string];
  /** 压在照片上的叠层（徽章 / 标题 / 渐变遮罩） */
  children?: ReactNode;
  /** 图片填充方式，网格与列表缩略图用 cover，查看器用 contain */
  fit?: 'cover' | 'contain';
}

export const ProgressiveImage = memo(function ProgressiveImage({
  src,
  alt,
  aspect,
  colors,
  children,
  fit = 'cover',
}: ProgressiveImageProps) {
  const [loaded, setLoaded] = useState(false);
  // onLoad 必须稳定引用，否则每次渲染都让 <img> 的监听器重建
  const handleLoad = useCallback(() => setLoaded(true), []);

  return (
    <div
      className="progressive"
      style={{
        aspectRatio: `${aspect[0]} / ${aspect[1]}`,
        backgroundImage: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`,
      }}
    >
      <img
        className={`progressive__img${loaded ? ' is-loaded' : ''}`}
        style={{ objectFit: fit }}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={handleLoad}
        /* 照片一律不可拖：浏览器默认会把 <img> 变成可拖拽对象，一旦按下拖动就会
           拖出一个半透明的「照片幽灵」跟着指针走，并且松手可能触发新标签页打开图片 ——
           这里所有照片的点击语义都是「打开查看器」，拖拽必须让位。
           属性层（draggable）覆盖全部浏览器，样式层（-webkit-user-drag / touch-callout）
           负责 WebKit 系的拖拽与长按菜单，两处都写才是完整的（见 app.css「禁止拖拽」一节）。 */
        draggable={false}
      />
      {children}
    </div>
  );
});