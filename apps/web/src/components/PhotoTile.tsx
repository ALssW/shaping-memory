/**
 * apps/web/src/components/PhotoTile.tsx
 *
 * 一张可点的照片（墙面卡片）。
 *
 * 【放大：卡片与照片共用一个变换】hover 时外层卡片（article）抬起并放大 1.05，
 * 照片长在卡片里、跟着同比放大 —— 两者是同一个变换矩阵，天生同步，
 * 不存在「先后到位」的错位。想突出容器时才会去动内层缩放，此处不做。
 *
 * 【闪白的两处根因都已拆掉】一是内层缩放层被 will-change 提升成独立图层，
 * 父级逐帧变换让它反复重新光栅化，未就绪时整块是白的；二是卡片上的
 * overflow:hidden 让合成层每帧重算裁切矩形。现在照片的裁切由 .progressive
 * 自己负责，卡片既不裁剪、也不再挂 will-change 在子层上。
 *
 * 本组件只管「我这张怎么动」，不知道邻位在哪 —— 聚拢位移由父级（useRipple）算好传入。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { animate, motion, useMotionValue, useSpring, useTransform } from 'motion/react';
import type { MotionValue } from 'motion/react';
import { EXIF_SCOPE_CLASS, photoAspect, placeholderColors } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';

import { Icon } from './Icon';
import { PhotoMask } from './PhotoMask';
import { ProgressiveImage } from './ProgressiveImage';
import { ATTACH_RANGE, fade, HOVER_LIFT, HOVER_LIFT_Y, PRESS_SINK, springOptions, springs } from '../lib/motion';
import { ZERO_PUSH } from '../hooks/useRipple';
import type { PushVector } from '../hooks/useRipple';

interface PhotoTileProps {
  photo: Photo;
  /**
   * 本张在整份有序列表里的下标。墙面是按列轮转排布的，DOM 顺序因此不等于时间顺序，
   * 邻位聚拢要按这个下标认卡片（原样落到 data-index 上，见 useRipple）。
   */
  index: number;
  /** 被指针悬停（或键盘聚焦）：本张抬起、放大，并浮现蒙版 */
  active: boolean;
  /** 邻位聚拢位移（ZERO_PUSH = 不受影响）；悬浮的那张恒为 ZERO_PUSH */
  push: PushVector;
  onHover: (hovering: boolean) => void;
  /** 激活时把「照片本体」的视口矩形一并交出去：查看器的放大动画以它为起点 */
  onActivate: (origin: DOMRect) => void;
  /** 选择模式（admin 批量编辑）：为 true 时点卡片切换选中、不打开查看器 */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export const PhotoTile = memo(function PhotoTile({
  photo,
  index,
  active,
  push = ZERO_PUSH,
  onHover,
  onActivate,
  selecting = false,
  selected = false,
  onToggleSelect,
}: PhotoTileProps) {
  /** 查看器退出时要按 data-photo 反查回这张卡的矩形，因此 ref 挂在根节点上 */
  const tileRef = useRef<HTMLElement>(null);

  /* 指针附着：指针在卡片内的相对位置 → **整张卡片**的位移。
     读数存进 MotionValue + useSpring，指针移动因此不触发任何 React 渲染。 */
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const attachX = useSpring(pointerX, springOptions('smooth'));
  const attachY = useSpring(pointerY, springOptions('smooth'));

  /* 离散状态（聚拢 / 抬起 / 放大）统一走 animate + springs.smooth，不用 useSpring(...).set()：
     那条跟随路径实测不认 token 的 duration 档 —— 8px 的聚拢两三帧内就到位（≈47ms），
     而同参数的 animate 是 400ms。聚拢本该是「平滑靠拢、平滑归位」，快 8 倍就没有弹簧可言了。 */
  const pushX = useMotionValue(0);
  const pushY = useMotionValue(0);
  const cardScale = useMotionValue(1);

  /** 按下态：整张卡片略沉（原先是 whileTap，改由 MotionValue 驱动后自己接指针事件） */
  const [pressed, setPressed] = useState(false);

  /** 抬起：hover 时整张卡片向上让出一点，做出「被拿起来」的观感 */
  const lift = active ? HOVER_LIFT_Y : 0;

  useEffect(() => {
    const targets: readonly [MotionValue<number>, number][] = [
      [pushX, push.x],
      [pushY, lift + push.y],
      [cardScale, pressed ? PRESS_SINK : active ? HOVER_LIFT : 1],
    ];
    const running = targets.map(([value, target]) => animate(value, target, springs.smooth));
    return () => running.forEach((controls) => controls.stop());
  }, [push.x, push.y, lift, pressed, active, pushX, pushY, cardScale]);

  /* 照片不需要单独一条缩放：它长在卡片里，卡片放大 1.05 时照片跟着同比放大，
     两者是同一个变换矩阵，天生同步 —— 上一版为了让「放大的是外壳」可见而给照片
     反向缩放，代价是照片恒不放大、卡片放大只体现在四周的装裱边，放大感太弱。 */

  /** 卡片最终位移 = 邻位聚拢 + 抬起 + 指针附着 */
  const x = useTransform<number, number>([pushX, attachX], ([pushed, attached]) => pushed + attached);
  const y = useTransform<number, number>([pushY, attachY], ([pushed, attached]) => pushed + attached);

  const handleMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      // 归一到 -1..1 再乘以附着半径：指针在中心时位移为 0
      pointerX.set(((event.clientX - rect.left) / rect.width - 0.5) * 2 * ATTACH_RANGE);
      pointerY.set(((event.clientY - rect.top) / rect.height - 0.5) * 2 * ATTACH_RANGE);
    },
    [pointerX, pointerY],
  );

  /** 指针离开：附着归零 —— 「下沉」的后半段，先松手再落回 */
  const handleLeave = useCallback(() => {
    pointerX.set(0);
    pointerY.set(0);
    setPressed(false);
    onHover(false);
  }, [onHover, pointerX, pointerY]);

  /* 打开查看器前先撤销 hover：本张的缩放要落回 1，
     否则放大动画会从一个被放大过的盒子里起飞，位置与尺寸都会偏。
     同时把「照片本体」的视口矩形交出去 —— 查看器的进出场都以它为基准。 */
  const activate = useCallback(() => {
    handleLeave();
    const tile = tileRef.current;
    const box = tile?.querySelector('.progressive') ?? tile;
    onActivate(box ? box.getBoundingClientRect() : new DOMRect(0, 0, 0, 0));
  }, [handleLeave, onActivate]);

  /** 选择模式下点卡片 = 切换选中（不回退打开查看器） */
  const toggleSelect = useCallback(() => {
    onToggleSelect?.(photo.id);
  }, [onToggleSelect, photo.id]);

  return (
    <motion.article
      ref={tileRef}
      className={`photo-card${selecting ? (selected ? ' is-selected' : ' is-selectable') : ''}`}
      data-photo={photo.id}
      /* 时间下标原样落到 DOM：DOM 顺序是列优先的，聚拢要靠它把「第几张」对回去 */
      data-index={index}
      role="button"
      tabIndex={0}
      aria-label={selecting ? (selected ? `取消选中《${photo.title}》` : `选中《${photo.title}》`) : `查看《${photo.title}》`}
      aria-pressed={selecting ? selected : undefined}
      /* 卡片整体不可拖：卡片里没有可拖的文本，但它包着照片，浏览器会把拖拽起点
         算到最近的 img 上。在根节点上关掉，拖到角标 / 蒙版 / 卡边时同样不会起拖。 */
      draggable={false}
      onClick={selecting ? toggleSelect : activate}
      onKeyDown={(event) => {
        // 自定义按钮需自己补齐键盘的两种激活方式
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (selecting) toggleSelect();
          else activate();
        }
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={handleLeave}
      onPointerMove={handleMove}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onFocus={() => onHover(true)}
      onBlur={handleLeave}
      /* 位移与缩放都是空间运动，全部由 style 里的 MotionValue 驱动（见上方 animate 调用），
         不走 animate/whileTap 属性 —— 同一个属性两处驱动会互相覆盖。 */
      style={{ x, y, scale: cardScale }}
    >
      <ProgressiveImage
        src={photo.cardUrl ?? photo.url}
        alt={photo.title}
        aspect={photoAspect(photo)}
        colors={placeholderColors(photo)}
      />

      {/* 选择模式下的勾选角标：常驻右上角，选中打勾、未选空心圈 */}
      {selecting ? (
        <span className="photo-card__check" aria-hidden="true">
          {selected ? <Icon name="check" /> : null}
        </span>
      ) : null}

      {/* 实况角标：常驻右上角 —— 它是「这张有动态内容」的指示，
          不能跟着 hover 蒙版一起淡入淡出，否则要悬停才知道哪几张会动 */}
      {photo.isLive ? (
        <span className="photo-card__live" title="实况照片">
          <Icon name="live" />
          <span className="photo-card__live-text">实况</span>
        </span>
      ) : null}

      {/* 隐私角标：与实况分居两角（左上），因为一张照片可以同时是实况且受保护。
          带角标的照片看到的画面本身就是后端给的模糊图 —— 这里只是把「为什么看不清」提前说清 */}
      {photo.privacy && photo.privacy.mode !== 'visible' ? (
        <span className="photo-card__lock" title="隐私照片，需要授权查看">
          <Icon name="lock" />
        </span>
      ) : null}

      {/* 蒙版层独立于卡片：文字跟着卡片一起缩放会立刻读不清。
          它承载的是拍摄参数与时间，因此归入 EXIF 专区 —— 专区倍率单独调这一块的字号。 */}
      <motion.div
        className={`photo-card__overlay ${EXIF_SCOPE_CLASS}`}
        initial={false}
        animate={{ opacity: active ? 1 : 0 }}
        transition={fade()}
      >
        {/* 拍摄地点由蒙版里的 .photo-card__place 承担 —— 它在墙面形态下被 CSS
            钉到照片右上角（绝对定位 + 玻璃底），因此这里不再单独挂一枚徽章，
            同一份信息重复两次只是噪声。 */}
        <PhotoMask photo={photo} />
      </motion.div>
    </motion.article>
  );
});